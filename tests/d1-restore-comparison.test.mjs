import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,linkSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyD1Restore} from '../tools/verify-d1-restore.mjs';

const schema=readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8');
const journal=readFileSync(new URL('../worker/migrations/0003-scoped-workspace.sql',import.meta.url),'utf8');
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const deny=fn=>assert.throws(fn,error=>error.message==='d1_restore_comparison_refused');
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'ds-restore-compare-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {dir,source:join(dir,'source.sqlite'),target:join(dir,'target.sqlite')};
}
function create(path,{reverse=false,withJournal=false,internal=false,compact=false}={}){
  const db=new DatabaseSync(path);
  try{
    const source=schema+(withJournal?'\n'+journal:'');
    db.exec(compact?source.replace(/--[^\n]*/g,'').replace(/\s+/g,' ').replace(/\s*([(),])\s*/g,'$1'):source);
    const labels=reverse?['b','a']:['a','b'];
    for(const label of labels){
      db.prepare('INSERT INTO push_devices VALUES (?,?,?,?,?,?,?,?)').run('synthetic-'+label,'device-'+label,'hash-'+label,'https://push.example.test/'+label,9007199254740993n,100,null,1);
      db.prepare('INSERT INTO push_delivery_log VALUES (?,?,?,?,?,?,?)').run('delivery-'+label,'synthetic-'+label,'device-'+label,'manual-test','accepted',201,101);
      db.prepare('INSERT INTO station_documents VALUES (?,?,?,?,?,?)').run('synthetic-'+label,1,1,'Fabricated 私密 \\0 data '+label,100,'operation-'+label);
      db.prepare('INSERT INTO station_write_audit VALUES (?,?,?,?,?,?)').run('synthetic-'+label,'operation-'+label,1,'Synthetic action','a'.repeat(64),100);
      db.prepare('INSERT INTO station_portfolio_cache VALUES (?,?,?,?)').run('synthetic-'+label,'synthetic-source',100,Buffer.from([0,1,255]));
      if(withJournal)db.prepare('INSERT INTO station_workspace_state VALUES (?,?,?,?,?,?,?)').run('synthetic-'+label,'personal','synthetic-scope','synthetic-principal',1,'Synthetic snapshot','b'.repeat(64));
    }
    if(internal)db.exec("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID; INSERT INTO _cf_KV VALUES ('synthetic-provider-only','not portable');");
  }finally{db.close();}
}
function mutate(path,sql){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}

test('read-only full application comparison ignores insertion order and preserves both file hashes',t=>{
  const f=fixture(t);create(f.source);create(f.target,{reverse:true,compact:true});
  const before=[digest(f.source),digest(f.target)],files=readdirSync(f.dir);
  const result=verifyD1Restore(f.source,f.target);
  assert.equal(result.status,'OFFLINE_APPLICATION_COPY_MATCH');
  assert.deepEqual(Object.values(result.rowCounts),[2,2,2,2,2]);
  assert.equal(result.cloudflareRestoreVerified,false);
  assert.equal(result.productionCutoverAuthorized,false);
  assert.equal(result.providerMetadataCompared,false);
  assert.deepEqual([digest(f.source),digest(f.target)],before);
  assert.deepEqual(readdirSync(f.dir),files,'no sidecars, reports or exports created');
  assert(!JSON.stringify(result).includes('Fabricated'));
  assert(!JSON.stringify(result).includes('example.test'));
});

test('same-count alterations in every application table fail, including typed values',t=>{
  const f=fixture(t);create(f.source,{withJournal:true});
  const mutations=[
    "UPDATE push_devices SET endpoint='https://different.example.test'",
    'UPDATE push_devices SET created_at=9007199254740992',
    "UPDATE push_delivery_log SET service_status=400",
    "UPDATE station_documents SET payload='Fabricated altered record'",
    "UPDATE station_write_audit SET action='Altered audit'",
    "UPDATE station_portfolio_cache SET payload='0001ff'",
    "UPDATE station_workspace_state SET snapshot='Altered receipt'"
  ];
  for(const sql of mutations){
    if(existsSync(f.target))rmSync(f.target);
    create(f.target,{withJournal:true});mutate(f.target,sql);
    deny(()=>verifyD1Restore(f.source,f.target));
  }
});

test('journal-inclusive equality and additive empty-journal mode are separate explicit checks',t=>{
  const f=fixture(t);create(f.source);create(f.target);
  mutate(f.target,journal);
  deny(()=>verifyD1Restore(f.source,f.target));
  const before=[digest(f.source),digest(f.target)];
  const result=verifyD1Restore(f.source,f.target,{mode:'additive-empty-journal'});
  assert.equal(result.emptyAdditiveJournalVerified,true);
  assert.deepEqual([digest(f.source),digest(f.target)],before,'verifier never applies migration');
  mutate(f.target,"INSERT INTO station_workspace_state VALUES ('synthetic','personal','scope','principal',1,'Synthetic new receipt','digest')");
  deny(()=>verifyD1Restore(f.source,f.target,{mode:'additive-empty-journal'}));
  rmSync(f.source);rmSync(f.target);
  create(f.source,{withJournal:true});create(f.target,{withJournal:true,reverse:true});
  assert.equal(verifyD1Restore(f.source,f.target).rowCounts.station_workspace_state,2);
  deny(()=>verifyD1Restore(f.source,f.target,{mode:'additive-empty-journal'}));
});

test('missing indexes, changed constraints, unexpected tables and triggers fail closed',t=>{
  const f=fixture(t);create(f.source);
  for(const sql of [
    'DROP INDEX station_audit_owner_time',
    'CREATE TABLE unexpected (value TEXT)',
    'CREATE TRIGGER unexpected AFTER INSERT ON station_documents BEGIN SELECT 1; END;',
    'ALTER TABLE station_documents ADD COLUMN unexpected TEXT'
  ]){
    if(existsSync(f.target))rmSync(f.target);
    create(f.target);mutate(f.target,sql);deny(()=>verifyD1Restore(f.source,f.target));
  }
  rmSync(f.target);
  const db=new DatabaseSync(f.target);db.exec(schema.replace('CHECK (revision > 0)','CHECK (revision >= 0)'));db.close();
  deny(()=>verifyD1Restore(f.source,f.target));
});

test('D1 internal metadata is explicitly excluded while unexpected provider schema is rejected',t=>{
  const f=fixture(t);create(f.source,{internal:true});create(f.target);
  assert.equal(verifyD1Restore(f.source,f.target).providerMetadataCompared,false);
  mutate(f.target,'CREATE TRIGGER _cf_KV AFTER INSERT ON station_documents BEGIN SELECT 1; END;');
  deny(()=>verifyD1Restore(f.source,f.target));
  mutate(f.target,'DROP TRIGGER _cf_KV');
  mutate(f.target,'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY,value TEXT) WITHOUT ROWID');
  deny(()=>verifyD1Restore(f.source,f.target));
});

test('same file, hard links, symlinks, absent files, WAL and sidecars are refused without creating files',t=>{
  const f=fixture(t);create(f.source);create(f.target);
  deny(()=>verifyD1Restore(f.source,f.source));
  const absent=join(f.dir,'absent.sqlite');deny(()=>verifyD1Restore(f.source,absent));assert(!existsSync(absent));
  const hard=join(f.dir,'hard.sqlite');linkSync(f.source,hard);deny(()=>verifyD1Restore(f.source,hard));
  const symbolic=join(f.dir,'symbolic.sqlite');symlinkSync(f.source,symbolic);deny(()=>verifyD1Restore(f.source,symbolic));
  for(const suffix of ['-wal','-shm','-journal']){
    writeFileSync(f.target+suffix,'Synthetic sidecar');deny(()=>verifyD1Restore(f.source,f.target));rmSync(f.target+suffix);
  }
  const bytes=readFileSync(f.target);bytes[18]=2;bytes[19]=2;writeFileSync(f.target,bytes);
  deny(()=>verifyD1Restore(f.source,f.target));
});

test('CLI emits only safe summaries/errors, never raw row values, paths or SQLite exceptions',t=>{
  const f=fixture(t);create(f.source);create(f.target);
  const cli=new URL('../tools/verify-d1-restore.mjs',import.meta.url);
  const run=args=>spawnSync(process.execPath,[cli.pathname,...args],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'}});
  const good=run([f.source,f.target]);assert.equal(good.status,0);assert(JSON.parse(good.stdout).rowCounts);
  mutate(f.target,"UPDATE station_documents SET payload='Fabricated private text'");
  const bad=run([f.source,f.target]);assert.equal(bad.status,1);assert.equal(bad.stdout,'');assert.equal(bad.stderr,'d1_restore_comparison_refused\n');
  writeFileSync(f.target,'This is fabricated SQL or invalid bytes, not a SQLite copy');
  const invalid=run([f.source,f.target]);assert.equal(invalid.stderr,bad.stderr);
  deny(()=>verifyD1Restore(f.source,f.target,{mode:'invented'}));
});
