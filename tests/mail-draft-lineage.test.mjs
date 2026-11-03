import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
import {createD1Outbox,createOutboxDispatcher} from '../src/communications/mail-outbox.mjs';

const owner={installationId:'personal',mailboxId:'hello',ownerSub:'synthetic-owner'};
const peer={...owner,ownerSub:'synthetic-peer'};
const context={installationId:'personal',principalId:'owner'};
const from='hello@devonakins.com';
const registry={mailboxes:[{id:'hello',installationId:'personal',mode:'imap',sendVerified:true}],
 identities:[{address:from,mailboxId:'hello',installationId:'personal',sendVerified:true}],
 grants:[{installationId:'personal',principalId:'owner',mailboxId:'hello',capabilities:['send']}]};
const sample={to:['recipient@example.test'],subject:'Synthetic draft',body:'Plain text only'};
const UUID={
 draft:'a0000000-0000-4000-8000-000000000001',
 operation:'a0000000-0000-4000-8000-000000000002',
 first:'a0000000-0000-4000-8000-000000000003',
 second:'a0000000-0000-4000-8000-000000000004',
 third:'a0000000-0000-4000-8000-000000000005',
 alternate:'a0000000-0000-4000-8000-000000000006'
};
const isCode=code=>error=>error?.code===code;

// This adapter exercises REAL SQLite constraints via Node's built-in SQLite
// while preserving the D1 async prepare/bind/first/run API surface.
function fixture(t){
 const sqlite=new DatabaseSync(':memory:');
 t.after(()=>sqlite.close());
 for(const file of ['0005-comms-drafts.sql','0006-comms-outbox.sql','0007-comms-draft-outbox-lineage.sql','0008-comms-one-delivery-per-draft.sql']){
  const sql=readFileSync(new URL('../worker/migrations/'+file,import.meta.url),'utf8');
  sqlite.exec(sql);
 }
 const d1={prepare(sql){
  return {bind(...args){
   const statement=sqlite.prepare(sql);
   return {
    async first(){return statement.get(...args)??null},
    async all(){return {results:statement.all(...args),success:true}},
    async run(){const result=statement.run(...args);return {meta:{changes:result.changes},success:true}}
   };
  }};
 }};
 const drafts=createD1DraftStore(d1,{now:()=> '2026-11-03T10:00:00.000Z'});
 const outbox=createD1Outbox(d1,owner,{now:()=> '2026-11-03T10:01:00.000Z'});
 const dispatcher=createOutboxDispatcher({store:outbox,draftStore:drafts,ownerSub:owner.ownerSub,
  registry,context,mailboxId:'hello',from,now:()=>new Date('2026-11-03T10:01:00.000Z')});
 return {sqlite,d1,drafts,outbox,dispatcher};
}
async function seed(drafts){
 await drafts.create(owner,UUID.draft);
 return drafts.save(owner,{id:UUID.draft,revision:1,operationId:UUID.operation,...sample});
}
const prepare=(dispatcher,deliveryId,revision=2)=>dispatcher.enqueueSavedDraft({
 deliveryId,draftId:UUID.draft,draftRevision:revision,approvedByOwner:true
});

test('one scoped draft revision produces exactly one immutable delivery under competing Worker requests',async t=>{
 const {sqlite,drafts,outbox,dispatcher}=fixture(t);await seed(drafts);
 const results=await Promise.allSettled([
  prepare(dispatcher,UUID.first),prepare(dispatcher,UUID.second)
 ]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.filter(x=>x.status==='rejected'&&isCode('outbox_draft_already_prepared')(x.reason)).length,1);
 const winner=results[0].status==='fulfilled'?UUID.first:UUID.second;
 const replay=await prepare(dispatcher,winner);
 assert.equal(replay.deliveryId,winner);
 assert.equal(replay.state,'queued');assert.equal(replay.draftId,UUID.draft);assert.equal(replay.draftRevision,2);
 assert.equal((await outbox.list()).filter(x=>x.draftId===UUID.draft).length,1);
 assert.equal(sqlite.prepare('SELECT count(*) AS n FROM comms_outbox').get().n,1);
 const linked=(await outbox.read(winner));
 assert.deepEqual(linked.payload.draft,sample);
 assert.equal(linked.payload.from,from);
 assert.equal(linked.payload.date,'2026-11-03T10:01:00.000Z');
 await assert.rejects(prepare(dispatcher,UUID.third),isCode('outbox_draft_already_prepared'));
 await drafts.save(owner,{id:UUID.draft,revision:2,operationId:UUID.alternate,
  ...sample,subject:'Edited after original delivery'});
 await assert.rejects(prepare(dispatcher,UUID.third,3),isCode('outbox_draft_already_prepared'));
 assert.equal(sqlite.prepare('SELECT count(*) AS n FROM comms_outbox').get().n,1);
 await assert.rejects(dispatcher.enqueueSavedDraft({deliveryId:winner,draftId:UUID.alternate,
  draftRevision:2,approvedByOwner:true}),isCode('outbox_conflict'));
});

test('saved-draft revision is rechecked atomically against edits and deleted rows',async t=>{
 const {sqlite,drafts,outbox,dispatcher}=fixture(t);await seed(drafts);
 const old=await drafts.read(owner,UUID.draft);assert.equal(old.revision,2);
 await drafts.save(owner,{id:UUID.draft,revision:2,operationId:UUID.alternate,
  to:sample.to,subject:'New subject',body:sample.body});
 await assert.rejects(prepare(dispatcher,UUID.first,2),isCode('outbox_draft_stale'));
 const tampered={from,draft:sample,date:'2026-11-03T10:01:00.000Z'};
 await assert.rejects(outbox.offerLinkedDraft(UUID.first,{
  draftId:UUID.draft,draftRevision:3,payload:tampered
 }),isCode('outbox_draft_stale'));
 assert.equal(sqlite.prepare('SELECT count(*) AS n FROM comms_outbox').get().n,0);
 const newReceipt=await prepare(dispatcher,UUID.second,3);
 assert.equal(newReceipt.state,'queued');
 await drafts.remove(owner,{id:UUID.draft,revision:3});
 await assert.rejects(prepare(dispatcher,UUID.third,3),isCode('outbox_draft_stale'));
 assert.equal((await outbox.list()).length,1,'deleting draft must not erase immutable outbox receipts');
});

test('scope boundary, unique-index scope and legacy outbox inserts remain intact',async t=>{
 const {sqlite,d1,drafts,outbox,dispatcher}=fixture(t);await seed(drafts);
 const another=createD1Outbox(d1,peer),otherDispatcher=createOutboxDispatcher({
  store:another,draftStore:drafts,ownerSub:peer.ownerSub,
  registry,context,mailboxId:'hello',from
 });
 assert.equal(await drafts.read(peer,UUID.draft),null);
 await assert.rejects(prepare(otherDispatcher,UUID.first),isCode('outbox_draft_stale'));
 const linked=await prepare(dispatcher,UUID.first);
 assert.equal((await another.list()).length,0);
 assert.equal((await outbox.list()).length,1);
 assert.equal(linked.draftId,UUID.draft);
 // Legacy code paths can still create historical/unlinked rows in the migrated schema;
 // the HTTP submit handler will separately reject any unlinked record.
 const legacyId=UUID.third,legacyPayload={from,draft:sample,date:'2026-11-03T10:01:00.000Z'};
 const legacy=await outbox.offer(legacyId,legacyPayload);
 assert.equal(legacy.state,'queued');assert.equal(legacy.draftId,undefined);
 assert.equal((await outbox.list()).length,2);
 assert.equal(sqlite.prepare('SELECT draft_id FROM comms_outbox WHERE delivery_id=?').get(legacyId).draft_id,null);
 const ownerRecord=sqlite.prepare('SELECT draft_id,draft_revision FROM comms_outbox WHERE delivery_id=?').get(UUID.first);
 assert.equal(ownerRecord.draft_id,UUID.draft);assert.equal(ownerRecord.draft_revision,2);
 const row=await outbox.read(UUID.first);assert.equal(row.draftId,UUID.draft);
 assert(!JSON.stringify(await outbox.list()).includes(sample.body),'listing never includes saved body or recipients');
});
