import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
import {handleMailDraftApi} from '../worker/mail-drafts-api.mjs';
const S={installationId:'personal',mailboxId:'hello',ownerSub:'signed-owner'};
const O={...S,ownerSub:'another-owner'};
const D='d1111111-1111-4111-8111-111111111111',OP='a1111111-1111-4111-8111-111111111111';
const L='f1111111-1111-4111-8111-111111111111';
function setup(t,{outbox=true}={}){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 const names=outbox?['0005-comms-drafts.sql','0006-comms-outbox.sql','0007-comms-draft-outbox-lineage.sql','0008-comms-one-delivery-per-draft.sql']:['0005-comms-drafts.sql'];
 for(const n of names)sql.exec(readFileSync(new URL('../worker/migrations/'+n,import.meta.url),'utf8'));
 const d1={prepare(query){return {
  bind(...args){return {async first(){return sql.prepare(query).get(...args)??null},async run(){const r=sql.prepare(query).run(...args);return {success:true,meta:{changes:r.changes}}},async all(){return {success:true,results:sql.prepare(query).all(...args)}}}},
  async first(){return sql.prepare(query).get()??null},
  async run(){const r=sql.prepare(query).run();return {success:true,meta:{changes:r.changes}}}
 }}};
 const store=createD1DraftStore(d1);
 const env={MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}),MAIL_DRAFTS_ENABLED:'true',MAIL_OUTBOX_ENABLED:'false',MAIL_SEND_ENABLED:'false',MAIL_OWNER_SUB:S.ownerSub,MAIL_DB:d1};
 async function del(user=S.ownerSub,revision=2){return handleMailDraftApi({request:{method:'POST'},url:new URL('https://station.test/api/mail/drafts/delete'),user:{subject:user},env,readBody:async()=>({id:D,revision})})}
 return {sql,d1,store,env,del};
}
async function seed(f){await f.store.create(S,D);await f.store.save(S,{id:D,revision:1,operationId:OP,to:['a@example.test'],subject:'s',body:'b'});}
function delivery(f,state,owner=S.ownerSub){f.sql.prepare('INSERT INTO comms_outbox(installation_id,mailbox_id,owner_sub,delivery_id,payload_json,state,claim_id,created_at,updated_at,draft_id,draft_revision) VALUES (?,?,?,?,?,?,NULL,?,?,?,?)').run('personal','hello',owner,L,'{}',state,'2026-11-03','2026-11-03',D,2);}
for(const state of ['queued','claimed','uncertain'])test(`pending ${state} blocks owner delete when send disabled`,async t=>{
 const f=setup(t);await seed(f);delivery(f,state);
 assert.deepEqual(await f.del(),{status:409,body:{error:'mail_draft_pending_delivery'}});
 assert.equal((await f.store.read(S,D)).revision,2);
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM comms_outbox').get().n,1);
});
test('accepted/failed/rejected receipt permits deletion but keeps tombstone',async t=>{
 for(const state of ['accepted','rejected','failed']){
  await t.test(state,async inner=>{const f=setup(inner);await seed(f);delivery(f,state);assert.deepEqual(await f.del(),{status:200,body:{deleted:true}});assert.equal(await f.store.read(S,D),null);assert.equal(f.sql.prepare('SELECT state FROM comms_outbox').get().state,state);});
 }
});
test('owner identity boundary precedes DB query',async t=>{const f=setup(t);await seed(f);delivery(f,'queued');assert.deepEqual(await f.del(O.ownerSub),{status:403,body:{error:'mail_owner_not_authorized'}});assert.equal((await f.store.read(S,D)).revision,2);});
test('stale revision returns conflict rather than pending delivery status',async t=>{const f=setup(t);await seed(f);delivery(f,'queued');assert.deepEqual(await f.del(S.ownerSub,1),{status:409,body:{error:'mail_draft_conflict'}});});
test('other owner can delete identical draft ID',async t=>{const f=setup(t);await seed(f);await f.store.create(O,D);delivery(f,'claimed');const guard=createD1DraftStore(f.d1,{protectPendingOutbox:true});assert.deepEqual(await guard.remove(O,{id:D,revision:1}),{deleted:true});assert.equal((await f.store.read(S,D)).revision,2);});
test('draft-only schema retains deletion API',async t=>{const f=setup(t,{outbox:false});await seed(f);assert.deepEqual(await f.del(),{status:200,body:{deleted:true}});});
test('DB catalog read errors fail closed without deletion',async t=>{const f=setup(t);await seed(f);const faulty={prepare(q){if(q.includes('sqlite_master'))throw Error('Simulated D1 outage');return f.d1.prepare(q)}};const result=await handleMailDraftApi({request:{method:'POST'},url:new URL('https://station.test/api/mail/drafts/delete'),user:{subject:S.ownerSub},env:{...f.env,MAIL_DB:faulty},readBody:async()=>({id:D,revision:2})});assert.deepEqual(result,{status:502,body:{error:'mail_draft_storage_failed'}});assert.equal((await f.store.read(S,D)).revision,2);});
