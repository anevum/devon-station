// Synthetic cold-backup rehearsal only. Never connects to Cloudflare or an email provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,rm,readdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare} from 'miniflare';
import {createD1MailStore} from '../src/communications/mail-d1-store.mjs';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';

const compatibilityDate=process.env.DS_WORKERD_COMPAT_DATE??'2026-07-30';
if(!['2026-07-30','2026-10-28'].includes(compatibilityDate))throw Error('Unsupported synthetic compatibility date');
const scope={installationId:'personal',mailboxId:'hello'};
const other={installationId:'client-two',mailboxId:'hello'};
const owner={...scope,ownerSub:'synthetic-owner'};
const peer={...scope,ownerSub:'synthetic-peer'};
const id='ba000000-0000-4000-8000-000000000001';
const operationId='ba000000-0000-4000-8000-000000000002';
const nextOperation='ba000000-0000-4000-8000-000000000003';
const payload={id,revision:1,operationId,to:['recipient@example.test'],subject:'Synthetic café',body:'Draft before backup\nPlain text only.'};
const code=expected=>error=>error?.code===expected;
const record=(s,validity,uid)=>({key:`${s.installationId}/${s.mailboxId}/${validity}/${uid}`,...s,
 uidValidity:validity,uid,from:'author@example.test',subject:'Synthetic '+uid,text:'Café\n<not-active> & untrusted source',
 timestamp:'2026-11-03T12:00:00.000Z',flags:['seen','flagged']});
async function runtime(path){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic local recovery only")}}',
  compatibilityDate,compatibilityFlags:['nodejs_compat'],
  d1Databases:{MAIL_RECOVERY:'00000000-0000-4000-8000-000000000001'},d1Persist:path});
 try{
  const db=await mf.getD1Database('MAIL_RECOVERY');
  return {mf,db,inbox:createD1MailStore(db),drafts:createD1DraftStore(db,{now:()=> '2026-11-03T12:00:00.000Z'})};
 }catch(error){await mf.dispose();throw error;}
}
async function files(root,relative=''){
 const entries=await readdir(join(root,relative),{withFileTypes:true});const result=[];
 for(const entry of entries){
  const name=relative?relative+'/'+entry.name:entry.name;
  assert(!entry.isSymbolicLink(),'rehearsal never follows symlinks');
  if(entry.isDirectory())result.push(...await files(root,name));
  else{assert(entry.isFile());result.push(name);}
 }
 return result.sort();
}
async function fingerprint(root){
 return Promise.all((await files(root)).map(async path=>({path,
  sha256:createHash('sha256').update(await readFile(join(root,path))).digest('hex')})));
}
async function restoreFresh(backup,target,manifest,copy=cp){
 // Test-only helper; target must not already exist, even if empty.
 await assert.rejects(lstat(target),error=>error.code==='ENOENT');
 assert.deepEqual(await fingerprint(backup),manifest,'backup integrity mismatch');
 try{
  await copy(backup,target,{recursive:true,errorOnExist:true,force:false});
  assert.deepEqual(await fingerprint(target),manifest);
 }
 catch(error){await rm(target,{recursive:true,force:true});throw error;}
}
async function rows(db){
 const tables=[['comms_ro_mailboxes','installation_id,mailbox_id'],
  ['comms_ro_messages','installation_id,mailbox_id,uid_validity,uid'],
  ['comms_mail_drafts','installation_id,mailbox_id,owner_sub,draft_id'],['unrelated_sentinel','id']];
 const entries=[];
 for(const [table,order] of tables){
  // Fixed source allowlist only; no imported SQL or dynamic caller-controlled identifier.
  const result=await db.prepare('SELECT * FROM '+table+' ORDER BY '+order).all();
  entries.push([table,result.results]);
 }
 return Object.fromEntries(entries);
}

test(`workerd ${compatibilityDate}: isolated mail cold backup restores inbox, drafts and retry authority`,async t=>{
 const temp=await mkdtemp(join(tmpdir(),'ds-comms-recovery-'));
 const source=join(temp,'source'),backup=join(temp,'cold-backup'),target=join(temp,'restored');
 let active,expected,manifest,inboxBefore,draftsBefore;
 const step=async(name,body)=>{
  let failure;
  await t.test(name,async()=>{try{await body();}catch(error){failure=error;throw error;}});
  if(failure)throw failure;
 };
 try{
  await step('seed candidate schemas and separated synthetic data in file-backed D1',async()=>{
   active=await runtime(source);
   for(const name of ['0004-comms-ro-mail.sql','0005-comms-drafts.sql']){
    const sql=await readFile(new URL('../worker/migrations/'+name,import.meta.url),'utf8');
    for(const statement of sql.split('\n').filter(line=>!/^\s*--/.test(line)).join('\n').split(';').map(x=>x.trim()).filter(Boolean))
     await active.db.prepare(statement).run();
   }
   await active.db.prepare('CREATE TABLE unrelated_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)').run();
   await active.db.prepare('INSERT INTO unrelated_sentinel VALUES (1,?)').bind('preserve synthetic unrelated row').run();
   await active.inbox.commitSnapshot({scope,expectedRevision:0,next:{cursor:{uidValidity:8,highestUid:33},
    records:[record(scope,7,1),record(scope,8,17)]}});
   await active.inbox.commitSnapshot({scope:other,expectedRevision:0,next:{cursor:{uidValidity:7,highestUid:1},records:[record(other,7,1)]}});
   await active.drafts.create(owner,id);await active.drafts.save(owner,payload);
   await active.drafts.create(peer,id);
   expected=await rows(active.db);inboxBefore=await active.inbox.readSnapshot(scope);draftsBefore=await active.drafts.list(owner);
   assert.equal(draftsBefore[0].revision,2);assert.equal((await active.drafts.list(peer))[0].revision,1);
  });
  await step('close runtime before copy, persist a content-free integrity manifest and check SQLite',async()=>{
   await active.mf.dispose();active=null;
   await cp(source,backup,{recursive:true,errorOnExist:true,force:false});
   manifest=await fingerprint(backup);assert(manifest.length>0);
   await writeFile(join(temp,'manifest.json'),JSON.stringify(manifest));
   manifest=JSON.parse(await readFile(join(temp,'manifest.json'),'utf8'));
   // Even read-only SQLite opens may update shared-memory sidecars. Inspect a disposable clone.
   const inspection=join(temp,'integrity-inspection');await cp(backup,inspection,{recursive:true});
   const databases=manifest.filter(x=>/\.sqlite$/.test(x.path));assert(databases.length>=1);let applicationDatabases=0;
   for(const entry of databases){
    const db=new DatabaseSync(join(inspection,entry.path),{readOnly:true});
    try{
     if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='comms_ro_messages'").get())applicationDatabases++;
     assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(x=>x.integrity_check),['ok']);
     assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    }finally{db.close();}
   }
   assert.equal(applicationDatabases,1,'exactly one copied database holds the mail tables');
  });
  await step('source can diverge after the backup without changing the copied recovery point',async()=>{
   active=await runtime(source);
   await active.drafts.remove(owner,{id,revision:2});
   await active.inbox.commitSnapshot({scope,expectedRevision:1,next:{cursor:{uidValidity:9,highestUid:1},records:[record(scope,9,1)]}});
   assert.notDeepEqual(await rows(active.db),expected);
   await active.mf.dispose();active=null;
   assert.deepEqual(await fingerprint(backup),manifest);
  });
  await step('corrupt backup is rejected before target creation',async()=>{
   const bad=join(temp,'corrupt'),denied=join(temp,'denied');await cp(backup,bad,{recursive:true});
   const path=join(bad,manifest[0].path),bytes=await readFile(path);bytes[0]^=1;await writeFile(path,bytes);
   await assert.rejects(restoreFresh(bad,denied,manifest),/backup integrity mismatch/);
   await assert.rejects(lstat(denied),error=>error.code==='ENOENT');
  });
  await step('interrupted copy cleans only its fresh target and leaves backup intact',async()=>{
   const interrupted=join(temp,'interrupted');
   await assert.rejects(restoreFresh(backup,interrupted,manifest,async(from,to,options)=>{
    await cp(from,to,options);throw Error('synthetic_copy_interruption');
   }),/synthetic_copy_interruption/);
   await assert.rejects(lstat(interrupted),error=>error.code==='ENOENT');
   assert.deepEqual(await fingerprint(backup),manifest);
  });
  await step('restore to fresh persistence directory retains every scoped row and operation UUID',async()=>{
   await restoreFresh(backup,target,manifest);active=await runtime(target);
   assert.deepEqual(await rows(active.db),expected);
   assert.deepEqual(await active.inbox.readSnapshot(scope),inboxBefore);
   assert.deepEqual(await active.drafts.list(owner),draftsBefore);
   assert.equal((await active.inbox.readSnapshot(other)).records[0].installationId,'client-two');
   assert.equal((await active.drafts.list(peer))[0].revision,1);
   assert.deepEqual(await active.drafts.list({...owner,ownerSub:'ungranted-synthetic-subject'}),[]);
  });
  await step('restored CAS and draft retry IDs reject stale or altered replay without overwrites',async()=>{
   assert.deepEqual(await active.inbox.commitSnapshot({scope,expectedRevision:0,
    next:{cursor:{uidValidity:8,highestUid:33},records:[]}}),{ok:false});
   assert.deepEqual(await active.inbox.readSnapshot(scope),inboxBefore);
   assert.deepEqual(await active.drafts.save(owner,payload),draftsBefore[0]);
   await assert.rejects(active.drafts.save(owner,{...payload,body:'altered replay'}),code('mail_draft_conflict'));
   await assert.rejects(active.drafts.remove(owner,{id,revision:1}),code('mail_draft_conflict'));
   assert.deepEqual(await rows(active.db),expected);
  });
  await step('existing restore target is never overwritten',async()=>{
   await assert.rejects(restoreFresh(backup,target,manifest));
   assert.deepEqual(await rows(active.db),expected);
  });
  await step('new draft save survives second runtime restart; original cold backup stays immutable',async()=>{
   await active.drafts.save(owner,{...payload,revision:2,operationId:nextOperation,body:'Saved after recovery'});
   const after=await rows(active.db);await active.mf.dispose();active=await runtime(target);
   assert.deepEqual(await rows(active.db),after);assert.equal((await active.drafts.list(owner))[0].revision,3);
   assert.deepEqual(await fingerprint(backup),manifest);
  });
 }finally{await active?.mf.dispose();await rm(temp,{recursive:true,force:true});}
});
