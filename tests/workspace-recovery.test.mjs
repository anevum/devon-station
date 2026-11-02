import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStation} from '../worker/index.mjs';
import {validatePortableBackupState} from '../src/backup-core.mjs';
import {emptyState,validateOwnerState} from '../worker/state.mjs';
import {createFoundation} from '../foundation/src/foundation.mjs';
import {journalDigest,openJournal} from '../worker/workspace-journal.mjs';
import {encryptWorkspaceBackup,decryptWorkspaceBackup} from '../src/workspace-backup.mjs';

const origin='https://recovery.example.test',user={subject:'synthetic-recovery-owner',email:'owner@example.test'},scope={scopeKind:'personal',scopeId:'personal-a'};
const grant={...scope,subject:user.subject,principalId:'owner-a',role:'owner'},projectGrant={...scope,principalId:'owner-a',projectId:'project-a',area:'Devon Works'};
const project={id:'project-a',name:'Synthetic recovery project',area:'Devon Works',record:'https://www.notion.so/synthetic-recovery'};
const passphrase='fabricated recovery phrase only';
function fixture(path=':memory:'){
 const sqlite=new DatabaseSync(path);sqlite.exec(readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8'));sqlite.exec(readFileSync(new URL('../worker/migrations/0003-scoped-workspace.sql',import.meta.url),'utf8'));
 const DB={sqlite,prepare(sql){return {bind(...params){return {first:async()=>sqlite.prepare(sql).get(...params)??null,run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...params).changes)}})};}}}};
 const cache=(rows=[project])=>sqlite.prepare('INSERT OR REPLACE INTO station_portfolio_cache(owner_sub,source_id,fetch_time,payload) VALUES(?,?,?,?)').run(user.subject,'synthetic-source',1793448000000,JSON.stringify(rows));cache();
 const env={APP_ORIGIN:origin,OWNER_EMAIL:user.email,DB,WORKSPACE_GRANTS:[grant],WORKSPACE_PROJECT_GRANTS:[projectGrant]};let calls=0;
 const app=createStation({},async()=>user,async()=>{calls++;throw Error('external operation forbidden');});
 const req=(path,body,otherScope=scope,headers={})=>new Request(origin+'/api/workspace'+path+'?'+new URLSearchParams(otherScope),body===undefined?{headers}:{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const call=async(path='',body,status=200)=>{const response=await app.fetch(req(path,body),env,{}),data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;};
 return {DB,sqlite,env,app,req,call,cache,close:()=>sqlite.close(),externalCalls:()=>calls};
}
const propose={expectedGeneration:0,input:{operationId:'proposal-a',recordId:'action-a',projectId:'project-a',summary:'Review fabricated recovery evidence',expectedRevision:0}};
async function populated(f){await f.call('/propose',propose);return f.call('/decide',{expectedGeneration:1,input:{operationId:'decision-a',recordId:'action-a',decision:'approved',expectedRevision:1}});}

test('encrypted journal round-trip retains action receipts, binds the owner and survives independent restore/restart',async()=>{
 const source=fixture(),dir=mkdtempSync(join(tmpdir(),'ds-recover-')),path=join(dir,'isolated.sqlite');let target=fixture(path);
 try{
  const original=await populated(source),transfer=await source.call('/backup');const encrypted=await encryptWorkspaceBackup(transfer,passphrase);
  assert(!JSON.stringify(encrypted).includes(propose.input.summary));assert(!JSON.stringify(encrypted).includes(user.subject));
  const backup=await decryptWorkspaceBackup(encrypted,passphrase),review=await target.call('/restore-review',{backup});assert.equal(review.canRestore,true);assert.equal(review.receipts,2);
  const request={expectedGeneration:0,operationId:'restore-a',reviewDigest:review.reviewDigest,backup};
  const restored=await target.call('/restore',request);assert.deepEqual(restored.actions,original.actions);assert.deepEqual(restored.receipts,original.receipts);assert.equal(restored.journalEvents[0].kind,'restore');assert.equal(restored.generation,1);
  assert.equal((await target.call('/restore',request)).duplicate,true);target.close();target=fixture(path);assert.deepEqual((await target.call()).receipts,original.receipts);assert.equal(target.externalCalls()+source.externalCalls(),0);
 }finally{source.close();target.close();rmSync(dir,{recursive:true,force:true});}
});
test('wrong passphrase, ciphertext tampering, KDF changes and noncanonical encoding are rejected',async()=>{
 const f=fixture();try{
  const transfer=await f.call('/backup'),sealed=await encryptWorkspaceBackup(transfer,passphrase);
  const second=await encryptWorkspaceBackup(transfer,passphrase);assert.notEqual(sealed.salt,second.salt);assert.notEqual(sealed.iv,second.iv);assert.notEqual(sealed.payload,second.payload);
  await assert.rejects(decryptWorkspaceBackup(sealed,'different fabricated phrase'));
  await assert.rejects(decryptWorkspaceBackup({...sealed,payload:(sealed.payload[0]==='A'?'B':'A')+sealed.payload.slice(1)},passphrase));
  await assert.rejects(decryptWorkspaceBackup({...sealed,iterations:1},passphrase));await assert.rejects(decryptWorkspaceBackup({...sealed,salt:sealed.salt+'='},passphrase));
  await assert.rejects(encryptWorkspaceBackup(transfer,'short'));
 }finally{f.close();}
});
test('restore refuses a populated target and rejects changed review, wrong subject, scope, principal and corrupt snapshots',async()=>{
 const f=fixture(),target=fixture();try{
  await populated(f);const backup=await f.call('/backup');
  const preview=await f.call('/restore-review',{backup});assert.equal(preview.canRestore,false);
  const before=f.sqlite.prepare('SELECT snapshot FROM station_workspace_state').get().snapshot;
  await f.call('/restore',{expectedGeneration:0,operationId:'restore-overwrite',reviewDigest:preview.reviewDigest,backup},409);assert.equal(f.sqlite.prepare('SELECT snapshot FROM station_workspace_state').get().snapshot,before);
  for(const altered of [{...backup,ownerSubject:'other'},{...backup,principalId:'other'},{...backup,scope:{scopeKind:'business',scopeId:'business-a'}},{...backup,snapshot:'{}'}])await target.call('/restore-review',{backup:altered},400);
  const review=await target.call('/restore-review',{backup});await target.call('/restore',{expectedGeneration:0,operationId:'restore-stale',reviewDigest:'changed',backup},409);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM station_workspace_state').get().n,0);
 }finally{f.close();target.close();}
});
test('explicit source reconciliation retains every action/receipt, records a governance event and restores retry semantics',async()=>{
 const f=fixture();try{
  const original=await populated(f);f.cache([{...project,name:'Approved updated title',record:'https://www.notion.so/reviewed-updated-source'}]);
  await f.call('',undefined,409);const review=await f.call('/review');assert.equal(review.canReconcile,true);assert.equal(review.changes[0].kind,'changed');assert.equal(review.changes[0].before.title,project.name);
  const request={expectedGeneration:2,operationId:'reconcile-a',reviewDigest:review.reviewDigest};
  const reconciled=await f.call('/reconcile',request);assert.deepEqual(reconciled.actions,original.actions);assert.deepEqual(reconciled.receipts,original.receipts);assert.equal(reconciled.projects[0].title,'Approved updated title');assert.equal(reconciled.journalEvents[0].kind,'reconcile');assert.equal(reconciled.generation,3);
  assert.equal((await f.call('/reconcile',request)).duplicate,true);await f.call('/reconcile',{...request,reviewDigest:'different'},409);
  const backup=await f.call('/backup');assert.equal(openJournal({principalId:'owner-a',role:'owner',...scope},backup.snapshot).events.length,1);
 }finally{f.close();}
});
test('source removal with history remains blocked and does not disclose removed metadata',async()=>{
 const f=fixture();try{
  await populated(f);f.env.WORKSPACE_PROJECT_GRANTS=[];const before=f.sqlite.prepare('SELECT snapshot FROM station_workspace_state').get().snapshot;
  const review=await f.call('/review');assert.equal(review.canReconcile,false);assert.equal(review.changes[0].historyCount,1);assert.equal(review.changes[0].before,null);assert(!JSON.stringify(review).includes(project.name));
  await f.call('/reconcile',{expectedGeneration:2,operationId:'remove-with-history',reviewDigest:review.reviewDigest},409);assert.equal(f.sqlite.prepare('SELECT snapshot FROM station_workspace_state').get().snapshot,before);
 }finally{f.close();}
});
test('adding and removing unused projects requires review; stale review and racing reconciliation do not overwrite history',async()=>{
 const f=fixture();try{
  await populated(f);f.env.WORKSPACE_PROJECT_GRANTS.push({...projectGrant,projectId:'project-b'});f.cache([project,{...project,id:'project-b',name:'Second project'}]);
  let review=await f.call('/review');assert.equal(review.changes[0].kind,'added');f.cache([project,{...project,id:'project-b',name:'Changed before approval'}]);
  await f.call('/reconcile',{expectedGeneration:2,operationId:'stale-review',reviewDigest:review.reviewDigest},409);
  review=await f.call('/review');const requests=['first-race','second-race'].map(operationId=>f.app.fetch(f.req('/reconcile',{expectedGeneration:2,operationId,reviewDigest:review.reviewDigest}),f.env,{}));
  assert.deepEqual((await Promise.all(requests)).map(r=>r.status).sort(),[200,409]);
  f.env.WORKSPACE_PROJECT_GRANTS.pop();review=await f.call('/review');assert.equal(review.canReconcile,true);assert.equal(review.changes[0].kind,'removed');await f.call('/reconcile',{expectedGeneration:3,operationId:'remove-unused',reviewDigest:review.reviewDigest});assert.equal((await f.call()).receipts.length,2);
 }finally{f.close();}
});
test('recovery endpoints enforce scope/auth/origin boundaries and failed writes leave the target empty',async()=>{
 const f=fixture();try{
  const backup=await f.call('/backup'),review=await f.call('/restore-review',{backup}),body={expectedGeneration:0,operationId:'restore-fail',reviewDigest:review.reviewDigest,backup};
  for(const path of ['/backup','/review','/restore-review','/restore','/reconcile']){
   const routeBody=path==='/restore-review'?{backup}:path==='/reconcile'?{expectedGeneration:0,operationId:'boundary-test',reviewDigest:'synthetic'}:body;
   const req=f.req(path,path==='/backup'||path==='/review'?undefined:routeBody);
   assert.equal((await createStation({}).fetch(req,f.env,{})).status,401);
   assert.equal((await createStation({},async()=>({...user,subject:'other'})).fetch(req,f.env,{})).status,403);
  }
  assert.equal((await f.app.fetch(f.req('/restore',body,scope,{Origin:'https://evil.example.test'}),f.env,{})).status,403);
  f.sqlite.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON station_workspace_state BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");await f.call('/restore',body,500);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM station_workspace_state').get().n,0);
 }finally{f.close();}
});
test('legacy runtime snapshots remain readable and governance receipt corruption fails closed',async()=>{
 const f=fixture();try{
  const current=await f.call(),identity={principalId:'owner-a',role:'owner',...scope},legacy=createFoundation({identity,projects:current.projects});legacy.propose(identity,propose.input);const snapshot=legacy.export(identity);
  f.sqlite.prepare('INSERT INTO station_workspace_state VALUES(?,?,?,?,?,?,?)').run(user.subject,scope.scopeKind,scope.scopeId,identity.principalId,1,snapshot,journalDigest(snapshot));assert.equal((await f.call()).actions.length,1);
  f.cache([{...project,name:'New reviewed name'}]);const review=await f.call('/review');await f.call('/reconcile',{expectedGeneration:1,operationId:'legacy-review',reviewDigest:review.reviewDigest});
  const value=JSON.parse(f.sqlite.prepare('SELECT snapshot FROM station_workspace_state').get().snapshot);value.events[0].kind='restore';const changed=JSON.stringify(value);f.sqlite.prepare('UPDATE station_workspace_state SET snapshot=?,content_sha256=?').run(changed,journalDigest(changed));await f.call('',undefined,503);
 }finally{f.close();}
});

test('journal import cannot bypass sensitive-content checks by recomputing unkeyed checksums',async()=>{
 const source=fixture(),target=fixture();try{
  await populated(source);const backup=await source.call('/backup'),wrapper=JSON.parse(backup.snapshot),foundation=JSON.parse(wrapper.foundation),data=foundation.data;
  const action=data.actions[0];action.summary='Synthetic patient record';const receipt=data.receipts.find(r=>r.action==='propose'),operation=data.operations.find(op=>op.receiptId===receipt.receiptId);
  const fingerprint=journalDigest({kind:'propose',actor:data.owner,input:{operationId:operation.operationId,recordId:action.recordId,projectId:action.projectId,summary:action.summary,expectedRevision:0}});receipt.payloadDigest=fingerprint;operation.fingerprint=fingerprint;foundation.checksum=journalDigest(data);wrapper.foundation=JSON.stringify(foundation);backup.snapshot=JSON.stringify(wrapper);
  await target.call('/restore-review',{backup},400);assert.equal(target.sqlite.prepare('SELECT COUNT(*) n FROM station_workspace_state').get().n,0);
 }finally{source.close();target.close();}
});
test('device-note backup retains feedback created in the integrated workspace section',()=>{
 const state=emptyState();state.feedback.push({id:'local:fixture-feedback',section:'workspace',category:'Design',note:'Refine the project source review',state:'Open',createdAt:'2026-10-31T20:00:00.000Z'});
 assert.deepEqual(validatePortableBackupState(state),validateOwnerState(state));
});
