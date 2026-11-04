/**
 * Synthetic D1/SQLite recovery drill. Only fabricated fixtures are created.
 * This does not import, inspect, authenticate, or restore production D1 data.
 * Node's SQLite backup is NOT a substitute for a real Cloudflare D1 export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync, backup} from 'node:sqlite';
import {emptyState, getOwnerState, saveOwnerState} from '../worker/state.mjs';
import {createStation} from '../worker/index.mjs';

const origin='https://synthetic-restoration.example.test';
const ownerEmail='synthetic-owner@example.test';
const owners=['synthetic-subject-a','synthetic-subject-b'];
const auditOps=[
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
];
const schema=readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8');
const migration=readFileSync(new URL('../worker/migrations/0002-owner-state.sql',import.meta.url),'utf8');
const legacySchema=schema.split('-- V1.0 additive, owner-scoped private state.')[0];
const sha=value=>createHash('sha256').update(value).digest('hex');
const syntheticState=(suffix)=>{
 const state=emptyState();
 state.drafts=[{id:'local:restore-'+suffix,title:'Synthetic restoration record '+suffix,area:'Devon Works',project:null,destination:null,state:'Draft',createdAt:'2026-10-30T12:00:00.000Z'}];
 return state;
};
function d1Adapter(sqlite){return {
 prepare(sql){return {bind(...args){return {
  first:async()=>sqlite.prepare(sql).get(...args)??null,
  all:async()=>({results:sqlite.prepare(sql).all(...args)}),
  run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}})
 }}}},
 async batch(queries){sqlite.exec('BEGIN');try{const results=[];for(const q of queries)results.push(await q.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}
};}
function checkRecoveredSnapshot(sqlite){
 assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 const expected=['push_delivery_log','push_devices','station_documents','station_portfolio_cache','station_write_audit'];
 const actual=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
 assert.deepEqual(actual,expected,'the recovered schema must contain exactly the independently reviewed tables');
 const indexes=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
 assert.deepEqual(indexes,['push_log_owner_time','station_audit_owner_time'],'restore must retain reviewed performance indexes');
 const rows=sqlite.prepare('SELECT owner_sub,revision,schema_version,payload,last_operation FROM station_documents ORDER BY owner_sub').all();
 for(const row of rows){
  assert.equal(row.schema_version,1);
  assert(Number.isSafeInteger(row.revision)&&row.revision>0);
  const audit=sqlite.prepare('SELECT content_sha256 FROM station_write_audit WHERE owner_sub=? AND operation_id=? AND revision=?').get(row.owner_sub,row.last_operation,row.revision);
  assert(audit,'each latest state revision must have its matching durable operation');
  assert.equal(audit.content_sha256,sha(row.payload),'document payload must match its last audit checksum');
  assert.equal(JSON.parse(row.payload).version,1);
 }
 return rows.length;
}
function legacyPushSeed(sqlite){
 sqlite.prepare('INSERT INTO push_devices(owner_sub,device_id,endpoint_hash,endpoint,created_at,updated_at,active) VALUES(?,?,?,?,?,?,1)').run(owners[0],'synthetic-device-a','hash-a','https://web.push.apple.com/synthetic-a',100,100);
 sqlite.prepare('INSERT INTO push_devices(owner_sub,device_id,endpoint_hash,endpoint,created_at,updated_at,active) VALUES(?,?,?,?,?,?,1)').run(owners[1],'synthetic-device-b','hash-b','https://web.push.apple.com/synthetic-b',100,100);
 sqlite.prepare('INSERT INTO push_delivery_log(id,owner_sub,device_id,kind,status,created_at) VALUES(?,?,?,?,?,?)').run('synthetic-delivery-a',owners[0],'synthetic-device-a','manual-test','accepted',100);
}
async function seedOwnerState(sqlite){
 const d1=d1Adapter(sqlite);
 for(const [index,record] of [[0,syntheticState('a')],[1,syntheticState('b')]]){
  const result=await saveOwnerState(d1,owners[index],{state:record,expectedRevision:0,operationId:auditOps[index===0?0:2],action:'Synthetic offline drill'});
  assert.equal(result.revision,1);
 }
 const updated=syntheticState('a-revised');
 const next=await saveOwnerState(d1,owners[0],{state:updated,expectedRevision:1,operationId:auditOps[1],action:'Synthetic offline drill'});
 assert.equal(next.revision,2);
 sqlite.prepare('INSERT INTO station_portfolio_cache(owner_sub,source_id,fetch_time,payload) VALUES(?,?,?,?)').run(owners[0],'00000000-0000-4000-8000-000000000001',200,'[]');
}
function rowsByTable(sqlite,table){
 const allowed=new Set(['push_devices','push_delivery_log','station_documents','station_write_audit','station_portfolio_cache']);
 assert(allowed.has(table));
 return sqlite.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all();
}
const tables=['push_devices','push_delivery_log','station_documents','station_write_audit','station_portfolio_cache'];

async function temporaryBackup(t,seed){
 const dir=mkdtempSync(join(tmpdir(),'ds011-synthetic-restore-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const src=new DatabaseSync(':memory:');
 try {await seed(src);const destination=join(dir,'synthetic-backup.sqlite');await backup(src,destination);assert(existsSync(destination));return {destination,sourceRows:Object.fromEntries(tables.filter(table=>src.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name=?").get(table)).map(table=>[table,rowsByTable(src,table)]))};}
 finally{src.close();}
}

test('full synthetic snapshot restores both owners, push subscriptions, audit operations and portfolio cache',async t=>{
 const {destination,sourceRows}=await temporaryBackup(t,async db=>{db.exec(schema);legacyPushSeed(db);await seedOwnerState(db);});
 const restored=new DatabaseSync(destination);
 try {
  assert.equal(checkRecoveredSnapshot(restored),2);
  restored.exec(migration);restored.exec(migration); // additive migration is repeatable after restore
  assert.equal(checkRecoveredSnapshot(restored),2);
  for(const table of tables)assert.deepEqual(rowsByTable(restored,table),sourceRows[table],table+' survives restore unchanged');
  const adapter=d1Adapter(restored);
  const a=await getOwnerState(adapter,owners[0]),b=await getOwnerState(adapter,owners[1]);
  assert.equal(a.revision,2);assert.equal(b.revision,1);
  assert.match(a.state.drafts[0].title,/a-revised/);assert.match(b.state.drafts[0].title,/ b$/);
  const retry=await saveOwnerState(adapter,owners[0],{state:syntheticState('a'),expectedRevision:0,operationId:auditOps[0],action:'Synthetic offline drill'});
  assert.equal(retry.duplicate,true);assert.equal(retry.superseded,true);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM station_write_audit').get().n,3,'restored idempotent retry must not duplicate the audit');
  await assert.rejects(saveOwnerState(adapter,owners[1],{state:syntheticState('b-updated'),expectedRevision:0,operationId:'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',action:'Synthetic offline drill'}),/revision_conflict/);
  assert.equal((await getOwnerState(adapter,owners[1])).revision,1);
 }finally{restored.close();}
});

test('pre-migration legacy snapshot can be restored and extended without losing push history',async t=>{
 const {destination,sourceRows}=await temporaryBackup(t,async db=>{db.exec(legacySchema);legacyPushSeed(db);});
 const restored=new DatabaseSync(destination);
 try{
  assert.deepEqual(rowsByTable(restored,'push_devices'),sourceRows.push_devices);
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='station_documents'").get().n,0);
  restored.exec(migration);restored.exec(migration);
  assert.equal(checkRecoveredSnapshot(restored),0);
  assert.deepEqual(rowsByTable(restored,'push_devices'),sourceRows.push_devices);
  assert.deepEqual(rowsByTable(restored,'push_delivery_log'),sourceRows.push_delivery_log);
  assert.equal((await getOwnerState(d1Adapter(restored),owners[0])).revision,0);
 }finally{restored.close();}
});

test('seemingly valid SQLite snapshot with changed content but unchanged audit is rejected',async t=>{
 const {destination}=await temporaryBackup(t,async db=>{db.exec(schema);await seedOwnerState(db);});
 const restored=new DatabaseSync(destination);
 try {
  assert.equal(checkRecoveredSnapshot(restored),2);
  const fake=JSON.stringify(syntheticState('tampered'));
  restored.prepare('UPDATE station_documents SET payload=? WHERE owner_sub=?').run(fake,owners[0]);
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok','physical database integrity alone is insufficient');
  assert.throws(()=>checkRecoveredSnapshot(restored),/checksum/);
 }finally{restored.close();}
});

test('state API remains owner-scoped and rejects an unrelated email after isolated restore',async t=>{
 const {destination}=await temporaryBackup(t,async db=>{db.exec(schema);await seedOwnerState(db);});
 const restored=new DatabaseSync(destination),DB=d1Adapter(restored),env={APP_ORIGIN:origin,OWNER_EMAIL:ownerEmail,DB};
 const request=new Request(origin+'/api/state');
 try {
  const a=createStation({},async()=>({subject:owners[0],email:ownerEmail}));
  const b=createStation({},async()=>({subject:owners[1],email:ownerEmail}));
  const other=createStation({},async()=>({subject:owners[0],email:'unapproved@example.test'}));
  const aState=await (await a.fetch(request,env,{})).json();
  const bState=await (await b.fetch(request,env,{})).json();
  assert.equal(aState.revision,2);assert.equal(bState.revision,1);
  assert.notEqual(aState.state.drafts[0].title,bState.state.drafts[0].title);
  assert.equal((await other.fetch(request,env,{})).status,403);
  assert.equal((await a.fetch(new Request('https://attacker.example.test/api/state'),env,{})).status,403);
 }finally{restored.close();}
});

test('schema drift is detected instead of accepting a partly restored synthetic database',async t=>{
 const {destination}=await temporaryBackup(t,async db=>{db.exec(schema);await seedOwnerState(db);});
 const restored=new DatabaseSync(destination);
 try {
  assert.equal(checkRecoveredSnapshot(restored),2);
  restored.exec('DROP INDEX station_audit_owner_time');
  assert.throws(()=>checkRecoveredSnapshot(restored),/performance indexes/);
 }finally{restored.close();}
});
