import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openSyntheticAdapter } from '../src/synthetic-adapter.mjs';

const owner={principalId:'alice',role:'owner',scopeKind:'personal',scopeId:'scope1'};
const other={principalId:'bob',role:'owner',scopeKind:'personal',scopeId:'scope2'};
const project=x=>({projectId:'p1',scopeKind:x.scopeKind,scopeId:x.scopeId,title:'Synthetic',freshness:'cached',source:{sourceSystem:'notion',sourceType:'project',sourceId:'source',observedAt:'2026-01-01T00:00:00.000Z'}});
const now=1800000000;
const claims=x=>({iss:'synthetic-issuer',aud:'synthetic-app',sub:x.principalId,scopeKind:x.scopeKind,scopeId:x.scopeId,iat:now-1,exp:now+120});
const makeToken=(privateKey,payload)=>{const body=Buffer.from(JSON.stringify(payload));return `${body.toString('base64url')}.${sign(null,body,privateKey).toString('base64url')}`;};
const setup=db=>{const keys=generateKeyPairSync('ed25519');const config={db,publicKey:keys.publicKey,issuer:'synthetic-issuer',audience:'synthetic-app',grants:[owner,other],seeds:[{identity:owner,projects:[project(owner)]},{identity:other,projects:[project(other)]}],clock:()=>now*1000};return {keys,config,adapter:openSyntheticAdapter(config)};};
const proposal={operationId:'op1',recordId:'a1',projectId:'p1',summary:'Review synthetic plan',expectedRevision:0};

test('verified synthetic identity, scoped storage, conflict and idempotency',()=>{
 const db=new DatabaseSync(':memory:');try {const {keys,adapter}=setup(db), alice=makeToken(keys.privateKey,claims(owner)), bob=makeToken(keys.privateKey,claims(other));
 assert.equal(adapter.read(alice).generation,0);assert.deepEqual(adapter.read(bob).actions,[]);
 const first=adapter.mutate(alice,0,'propose',proposal);assert.equal(first.generation,1);assert.equal(adapter.read(bob).actions.length,0);
 assert.deepEqual(adapter.mutate(alice,0,'propose',proposal),first);
 assert.throws(()=>adapter.mutate(alice,0,'propose',{...proposal,operationId:'op2',recordId:'a2'}));
 assert.throws(()=>adapter.mutate(alice,1,'propose',{...proposal,summary:'different'}));assert.equal(adapter.read(alice).actions.length,1);
 const decided=adapter.mutate(alice,1,'decide',{operationId:'op2',recordId:'a1',decision:'approved',expectedRevision:1});assert.equal(decided.generation,2);
 assert.throws(()=>adapter.mutate(bob,0,'decide',{operationId:'x',recordId:'a1',decision:'approved',expectedRevision:1}));
 assert.equal(adapter.read(alice).receipts.length,2);assert.equal(adapter.read(bob).receipts.length,0);
 }finally{db.close();}
});

test('forged, expired, mis-scoped and malformed assertions fail closed',()=>{
 const db=new DatabaseSync(':memory:');try {const {keys,adapter}=setup(db), fake=generateKeyPairSync('ed25519');const valid=claims(owner);
 for(const token of [makeToken(fake.privateKey,valid),makeToken(keys.privateKey,{...valid,aud:'other'}),makeToken(keys.privateKey,{...valid,iss:'other'}),makeToken(keys.privateKey,{...valid,exp:now}),makeToken(keys.privateKey,{...valid,iat:now+1}),makeToken(keys.privateKey,{...valid,exp:now+400}),makeToken(keys.privateKey,{...valid,sub:'mallory'}),makeToken(keys.privateKey,{...valid,scopeId:'scope2'}),makeToken(keys.privateKey,{...valid,role:'owner'}),'x'.repeat(4097),'e30.AA']) assert.throws(()=>adapter.read(token));
 const good=makeToken(keys.privateKey,valid);assert.throws(()=>adapter.mutate(good,0,'propose',{...proposal,principalId:'bob'}));assert.deepEqual(adapter.read(good).actions,[]);
 }finally{db.close();}
});

test('SQLite restart preserves history and retries; two connections detect stale writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'devonstation-synthetic-'));const path=join(dir,'synthetic.sqlite');const a=new DatabaseSync(path),b=new DatabaseSync(path);
 try {const {keys,config,adapter}=setup(a), token=makeToken(keys.privateKey,claims(owner));const second=openSyntheticAdapter({...config,db:b});
 const first=adapter.mutate(token,0,'propose',proposal);assert.equal(second.read(token).generation,1);
 assert.throws(()=>second.mutate(token,0,'propose',{...proposal,operationId:'op2',recordId:'a2'}));assert.equal(second.read(token).actions.length,1);
 a.close();const reopened=new DatabaseSync(path);try {const restored=openSyntheticAdapter({...config,db:reopened});assert.deepEqual(restored.mutate(token,0,'propose',proposal),first);assert.equal(restored.read(token).receipts.length,1);}finally{reopened.close();}
 }finally{try{a.close()}catch{}b.close();await rm(dir,{recursive:true,force:true});}
});

test('tampered database snapshots fail closed',()=>{
 const db=new DatabaseSync(':memory:');try{const {keys,adapter}=setup(db),token=makeToken(keys.privateKey,claims(owner));adapter.mutate(token,0,'propose',proposal);db.prepare('UPDATE synthetic_scope_state SET snapshot=? WHERE scope_id=?').run('{}','scope1');assert.throws(()=>adapter.read(token));}finally{db.close();}
});

test('failure after update and during commit leaves no partial state and supports retry',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');const {keys,adapter}=setup(db), token=makeToken(keys.privateKey,claims(owner));
  const before=adapter.read(token);
  db.exec("CREATE TRIGGER fail_after_update AFTER UPDATE ON synthetic_scope_state BEGIN SELECT RAISE(ABORT, 'injected update failure'); END");
  assert.throws(()=>adapter.mutate(token,0,'propose',proposal),/injected update failure/);assert.deepEqual(adapter.read(token),before);
  db.exec('DROP TRIGGER fail_after_update');
  db.exec('CREATE TABLE synthetic_test_parent (id INTEGER PRIMARY KEY); CREATE TABLE synthetic_test_child (parent_id INTEGER REFERENCES synthetic_test_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_on_commit AFTER UPDATE ON synthetic_scope_state BEGIN INSERT INTO synthetic_test_child VALUES (99); END');
  assert.throws(()=>adapter.mutate(token,0,'propose',proposal),/FOREIGN KEY/);assert.deepEqual(adapter.read(token),before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM synthetic_test_child').get().n,0);
  db.exec('DROP TRIGGER fail_on_commit');const result=adapter.mutate(token,0,'propose',proposal);assert.equal(result.generation,1);assert.equal(adapter.read(token).receipts.length,1);
 }finally{db.close();}
});

test('simultaneous local writers serialize and reject one stale new operation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'devonstation-race-'));const path=join(dir,'synthetic.sqlite');const db=new DatabaseSync(path);let workers=[];
 try {
  const {keys,adapter}=setup(db),token=makeToken(keys.privateKey,claims(owner)),gateBuffer=new SharedArrayBuffer(8),gate=new Int32Array(gateBuffer);
  const common={path,publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}),owner,token,gateBuffer,now};
  const run=operationId=>new Promise((resolve,reject)=>{
   const worker=new Worker(new URL('./fixtures/synthetic-writer.mjs',import.meta.url),{workerData:{...common,proposal:{...proposal,operationId,recordId:operationId}}});workers.push(worker);
   worker.on('error',reject);worker.on('message',message=>{if(message.type==='ready'){if(Atomics.load(gate,0)===2){Atomics.store(gate,1,1);Atomics.notify(gate,1,2);}}else if(message.type==='fatal')reject(new Error(message.error));else if(message.type==='result')resolve(message);});
   worker.on('exit',code=>{if(code!==0)reject(new Error(`writer exited ${code}`));});
  });
  const results=await Promise.all([run('race1'),run('race2')]);assert.equal(results.filter(x=>x.ok).length,1);assert.match(results.find(x=>!x.ok).error,/denied or invalid request/);
  const state=adapter.read(token);assert.equal(state.generation,1);assert.equal(state.actions.length,1);assert.equal(state.receipts.length,1);
 }finally{await Promise.all(workers.map(w=>w.terminate()));db.close();await rm(dir,{recursive:true,force:true});}
});

test('simultaneous duplicate operation yields the same receipt without a second revision',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'devonstation-retry-race-'));const path=join(dir,'synthetic.sqlite');const db=new DatabaseSync(path);let workers=[];
 try {
  const {keys,adapter}=setup(db),token=makeToken(keys.privateKey,claims(owner)),gateBuffer=new SharedArrayBuffer(8),gate=new Int32Array(gateBuffer);
  const common={path,publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}),owner,token,gateBuffer,now,proposal};
  const run=()=>new Promise((resolve,reject)=>{const w=new Worker(new URL('./fixtures/synthetic-writer.mjs',import.meta.url),{workerData:common});workers.push(w);w.on('error',reject);w.on('message',m=>{if(m.type==='ready'){if(Atomics.load(gate,0)===2){Atomics.store(gate,1,1);Atomics.notify(gate,1,2);}}else if(m.type==='fatal')reject(new Error(m.error));else if(m.type==='result')resolve(m);});w.on('exit',code=>{if(code!==0)reject(new Error(`writer exited ${code}`));});});
  const [a,b]=await Promise.all([run(),run()]);assert.equal(a.ok,true);assert.equal(b.ok,true);assert.deepEqual(a.value,b.value);
  const state=adapter.read(token);assert.equal(state.generation,1);assert.equal(state.actions.length,1);assert.equal(state.receipts.length,1);
 }finally{await Promise.all(workers.map(w=>w.terminate()));db.close();await rm(dir,{recursive:true,force:true});}
});

test('an assertion expiring before the write lock is held cannot mutate state',()=>{
 const db=new DatabaseSync(':memory:');try {
  const {keys,config}=setup(db),token=makeToken(keys.privateKey,claims(owner));let clockCalls=0;
  const changing=openSyntheticAdapter({...config,seeds:[],clock:()=>((clockCalls++===0)?now:now+121)*1000});
  assert.throws(()=>changing.mutate(token,0,'propose',proposal));
  const current=openSyntheticAdapter(config).read(token);assert.equal(current.generation,0);assert.deepEqual(current.actions,[]);assert.deepEqual(current.receipts,[]);
 }finally{db.close();}
});

test('an assertion expiring before commit rolls the transaction back',()=>{
 const db=new DatabaseSync(':memory:');try {
  const {keys,config}=setup(db),token=makeToken(keys.privateKey,claims(owner));let clockCalls=0;
  const changing=openSyntheticAdapter({...config,seeds:[],clock:()=>((clockCalls++<2)?now:now+121)*1000});
  assert.throws(()=>changing.mutate(token,0,'propose',proposal));
  const current=openSyntheticAdapter(config).read(token);assert.equal(current.generation,0);assert.deepEqual(current.actions,[]);assert.deepEqual(current.receipts,[]);
 }finally{db.close();}
});
