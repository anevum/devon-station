import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { startDemo } from '../demo/server.mjs';

async function client(demo){const page=await fetch(demo.origin);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);const token=(await page.text()).match(/name="demo-token" content="([0-9a-f]{64})"/)[1];const headers={'x-demo-token':token};return {token,state:async()=>await (await fetch(`${demo.origin}/api/state`,{headers})).json(),post:(path,body,origin=demo.origin)=>fetch(`${demo.origin}${path}`,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)})};}
const proposal=(generation=0)=>({projectId:'studio',summary:'Review synthetic plan',generation,operationId:randomUUID(),recordId:randomUUID()});

test('local UI checks request boundaries, revisions and idempotent decisions',async t=>{
 const demo=await startDemo();t.after(()=>demo.close());const c=await client(demo);assert.equal((await fetch(`${demo.origin}/api/state`)).status,403);
 assert.equal((await c.state()).generation,0);const p=proposal();
 assert.equal((await c.post('/api/proposals',p,'http://evil.example')).status,403);
 assert.equal((await c.post('/api/proposals',{...p,principalId:'other'})).status,400);
 assert.equal((await c.post('/api/proposals',{...p,projectId:'unknown'})).status,400);
 const first=await (await c.post('/api/proposals',p)).json();const retry=await (await c.post('/api/proposals',p)).json();assert.deepEqual(first,retry);
 assert.equal((await c.post('/api/proposals',proposal())).status,400);let state=await c.state();assert.equal(state.generation,1);assert.equal(state.actions.length,1);assert.equal(state.actions[0].status,'proposed');
 const decision={recordId:p.recordId,revision:1,decision:'approved',generation:1,operationId:randomUUID()};
 assert.equal((await c.post('/api/decisions',{...decision,revision:0})).status,400);assert.equal((await c.post('/api/decisions',decision)).status,200);
 state=await c.state();assert.equal(state.generation,2);assert.equal(state.actions[0].status,'approved');assert.equal(state.receipts.length,2);
 assert.equal((await c.post('/api/decisions',{...decision,revision:2,decision:'rejected',operationId:randomUUID(),generation:2})).status,400);
 assert.equal((await c.post('/api/proposals',{...proposal(2),summary:'x'.repeat(5000)})).status,413);
 const spoofed=await new Promise((resolve,reject)=>{http.get(demo.origin,{headers:{host:'attacker.example'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));}).on('error',reject);});assert.equal(spoofed,403);
});
test('independent default preview instances start empty',async t=>{const a=await startDemo(),b=await startDemo();t.after(()=>Promise.all([a.close(),b.close()]));assert.notEqual(a.origin,b.origin);assert.deepEqual((await (await client(b)).state()).actions,[]);});
test('invalid UTF-8 is rejected before mutation',async t=>{
 const demo=await startDemo();t.after(()=>demo.close());const c=await client(demo);
 const body=Buffer.concat([Buffer.from('{"projectId":"studio","summary":"'),Buffer.from([0xff]),Buffer.from('"}')]);
 const response=await fetch(`${demo.origin}/api/proposals`,{method:'POST',headers:{'x-demo-token':c.token,origin:demo.origin,'content-type':'application/json'},body});assert.equal(response.status,400);assert.deepEqual((await c.state()).actions,[]);
});
test('synthetic scope isolation, persisted restart, and injected database failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'station-preview-'));const path=join(dir,'synthetic.sqlite');let db=new DatabaseSync(path), demo;
 try{
  demo=await startDemo({db});let c=await client(demo);const p=proposal();assert.equal((await c.post('/api/proposals',p)).status,200);
  await demo.close();demo=undefined;db.close();db=new DatabaseSync(path);
  demo=await startDemo({db});c=await client(demo);let state=await c.state();assert.equal(state.actions.length,1);assert.equal(state.actions[0].recordId,p.recordId);assert.equal(state.generation,1);
  db.exec("CREATE TRIGGER synthetic_fail AFTER UPDATE ON synthetic_scope_state BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.equal((await c.post('/api/decisions',{recordId:p.recordId,revision:1,decision:'approved',generation:1,operationId:randomUUID()})).status,400);
  state=await c.state();assert.equal(state.actions[0].status,'proposed');assert.equal(state.generation,1);assert.equal(state.receipts.length,1);db.exec('DROP TRIGGER synthetic_fail');
  await demo.close();demo=undefined;
  const otherIdentity={principalId:'other-owner',role:'owner',scopeKind:'personal',scopeId:'other-scope'};
  demo=await startDemo({db,identity:otherIdentity});c=await client(demo);state=await c.state();assert.deepEqual(state.actions,[]);assert.equal(state.generation,0);
  assert.equal((await c.post('/api/decisions',{recordId:p.recordId,revision:1,decision:'approved',generation:0,operationId:randomUUID()})).status,400);assert.deepEqual((await c.state()).actions,[]);
 } finally {if(demo)await demo.close();db.close();await rm(dir,{recursive:true,force:true});}
});
test('corrupt snapshot returns unavailable without crashing server',async()=>{
 const db=new DatabaseSync(':memory:');let demo;try{demo=await startDemo({db});const c=await client(demo);db.prepare('UPDATE synthetic_scope_state SET snapshot=? WHERE scope_id=?').run('{}','demo-scope');const response=await fetch(`${demo.origin}/api/state`,{headers:{'x-demo-token':c.token}});assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'Synthetic workspace unavailable'});assert.equal((await fetch(demo.origin)).status,200);}finally{if(demo)await demo.close();db.close();}
});
