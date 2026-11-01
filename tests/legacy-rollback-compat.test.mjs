/**
 * DS011: synthetic V0.3 rollback compatibility, NOT a live rollback drill.
 * The historical public V0.3 entry has no co-located import dependencies.
 * For this test only, load its original bytes beside the already-published
 * recovered Access and notifications modules in an isolated temporary folder.
 * Most cases inject fabricated subjects; the signed-token case exercises the
 * hardened verifier against generated keys. Real Access is not exercised.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
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
const oldFingerprint='b2974dde4ca177420caecd810b8f008d582c93131317c6a822b5bb821c3c8c94';
const hardenedAccessFingerprint='1f3127c82f2079f82685f8f4ee56a82c390cf36dd7ef36273b4623e9ab3c9654';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function legacyWorker(t) {
  const dir=await mkdtemp(join(tmpdir(),'ds011-v03-rollback-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=await readFile(new URL('../legacy/v03/worker/index.mjs',import.meta.url));
  assert.equal(hash(source),oldFingerprint);
  await writeFile(join(dir,'index.mjs'),source);
  const access=await readFile(new URL('../worker/access.mjs',import.meta.url));
  assert.equal(hash(access),hardenedAccessFingerprint,'fallback must preserve the reviewed verifier, not historical deployed authentication');
  await writeFile(join(dir,'access.mjs'),access);
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

test('RB01 upgrade, legacy fallback and return preserve all six tables and journal receipts',async t=>{
  const legacy=await legacyWorker(t),{d1,db}=storage(t),e={...env(d1),
    WORKSPACE_GRANTS:[{subject:owner,principalId:'owner-a',scopeKind:'personal',scopeId:'personal-a',role:'owner'}],
    WORKSPACE_PROJECT_GRANTS:[{principalId:'owner-a',scopeKind:'personal',scopeId:'personal-a',projectId:'project-a',area:'Devon Works'}]
  };
  await seedCurrentState(d1);
  db.prepare('INSERT INTO push_devices(owner_sub,device_id,endpoint_hash,endpoint,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(owner,'existing-device','existing-hash','https://web.push.apple.com/synthetic-existing',1,1);
  db.prepare('INSERT INTO push_delivery_log(id,owner_sub,device_id,kind,status,created_at) VALUES(?,?,?,?,?,?)').run('delivery-a',owner,'existing-device','manual-test','accepted',1);
  db.prepare('INSERT INTO station_portfolio_cache(owner_sub,source_id,fetch_time,payload) VALUES(?,?,?,?)').run(owner,'synthetic-source',1793448000000,JSON.stringify([{id:'project-a',name:'Synthetic rollback project',area:'Devon Works',record:'https://www.notion.so/synthetic'}]));
  const tables=['push_devices','push_delivery_log','station_documents','station_write_audit','station_portfolio_cache'];
  const snapshot=()=>Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all()]));
  const before=snapshot();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='station_workspace_state'").get().n,0);
  const migration=await readFile(new URL('../worker/migrations/0003-scoped-workspace.sql',import.meta.url),'utf8');
  db.exec(migration);db.exec(migration);
  assert.deepEqual(snapshot(),before,'additive journal migration preserves every existing table');
  const query='?scopeKind=personal&scopeId=personal-a';
  const current=currentWorker({},identity(owner),()=>{throw Error('External transport forbidden');});
  const invoke=async(path,body)=>{
    const response=await current.fetch(request(path+query,body),e,{});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  };
  await invoke('/api/workspace/propose',{expectedGeneration:0,input:{operationId:'propose-a',recordId:'action-a',projectId:'project-a',summary:'Review fabricated fallback evidence',expectedRevision:0}});
  const approved=await invoke('/api/workspace/decide',{expectedGeneration:1,input:{operationId:'approve-a',recordId:'action-a',decision:'approved',expectedRevision:1}});
  assert.equal(approved.receipts.length,2);
  const journal=db.prepare('SELECT * FROM station_workspace_state').get();
  const fallback=legacy({},identity(owner),()=>{throw Error('External transport forbidden');});
  for(const path of ['/api/state','/api/workspace'+query])assert.equal((await fallback.fetch(request(path),e,{})).status,404,'legacy fallback cannot expose newer state');
  assert.equal((await fallback.fetch(request('/api/notifications/subscribe',{deviceId:'temporary-device',subscription:{endpoint:'https://web.push.apple.com/synthetic-temporary'}}),e,{})).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM push_devices').get().n,2);
  assert.equal((await fallback.fetch(request('/api/notifications/unsubscribe',{deviceId:'temporary-device'}),e,{})).status,200);
  assert.deepEqual(snapshot(),before,'legacy push operations preserve pre-upgrade rows');
  assert.deepEqual(db.prepare('SELECT * FROM station_workspace_state').get(),journal,'fallback must never change RB01 state');
  const resumed=await invoke('/api/workspace');
  const {receipt,duplicate,...expectedView}=approved;
  assert.equal(receipt.result,'approved');assert.equal(duplicate,false);
  assert.deepEqual(resumed,expectedView);
  assert.equal(resumed.actions[0].status,'approved');
  assert.equal(resumed.generation,2);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('guarded legacy fallback uses actual hardened JWT validation without an injected identity',async t=>{
  const legacy=await legacyWorker(t),{d1}=storage(t),e={...env(d1),
    ACCESS_ISSUER:'https://synthetic-fallback.cloudflareaccess.com',ACCESS_AUD:'synthetic-fallback',
    ACCESS_JWKS_URL:'https://synthetic-fallback.cloudflareaccess.com/cdn-cgi/access/certs'
  };
  const keys=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=keys.publicKey.export({format:'jwk'});
  Object.assign(jwk,{kid:'fallback-key',alg:'RS256',use:'sig'});
  t.mock.method(globalThis,'fetch',async url=>{
    assert.equal(url,e.ACCESS_JWKS_URL);return new Response(JSON.stringify({keys:[jwk]}));
  });
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const token=(claims={})=>{
    const input=encode({alg:'RS256',kid:jwk.kid})+'.'+encode({iss:e.ACCESS_ISSUER,aud:[e.ACCESS_AUD],sub:owner,email:ownerEmail,exp:Date.now()/1000+300,...claims});
    return input+'.'+sign('RSA-SHA256',Buffer.from(input),keys.privateKey).toString('base64url');
  };
  const app=legacy({'/index.html':{type:'text/html',body:'Synthetic guarded fallback'}});
  const check=claims=>app.fetch(request('/api/session',undefined,{'Cf-Access-Jwt-Assertion':token(claims)}),e,{});
  assert.equal((await check()).status,200);
  assert.equal((await check({exp:Date.now()/1000+300.25,nbf:Date.now()/1000-0.25})).status,200);
  for(const claims of [{nbf:'invalid'},{nbf:null},{iat:'invalid'},{iat:[]},{exp:1},{aud:['wrong']},
    {iss:'https://other.cloudflareaccess.com'}])assert.equal((await check(claims)).status,401);
  assert.equal((await check({email:'unapproved@example.test'})).status,403);
  assert.equal((await app.fetch(request('/api/session',undefined,{'X-Owner-Email':ownerEmail}),e,{})).status,401);
  const forged=token().split('.');forged[1]=encode({sub:owner,email:ownerEmail,exp:Date.now()/1000+300});
  assert.equal((await app.fetch(request('/api/session',undefined,{'Cf-Access-Jwt-Assertion':forged.join('.')}),e,{})).status,401);
});
