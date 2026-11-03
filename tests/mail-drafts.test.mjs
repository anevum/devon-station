import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createD1DraftStore,validateDraftPayload} from '../src/communications/mail-drafts.mjs';
import {handleMailDraftApi} from '../worker/mail-drafts-api.mjs';
const schema=readFileSync(new URL('../worker/migrations/0005-comms-drafts.sql',import.meta.url),'utf8');
const personal={installationId:'personal',mailboxId:'hello',ownerSub:'signed-owner-sub'};
const sameInstallationOtherUser={...personal,ownerSub:'different-signed-sub'};
const anotherInstallation={...personal,installationId:'client-two'};
const ID='9a4a8d93-209d-45e1-a0ce-89ec48292401';
const OP='51f04cd9-f018-473f-94d1-b31f0f054fe2';
const idFromNumber=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
function setup(migrate=true){
 const db=new DatabaseSync(':memory:');
 if(migrate)db.exec(schema);
 const d1={prepare(sql){return {bind(...args){return {
   async first(){return db.prepare(sql).get(...args)??null;},
   async all(){return {success:true,results:db.prepare(sql).all(...args)};},
   async run(){return {success:true,meta:{changes:db.prepare(sql).run(...args).changes}};}
 };}}}};
 return {db,d1,store:createD1DraftStore(d1,{now:()=> '2026-11-03T12:00:00.000Z'})};
}
const assertCode=code=>e=>e?.code===code;
test('schema migration is explicit, not an implicit side effect of opening a draft store',async()=>{
 const {db,store}=setup(false);
 await assert.rejects(store.list(personal),assertCode('mail_draft_storage_failed'));
 assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='comms_mail_drafts'").get().n,0);
 db.close();
});
test('creation is idempotent across HTTP retries and does not overwrite saved content',async()=>{
 const {db,store}=setup();
 const first=await store.create(personal,ID);
 assert.deepEqual(first.to,[]);assert.equal(first.revision,1);
 const saved=await store.save(personal,{id:ID,revision:1,operationId:OP,to:['recipient@example.org'],subject:'Hello',body:'Private draft body'});
 assert.equal(saved.revision,2);
 assert.equal(saved.subject,'Hello');
 const retried=await store.create(personal,ID);
 assert.deepEqual(retried,saved);
 assert.equal((await store.list(personal)).length,1);
 db.close();
});
test('same save operation can replay safely but stale edits and operation substitution fail',async()=>{
 const {db,store}=setup();
 await store.create(personal,ID);
 const input={id:ID,revision:1,operationId:OP,to:['a@example.org'],subject:'Draft',body:'Private'};
 const first=await store.save(personal,input);
 const retried=await store.save(personal,input);
 assert.deepEqual(retried,first);assert.equal(retried.revision,2);
 await assert.rejects(store.save(personal,{...input,operationId:idFromNumber(2),subject:'Overwritten'}),assertCode('mail_draft_conflict'));
 await assert.rejects(store.save(personal,{...input,subject:'Changed replay'}),assertCode('mail_draft_conflict'));
 assert.equal((await store.list(personal))[0].subject,'Draft');
 db.close();
});
test('separate owners and installations cannot list, modify or delete another draft',async()=>{
 const {db,store}=setup();
 await store.create(personal,ID);
 await store.save(personal,{id:ID,revision:1,operationId:OP,to:[],subject:'Private',body:'Secret'});
 assert.deepEqual(await store.list(sameInstallationOtherUser),[]);
 assert.deepEqual(await store.list(anotherInstallation),[]);
 await assert.rejects(store.save(sameInstallationOtherUser,{id:ID,revision:2,operationId:idFromNumber(3),to:[],subject:'Attack',body:'Hijack'}),assertCode('mail_draft_not_found'));
 await assert.rejects(store.remove(anotherInstallation,{id:ID,revision:2}),assertCode('mail_draft_not_found'));
 const other=await store.create(sameInstallationOtherUser,ID);
 assert.equal(other.revision,1);assert.equal(other.subject,'');
 assert.equal((await store.list(personal))[0].subject,'Private');
 db.close();
});
test('limit is enforced per owner and cannot overflow the dedicated table',async()=>{
 const {db,store}=setup();
 for(let n=1;n<=20;n++)await store.create(personal,idFromNumber(n));
 await assert.rejects(store.create(personal,idFromNumber(21)),assertCode('mail_draft_limit'));
 assert.equal((await store.list(personal)).length,20);
 const extra=await store.create(anotherInstallation,idFromNumber(21));
 assert.equal(extra.revision,1);
 assert.equal((await store.list(personal)).length,20);
 db.close();
});
test('single-action draft delete enforces revision precondition and owner',async()=>{
 const {db,store}=setup();
 await store.create(personal,ID);
 await assert.rejects(store.remove(personal,{id:ID,revision:2}),assertCode('mail_draft_conflict'));
 assert.deepEqual(await store.remove(personal,{id:ID,revision:1}),{deleted:true});
 await assert.rejects(store.remove(personal,{id:ID,revision:1}),assertCode('mail_draft_not_found'));
 assert.deepEqual(await store.list(personal),[]);
 db.close();
});
test('addresses, control characters, duplicate recipients, body bounds and bad revisions reject without writes',async()=>{
 const {db,store}=setup();
 await store.create(personal,ID);
 const bad=[
  {to:['victim@example.com\r\nBcc:spy@example.com'],subject:'a',body:''},
  {to:['a@example.org','A@EXAMPLE.ORG'],subject:'a',body:''},
  {to:[],subject:'Injected\r\nCc:steal@example.org',body:''},
  {to:[],subject:'No',body:'z'.repeat(32769)}
 ];
 for(const payload of bad)await assert.rejects(store.save(personal,{id:ID,revision:1,operationId:idFromNumber(4),...payload}),e=>e?.status===400);
 await assert.rejects(store.save(personal,{id:ID,revision:0,operationId:OP,to:[],subject:'x',body:'y'}),assertCode('invalid_mail_draft_revision'));
 assert.equal((await store.list(personal))[0].revision,1);
 assert.equal((await store.list(personal))[0].body,'');
 db.close();
});
test('no write through guessed cross-owner scope or malformed ID',async()=>{
 const {db,store}=setup();
 await assert.rejects(store.create({...personal,ownerSub:'evil\nsub'},ID),assertCode('invalid_mail_draft_scope'));
 await assert.rejects(store.create(personal,'../../other'),assertCode('invalid_mail_draft_id'));
 await assert.rejects(store.save(personal,{id:ID,revision:1,operationId:'BAD',to:[],subject:'',body:''}),assertCode('invalid_mail_draft_id'));
 assert.deepEqual(await store.list(personal),[]);
 db.close();
});


test('legacy draft-only HTTP delete still works when no outbox schema exists',async()=>{
 const {db,d1,store}=setup();
 await store.create(personal,ID);
 const url=new URL('https://station.example/api/mail/drafts/delete');
 const result=await handleMailDraftApi({
  request:new Request(url,{method:'POST'}),url,
  user:{subject:personal.ownerSub},
  env:{MAIL_DRAFTS_ENABLED:'true',MAIL_OWNER_SUB:personal.ownerSub,MAIL_DB:d1},
  readBody:async()=>({id:ID,revision:1})
 });
 assert.deepEqual(result,{status:200,body:{deleted:true}});
 assert.equal((await store.list(personal)).length,0);
 db.close();
});
