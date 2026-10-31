import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,validateOwnerState} from '../worker/state.mjs';
import {validatePortableBackupState,encryptPortableBackup,decryptPortableBackup} from '../src/backup-core.mjs';
const seed=()=>{const s=emptyState();s.drafts=[{id:'local:abc12345',title:'Document next action',area:'Devon Works',project:null,destination:null,state:'Draft',createdAt:'2026-10-28T20:00:00.000Z'}];s.feedback=[{id:'local:note2345',section:'settings',category:'Feature',note:'Allow portable recovery copies',state:'Open',createdAt:'2026-10-28T20:00:00.000Z'}];s.history=[{action:'Synthetic capture saved',at:'2026-10-28T20:00:00.000Z'}];return s;};
const secret='a long passphrase that is never logged';
test('encrypted backup is portable, authenticated, and valid under the server owner-state contract',async()=>{
 const state=seed();const envelope=await encryptPortableBackup(state,secret);
 assert.equal(envelope.version,1);assert.equal(envelope.format,'devon-station-owner-backup');
 assert.equal(envelope.iterations,310000);
 assert(!JSON.stringify(envelope).includes('Document next action'));
 assert(!JSON.stringify(envelope).includes('Allow portable recovery'));
 const restored=await decryptPortableBackup(JSON.parse(JSON.stringify(envelope)),secret);
 assert.deepEqual(restored,state);assert.deepEqual(validateOwnerState(restored),state);
});
test('encrypted backups use fresh salts and nonces even for identical state',async()=>{
 const first=await encryptPortableBackup(seed(),secret),second=await encryptPortableBackup(seed(),secret);
 assert.notEqual(first.iv,second.iv);assert.notEqual(first.salt,second.salt);assert.notEqual(first.payload,second.payload);
});
test('wrong passphrase, tampering and changed encryption parameters fail closed',async()=>{
 const good=await encryptPortableBackup(seed(),secret);
 await assert.rejects(()=>decryptPortableBackup(good,'incorrect passphrase that is long enough'),/backup_unlock_failed_or_file_modified/);
 const tampered={...good,payload:good.payload.slice(0,-1)+(good.payload.endsWith('A')?'B':'A')};
 await assert.rejects(()=>decryptPortableBackup(tampered,secret),/backup_unlock_failed_or_file_modified/);
 await assert.rejects(()=>decryptPortableBackup({...good,iterations:1},secret),/unsupported_backup_format/);
 await assert.rejects(()=>decryptPortableBackup({...good,format:'another-product'},secret),/unsupported_backup_format/);
});
test('backup rejects source-of-truth links, sensitive content, invalid IDs, and over-limit input',async()=>{
 const sourceLinked=seed();sourceLinked.drafts[0].project='DS-007';
 await assert.rejects(()=>encryptPortableBackup(sourceLinked,secret),/invalid_backup_draft/);
 const injected=seed();injected.feedback[0].note='password bank account';
 assert.throws(()=>validatePortableBackupState(injected),/backup_contains_unsupported_content/);
 const clone=seed();clone.drafts[0].id='not-a-local-id';
 assert.throws(()=>validatePortableBackupState(clone),/invalid_backup_draft/);
 const oversized=seed();oversized.drafts=Array(201).fill(seed().drafts[0]);
 assert.throws(()=>validatePortableBackupState(oversized),/backup_state_limit_exceeded/);
});
test('backup rejects invalid file framing and short passphrases',async()=>{
 const backup=await encryptPortableBackup(seed(),secret);
 await assert.rejects(()=>decryptPortableBackup({...backup,salt:'oops'},secret),/invalid_backup_envelope/);
 await assert.rejects(()=>encryptPortableBackup(seed(),'short'),/passphrase_must_be_14_to_256_characters/);
 await assert.rejects(()=>decryptPortableBackup({...backup,untrusted:'x'},secret),/backup_contains_unexpected_field/);
});
