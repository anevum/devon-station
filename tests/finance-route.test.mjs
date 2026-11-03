import test from 'node:test';
import assert from 'node:assert/strict';
import {createStation} from '../worker/index.mjs';

const origin='https://station.example.test';
const owner={subject:'trusted-subject',email:'owner@example.test'};
const env={APP_ORIGIN:origin,OWNER_EMAIL:owner.email,FINANCE_OWNER_SUBJECT:owner.subject,FINANCE_READ_MODE:'read_only'};
const request=(path='/api/finance/summary',method='GET')=>new Request(origin+path,{
 method,...(method==='POST'?{headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'}:{})
});

test('signed owner GET returns read-only unconfigured sources without D1 or secrets',async()=>{
 let calls=0;const station=createStation({},async()=>owner,async()=>{calls++;throw Error('never called');});
 const response=await station.fetch(request(),env,{});
 assert.equal(response.status,200);
 assert.match(response.headers.get('cache-control'),/no-store/);
 const body=await response.json();
 assert.equal(body.schema,'devonstation-financial-readonly-v1');
 assert.equal(body.sources.mercury.status,'not_configured');
 assert.equal(body.sources.alpaca.status,'not_configured');
 assert.equal(body.combinedNetWorthCents,null);
 assert.equal(calls,0);
});

test('signed owner must also match private financial subject binding',async()=>{
 let calls=0;const station=createStation({},async()=>({...owner,subject:'other'}),async()=>{calls++;});
 const response=await station.fetch(request(),env,{});
 assert.equal(response.status,403);
 assert.equal((await response.json()).error,'finance_owner_not_authorized');
 assert.equal(calls,0);
});

test('route denies unsigned requests, wrong origin, unexpected query and writes',async()=>{
 const unsigned=createStation({},async()=>{throw Error('not signed');});
 assert.equal((await unsigned.fetch(request(),env,{})).status,401);
 const authenticated=createStation({},async()=>owner);
 assert.equal((await authenticated.fetch(new Request('https://evil.example.test/api/finance/summary'),env,{})).status,403);
 assert.equal((await authenticated.fetch(request('/api/finance/summary?account=other'),env,{})).status,400);
 assert.equal((await authenticated.fetch(request('/api/finance/summary','POST'),env,{})).status,405);
 assert.equal((await authenticated.fetch(request('/api/finance/transfer'),env,{})).status,404);
});
