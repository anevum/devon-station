import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encryptD1Backup,decryptD1Backup} from '../tools/d1-backup-envelope.mjs';
import {verifyD1Restore} from '../tools/verify-d1-restore.mjs';
const password='Synthetic only backup passphrase 2026';
const refused=promise=>assert.rejects(promise,error=>error.message==='d1_backup_invalid_or_unlock_failed');
const change=value=>{const b=Buffer.from(value,'base64url');b[0]^=1;return b.toString('base64url');};

test('synthetic SQLite encryption, serialized transport, decryption and independent copy comparison',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ds-encrypted-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=join(dir,'source.sqlite'),target=join(dir,'target.sqlite');
  const db=new DatabaseSync(source);
  db.exec(readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8'));
  db.exec("INSERT INTO station_documents VALUES ('synthetic',1,1,'Synthetic private note',100,'synthetic-operation')");db.close();
  const input=readFileSync(source),before=Buffer.from(input);
  const sealed=await encryptD1Backup(input,password,{kind:'sqlite'});
  const text=JSON.stringify(sealed);assert(!text.includes('Synthetic private note'));assert(!text.includes(password));
  const archive=join(dir,'synthetic.encrypted.json');writeFileSync(archive,text,{mode:0o600,flag:'wx'});
  const opened=await decryptD1Backup(JSON.parse(readFileSync(archive,'utf8')),password);
  assert.equal(opened.kind,'sqlite');assert.deepEqual(opened.bytes,before);assert.deepEqual(input,before);
  writeFileSync(target,opened.bytes);opened.bytes.fill(0);
  assert.equal(verifyD1Restore(source,target).rowCounts.station_documents,1);
  assert.deepEqual(readFileSync(source),before);
});

test('fresh salts/IVs, opaque SQL bytes and asynchronous caller mutation',async()=>{
  const raw=Buffer.from('-- Fabricated SQL only\nSELECT \'synthetic Δ\';\n');
  const before=Buffer.from(raw);
  const pending=encryptD1Backup(raw,password,{kind:'d1-sql'});raw.fill(0);
  const a=await pending,b=await encryptD1Backup(before,password,{kind:'d1-sql'});
  assert.notEqual(a.salt,b.salt);assert.notEqual(a.iv,b.iv);assert.notEqual(a.payload,b.payload);
  const decoded=await decryptD1Backup(a,password);assert.deepEqual(decoded.bytes,before);decoded.bytes.fill(0);
});

test('wrong passphrase, tampered ciphertext/tag/salt/IV and authenticated metadata all fail',async()=>{
  const e=await encryptD1Backup(Buffer.from('Synthetic opaque bytes'),password,{kind:'sqlite'});
  await refused(decryptD1Backup(e,'Wrong synthetic passphrase'));
  for(const field of ['payload','tag','salt','iv'])await refused(decryptD1Backup({...e,[field]:change(e[field])},password));
  for(const mutation of [{kind:'d1-sql'},{length:e.length+1},{version:2},{iterations:1},{iterations:999999999},{cipher:'AES-128-GCM'},{kdf:'invented'},{extra:'Synthetic private value'},{payload:e.payload+'='},{tag:'AA'}])
    await refused(decryptD1Backup({...e,...mutation},password));
});

test('invalid/oversized inputs are rejected without logging plaintext or credentials',async()=>{
  for(const bytes of [null,'Synthetic string',Buffer.alloc(0),new Uint8Array(64*1024*1024+1)])
    await refused(encryptD1Backup(bytes,password,{kind:'sqlite'}));
  for(const pass of ['short',' '.repeat(20),'x'.repeat(257)])await refused(encryptD1Backup(Buffer.from('synthetic'),pass,{kind:'sqlite'}));
  await refused(encryptD1Backup(Buffer.from('synthetic'),password,{kind:'unknown'}));
  for(const value of [null,[],{format:'Synthetic private malformed input'}])await refused(decryptD1Backup(value,password));
});
