import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync,backup} from 'node:sqlite';
import {createStation} from '../worker/index.mjs';
import {emptyState,validateOwnerState} from '../worker/state.mjs';
const origin='https://devon-station.example.test';
const env={APP_ORIGIN:origin,OWNER_EMAIL:'owner@example.test',ACCESS_AUD:'test-audience',ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_JWKS_URL:'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs'};
function memoryDB(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8'));
 const db={
  prepare(sql){return {bind(...params){return {first:async()=>sqlite.prepare(sql).get(...params)??null,all:async()=>({results:sqlite.prepare(sql).all(...params)}),run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...params).changes)}})};}}},
  async batch(rows){sqlite.exec('BEGIN');try{const r=[];for(const row of rows)r.push(await row.run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}},
  close:()=>sqlite.close(),sqlite
 };return db;
}
const user={subject:'owner-sub-123',email:'owner@example.test'};
function req(path,body,headers={}){return new Request(origin+path,body===undefined?{headers}:{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});}
const save=(state,revision,opId='12345678-1234-4123-8123-123456789012')=>({state,expectedRevision:revision,operationId:opId,action:'Test capture'});
const draft={id:'local:12345678-1234-4123-8123-123456789012',title:'Check the release notes',area:'Devon Works',project:null,destination:null,state:'Draft',createdAt:'2026-10-28T19:00:00Z'};
test('private owner state read/write, revision checks, idempotency and content-free audit',async()=>{
 const DB=memoryDB(),app=createStation({},async()=>user),e={...env,DB};try{
  const first=await app.fetch(req('/api/state'),e,{});assert.equal(first.status,200);assert.equal((await first.json()).revision,0);
  const state=emptyState();state.drafts.push(draft);
  const result=await app.fetch(req('/api/state',save(state,0)),e,{});assert.equal(result.status,200);assert.equal((await result.json()).revision,1);
  const retry=await app.fetch(req('/api/state',save(state,0)),e,{});assert.equal(retry.status,200);assert.equal((await retry.json()).duplicate,true);
  assert.equal((await app.fetch(req('/api/state',save(state,0,'12345678-1234-4123-8123-123456789013')),e,{})).status,409);
  const changed=structuredClone(state);changed.drafts[0].title='Different text for same operation';
  assert.equal((await app.fetch(req('/api/state',save(changed,0)),e,{})).status,409);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM station_write_audit').get().n,1);
  const later=structuredClone(state);later.drafts[0].title='Second valid revision';
  const nextId='12345678-1234-4123-8123-123456789014';
  assert.equal((await app.fetch(req('/api/state',save(later,1,nextId)),e,{})).status,200);
  const oldRetry=await app.fetch(req('/api/state',save(state,0)),e,{});
  assert.equal(oldRetry.status,200);
  const oldRetryResult=await oldRetry.json();
  assert.equal(oldRetryResult.revision,1);
  assert.equal(oldRetryResult.currentRevision,2);
  assert.equal(oldRetryResult.superseded,true);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM station_write_audit').get().n,2);
  const updated=(await (await app.fetch(req('/api/state'),e,{})).json());assert.equal(updated.state.drafts[0].title,'Second valid revision');assert.equal(updated.revision,2);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM station_write_audit').get().n,2);
  const audit=DB.sqlite.prepare('SELECT * FROM station_write_audit WHERE revision=1').get();assert.equal(audit.action,'Test capture');assert(!JSON.stringify(audit).includes(draft.title));assert.match(audit.content_sha256,/^[a-f0-9]{64}$/);
  const owner2=createStation({},async()=>({...user,subject:'another-approved-sub'}));assert.equal((await (await owner2.fetch(req('/api/state'),e,{})).json()).revision,0);
 }finally{DB.close();}
});
test('owner-only signed identity is checked for state APIs and CORS/CSRF is blocked',async()=>{
 const DB=memoryDB(),e={...env,DB};try{
  const anon=createStation({});assert.equal((await anon.fetch(req('/api/state',{state:emptyState()}),e,{})).status,401);
  const other=createStation({},async()=>({...user,email:'wrong@example.test'}));assert.equal((await other.fetch(req('/api/state'),e,{})).status,403);
  const authed=createStation({},async()=>user);assert.equal((await authed.fetch(req('/api/state',save(emptyState(),0),{Origin:'https://external.test'}),e,{})).status,403);
  assert.equal((await authed.fetch(new Request(origin+'/api/state',{method:'POST',headers:{'Origin':origin,'Content-Type':'text/plain'},body:'{}'}),e,{})).status,403);
  assert.equal((await authed.fetch(new Request('https://evil.test/api/state'),e,{})).status,403);
  assert.equal((await authed.fetch(req('/api/state'),env,{})).status,503);
 }finally{DB.close();}
});
test('state validator rejects hostile text, arbitrary links and oversized payloads',()=>{
 const state=emptyState();state.drafts.push(draft);assert.equal(validateOwnerState(state).drafts.length,1);
 assert.throws(()=>validateOwnerState({...state,drafts:[{...draft,destination:'https://example.com/secret'}]}),/external_project/);
 assert.throws(()=>validateOwnerState({...state,drafts:[{...draft,title:'patient test data'}]}),/invalid_draft/);
 assert.throws(()=>validateOwnerState({...state,drafts:[draft,draft]}),/duplicate/);
 assert.throws(()=>validateOwnerState({...state,notionToken:'leaked'}),/unexpected_state/);
 assert.throws(()=>validateOwnerState({...state,history:[{action:'sk-abcdefghijabcdefghij',at:'2026-10-28T19:00:00Z'}]}),/invalid_history/);
 assert.throws(()=>validateOwnerState({...state,prefs:{theme:'<script>'}}),/invalid_preference/);
});
test('synthetic backup restores private owner document with matching content hash; no live database touched',async()=>{
 const db=memoryDB(),app=createStation({},async()=>user),e={...env,DB:db};
 const dir=mkdtempSync(join(tmpdir(),'station-restore-')),backupPath=join(dir,'station-backup.sqlite');
 try{
  const state=emptyState();state.drafts.push(draft);
  const r=await app.fetch(req('/api/state',save(state,0)),e,{});assert.equal(r.status,200);
  await backup(db.sqlite,backupPath);
  assert(existsSync(backupPath));
  const recovered=new DatabaseSync(backupPath);
  const row=recovered.prepare('SELECT revision,payload FROM station_documents WHERE owner_sub=?').get(user.subject);
  const audit=recovered.prepare('SELECT content_sha256 FROM station_write_audit WHERE owner_sub=?').get(user.subject);
  const checksum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(row.payload))),x=>x.toString(16).padStart(2,'0')).join('');
  assert.equal(row.revision,1);assert.equal(checksum,audit.content_sha256);assert.equal(JSON.parse(row.payload).drafts[0].title,draft.title);
  recovered.close();
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
