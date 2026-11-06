import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,copyFileSync,symlinkSync,linkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMailPayloadCipher} from '../src/communications/mail-payload-crypto.mjs';
import {createD1MailStore} from '../src/communications/mail-d1-store.mjs';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
import {createD1Outbox} from '../src/communications/mail-outbox.mjs';
import {encryptD1Backup} from '../tools/d1-backup-envelope.mjs';
import {runLocalD1Backup} from '../tools/d1-backup-local.mjs';
import {verifyMailRecovery,readRecoveryKeys} from '../tools/verify-mail-recovery.mjs';
const owner={installationId:'personal',mailboxId:'hello',ownerSub:'synthetic-owner'};
const peer={installationId:'client-two',mailboxId:'hello',ownerSub:'synthetic-peer'};
const keys={old:Buffer.alloc(32,1).toString('base64'),new:Buffer.alloc(32,2).toString('base64')};
const config={activeKeyId:'new',keys,ownerSub:owner.ownerSub};
const id=n=>'a0000000-0000-4000-8000-'+String(n).padStart(12,'0');
const now=()=> '2026-01-01T00:00:00.000Z';
const draft={to:['synthetic-recipient@example.test'],subject:'Synthetic private subject',body:'Synthetic private body café'};
const refused=p=>assert.rejects(p,{message:'offline_mail_recovery_refused'});
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function binding(sqlite){
 const prepare=sql=>{
  const bind=(...args)=>({async first(){return sqlite.prepare(sql).get(...args)??null;},
   async all(){return {success:true,results:sqlite.prepare(sql).all(...args)};},
   async run(){return {success:true,meta:{changes:sqlite.prepare(sql).run(...args).changes}};}});
  return {...bind(),bind};
 };
 return {prepare,async batch(statements){
  sqlite.exec('BEGIN;');try{const r=[];for(const s of statements)r.push(await s.run());sqlite.exec('COMMIT;');return r;}
  catch(e){sqlite.exec('ROLLBACK;');throw e;}
 }};
}
async function fixture(t,{archive=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'ds-mail-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const source=join(dir,'source.sqlite'),target=join(dir,'restored.sqlite'),keyFile=join(dir,'keys.json');
 const sqlite=new DatabaseSync(source);
 for(const name of ['0004-comms-ro-mail.sql','0005-comms-drafts.sql','0006-comms-outbox.sql',
  '0007-comms-draft-outbox-lineage.sql','0008-comms-one-delivery-per-draft.sql',...(archive?['0009-comms-sent-archive.sql']:[])])
  sqlite.exec(readFileSync(new URL('../worker/migrations/'+name,import.meta.url),'utf8'));
 const db=binding(sqlite),oldCipher=createMailPayloadCipher({activeKeyId:'old',keys:{old:keys.old}});
 const currentCipher=createMailPayloadCipher(config);
 const inbox=createD1MailStore(db,{cipher:oldCipher,ownerSub:owner.ownerSub});
 for(const scope of [owner,peer])await inbox.commitSnapshot({scope,expectedRevision:0,next:{cursor:{uidValidity:1,highestUid:1},records:[{
  ...scope,key:scope.installationId+'/hello/1/1',uidValidity:1,uid:1,from:'synthetic-author@example.test',
  subject:draft.subject,text:draft.body,timestamp:now(),flags:[]}]}});
 for(const [i,state] of ['accepted','queued','claimed','uncertain','failed','rejected'].entries()){
  const scope=i%2?peer:owner,cipher=i%2?currentCipher:oldCipher;
  const drafts=createD1DraftStore(db,{cipher,now}),outbox=createD1Outbox(db,scope,{cipher,now});
  await drafts.create(scope,id(i+1));
  await drafts.save(scope,{id:id(i+1),revision:1,operationId:id(i+100),...draft});
  await outbox.offerLinkedDraft(id(i+20),{draftId:id(i+1),draftRevision:2,payload:{from:'hello@devonakins.com',draft,date:now()}});
  if(state!=='queued'){
   await outbox.claim(id(i+20),id(i+200));
   if(state!=='claimed')await outbox.finish(id(i+20),id(i+200),state);
  }
 }
 sqlite.close();copyFileSync(source,target);
 writeFileSync(keyFile,JSON.stringify(config),{mode:0o600});
 return {dir,source,target,keyFile,options:()=>readRecoveryKeys(keyFile)};
}
const edit=(path,sql)=>{const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}};

test('portable encrypted mail backup restores in a separate process with separately supplied historical keys',async t=>{
 const f=await fixture(t),sourceDigest=digest(f.source),backup=join(f.dir,'backup.encrypted.json'),restored=join(f.dir,'portable.sqlite');
 const password='Synthetic portable backup passphrase 2026';
 writeFileSync(backup,JSON.stringify(await encryptD1Backup(readFileSync(f.source),password,{kind:'sqlite'})),{mode:0o600});
 const sealed=readFileSync(backup,'utf8');
 for(const secret of [password,keys.old,keys.new,draft.subject,draft.body])assert(!sealed.includes(secret));
 await runLocalD1Backup({mode:'decrypt',source:backup,destination:restored},{prompt:async()=>password});
 const cli=fileURLToPath(new URL('../tools/verify-mail-recovery.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[cli,f.source,restored,f.keyFile],{encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);
 assert.equal(report.status,'OFFLINE_MAIL_COPY_AND_DECRYPTION_VERIFIED');
 assert.deepEqual(report.rowCounts,{comms_ro_mailboxes:2,comms_ro_messages:2,comms_mail_drafts:6,comms_outbox:6,comms_sent_archive:1});
 assert.equal(report.networkUsed,false);assert.equal(report.realKeyCustodyVerified,false);assert.equal(report.releaseAuthorized,false);
 for(const secret of [keys.old,keys.new,draft.subject,draft.body,owner.ownerSub])assert(!result.stdout.includes(secret));
 assert.equal(digest(f.source),sourceDigest);assert.equal(digest(restored),sourceDigest);
 const db=new DatabaseSync(restored,{readOnly:true});t.after(()=>db.close());
 assert.deepEqual(db.prepare('SELECT state FROM comms_outbox ORDER BY delivery_id').all().map(x=>x.state),
  ['accepted','queued','claimed','uncertain','failed','rejected']);
});

test('equal copies still fail when a historical payload key is missing or the inbox owner is wrong',async t=>{
 const f=await fixture(t);
 await refused(verifyMailRecovery(f.source,f.target,{cipher:createMailPayloadCipher({activeKeyId:'new',keys:{new:keys.new}}),ownerSub:owner.ownerSub}));
 await refused(verifyMailRecovery(f.source,f.target,{...f.options(),ownerSub:'wrong-synthetic-owner'}));
 assert.equal((await verifyMailRecovery(f.source,f.target,f.options())).archivePresent,true);
});

test('valid SQLite and equal bytes do not conceal broken ciphertext or receipt linkage',async t=>{
 const f=await fixture(t),original=readFileSync(f.source);
 edit(f.source,"UPDATE comms_outbox SET state='uncertain' WHERE state='accepted'");copyFileSync(f.source,f.target);
 await refused(verifyMailRecovery(f.source,f.target,f.options()));
 writeFileSync(f.source,original);
 edit(f.source,"UPDATE comms_ro_messages SET body_text='{}'");copyFileSync(f.source,f.target);
 await refused(verifyMailRecovery(f.source,f.target,f.options()));
});

test('lost rows, missing schema and modified immutable archive triggers are refused',async t=>{
 const f=await fixture(t);
 edit(f.target,'DELETE FROM comms_mail_drafts WHERE draft_id=\''+id(2)+'\'');
 await refused(verifyMailRecovery(f.source,f.target,f.options()));
 copyFileSync(f.source,f.target);edit(f.source,'DROP TRIGGER comms_sent_archive_immutable_delete');copyFileSync(f.source,f.target);
 await refused(verifyMailRecovery(f.source,f.target,f.options()));
 edit(f.source,'DROP TABLE comms_mail_drafts');copyFileSync(f.source,f.target);
 await refused(verifyMailRecovery(f.source,f.target,f.options()));
});

test('pre-archive recovery is supported without migrating; loss of the last accepted payload is refused',async t=>{
 const f=await fixture(t,{archive:false});
 assert.equal((await verifyMailRecovery(f.source,f.target,f.options())).archivePresent,false);
 edit(f.source,"UPDATE comms_outbox SET payload_json='null' WHERE state='accepted'");copyFileSync(f.source,f.target);
 await refused(verifyMailRecovery(f.source,f.target,f.options()));
});

test('same-file/hardlink/symlink/live-WAL inputs and missing backup are refused',async t=>{
 const f=await fixture(t),hard=join(f.dir,'hard.sqlite'),sym=join(f.dir,'symbolic.sqlite');
 linkSync(f.source,hard);symlinkSync(f.source,sym);
 for(const target of [f.source,hard,sym,join(f.dir,'missing.sqlite')])await refused(verifyMailRecovery(f.source,target,f.options()));
 writeFileSync(f.target+'-wal','synthetic sidecar');await refused(verifyMailRecovery(f.source,f.target,f.options()));
});

test('private key input rejects public permissions, symlinks and malformed material without echoing it',async t=>{
 const f=await fixture(t),sym=join(f.dir,'symbolic-keys.json');symlinkSync(f.keyFile,sym);
 assert.throws(()=>readRecoveryKeys(sym),{message:'offline_mail_recovery_refused'});
 chmodSync(f.keyFile,0o644);assert.throws(()=>readRecoveryKeys(f.keyFile),{message:'offline_mail_recovery_refused'});
 chmodSync(f.keyFile,0o600);writeFileSync(f.keyFile,'synthetic-secret-invalid-json');
 const run=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/verify-mail-recovery.mjs',import.meta.url)),f.source,f.target,f.keyFile],{encoding:'utf8'});
 assert.equal(run.status,1);assert.equal(run.stdout,'');
 assert.match(run.stderr,/offline_mail_recovery_refused/);assert(!run.stderr.includes('synthetic-secret'));
});
