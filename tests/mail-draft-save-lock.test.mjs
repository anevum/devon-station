import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {mailPayloadCipherFromEnv} from '../src/communications/mail-payload-crypto.mjs';
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
 const env={MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}),MAIL_DRAFTS_ENABLED:'true',MAIL_OUTBOX_ENABLED:'false',MAIL_SEND_ENABLED:'false',MAIL_OWNER_SUB:S.ownerSub,MAIL_DB:d1};
 const store=createD1DraftStore(d1,{cipher:mailPayloadCipherFromEnv(env)});
 async function del(user=S.ownerSub,revision=2){return handleMailDraftApi({request:{method:'POST'},url:new URL('https://station.test/api/mail/drafts/delete'),user:{subject:user},env,readBody:async()=>({id:D,revision})})}
 return {sql,d1,store,env,del};
}
async function seed(f){await f.store.create(S,D);await f.store.save(S,{id:D,revision:1,operationId:OP,to:['a@example.test'],subject:'s',body:'b'});}
function delivery(f,state,owner=S.ownerSub){f.sql.prepare('INSERT INTO comms_outbox(installation_id,mailbox_id,owner_sub,delivery_id,payload_json,state,claim_id,created_at,updated_at,draft_id,draft_revision) VALUES (?,?,?,?,?,?,NULL,?,?,?,?)').run('personal','hello',owner,L,'{}',state,'2026-11-03','2026-11-03',D,2);}
const NEW='b1111111-1111-4111-8111-111111111111';
async function save(f,{user=S.ownerSub,revision=2,operationId=NEW,subject='Changed',body='Different'}={}){
 const env={...f.env,MAIL_OWNER_SUB:user};
 return handleMailDraftApi({request:{method:'POST'},url:new URL('https://station.test/api/mail/drafts/save'),user:{subject:user},env,
  readBody:async()=>({id:D,revision,operationId,to:['a@example.test'],subject,body})});
}
for(const state of ['queued','claimed','uncertain','accepted','rejected','failed'])test('existing '+state+' delivery prevents subsequent save even when send disabled',async t=>{
 const f=setup(t);await seed(f);delivery(f,state);
 const result=await save(f);
 assert.deepEqual(result,{status:409,body:{error:'mail_draft_delivery_locked'}});
 const original=await f.store.read(S,D);
 assert.equal(original.revision,2);assert.equal(original.subject,'s');assert.equal(original.body,'b');
 assert.equal(f.sql.prepare('SELECT state FROM comms_outbox').get().state,state);
});
test('same previous save operation can replay without mutating linked immutable snapshot',async t=>{
 const f=setup(t);await seed(f);delivery(f,'queued');
 const result=await save(f,{revision:1,operationId:OP,subject:'s',body:'b'});
 assert.equal(result.status,200);assert.equal(result.body.draft.revision,2);
 assert.equal((await f.store.read(S,D)).revision,2);
});
test('other signed owner with identical draft ID can save independently',async t=>{
 const f=setup(t);await seed(f);await f.store.create(O,D);delivery(f,'uncertain');
 const result=await save(f,{user:O.ownerSub,revision:1});
 assert.equal(result.status,200);assert.equal(result.body.draft.revision,2);
 assert.equal((await f.store.read(S,D)).subject,'s');
 assert.equal((await f.store.read(O,D)).subject,'Changed');
});
test('legacy draft-only schema permits save without outbox',async t=>{
 const f=setup(t,{outbox:false});await seed(f);
 const result=await save(f);assert.equal(result.status,200);
 assert.equal(result.body.draft.subject,'Changed');
});
test('stale revision conflicts before delivery locked signal',async t=>{
 const f=setup(t);await seed(f);delivery(f,'queued');
 const result=await save(f,{revision:1,operationId:NEW});
 assert.deepEqual(result,{status:409,body:{error:'mail_draft_conflict'}});
});
test('catalog lookup failures do not permit save',async t=>{
 const f=setup(t);await seed(f);
 const faulty={prepare(q){if(q.includes('sqlite_master'))throw Error('DB introspection outage');return f.d1.prepare(q)}};
 const env={...f.env,MAIL_DB:faulty};
 const result=await handleMailDraftApi({request:{method:'POST'},url:new URL('https://station.test/api/mail/drafts/save'),user:{subject:S.ownerSub},env,
  readBody:async()=>({id:D,revision:2,operationId:NEW,to:['a@example.test'],subject:'Changed',body:'Different'})});
 assert.deepEqual(result,{status:502,body:{error:'mail_draft_storage_failed'}});
 assert.equal((await f.store.read(S,D)).revision,2);
});
