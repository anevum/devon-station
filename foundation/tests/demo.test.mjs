import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startDemo } from '../demo/server.mjs';

test('local synthetic UI enforces host, token and origin; proposals require explicit decisions',async t=>{
 const demo=await startDemo();t.after(()=>demo.close());
 const page=await fetch(demo.origin);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);const html=await page.text();const token=html.match(/name="demo-token" content="([0-9a-f]{64})"/)[1];
 assert.equal((await fetch(`${demo.origin}/api/state`)).status,403);
 const headers={'x-demo-token':token};const state=async()=>await (await fetch(`${demo.origin}/api/state`,{headers})).json();let initial=await state();assert.equal(initial.projects.length,2);assert.equal(initial.actions.length,0);
 const post=(path,body,origin=demo.origin)=>fetch(`${demo.origin}${path}`,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post('/api/proposals',{projectId:'studio',summary:'Review plan'},'http://evil.example')).status,403);
 assert.equal((await post('/api/proposals',{projectId:'studio',summary:'Review plan',principalId:'other'})).status,400);
 assert.equal((await post('/api/proposals',{projectId:'unknown',summary:'Review plan'})).status,400);
 assert.equal((await post('/api/proposals',{projectId:'studio',summary:'Review plan'})).status,200);
 let current=await state();assert.equal(current.actions[0].status,'proposed');assert.equal(current.receipts.length,1);
 assert.equal((await post('/api/decisions',{recordId:current.actions[0].recordId,revision:0,decision:'approved'})).status,400);
 assert.equal((await post('/api/decisions',{recordId:current.actions[0].recordId,revision:1,decision:'approved'})).status,200);
 current=await state();assert.equal(current.actions[0].status,'approved');assert.equal(current.receipts.length,2);
 assert.equal((await post('/api/decisions',{recordId:current.actions[0].recordId,revision:2,decision:'rejected'})).status,400);
 assert.equal((await post('/api/proposals',{projectId:'studio',summary:'x'.repeat(5000)})).status,413);
 const spoofed=await new Promise((resolve,reject)=>{http.get(demo.origin,{headers:{host:'attacker.example'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));}).on('error',reject);});assert.equal(spoofed,403);
});
test('independent preview instances start empty',async t=>{const a=await startDemo(),b=await startDemo();t.after(()=>Promise.all([a.close(),b.close()]));assert.notEqual(a.origin,b.origin);const html=await (await fetch(b.origin)).text();const token=html.match(/name="demo-token" content="([0-9a-f]{64})"/)[1];const state=await (await fetch(`${b.origin}/api/state`,{headers:{'x-demo-token':token}})).json();assert.deepEqual(state.actions,[]);});
