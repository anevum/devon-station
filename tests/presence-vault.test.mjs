import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createStation} from '../worker/index.mjs';
import {presenceBlank,presenceDraft,presenceSnapshot,presenceReady,presenceMarkPublished} from '../src/presence-core.mjs';
import {encryptPresenceVault,decryptPresenceVault,validatePresenceEnvelope} from '../src/presence-vault-crypto.mjs';
import {validateVaultEnvelope} from '../worker/presence-vault.mjs';

const origin='https://devon-station.example.test';
const envBase={APP_ORIGIN:origin,OWNER_EMAIL:'owner@example.test'};
const me={subject:'owner-synthetic-1',email:'owner@example.test'};
const pass='A reasonably long private vault passphrase.';
const time='2026-11-02T17:00:00Z';
function fixture(){
 const draft=presenceDraft({
  title:'Original studio update',format:'photo',channels:['facebook','instagram'],
  captions:{facebook:'A new drawing and a real story.',instagram:'A new drawing and details.',threads:''},
  privacyReviewed:true
 },null,time,'ps-12345678-1234-4123-8123-123456789012');
 const ready=presenceReady(draft,time);
 const partial=presenceMarkPublished(ready,'facebook','https://www.facebook.com/owner/posts/1234567',time);
 return {version:1,drafts:[partial],snapshots:[presenceSnapshot({platform:'facebook',observedOn:'2026-11-02',periodDays:30,followers:34,views:5000,engagements:362})]};
}
function sqliteDB({migrate=true}={}){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8'));
 if(migrate)sqlite.exec(readFileSync(new URL('../worker/migrations/0004-presence-vault.sql',import.meta.url),'utf8'));
 return {sqlite,db:{
  prepare(sql){return{bind(...args){return{
   first:async()=>sqlite.prepare(sql).get(...args)??null,
   all:async()=>({results:sqlite.prepare(sql).all(...args)}),
   run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}})
  }}}},
  async batch(stmts){sqlite.exec('BEGIN');try{const out=[];for(const x of stmts)out.push(await x.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}
 },close:()=>sqlite.close()};
}
function request(path,body,extraHeaders={}){
 return new Request(origin+path,body===undefined?{headers:extraHeaders}:{
  method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...extraHeaders},body:JSON.stringify(body)
 });
}
const operationId='12345678-1234-4123-8123-123456789012';
const operation2='12345678-1234-4123-8123-123456789013';

test('encryption roundtrip uses randomized ciphertext and preserves owner-entered historical data',async()=>{
 const state=fixture();
 const a=await encryptPresenceVault(state,pass),b=await encryptPresenceVault(state,pass);
 assert.equal(a.format,'devon-station-presence-vault');
 assert.equal(a.cipher,'AES-256-GCM');
 assert.equal(a.kdf,'PBKDF2-SHA256');
 assert.notEqual(a.payload,b.payload);
 assert(!JSON.stringify(a).includes('Original studio update'));
 assert(!JSON.stringify(a).includes('A new drawing'));
 assert.deepEqual(validatePresenceEnvelope(a),a);
 const clear=await decryptPresenceVault(a,pass);
 assert.equal(clear.drafts.length,1);
 assert.equal(clear.drafts[0].title,'Original studio update');
 assert.equal(clear.drafts[0].stage,'ready');
 assert.equal(clear.drafts[0].published.facebook.source,'owner-entered');
 assert.equal(clear.snapshots[0].followers,34);
 assert.equal(clear.snapshots[0].views,5000);
 assert.equal(clear.snapshots[0].engagements,362);
 assert.deepEqual(await decryptPresenceVault(b,pass),clear);
});
test('wrong passphrase, modified ciphertext, altered metadata, invalid schema and short passphrase fail closed',async()=>{
 const envelope=await encryptPresenceVault(fixture(),pass);
 await assert.rejects(decryptPresenceVault(envelope,'Something else 1234567890'),/incorrect|modified/i);
 const damaged={...envelope,payload:envelope.payload.slice(0,-2)+'aa'};
 await assert.rejects(decryptPresenceVault(damaged,pass),/incorrect|modified|invalid/i);
 assert.throws(()=>validatePresenceEnvelope({...envelope,extra:'plaintext'}),/Invalid encrypted/);
 assert.throws(()=>validateVaultEnvelope({...envelope,source:'secret'}),/invalid_encrypted/);
 await assert.rejects(encryptPresenceVault(fixture(),'too short'),/14/);
 await assert.rejects(encryptPresenceVault({...fixture(),drafts:[{id:'bad'}]},pass),/rejected|invalid/i);
 await assert.rejects(encryptPresenceVault({...fixture(),tokens:'token'},pass),/Invalid Presence Studio data/);
});
test('owner-only encrypted vault uses signed identity, strict origin/media type and only ciphertext leaves the browser',async()=>{
 const s=sqliteDB(),app=createStation({},async()=>me),env={...envBase,DB:s.db};
 try{
  const snapshot=await encryptPresenceVault(fixture(),pass);
  const init=await app.fetch(request('/api/presence/vault'),env,{});
  assert.equal(init.status,200);
  assert.deepEqual(await init.json(),{revision:0,exists:false,updatedAt:null,envelope:null});
  const saved=await app.fetch(request('/api/presence/vault',{operationId,expectedRevision:0,envelope:snapshot}),env,{});
  assert.equal(saved.status,200);assert.equal((await saved.json()).revision,1);
  const read=await (await app.fetch(request('/api/presence/vault'),env,{})).json();
  assert.equal(read.revision,1);
  assert.equal(read.envelope.payload,snapshot.payload);
  const dbRow=s.sqlite.prepare('SELECT envelope,revision FROM station_presence_vault WHERE owner_sub=?').get(me.subject);
  assert(!dbRow.envelope.includes('Original studio update'));
  assert(!dbRow.envelope.includes('A new drawing'));
  assert.equal(dbRow.revision,1);
  const anotherOwner=createStation({},async()=>({subject:'another-synthetic-owner',email:'owner@example.test'}));
  const other=await (await anotherOwner.fetch(request('/api/presence/vault'),env,{})).json();
  assert.equal(other.revision,0);assert.equal(other.envelope,null);
  const invalidOwner=createStation({},async()=>({...me,email:'other@example.test'}));
  assert.equal((await invalidOwner.fetch(request('/api/presence/vault'),env,{})).status,403);
  assert.equal((await createStation({}).fetch(request('/api/presence/vault'),env,{})).status,401);
  assert.equal((await app.fetch(request('/api/presence/vault',{operationId:operation2,expectedRevision:1,envelope:snapshot},{Origin:'https://evil.test'}),env,{})).status,403);
  assert.equal((await app.fetch(new Request(origin+'/api/presence/vault',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:'{}'}),env,{})).status,403);
  assert.equal((await app.fetch(request('/api/presence/vault'),envBase,{})).status,503);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) n FROM station_presence_vault_audit').get().n,1);
 }finally{s.close();}
});
test('idempotent revision receipts and stale-write conflicts never overwrite newer ciphertext',async()=>{
 const s=sqliteDB(),app=createStation({},async()=>me),env={...envBase,DB:s.db};
 try{
  const first=await encryptPresenceVault(fixture(),pass);
  const input={operationId,expectedRevision:0,envelope:first};
  assert.equal((await app.fetch(request('/api/presence/vault',input),env,{})).status,200);
  const retry=await (await app.fetch(request('/api/presence/vault',input),env,{})).json();
  assert.equal(retry.duplicate,true);assert.equal(retry.revision,1);
  const changed=await encryptPresenceVault(fixture(),pass);
  assert.equal((await app.fetch(request('/api/presence/vault',{...input,envelope:changed}),env,{})).status,409);
  assert.equal((await app.fetch(request('/api/presence/vault',{operationId:operation2,expectedRevision:0,envelope:changed}),env,{})).status,409);
  assert.equal((await app.fetch(request('/api/presence/vault',{operationId:operation2,expectedRevision:1,envelope:changed}),env,{})).status,200);
  const oldRetry=await (await app.fetch(request('/api/presence/vault',input),env,{})).json();
  assert.equal(oldRetry.duplicate,true);assert.equal(oldRetry.superseded,true);
  assert.equal(oldRetry.currentRevision,2);
  assert.equal((await (await app.fetch(request('/api/presence/vault'),env,{})).json()).envelope.payload,changed.payload);
  const audit=s.sqlite.prepare('SELECT * FROM station_presence_vault_audit ORDER BY revision').all();
  assert.equal(audit.length,2);
  assert(!JSON.stringify(audit).includes('Original studio update'));
  assert(audit.every(x=>/^[a-f0-9]{64}$/.test(x.content_sha256)));
 }finally{s.close();}
});
test('malformed or oversized writes are denied and do not change stored records',async()=>{
 const s=sqliteDB(),app=createStation({},async()=>me),env={...envBase,DB:s.db};
 try{
  const envelope=await encryptPresenceVault(fixture(),pass);
  for(const payload of [
   {operationId,expectedRevision:0,envelope:{...envelope,payload:'bad*'}},
   {operationId,expectedRevision:0,envelope:{...envelope,extra:'plaintext'}},
   {operationId,expectedRevision:0,envelope:{...envelope,payload:''}},
   {operationId,expectedRevision:0,envelope,privateToken:'do-not-store'}
  ]){
   assert.equal((await app.fetch(request('/api/presence/vault',payload),env,{})).status,400);
  }
  const huge={operationId,expectedRevision:0,envelope:{...envelope,payload:'A'.repeat(1100000)}};
  assert.equal((await app.fetch(request('/api/presence/vault',huge),env,{})).status,413);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) n FROM station_presence_vault').get().n,0);
 }finally{s.close();}
});
test('additive migration is repeatable and does not change existing owner-state, push devices or workspaces',()=>{
 const s=sqliteDB({migrate:false});
 try{
  s.sqlite.prepare("INSERT INTO station_documents(owner_sub,revision,schema_version,payload,updated_at,last_operation) VALUES(?,?,?,?,?,?)").run('old',1,1,'{"version":1}',100,'old-op');
  s.sqlite.prepare("INSERT INTO push_devices(owner_sub,device_id,endpoint_hash,endpoint,created_at,updated_at,active) VALUES(?,?,?,?,?,?,1)").run('old','synthetic-device','hash-1','https://push.test/example',100,100);
  const migration=readFileSync(new URL('../worker/migrations/0004-presence-vault.sql',import.meta.url),'utf8');
  s.sqlite.exec(migration);s.sqlite.exec(migration);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) n FROM station_documents').get().n,1);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) n FROM push_devices').get().n,1);
  assert.equal(s.sqlite.prepare('SELECT COUNT(*) n FROM station_presence_vault').get().n,0);
  const columns=s.sqlite.prepare("PRAGMA table_info('station_presence_vault')").all().map(r=>r.name);
  assert.deepEqual(columns,['owner_sub','revision','envelope','updated_at','last_operation']);
  assert(!columns.includes('plaintext'));
 }finally{s.close();}
});
