/* Disposable, file-backed SQLite rehearsal of the proposed D1 0004 migration.
 * Never accepts a user database path, uses no Cloudflare credentials and never
 * applies schema changes to a deployed or existing owner database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {encryptPresenceVault,decryptPresenceVault} from '../src/presence-vault-crypto.mjs';
import {readPresenceVault,savePresenceVault} from '../worker/presence-vault.mjs';

const read = p => readFileSync(new URL('../'+p,import.meta.url),'utf8');
const proposed=read('worker/migrations/0004-presence-vault.sql');
const existing=['push_devices','push_delivery_log','station_documents','station_write_audit','station_portfolio_cache','station_workspace_state'];
const sampleOwner='synthetic-presence-owner';
const samplePassphrase='Synthetic owner recovery passphrase for migration rehearsal.';
const op='11111111-2222-4333-8444-555555555555';
function tables(db,names=existing){
 return Object.fromEntries(names.map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
}
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const hasTable=(db,name)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
function seed(db){
 db.exec(read('worker/schema.sql'));
 db.exec(read('worker/migrations/0003-scoped-workspace.sql'));
 db.prepare('INSERT INTO station_documents(owner_sub,revision,schema_version,payload,updated_at,last_operation) VALUES(?,?,1,?,?,?)')
   .run(sampleOwner,2,'{"version":1,"drafts":[]}',1793655000000,'synthetic-old-op');
 db.prepare('INSERT INTO station_write_audit(owner_sub,operation_id,revision,action,content_sha256,created_at) VALUES(?,?,?,?,?,?)')
   .run(sampleOwner,'11111111-2222-4333-8444-555555555501',2,'Previous owner state operation','a'.repeat(64),1793655000000);
 db.prepare('INSERT INTO station_portfolio_cache(owner_sub,source_id,fetch_time,payload) VALUES(?,?,?,?)')
   .run(sampleOwner,'synthetic-portfolio',1793655000000,'[{"id":"local-example"}]');
 db.prepare('INSERT INTO push_devices(owner_sub,device_id,endpoint_hash,endpoint,created_at,updated_at,active) VALUES(?,?,?,?,?,?,1)')
   .run(sampleOwner,'synthetic-device','synthetic-endpoint-hash','https://push.invalid/example',1793655000000,1793655000000);
 db.prepare('INSERT INTO push_delivery_log(id,owner_sub,device_id,kind,status,service_status,created_at) VALUES(?,?,?,?,?,?,?)')
   .run('synthetic-delivery',sampleOwner,'synthetic-device','manual-test','accepted',202,1793655000000);
 db.prepare('INSERT INTO station_workspace_state(owner_sub,scope_kind,scope_id,principal_id,generation,snapshot,content_sha256) VALUES(?,?,?,?,?,?,?)')
   .run(sampleOwner,'personal','personal-a','synthetic-principal',3,'{"synthetic":true}','b'.repeat(64));
}
function adapter(db){
 return {
  prepare(sql){return {bind(...params){return {
   first:async()=>db.prepare(sql).get(...params)??null,
   run:async()=>({meta:{changes:Number(db.prepare(sql).run(...params).changes)}})
  };}}},
  async batch(queries){
   db.exec('BEGIN IMMEDIATE');
   try{const result=[];for(const query of queries)result.push(await query.run());db.exec('COMMIT');return result;}
   catch(error){db.exec('ROLLBACK');throw error;}
  }
 };
}
test('disposable migration rehearsal: pre-backup, rollback, idempotent migrate, encrypted write and byte-faithful recovery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ds-presence-rehearsal-'));
 let source,previous,migrated,recovered;
 try{
  const sourceFile=join(dir,'owner-before.sqlite');
  const preBackup=join(dir,'pre-migration-backup.sqlite');
  const postBackup=join(dir,'post-migration-backup.sqlite');
  source=new DatabaseSync(sourceFile);
  seed(source);
  const before=tables(source),beforeHash=digest(before);
  assert.equal(source.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert(!hasTable(source,'station_presence_vault'));
  assert(!hasTable(source,'station_presence_vault_audit'));

  // A real SQLite backup is taken before migration, on a separate file.
  await backup(source,preBackup);
  assert(existsSync(preBackup));
  previous=new DatabaseSync(preBackup);
  assert.equal(digest(tables(previous)),beforeHash);

  // An interrupted migration must remain transactional and leave originals untouched.
  source.exec('BEGIN IMMEDIATE');
  try{
   source.exec(proposed);
   assert(hasTable(source,'station_presence_vault'));
   assert.throws(()=>source.exec('CREATE TABLE station_documents (broken INTEGER)'),/already exists/i);
  }finally{source.exec('ROLLBACK');}
  assert(!hasTable(source,'station_presence_vault'));
  assert(!hasTable(source,'station_presence_vault_audit'));
  assert.equal(digest(tables(source)),beforeHash);

  // The approved SQL is repeatable and additive. Existing data is byte-preserved.
  source.exec(proposed);
  source.exec(proposed);
  assert(hasTable(source,'station_presence_vault'));
  assert(hasTable(source,'station_presence_vault_audit'));
  assert.equal(digest(tables(source)),beforeHash);
  assert.equal(source.prepare('PRAGMA integrity_check').get().integrity_check,'ok');

  // Store only ciphertext using the same revision/audit contract as the Worker.
  const clear={version:1,drafts:[],snapshots:[]};
  const envelope=await encryptPresenceVault(clear,samplePassphrase);
  const saved=await savePresenceVault(adapter(source),sampleOwner,{expectedRevision:0,operationId:op,envelope});
  assert.equal(saved.revision,1);
  const ciphertext=source.prepare('SELECT envelope FROM station_presence_vault WHERE owner_sub=?').get(sampleOwner).envelope;
  assert(!ciphertext.includes(samplePassphrase));
  assert(!ciphertext.includes('"drafts"'));
  assert.equal(digest(tables(source)),beforeHash);
  assert.equal(source.prepare('SELECT COUNT(*) AS n FROM station_presence_vault_audit WHERE owner_sub=?').get(sampleOwner).n,1);

  // Real SQLite post-upgrade snapshot; verify it is independently readable.
  await backup(source,postBackup);
  assert(existsSync(postBackup));
  migrated=new DatabaseSync(postBackup);
  assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(digest(tables(migrated)),beforeHash);
  assert.equal((await readPresenceVault(adapter(migrated),sampleOwner)).revision,1);
  const restored=await decryptPresenceVault((await readPresenceVault(adapter(migrated),sampleOwner)).envelope,samplePassphrase);
  assert.deepEqual(restored,clear);

  // Roll back from the pre-upgrade snapshot into another disposable file.
  // No existing customer data, audit rows or source DB are touched.
  const restoredFile=join(dir,'restored-legacy.sqlite');
  await backup(previous,restoredFile);
  recovered=new DatabaseSync(restoredFile);
  assert.equal(recovered.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(digest(tables(recovered)),beforeHash);
  assert(!hasTable(recovered,'station_presence_vault'));
  assert.equal(source.prepare('SELECT revision FROM station_presence_vault WHERE owner_sub=?').get(sampleOwner).revision,1);
  assert.equal(digest(tables(source)),beforeHash);
  console.log(JSON.stringify({rehearsal:'sqlite isolated migration and rollback',preservedTables:existing.length,integrity:'ok',encryptedRevision:1,baselineSHA256:beforeHash,productionModified:false}));
 }finally{
  recovered?.close();migrated?.close();previous?.close();source?.close();
  rmSync(dir,{recursive:true,force:true});
 }
});
