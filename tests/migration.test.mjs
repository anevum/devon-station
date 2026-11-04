import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';
const path=new URL('../worker/migrations/0002-owner-state.sql',import.meta.url);
test('additive owner-state migration preserves pre-existing push subscriptions and is repeatable',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE push_devices(owner_sub TEXT NOT NULL, device_id TEXT NOT NULL, endpoint_hash TEXT NOT NULL, endpoint TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_sent_at INTEGER, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(owner_sub,device_id), UNIQUE(owner_sub,endpoint_hash)); CREATE TABLE push_delivery_log(id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, device_id TEXT NOT NULL, kind TEXT NOT NULL,status TEXT NOT NULL,service_status INTEGER,created_at INTEGER NOT NULL);`);
  db.prepare('INSERT INTO push_devices(owner_sub,device_id,endpoint_hash,endpoint,created_at,updated_at,active) VALUES(?,?,?,?,?,?,1)').run('synthetic-owner','device-a','hash-a','https://web.push.apple.com/synthetic',100,100);
  const migration=readFileSync(path,'utf8');db.exec(migration);db.exec(migration);
  assert.equal(db.prepare('SELECT endpoint FROM push_devices WHERE device_id=?').get('device-a').endpoint,'https://web.push.apple.com/synthetic');
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'station_%' ORDER BY name").all().map(x=>x.name);
  assert.deepEqual(names,['station_documents','station_portfolio_cache','station_write_audit']);
 }finally{db.close();}
});
