import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailRegistry, accessibleMailboxes, hasMailPermission, evaluateFromIdentity,
  reconcileImapBatch} from '../src/communications/mail-core.mjs';

const configuration = () => ({
  installations: [{id:'personal',domain:'devonakins.com'}, {id:'anevum',domain:'anevum.com'},
    {id:'client-example',domain:'example.org'}],
  mailboxes: [
    {id:'personal-hello',installationId:'personal',address:'hello@devonakins.com',provider:'purelymail',mode:'imap'},
    {id:'anevum-legacy',installationId:'anevum',address:'devon@anevum.com',provider:'cloudflare-routing',mode:'forward-only'},
    {id:'client-support',installationId:'client-example',address:'support@example.org',provider:'mock-imap',mode:'imap',sendVerified:true},
  ],
  identities: [
    {address:'hello@devonakins.com',mailboxId:'personal-hello',kind:'primary'},
    {address:'devon@anevum.com',mailboxId:'anevum-legacy',kind:'primary'},
    {address:'support@example.org',mailboxId:'client-support',kind:'primary',sendVerified:true},
    {address:'help@example.org',mailboxId:'client-support',kind:'alias'},
  ],
  grants: [
    {installationId:'personal',principalId:'devon',mailboxId:'personal-hello',capabilities:['read','draft','send','sync']},
    {installationId:'anevum',principalId:'devon',mailboxId:'anevum-legacy',capabilities:['read']},
    {installationId:'client-example',principalId:'support-agent',mailboxId:'client-support',capabilities:['read','draft']},
    {installationId:'client-example',principalId:'mail-service',mailboxId:'client-support',capabilities:['sync']},
    {installationId:'client-example',principalId:'supervisor',mailboxId:'client-support',capabilities:['read','send']},
  ],
});
const reg = createMailRegistry(configuration());
const personal = {installationId:'personal',principalId:'devon'};
const anevum = {installationId:'anevum',principalId:'devon'};
const service = {installationId:'client-example',principalId:'mail-service'};
const agent = {installationId:'client-example',principalId:'support-agent'};
const supervisor = {installationId:'client-example',principalId:'supervisor'};
const entry = (uid, overrides={}) => ({uid,from:'sender@external.org',subject:'Hello',text:'Message body',
  timestamp:'2026-11-02T20:00:00Z',flags:[],...overrides});
const sync = (overrides={}) => ({registry:reg,context:service,mailboxId:'client-support',
  batch:{uidValidity:101,messages:[entry(1)]},...overrides});

test('mailbox list honors BOTH legal installation and explicit read grants',()=>{
  assert.deepEqual(accessibleMailboxes(reg,personal).map(x=>x.address),['hello@devonakins.com']);
  assert.deepEqual(accessibleMailboxes(reg,anevum).map(x=>x.address),['devon@anevum.com']);
  assert.deepEqual(accessibleMailboxes(reg,agent).map(x=>x.address),['support@example.org']);
  assert.deepEqual(accessibleMailboxes(reg,service),[]);
  assert.equal(accessibleMailboxes(reg,anevum)[0].connectionStatus,'external-forwarding');
});
test('same human identifier in different installations cannot cross-read',()=>{
  assert.equal(hasMailPermission(reg,anevum,'personal-hello','read'),false);
  assert.equal(hasMailPermission(reg,personal,'anevum-legacy','read'),false);
  assert.equal(hasMailPermission(reg,{installationId:'client-example',principalId:'devon'},'client-support','read'),false);
});
test('role rights are explicit, not implied by UI or read access',()=>{
  assert.equal(hasMailPermission(reg,agent,'client-support','draft'),true);
  assert.equal(hasMailPermission(reg,agent,'client-support','send'),false);
  assert.equal(hasMailPermission(reg,supervisor,'client-support','send'),true);
  assert.equal(hasMailPermission(reg,supervisor,'client-support','sync'),false);
  assert.throws(()=>hasMailPermission(reg,personal,'personal-hello','admin'),/Unknown capability/);
});
test('forward-only and unverified providers never enable send',()=>{
  assert.equal(evaluateFromIdentity(reg,personal,'personal-hello','hello@devonakins.com').allowed,false);
  assert.equal(evaluateFromIdentity(reg,anevum,'anevum-legacy','devon@anevum.com').allowed,false);
  assert.equal(evaluateFromIdentity(reg,supervisor,'client-support','support@example.org').allowed,true);
  assert.equal(evaluateFromIdentity(reg,supervisor,'client-support','help@example.org').allowed,false);
  assert.equal(evaluateFromIdentity(reg,agent,'client-support','support@example.org').allowed,false);
});
test('registry rejects cross-installation identity spoofing, invalid grants, duplicate addresses',()=>{
  let v=configuration();v.identities[3].address='help@anevum.com';
  assert.throws(()=>createMailRegistry(v),/installation domain/);
  v=configuration();v.grants[0].installationId='anevum';
  assert.throws(()=>createMailRegistry(v),/Invalid mailbox grant/);
  v=configuration();v.identities.push({...v.identities[2]});
  assert.throws(()=>createMailRegistry(v),/Duplicate from identity/);
  v=configuration();v.mailboxes[1].sendVerified=true;
  assert.throws(()=>createMailRegistry(v),/Forward-only/);
  v=configuration();v.mailboxes[2].address='support@devonakins.com';
  assert.throws(()=>createMailRegistry(v),/Mailbox domain/);
});
test('registry is immutable and never has secrets or app passwords',()=>{
  assert(Object.isFrozen(reg));
  assert(Object.isFrozen(reg.grants[0].capabilities));
  assert.equal(JSON.stringify(reg).includes('password'),false);
  assert.throws(()=>reg.grants[0].capabilities.push('send'),TypeError);
});
test('synthetic provider batch creates cursor and text-only message records',()=>{
  const result=reconcileImapBatch(sync());
  assert.equal(result.imported,1);assert.equal(result.updated,0);assert.equal(result.uidValidityReset,false);
  assert.deepEqual(result.cursor,{uidValidity:101,highestUid:1});
  assert.equal(result.records[0].key,'client-example/client-support/101/1');
  assert.equal(result.records[0].text,'Message body');
});
test('duplicate/replayed provider polls are idempotent and flags refresh',()=>{
  const first=reconcileImapBatch(sync());
  const again=reconcileImapBatch(sync({existing:first.records,cursor:first.cursor}));
  assert.equal(again.imported,0);assert.equal(again.updated,1);assert.equal(again.records.length,1);
  const flags=reconcileImapBatch(sync({existing:again.records,cursor:again.cursor,
    batch:{uidValidity:101,messages:[entry(1,{flags:['seen']})]}}));
  assert.deepEqual(flags.records[0].flags,['seen']);
});
test('UIDVALIDITY reset preserves old cohort and resynchronizes new provider UID 1',()=>{
  const first=reconcileImapBatch(sync());
  const next=reconcileImapBatch(sync({existing:first.records,cursor:first.cursor,
    batch:{uidValidity:202,messages:[entry(1,{subject:'New UID cohort'})]}}));
  assert.equal(next.uidValidityReset,true);assert.equal(next.imported,1);
  assert.equal(next.records.length,2);assert.equal(next.cursor.highestUid,1);
  assert.deepEqual(next.records.map(x=>x.uidValidity),[101,202]);
});
test('batch cursors never move backwards within a UIDVALIDITY cohort',()=>{
  const old=reconcileImapBatch(sync({batch:{uidValidity:101,messages:[entry(7)]}}));
  const next=reconcileImapBatch(sync({cursor:old.cursor,existing:old.records,
    batch:{uidValidity:101,messages:[entry(3)]}}));
  assert.equal(next.cursor.highestUid,7);
  assert.equal(next.records.length,2);
});
test('no sync grant, other installation, and forward-only mail all fail closed',()=>{
  assert.throws(()=>reconcileImapBatch(sync({context:agent})),/not authorized/);
  assert.throws(()=>reconcileImapBatch(sync({context:personal})),/not authorized/);
  assert.throws(()=>reconcileImapBatch(sync({context:anevum,mailboxId:'anevum-legacy'})),/not authorized/);
  assert.throws(()=>reconcileImapBatch(sync({context:{installationId:'client-example',principalId:'devon'}})),/not authorized/);
});
test('never mix an existing record from another installation or mailbox',()=>{
  const existing=reconcileImapBatch(sync()).records;
  assert.throws(()=>reconcileImapBatch(sync({existing:[{...existing[0],installationId:'personal'}]})),/isolation/);
  assert.throws(()=>reconcileImapBatch(sync({existing:[{...existing[0],mailboxId:'other'}]})),/isolation/);
  assert.throws(()=>reconcileImapBatch(sync({existing:[{...existing[0],key:'spoofed'}]})),/isolation/);
});
test('reject malicious/oversize provider input without returning partial state',()=>{
  assert.throws(()=>reconcileImapBatch(sync({batch:{uidValidity:101,messages:[entry(1),entry(1)]}})),/Duplicate UID/);
  assert.throws(()=>reconcileImapBatch(sync({batch:{uidValidity:0,messages:[entry(1)]}})),/UIDVALIDITY/);
  assert.throws(()=>reconcileImapBatch(sync({batch:{uidValidity:101,messages:[entry(-1)]}})),/UID/);
  assert.throws(()=>reconcileImapBatch(sync({batch:{uidValidity:101,messages:[entry(1,{html:'<img src="//spy">'})]}})),/plain text/);
  assert.throws(()=>reconcileImapBatch(sync({batch:{uidValidity:101,messages:[entry(1,{raw:'MIME'})]}})),/plain text/);
  assert.throws(()=>reconcileImapBatch(sync({batch:{uidValidity:101,messages:[entry(1,{from:'x@anevum.com\r\nBcc:evil@test.com'})]}})),/email address/);
  assert.throws(()=>reconcileImapBatch(sync({batch:{uidValidity:101,messages:Array.from({length:101},(_,i)=>entry(i+1))}})),/oversized/);
  assert.throws(()=>reconcileImapBatch(sync({cursor:{uidValidity:101,highestUid:-1}})),/highest UID/);
});
test('unsafe control characters stripped and body truncated; no HTML representation',()=>{
  const huge='A'.repeat(5000)+'\u202e';
  const item=reconcileImapBatch(sync({batch:{uidValidity:101,messages:[entry(1,
    {subject:'Trust\u202eme',text:huge})]}})).records[0];
  assert.equal(item.subject,'Trustme');
  assert.equal(item.text.length,4096);
  assert.equal(Object.hasOwn(item,'html'),false);
});

test('trusted scan watermark advances atomically with messages and rejects rollback/overflow',()=>{
 const initial=reconcileImapBatch(sync({batch:{uidValidity:101,messages:[],scannedThrough:4096}}));
 assert.deepEqual(initial.cursor,{uidValidity:101,highestUid:4096});assert.deepEqual(initial.records,[]);
 for(const scannedThrough of [4095,-1,4294967296,NaN,'5000'])
  assert.throws(()=>reconcileImapBatch(sync({cursor:initial.cursor,batch:{uidValidity:101,messages:[],scannedThrough}})),/scan watermark/);
 assert.throws(()=>reconcileImapBatch(sync({batch:{uidValidity:101,messages:[entry(5)],scannedThrough:4}})),/scan watermark/);
 const reset=reconcileImapBatch(sync({cursor:initial.cursor,batch:{uidValidity:202,messages:[],scannedThrough:256}}));
 assert.equal(reset.uidValidityReset,true);assert.equal(reset.cursor.highestUid,256);
});


test('incoming sender case/dot-atoms are preserved without expanding authenticated identities or grants',()=>{
 for(const from of ['Case.Sensitive@Example.ORG','_newsletter+tag@EXAMPLE.org','9sender@example.net']){
  const result=reconcileImapBatch(sync({batch:{uidValidity:101,messages:[entry(1,{from})]}}));
  assert.equal(result.records[0].from,from);assert.equal(result.imported,1);
 }
 for(const from of ['.leading@example.org','trailing.@example.org','double..dot@example.org','two@@example.org','x@-bad.example','x@example..org','x@example.org\r\nBcc: evil@example.org','x<bad>@example.org'])
  assert.throws(()=>reconcileImapBatch(sync({batch:{uidValidity:101,messages:[entry(1,{from})]}})),{code:'mail_sender_address_invalid'});
 const altered=configuration();altered.mailboxes[2].address='Support@example.org';
 assert.throws(()=>createMailRegistry(altered),/Invalid email address/);
 assert.equal(evaluateFromIdentity(reg,supervisor,'client-support','Support@example.org').allowed,false);
 assert.equal(hasMailPermission(reg,agent,'client-support','sync'),false);
});
