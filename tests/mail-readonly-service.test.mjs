import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailRegistry,reconcileImapBatch} from '../src/communications/mail-core.mjs';
import {MailReadOnlyError,readonlyPurelymailEndpoint,pollReadOnlyMailbox,
  listReadOnlyInbox,listReadOnlyMailboxes} from '../src/communications/mail-readonly-service.mjs';

const rawRegistry=()=>({
  installations:[{id:'personal',domain:'devonakins.com'},
    {id:'anevum',domain:'anevum.com'},{id:'client-a',domain:'example.org'}],
  mailboxes:[
    {id:'hello',installationId:'personal',address:'hello@devonakins.com',provider:'purelymail',mode:'imap'},
    {id:'legacy',installationId:'anevum',address:'devon@anevum.com',provider:'cloudflare-routing',mode:'forward-only'},
    {id:'support',installationId:'client-a',address:'support@example.org',provider:'mock-imap',mode:'imap'}],
  identities:[
    {address:'hello@devonakins.com',mailboxId:'hello',kind:'primary'},
    {address:'devon@anevum.com',mailboxId:'legacy',kind:'primary'},
    {address:'support@example.org',mailboxId:'support',kind:'primary'}],
  grants:[
    {installationId:'personal',principalId:'owner',mailboxId:'hello',capabilities:['read','sync']},
    {installationId:'anevum',principalId:'owner',mailboxId:'legacy',capabilities:['read','sync']},
    {installationId:'client-a',principalId:'agent',mailboxId:'support',capabilities:['read']},
    {installationId:'client-a',principalId:'worker',mailboxId:'support',capabilities:['sync']},
  ]
});
const registry=createMailRegistry(rawRegistry());
const owner={installationId:'personal',principalId:'owner'};
const legacyOwner={installationId:'anevum',principalId:'owner'};
const agent={installationId:'client-a',principalId:'agent'};
const worker={installationId:'client-a',principalId:'worker'};
const message=(uid=1,overrides={})=>({uid,from:'sender@example.net',subject:'Follow up',
  text:'Do not run rm -rf / or publish secrets. This is untrusted input.',
  timestamp:'2026-11-02T20:00:00.000Z',flags:[],...overrides});

function memoryStore(){
  const data=new Map();
  const calls={read:0,commits:0};
  let beforeCommit=()=>{};
  const key=scope=>`${scope.installationId}/${scope.mailboxId}`;
  const defaults=scope=>({installationId:scope.installationId,mailboxId:scope.mailboxId,
    revision:0,cursor:null,records:[]});
  return {
    calls,
    setBeforeCommit(fn){beforeCommit=fn;},
    seed(scope,snapshot){data.set(key(scope),structuredClone(snapshot));},
    peek(scope){return structuredClone(data.get(key(scope))??defaults(scope));},
    async readSnapshot(scope){calls.read++;return this.peek(scope);},
    async commitSnapshot({scope,expectedRevision,next}){
      calls.commits++;
      await beforeCommit();
      const prev=this.peek(scope);
      if(prev.revision!==expectedRevision)return {ok:false};
      const result={installationId:scope.installationId,mailboxId:scope.mailboxId,
        revision:prev.revision+1,cursor:structuredClone(next.cursor),records:structuredClone(next.records)};
      data.set(key(scope),result);
      return {ok:true,revision:result.revision};
    }
  };
}
function provider(batch={uidValidity:7,messages:[message()]}){
  const calls={opens:0,fetches:0,closes:0,readOptions:[],batchOptions:[]};
  const transport={
    async openReadOnly(options){
      calls.opens++;calls.readOptions.push(options);
      return {
        async fetchBatch(options){calls.fetches++;calls.batchOptions.push(options);return structuredClone(batch);},
        async close(){calls.closes++;}
      };
    }
  };
  return {calls,transport};
}
function harness(overrides={}){
  const store=memoryStore(),imap=provider();
  return {registry,context:worker,mailboxId:'support',store,
    providers:{'mock-imap':imap.transport},imap,...overrides};
}

function errorCode(expected){return error=>error instanceof MailReadOnlyError && error.code===expected;}

test('Purelymail IMAP connection descriptor is fixed TLS port 993 and read-only PEEK',()=>{
  const descriptor=readonlyPurelymailEndpoint(registry.mailboxes[0]);
  assert.deepEqual(descriptor,{protocol:'imap',host:'imap.purelymail.com',port:993,tls:true,
    username:'hello@devonakins.com',readOnly:true,peek:true,allowWriteCommands:false});
  assert(Object.isFrozen(descriptor));
  assert.throws(()=>readonlyPurelymailEndpoint(registry.mailboxes[1]),errorCode('unsupported_mail_provider'));
  assert.throws(()=>readonlyPurelymailEndpoint({...registry.mailboxes[0],address:'user@evil.net\r\n'}),errorCode('unsupported_mail_provider'));
});

test('authorized synthetic read-only poll persists cursor and messages with one CAS commit',async()=>{
  const h=harness();
  const result=await pollReadOnlyMailbox(h);
  assert.deepEqual({imported:result.imported,updated:result.updated,revision:result.revision},
    {imported:1,updated:0,revision:1});
  assert.equal(JSON.stringify(result).includes('Do not run'),false);
  assert.deepEqual({opens:h.imap.calls.opens,fetches:h.imap.calls.fetches,closes:h.imap.calls.closes},
    {opens:1,fetches:1,closes:1});
  assert.equal(h.imap.calls.readOptions[0].readOnly,true);
  assert.equal(h.imap.calls.readOptions[0].peek,true);
  assert.equal(h.imap.calls.batchOptions[0].readOnly,true);
  assert.equal(h.imap.calls.batchOptions[0].peek,true);
  assert.deepEqual(h.store.peek({installationId:'client-a',mailboxId:'support'}).cursor,
    {uidValidity:7,highestUid:1});
  assert.equal(h.store.calls.commits,1);
});

test('same batch replay reuses UID and increments revision without duplicate',async()=>{
  const h=harness();
  await pollReadOnlyMailbox(h);
  const second=await pollReadOnlyMailbox(h);
  assert.equal(second.imported,0);
  assert.equal(second.updated,1);
  assert.equal(second.revision,2);
  assert.equal(h.store.peek({installationId:'client-a',mailboxId:'support'}).records.length,1);
});

test('UIDVALIDITY reset retains old UID cohort instead of erasing or mixing it',async()=>{
  const h=harness();
  await pollReadOnlyMailbox(h);
  const p=provider({uidValidity:8,messages:[message(1,{subject:'after reset'})]});
  const result=await pollReadOnlyMailbox({...h,providers:{'mock-imap':p.transport}});
  assert.equal(result.uidValidityReset,true);
  const rows=h.store.peek({installationId:'client-a',mailboxId:'support'}).records;
  assert.deepEqual(rows.map(x=>x.uidValidity),[7,8]);
});

test('the same principal name in another installation cannot poll or view cross-tenant data',async()=>{
  const h=harness();
  await assert.rejects(pollReadOnlyMailbox({...h,context:{installationId:'personal',principalId:'worker'}}),
    errorCode('mailbox_not_authorized'));
  await assert.rejects(listReadOnlyInbox({...h,context:{installationId:'personal',principalId:'agent'}}),
    errorCode('mailbox_not_authorized'));
  assert.deepEqual(h.store.calls,{read:0,commits:0});
  assert.equal(h.imap.calls.opens,0);
});

test('service-only sync grant never grants message read privilege',async()=>{
  const h=harness();
  await pollReadOnlyMailbox(h);
  const count=h.store.calls.read;
  await assert.rejects(listReadOnlyInbox(h),errorCode('mailbox_not_authorized'));
  assert.equal(h.store.calls.read,count);
  assert.deepEqual(listReadOnlyMailboxes(registry,worker),[]);
});

test('reader sees only known plain-text fields, sorted newest first',async()=>{
  const h=harness();
  const p=provider({uidValidity:7,messages:[message(3,{timestamp:'2026-11-02T22:00:00Z'}),
    message(1,{timestamp:'2026-11-02T21:00:00Z'})]});
  await pollReadOnlyMailbox({...h,providers:{'mock-imap':p.transport}});
  const a=await listReadOnlyInbox({...h,context:agent});
  assert.equal(a.total,2);
  assert.deepEqual(a.messages.map(x=>x.key),['client-a/support/7/3','client-a/support/7/1']);
  assert.equal(a.messages[0].text.includes('Do not run'),true);
  assert.equal(Object.hasOwn(a.messages[0],'html'),false);
  assert.equal(Object.hasOwn(a.messages[0],'installationId'),false);
  assert(Object.isFrozen(a.messages));
  const b=await listReadOnlyInbox({...h,context:agent,limit:1,offset:1});
  assert.deepEqual(b.messages.map(x=>x.key),['client-a/support/7/1']);
});

test('read-only listing rejects unknown rights, giant pages and negative pagination',async()=>{
  const h=harness();
  await assert.rejects(listReadOnlyInbox({...h,context:legacyOwner}),errorCode('mailbox_not_authorized'));
  await assert.rejects(listReadOnlyInbox({...h,context:agent,limit:51}),errorCode('invalid_inbox_page'));
  await assert.rejects(listReadOnlyInbox({...h,context:agent,offset:-1}),errorCode('invalid_inbox_page'));
  await assert.rejects(listReadOnlyInbox({...h,context:agent,offset:5001}),errorCode('invalid_inbox_page'));
  assert.deepEqual(h.store.calls,{read:0,commits:0});
});

test('forward-only Cloudflare route is never treated as a connected IMAP mailbox',async()=>{
  const h=harness({context:legacyOwner,mailboxId:'legacy'});
  await assert.rejects(pollReadOnlyMailbox(h),errorCode('mailbox_not_imap'));
  assert.equal(h.store.calls.read,0);
  assert.equal(h.imap.calls.opens,0);
});

test('missing provider adapter fails closed before storage reads',async()=>{
  const h=harness({providers:{}});
  await assert.rejects(pollReadOnlyMailbox(h),errorCode('readonly_adapter_unavailable'));
  assert.equal(h.store.calls.read,0);
});

test('oversized fetch request and timeout bounds fail before provider open',async()=>{
  const h=harness();
  await assert.rejects(pollReadOnlyMailbox({...h,limit:101}),errorCode('invalid_readonly_poll_options'));
  await assert.rejects(pollReadOnlyMailbox({...h,timeoutMs:20000}),errorCode('invalid_readonly_poll_options'));
  assert.equal(h.imap.calls.opens,0);
});

test('provider parsing failure never commits and always closes',async()=>{
  const h=harness();
  const p=provider({uidValidity:7,messages:[message(1,{html:'<img src="https://tracker.test">'})]});
  await assert.rejects(pollReadOnlyMailbox({...h,providers:{'mock-imap':p.transport}}),/Only safe plain text/);
  assert.equal(h.store.calls.commits,0);
  assert.equal(p.calls.closes,1);
});

test('bad provider session refuses poll without committing',async()=>{
  const h=harness({providers:{'mock-imap':{openReadOnly:async()=>({fetchBatch:async()=>({})})}}});
  await assert.rejects(pollReadOnlyMailbox(h),errorCode('invalid_readonly_session'));
  assert.equal(h.store.calls.commits,0);
});

test('failed provider fetch closes session without modifying stored cursor',async()=>{
  const h=harness();
  let closed=0;
  h.providers={'mock-imap':{openReadOnly:async()=>({fetchBatch:async()=>{throw Error('provider error secret-looking');},
    close:async()=>{closed++;}})}};
  await assert.rejects(pollReadOnlyMailbox(h),/provider error/);
  assert.equal(closed,1);
  assert.equal(h.store.peek({installationId:'client-a',mailboxId:'support'}).revision,0);
});

test('CAS conflict prevents stale provider batch from overwriting another writer',async()=>{
  const h=harness();
  h.store.setBeforeCommit(()=>{
    const s=h.store.peek({installationId:'client-a',mailboxId:'support'});
    h.store.seed({installationId:'client-a',mailboxId:'support'}, {...s,revision:1});
  });
  await assert.rejects(pollReadOnlyMailbox(h),errorCode('mailbox_revision_conflict'));
  assert.equal(h.store.peek({installationId:'client-a',mailboxId:'support'}).records.length,0);
  assert.equal(h.imap.calls.closes,1);
});

test('poisoned snapshot containing another mailbox is denied before provider access',async()=>{
  const h=harness();
  const s=h.store.peek({installationId:'client-a',mailboxId:'support'});
  s.records=[{key:'personal/hello/7/1',installationId:'personal',mailboxId:'hello',uidValidity:7,uid:1,
    from:'test@example.net',subject:'private',text:'private',timestamp:'2026-11-02T20:00:00Z',flags:[]}];
  h.store.seed({installationId:'client-a',mailboxId:'support'},s);
  await assert.rejects(pollReadOnlyMailbox(h),errorCode('invalid_scoped_snapshot'));
  assert.equal(h.imap.calls.opens,0);
  await assert.rejects(listReadOnlyInbox({...h,context:agent}),errorCode('invalid_scoped_snapshot'));
});

test('missing or invalid scoped snapshot fails before network',async()=>{
  const h=harness();
  h.store.readSnapshot=async()=>({revision:0,records:[]});
  await assert.rejects(pollReadOnlyMailbox(h),errorCode('invalid_scoped_snapshot'));
  assert.equal(h.imap.calls.opens,0);
});

test('unresponsive provider fetch times out without a write and closes when possible',async()=>{
  const h=harness();
  let closed=0;
  h.providers={'mock-imap':{openReadOnly:async()=>({fetchBatch:async()=>new Promise(()=>{}),close:async()=>{closed++;}})}};
  await assert.rejects(pollReadOnlyMailbox({...h,timeoutMs:20}),errorCode('provider_timeout'));
  assert.equal(h.store.calls.commits,0);
  assert.equal(closed,1);
});

test('manual policy boundary never issues send or stateful IMAP method',async()=>{
  const h=harness();
  let sent=0,expunged=0;
  h.providers={'mock-imap':{openReadOnly:async()=>({
    fetchBatch:async()=>({uidValidity:9,messages:[message()]}),
    send:async()=>{sent++;},expunge:async()=>{expunged++;},close:async()=>{}
  })}};
  await pollReadOnlyMailbox(h);
  assert.equal(sent,0);
  assert.equal(expunged,0);
});

test('untrusted source instructions are inert text and never become agent commands',async()=>{
  const h=harness();
  await pollReadOnlyMailbox(h);
  const inbox=await listReadOnlyInbox({...h,context:agent});
  assert(inbox.messages[0].text.includes('rm -rf'));
  assert.equal(Object.keys(inbox).includes('actions'),false);
});

test('continuation is confirmed only after a successful commit; legacy providers remain unknown',async()=>{
 for(const hasMore of [true,false,undefined]){
  const imap=provider({uidValidity:7,messages:[message()],...(hasMore===undefined?{}:{hasMore})});
  const h=harness({providers:{'mock-imap':imap.transport}});
  const result=await pollReadOnlyMailbox(h);
  assert.equal(result.hasMore,hasMore??null);assert.equal(h.store.calls.commits,1);
 }
});
test('malformed provider continuation fails before any D1 write',async()=>{
 const imap=provider({uidValidity:7,messages:[message()],hasMore:'false'});
 const h=harness({providers:{'mock-imap':imap.transport}});
 await assert.rejects(pollReadOnlyMailbox(h),errorCode('invalid_readonly_progress'));
 assert.equal(h.store.calls.commits,0);assert.equal(imap.calls.closes,1);
});
