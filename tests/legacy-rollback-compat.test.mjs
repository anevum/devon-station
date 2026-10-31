/**
 * DS011: synthetic V0.3 rollback compatibility, NOT a live rollback drill.
 * The historical public V0.3 entry has no co-located import dependencies.
 * For this test only, load its original bytes beside the already-published
 * recovered Access and notifications modules in an isolated temporary folder.
 * Auth is injected with fabricated subjects; real Access is not exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createStation as currentWorker} from '../worker/index.mjs';
import {emptyState,saveOwnerState,getOwnerState} from '../worker/state.mjs';

const origin='https://ds011-offline-rollback.example.test';
const ownerEmail='synthetic-owner@example.test';
const owner='synthetic-owner-subject';
const other='synthetic-other-subject';
const request=(path,body,override={})=>new Request(origin+path,body===undefined?
  {headers:override}:
  {method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...override},body:JSON.stringify(body)});
const oldFingerprint='b2974dde4ca177420caecd810b8f008d582c93131317c6a822b5bb821c3c84';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function legacyWorker(t) {
  const dir=await mkdtemp(join(tmpdir(),'ds011-v03-rollback-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=await readFile(new URL('../legacy/v03/worker/index.mjs',import.meta.url));
  assert.equal(hash(source),oldFingerprint);
  await writeFile(join(dir,'index.mjs'),source);
  await writeFile(join(dir,'access.mjs'),await readFile(new URL('../worker/access.mjs',import.meta.url)));
  await writeFile(join(dir,'notifications.mjs'),await readFile(new URL('../worker/notifications.mjs',import.meta.url)));
  return (await import(pathToFileURL(join(dir,'index.mjs')).href)).createStation;
}
function storage(t){
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec(readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8'));
  const d1={
    prepare(sql){return {bind(...values){return {
      first:async()=>db.prepare(sql).get(...values)??null,
      all:async()=>({results:db.prepare(sql).all(...values)}),
      run:async()=>({meta:{changes:Number(db.prepare(sql).run(...values).changes)}})
    }}}},
    async batch(queries){db.exec('BEGIN');try{const result=[];for(const q of queries)result.push(await q.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
  };
  return {db,d1};
}
const identity=subject=>async()=>({email:ownerEmail,subject});
const env=d1=>({APP_ORIGIN:origin,OWNER_EMAIL:ownerEmail,DB:d1});
async function seedCurrentState(d1){
  const state=emptyState();
  state.drafts=[{id:'local:synthetic-rollback',title:'Synthetic preserved owner document',area:'Devon Works',project:null,destination:null,state:'Draft',createdAt:'2026-10-30T12:00:00.000Z'}];
  const result=await saveOwnerState(d1,owner,{expectedRevision:0,operationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',action:'Synthetic save',state});
  assert.equal(result.revision,1);
  return await getOwnerState(d1,owner);
}

test('preserved V0.3 endpoint remains callable after additive migration; new state is invisible',async t=>{
  const legacy=await legacyWorker(t),{d1,db}=storage(t),e=env(d1);
  const before=await seedCurrentState(d1);
  const app=legacy({'/index.html':{type:'text/html',body:'Synthetic legacy shell'}},identity(owner));
  const session=await app.fetch(request('/api/session'),e,{});
  assert.equal(session.status,200);
  assert.equal((await session.json()).version,'0.3.0');
  assert.equal((await app.fetch(request('/api/state'),e,{})).status,404);
  assert.equal((await app.fetch(request('/'),e,{})).status,200);
  assert.equal((await app.fetch(request('/api/notifications/config'),e,{})).status,200);
  assert.deepEqual(await getOwnerState(d1,owner),before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM station_write_audit').get().n,1);
});

test('V0.3 push mutations on expanded schema preserve current owner state and owner boundaries',async t=>{
  const legacy=await legacyWorker(t),{d1,db}=storage(t),e=env(d1);
  const oldOwner=legacy({},identity(owner)),oldOther=legacy({},identity(other));
  const newOwner=currentWorker({},identity(owner));
  const before=await seedCurrentState(d1);
  const endpoint='https://web.push.apple.com/Q/synthetic-test';
  const subscribe=await oldOwner.fetch(request('/api/notifications/subscribe',{
    deviceId:'device-synthetic-a',subscription:{endpoint}
  }),e,{});
  assert.equal(subscribe.status,200);
  assert.equal((await subscribe.json()).subscribed,true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_devices WHERE owner_sub=?').get(owner).n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_devices WHERE owner_sub=?').get(other).n,0);
  // Other synthetic identity cannot alter the first scope's push subscription.
  assert.equal((await oldOther.fetch(request('/api/notifications/unsubscribe',{deviceId:'device-synthetic-a'}),e,{})).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_devices WHERE owner_sub=?').get(owner).n,1);
  assert.deepEqual(await getOwnerState(d1,owner),before);
  const current=await newOwner.fetch(request('/api/state'),e,{});
  assert.equal(current.status,200);
  assert.equal((await current.json()).revision,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM station_write_audit').get().n,1);
  const unsubscribe=await oldOwner.fetch(request('/api/notifications/unsubscribe',{deviceId:'device-synthetic-a'}),e,{});
  assert.equal(unsubscribe.status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_devices WHERE owner_sub=?').get(owner).n,0);
  assert.deepEqual(await getOwnerState(d1,owner),before);
});

test('V0.3 fallback still enforces origin, same-origin writes and owner-only identity',async t=>{
  const legacy=await legacyWorker(t),{d1}=storage(t),e=env(d1);
  const app=legacy({'/index.html':{type:'text/html',body:'synthetic'}},identity(owner));
  assert.equal((await app.fetch(new Request('https://untrusted.example.test/'),e,{})).status,403);
  assert.equal((await app.fetch(request('/api/notifications/subscribe',{}, {Origin:'https://untrusted.example.test'}),e,{})).status,403);
  const nonowner=legacy({},async()=>({subject:other,email:'not-owner@example.test'}));
  assert.equal((await nonowner.fetch(request('/api/session'),e,{})).status,403);
});
