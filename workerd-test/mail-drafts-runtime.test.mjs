import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
const date=process.env.DS_WORKERD_COMPAT_DATE??'2026-07-30';
if(!['2026-07-30','2026-10-28'].includes(date))throw Error('Unsupported test compatibility date');
const owner={installationId:'personal',mailboxId:'hello',ownerSub:'synthetic-owner-sub'};
const other={...owner,ownerSub:'another-synthetic-owner'};
const id='10d94bc0-f81d-4b99-8207-fdd9ac79d7b7';
const op1='6f6a7087-53dc-4a5b-b246-d1af125fffe6';
const op2='7a12868a-fd7b-4807-bc08-08b726044bbf';
const has=code=>e=>e?.code===code;
test('workerd '+date+': dedicated D1 draft storage uses real transaction semantics and tenant predicates',async t=>{
 const mf=new Miniflare({modules:true,script:'export default { fetch(){return new Response("isolated mail draft D1")}}',
  compatibilityDate:date,compatibilityFlags:['nodejs_compat'],d1Databases:['MAIL_DRAFTS']});
 try{
  const db=await mf.getD1Database('MAIL_DRAFTS');
  const store=createD1DraftStore(db);
  await t.test('candidate migration is required, idempotent and isolated',async()=>{
   await assert.rejects(store.list(owner),has('mail_draft_storage_failed'));
   const sql=(await readFile(new URL('../worker/migrations/0005-comms-drafts.sql',import.meta.url),'utf8'))
    .split('\n').filter(line=>!/^\s*--/.test(line)).join('\n')
    .split(';').map(x=>x.trim()).filter(Boolean);
   assert.equal(sql.length,2);
   for(const statement of sql)await db.prepare(statement).run();
   for(const statement of sql)await db.prepare(statement).run();
   assert.deepEqual(await store.list(owner),[]);
  });
  await t.test('two callers cannot both save the same revision',async()=>{
   await store.create(owner,id);
   const requests=[
    store.save(owner,{id,revision:1,operationId:op1,to:['a@example.org'],subject:'A',body:'First'}),
    store.save(owner,{id,revision:1,operationId:op2,to:['b@example.org'],subject:'B',body:'Second'})
   ];
   const results=await Promise.allSettled(requests);
   assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
   assert.equal(results.filter(x=>x.status==='rejected'&&x.reason?.code==='mail_draft_conflict').length,1);
   const rows=await store.list(owner);
   assert.equal(rows.length,1);assert.equal(rows[0].revision,2);
   assert(['A','B'].includes(rows[0].subject));
  });
  await t.test('scope-separated owners remain fully invisible',async()=>{
   assert.deepEqual(await store.list(other),[]);
   await assert.rejects(store.remove(other,{id,revision:2}),has('mail_draft_not_found'));
   await store.create(other,id);
   assert.equal((await store.list(other))[0].revision,1);
   assert.equal((await store.list(owner))[0].revision,2);
   assert.equal((await db.prepare('SELECT count(*) AS n FROM comms_mail_drafts').first()).n,2);
  });
  await t.test('database constraint failure cannot partially edit existing saved draft',async()=>{
   const before=(await store.list(owner))[0];
   await db.prepare("CREATE TRIGGER reject_draft_change BEFORE UPDATE ON comms_mail_drafts WHEN NEW.subject='BLOCK' BEGIN SELECT RAISE(ABORT,'synthetic'); END").run();
   try{
    await assert.rejects(store.save(owner,{id,revision:before.revision,operationId:op2,
      to:[],subject:'BLOCK',body:'Change'}),has('mail_draft_storage_failed'));
    assert.deepEqual((await store.list(owner))[0],before);
   }finally{await db.prepare('DROP TRIGGER reject_draft_change').run();}
  });
 }finally{await mf.dispose();}
});
