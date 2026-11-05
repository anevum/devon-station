import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createMailPayloadCipher} from '../src/communications/mail-payload-crypto.mjs';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
import {createD1Outbox} from '../src/communications/mail-outbox.mjs';
import {handleMailOutboxApi} from '../worker/mail-outbox-api.mjs';

const owner={installationId:'personal',mailboxId:'hello',ownerSub:'synthetic-owner'};
const peer={...owner,ownerSub:'synthetic-peer'};
const draftId='a0000000-0000-4000-8000-000000000001';
const deliveryId='a0000000-0000-4000-8000-000000000002';
const claimId='a0000000-0000-4000-8000-000000000003';
const from='hello@devonakins.com';
const sample={to:['recipient@example.test'],
 subject:'<script>plain text</script>',body:'Line one\n<img src="https://tracking.example.test">'};
const key='AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const migration=name=>readFileSync(new URL('../worker/migrations/'+name,import.meta.url),'utf8');

function fixture(t,{migrate=true}={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const name of ['0005-comms-drafts.sql','0006-comms-outbox.sql',
  '0007-comms-draft-outbox-lineage.sql','0008-comms-one-delivery-per-draft.sql'])
  sqlite.exec(migration(name));
 if(migrate)sqlite.exec(migration('0009-comms-sent-archive.sql'));
 const db={prepare(sql){return {bind(...args){
  const statement=sqlite.prepare(sql);
  return {async first(){return statement.get(...args)??null},
   async all(){return {success:true,results:statement.all(...args)}},
   async run(){const result=statement.run(...args);return {success:true,meta:{changes:result.changes}}}};
 },async first(){return sqlite.prepare(sql).get()??null}};}};
 const cipher=createMailPayloadCipher({activeKeyId:'one',keys:{one:key}});
 let clock='2026-01-01T00:00:00.000Z';
 const drafts=createD1DraftStore(db,{cipher,now:()=>clock});
 const outbox=createD1Outbox(db,owner,{cipher,now:()=>clock});
 const other=createD1Outbox(db,peer,{cipher,now:()=>clock});
 const seed=async()=>{
  await drafts.create(owner,draftId);
  await drafts.save(owner,{id:draftId,revision:1,operationId:claimId,...sample});
  return outbox.offerLinkedDraft(deliveryId,{draftId,draftRevision:2,
   payload:{from,draft:sample,date:clock}});
 };
 const accept=async()=>{await outbox.claim(deliveryId,claimId);return outbox.finish(deliveryId,claimId,'accepted');};
 return {sqlite,db,cipher,drafts,outbox,other,seed,accept,
  setClock:value=>{clock=value;},migrate:()=>sqlite.exec(migration('0009-comms-sent-archive.sql'))};
}

test('accepted linked draft is captured atomically as AES-GCM ciphertext; draft deletion and payload retention do not erase Sent archive',async t=>{
 const f=fixture(t);await f.seed();
 assert.deepEqual(await f.outbox.listArchived(),{entries:[],hasMore:false});
 await f.outbox.claim(deliveryId,claimId);
 assert.equal((await f.outbox.listArchived()).entries.length,0,'claimed is not sent');
 await f.outbox.finish(deliveryId,claimId,'accepted');
 const rows=f.sqlite.prepare('SELECT * FROM comms_sent_archive').all();
 assert.equal(rows.length,1);
 assert(!rows[0].payload_json.includes(sample.body));
 assert.equal(JSON.parse(rows[0].payload_json).alg,'A256GCM');
 assert.equal(rows[0].payload_json,f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json);
 const archived=await f.outbox.readArchived(deliveryId);
 assert.deepEqual({to:archived.to,subject:archived.subject,body:archived.body},sample);
 assert.equal(archived.messageId,'<'+deliveryId+'@devonakins.com>');
 assert.equal(archived.recipientDeliveryConfirmed,false);
 assert.equal(archived.providerCopyConfirmed,false);
 const list=await f.outbox.listArchived();
 assert.deepEqual(list.entries.map(x=>x.deliveryId),[deliveryId]);
 assert.equal(list.hasMore,false);
 assert(!JSON.stringify(list).includes(sample.subject),'listing must not disclose subject');
 assert(!JSON.stringify(list).includes(sample.body),'listing must not disclose body');
 const locked=createD1DraftStore(f.db,{cipher:f.cipher,protectPendingOutbox:true});
 assert.deepEqual(await locked.remove(owner,{id:draftId,revision:2}),{deleted:true});
 assert.equal(await f.drafts.read(owner,draftId),null);
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
 f.setClock('2026-03-10T00:00:00.000Z');
 assert.deepEqual(await f.outbox.expireTerminalPayloads({before:'2026-02-05T00:00:00.000Z'}),{expired:1});
 assert.equal((await f.outbox.read(deliveryId)).payload,null);
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
});

test('source-only migration backfills previously accepted encrypted snapshots once and ignores nonaccepted rows',async t=>{
 const f=fixture(t,{migrate:false});await f.seed();await f.accept();
 f.migrate();f.migrate();
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM comms_sent_archive').get().n,1);
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM comms_outbox').get().n,1);
});

test('uncertain SMTP attempt remains nonarchived and nonretryable; owner scopes cannot see each other',async t=>{
 const f=fixture(t);await f.seed();
 assert.equal(await f.outbox.readArchived(deliveryId),null);
 await f.outbox.claim(deliveryId,claimId);
 await f.outbox.finish(deliveryId,claimId,'uncertain');
 assert.deepEqual(await f.outbox.listArchived(),{entries:[],hasMore:false});
 await assert.rejects(f.outbox.finish(deliveryId,claimId,'accepted'),error=>error?.code==='outbox_transition_conflict');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM comms_sent_archive').get().n,0);
 await assert.rejects(f.outbox.readArchived('not-an-id'),error=>error?.code==='outbox_invalid_id');
 const source=f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json;
 f.sqlite.prepare('INSERT INTO comms_sent_archive (installation_id,mailbox_id,owner_sub,delivery_id,draft_id,draft_revision,payload_json,accepted_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(owner.installationId,owner.mailboxId,peer.ownerSub,deliveryId,draftId,2,source,'2026-01-01T00:00:00Z');
 assert.equal((await f.outbox.listArchived()).entries.length,0);
 await assert.rejects(f.other.readArchived(deliveryId),error=>error?.code==='outbox_archive_unavailable');
});

test('archive constraint failure rolls back accepted-state write without authorizing an SMTP retry',async t=>{
 const f=fixture(t);await f.seed();await f.outbox.claim(deliveryId,claimId);
 const source=f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json;
 f.sqlite.prepare('INSERT INTO comms_sent_archive (installation_id,mailbox_id,owner_sub,delivery_id,draft_id,draft_revision,payload_json,accepted_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(owner.installationId,owner.mailboxId,owner.ownerSub,deliveryId,draftId,2,source,'2026-01-01T00:00:00Z');
 await assert.rejects(f.outbox.finish(deliveryId,claimId,'accepted'));
 assert.equal(f.sqlite.prepare('SELECT state FROM comms_outbox').get().state,'claimed');
 assert.equal(await f.outbox.claim(deliveryId,claimId),null,'delivery cannot be re-claimed or resent');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM comms_sent_archive').get().n,1);
});

test('signed owner archive endpoints read the snapshot without provider I/O, reject invalid requests and remain closed before migration',async t=>{
 const f=fixture(t);await f.seed();await f.accept();
 const env={MAIL_OWNER_SUB:owner.ownerSub,MAIL_OUTBOX_ENABLED:'true',MAIL_DB:f.db,
  MAIL_PAYLOAD_KEY_ID:'one',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({one:key}),
  MAIL_SEND_ENABLED:'false',MAIL_SENDER_VERIFIED:'false'};
 const url=new URL('https://station.example/api/mail/outbox/archive/view');
 const request=new Request(url,{method:'POST'});
 let remoteCalls=0;
 const args={url,request,env,user:{subject:owner.ownerSub},
  readBody:async()=>({deliveryId}),connect:()=>{remoteCalls++;throw Error('provider access forbidden');},registry:{}};
 assert.deepEqual(await handleMailOutboxApi({...args,user:{subject:peer.ownerSub}}),
  {status:403,body:{error:'mail_owner_not_authorized'}});
 const result=await handleMailOutboxApi(args);
 assert.equal(result.status,200);assert.equal(result.body.archive.body,sample.body);
 assert.equal(result.body.archive.providerCopyConfirmed,false);
 assert.equal(result.body.archive.recipientDeliveryConfirmed,false);
 assert.equal(remoteCalls,0);
 assert.deepEqual(await handleMailOutboxApi({...args,readBody:async()=>({deliveryId,extra:true})}),
  {status:400,body:{error:'invalid_mail_archive_request'}});
 assert.deepEqual(await handleMailOutboxApi({...args,readBody:async()=>({deliveryId:'invalid'})}),
  {status:400,body:{error:'invalid_mail_archive_request'}});
 const listUrl=new URL('https://station.example/api/mail/outbox/archive');
 const listing=await handleMailOutboxApi({...args,url:listUrl,request:new Request(listUrl)});
 assert.equal(listing.status,200);assert.deepEqual(listing.body.entries.map(x=>x.deliveryId),[deliveryId]);
 assert.equal(listing.body.providerIndependent,true);
 assert.equal(remoteCalls,0);
 const other=fixture(t,{migrate:false});
 const missed=await handleMailOutboxApi({...args,env:{...env,MAIL_DB:other.db},url:listUrl,request:new Request(listUrl)});
 assert.deepEqual(missed,{status:503,body:{error:'mail_sent_archive_unavailable'}});
});
