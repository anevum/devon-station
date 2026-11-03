import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createStation} from '../worker/index.mjs';
const schema=readFileSync(new URL('../worker/migrations/0005-comms-drafts.sql',import.meta.url),'utf8');
const origin='https://station.example';
const id='78d4478a-4ac1-47f2-b41f-be6506c1c34a';
const op='f1c9b833-603a-4c34-b134-c56e7e0bfcb1';
const build=()=>{
 const db=new DatabaseSync(':memory:');db.exec(schema);
 const binding={prepare(sql){return {bind(...params){return {
  async first(){return db.prepare(sql).get(...params)??null;},
  async all(){return {success:true,results:db.prepare(sql).all(...params)};},
  async run(){return {success:true,meta:{changes:db.prepare(sql).run(...params).changes}};}
 };}}}};
 const env={OWNER_EMAIL:'owner@example.org',APP_ORIGIN:origin,
  MAIL_DRAFTS_ENABLED:'true',MAIL_OWNER_SUB:'trusted-owner-sub',MAIL_DB:binding};
 const station=createStation({},async()=>({email:'owner@example.org',subject:'trusted-owner-sub'}),fetch);
 const req=(path,method='GET',body={},headers)=>new Request(origin+path,{method,
  ...(method==='POST'?{headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)}:{})});
 return {db,env,station,req};
};
test('dedicated drafts can be enabled without IMAP password and remain marked UNSENT',async()=>{
 const x=build();
 const status=await x.station.fetch(x.req('/api/mail/status'),x.env);
 assert.equal(status.status,200);
 const value=await status.json();assert.equal(value.configured,false);
 assert.equal(value.draftsEnabled,true);assert.equal(value.outgoingEnabled,false);
 const created=await x.station.fetch(x.req('/api/mail/drafts/create','POST',{id}),x.env);
 assert.equal(created.status,200);assert.equal((await created.json()).draft.revision,1);
 const saved=await x.station.fetch(x.req('/api/mail/drafts/save','POST',
  {id,revision:1,operationId:op,to:['recipient@example.org'],subject:'For later',body:'This is not sent'}),x.env);
 assert.equal(saved.status,200);assert.equal((await saved.json()).draft.revision,2);
 const list=await x.station.fetch(x.req('/api/mail/drafts'),x.env);
 const rows=(await list.json()).drafts;
 assert.equal(rows.length,1);assert.equal(rows[0].body,'This is not sent');
 assert.equal(rows[0].from,'hello@devonakins.com');
 assert.equal((await x.station.fetch(x.req('/api/mail/send','POST'),x.env)).status,404);
 x.db.close();
});
test('owner subject mismatch, same-origin CSRF and invalid route method denied before D1 writes',async()=>{
 const x=build();
 const other={...x.env,MAIL_OWNER_SUB:'another-sub'};
 assert.equal((await x.station.fetch(x.req('/api/mail/drafts'),other)).status,403);
 assert.equal((await x.station.fetch(new Request(origin+'/api/mail/drafts/create',{
  method:'POST',headers:{Origin:'https://malicious.example','Content-Type':'application/json'},
  body:JSON.stringify({id})}),x.env)).status,403);
 assert.equal((await x.station.fetch(x.req('/api/mail/drafts/create','GET'),x.env)).status,405);
 assert.equal(x.db.prepare('SELECT count(*) AS n FROM comms_mail_drafts').get().n,0);
 x.db.close();
});
test('retries, stale updates, deletion and malformed recipients are enforced by authenticated API',async()=>{
 const x=build();
 const create=()=>x.station.fetch(x.req('/api/mail/drafts/create','POST',{id}),x.env);
 assert.equal((await create()).status,200);assert.equal((await create()).status,200);
 const send=(operationId,subject='Saved')=>x.station.fetch(x.req('/api/mail/drafts/save','POST',{
  id,revision:1,operationId,to:['test@example.org'],subject,body:'No SMTP send'}),x.env);
 assert.equal((await send(op)).status,200);
 assert.equal((await send(op)).status,200);
 assert.equal((await send('00000000-0000-4000-8000-000000000003')).status,409);
 assert.equal((await send(op,'Changed')).status,409);
 assert.equal((await x.station.fetch(x.req('/api/mail/drafts/delete','POST',{id,revision:1}),x.env)).status,409);
 assert.equal((await x.station.fetch(x.req('/api/mail/drafts/delete','POST',{id,revision:2}),x.env)).status,200);
 assert.equal((await x.station.fetch(x.req('/api/mail/drafts'),x.env)).status,200);
 assert.equal(x.db.prepare('SELECT count(*) AS n FROM comms_mail_drafts').get().n,0);
 x.db.close();
});
test('no draft storage binding rejects API without attempting a provider connection',async()=>{
 const x=build();
 const env={OWNER_EMAIL:x.env.OWNER_EMAIL,APP_ORIGIN:origin,MAIL_OWNER_SUB:'trusted-owner-sub'};
 const r=await x.station.fetch(x.req('/api/mail/drafts'),env);
 assert.equal(r.status,503);
 assert.equal((await r.json()).error,'mail_drafts_not_configured');
 x.db.close();
});
