/** Scoped decision journal. No external-operation dispatcher exists here. */
import {createAccessScopeBridge} from '../foundation/src/access-scope-bridge.mjs';
import {approvedProjectsForIdentity} from '../foundation/interop/approved-portfolio.mjs';
import {validateWorkspaceTransfer} from '../src/workspace-backup.mjs';
import {getCachedPortfolio} from './portfolio.mjs';
import {journalDigest as digest,sameAuthority,openJournal,serializeJournal,appendJournalEvent,reprojectJournal} from './workspace-journal.mjs';
const fail=(code,status)=>{throw Object.assign(new Error(code),{status,publicCode:code});};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const sensitiveSummary=value=>typeof value==='string'&&/\b(?:patient|diagnosis|medical record|social security number|ssn|password|bank account|credit card number)\b|(?:sk-|ghp_|github_pat_|xox[baprs]-)[a-zA-Z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value);
const identifier=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(x);
function bridge(user,env){try{return createAccessScopeBridge({verifyAssertion:async()=>user,grants:env.WORKSPACE_GRANTS??[]});}catch{fail('workspace_not_authorized',403);}}
// user is supplied exclusively by createStation AFTER hardened Access validation.
async function identityFor(user,env,scope){try{return await bridge(user,env).authorize('verified-station-request',scope);}catch{fail('workspace_not_authorized',403);}}
export async function workspaceScopes(user,env){
 bridge(user,env);const scopes=[];
 for(const grant of env.WORKSPACE_GRANTS??[]){if(grant.subject!==user.subject)continue;const scope={scopeKind:grant.scopeKind,scopeId:grant.scopeId};await identityFor(user,env,scope);scopes.push(scope);}
 return {scopes,execution:'record_only'};
}
async function load(db,user,env,scope,allowSourceChanges=false){
 const identity=await identityFor(user,env,scope);
 if(!db)fail('workspace_storage_unavailable',503);
 if(!Array.isArray(env.WORKSPACE_PROJECT_GRANTS))fail('workspace_not_authorized',403);
 let projects;
 try{
  const projectGrants=env.WORKSPACE_PROJECT_GRANTS.filter(g=>g.principalId===identity.principalId&&g.scopeKind===identity.scopeKind&&g.scopeId===identity.scopeId);
  projects=approvedProjectsForIdentity({identity,portfolio:await getCachedPortfolio(db,user.subject,false),projectGrants}).projects;
 }catch{fail('workspace_source_requires_review',409);}
 const row=await db.prepare('SELECT principal_id,generation,snapshot,content_sha256 FROM station_workspace_state WHERE owner_sub=? AND scope_kind=? AND scope_id=?').bind(user.subject,scope.scopeKind,scope.scopeId).first();
 let journal;
 try{
  if(row&&(row.principal_id!==identity.principalId||row.content_sha256!==digest(row.snapshot)||!Number.isSafeInteger(row.generation)||row.generation<1))throw Error();
  journal=openJournal(identity,row?.snapshot??null,projects);
 }catch{fail('workspace_integrity_failure',503);}
 if(!allowSourceChanges&&!sameAuthority(journal.store.projects(identity),projects))fail('workspace_source_requires_review',409);
 return {identity,journal,store:journal.store,row,projects};
}
function view({identity,journal,store,row,projects}){
 return {scope:{scopeKind:identity.scopeKind,scopeId:identity.scopeId},generation:row?.generation??0,projects,actions:store.actions(identity),receipts:store.receipts(identity),journalEvents:structuredClone(journal.events),execution:'record_only'};
}
async function persist(db,user,scope,loaded,journal,expectedGeneration){
 const {identity,row}=loaded;if((row?.generation??0)!==expectedGeneration)fail('workspace_conflict',409);
 let snapshot;try{snapshot=serializeJournal(identity,journal);}catch{fail('workspace_history_limit',413);}
 const generation=expectedGeneration+1;
 const statement=row
  ?db.prepare('UPDATE station_workspace_state SET generation=?,snapshot=?,content_sha256=? WHERE owner_sub=? AND scope_kind=? AND scope_id=? AND principal_id=? AND generation=? AND content_sha256=?').bind(generation,snapshot,digest(snapshot),user.subject,scope.scopeKind,scope.scopeId,identity.principalId,row.generation,row.content_sha256)
  :db.prepare('INSERT OR IGNORE INTO station_workspace_state(owner_sub,scope_kind,scope_id,principal_id,generation,snapshot,content_sha256) VALUES(?,?,?,?,?,?,?)').bind(user.subject,scope.scopeKind,scope.scopeId,identity.principalId,generation,snapshot,digest(snapshot));
 const result=await statement.run();if(result.meta?.changes!==1)fail('workspace_conflict',409);
 return view({...loaded,journal,store:journal.store,row:{generation}});
}
export async function readWorkspace(db,user,env,scope){return view(await load(db,user,env,scope));}
export async function mutateWorkspace(db,user,env,scope,kind,body){
 if(!exact(body,['expectedGeneration','input'])||!Number.isSafeInteger(body.expectedGeneration)||body.expectedGeneration<0)fail('invalid_workspace_request',400);
 if(kind==='propose'&&sensitiveSummary(body.input?.summary))fail('invalid_workspace_action',400);
 const loaded=await load(db,user,env,scope),{identity,journal,store}=loaded,before=store.export(identity);
 if(journal.events.some(e=>e.operationId===body.input?.operationId))fail('workspace_conflict',409);
 let receipt;try{receipt=store[kind](identity,body.input);}catch(error){fail(/conflict/.test(error.message)?'workspace_conflict':'invalid_workspace_action',/conflict/.test(error.message)?409:400);}
 if(before===store.export(identity))return {...view(loaded),receipt,duplicate:true};
 return {...await persist(db,user,scope,loaded,journal,body.expectedGeneration),receipt,duplicate:false};
}
function reviewDigest(loaded,extra={}){return digest({generation:loaded.row?.generation??0,snapshotDigest:loaded.row?.content_sha256??null,projects:loaded.projects,...extra});}
function sourceChanges(loaded){
 const before=new Map(loaded.store.projects(loaded.identity).map(p=>[p.projectId,p])),after=new Map(loaded.projects.map(p=>[p.projectId,p]));
 return [...new Set([...before.keys(),...after.keys()])].flatMap(projectId=>{
  const previous=before.get(projectId),next=after.get(projectId);if(previous&&next&&sameAuthority([previous],[next]))return [];
  // Removed project metadata is withheld; its scope-owned history stays intact.
  return [{projectId,kind:!previous?'added':!next?'removed':'changed',before:next?previous??null:null,after:next??null,historyCount:loaded.store.actions(loaded.identity).filter(a=>a.projectId===projectId).length}];
 });
}
export async function reviewWorkspaceSources(db,user,env,scope){
 const loaded=await load(db,user,env,scope,true),changes=sourceChanges(loaded);
 return {scope,generation:loaded.row?.generation??0,reviewDigest:reviewDigest(loaded),changes,canReconcile:!changes.some(x=>x.kind==='removed'&&x.historyCount>0)};
}
function previousEvent(loaded,operationId,requestDigest){
 const prior=loaded.journal.events.find(e=>e.operationId===operationId);if(!prior)return null;
 if(prior.requestDigest!==requestDigest)fail('workspace_conflict',409);if(!sameAuthority(loaded.store.projects(loaded.identity),loaded.projects))fail('workspace_source_requires_review',409);return {...view(loaded),journalReceipt:prior,duplicate:true};
}
export async function reconcileWorkspaceSources(db,user,env,scope,body){
 if(!exact(body,['expectedGeneration','operationId','reviewDigest'])||!Number.isSafeInteger(body.expectedGeneration)||body.expectedGeneration<0||!identifier(body.operationId)||typeof body.reviewDigest!=='string')fail('invalid_workspace_request',400);
 const loaded=await load(db,user,env,scope,true),requestDigest=digest({kind:'reconcile',expectedGeneration:body.expectedGeneration,operationId:body.operationId,reviewDigest:body.reviewDigest});
 const prior=previousEvent(loaded,body.operationId,requestDigest);if(prior)return prior;
 if(body.reviewDigest!==reviewDigest(loaded)||!sourceChanges(loaded).length)fail('workspace_review_changed',409);
 let journal;try{journal=reprojectJournal(loaded.identity,loaded.journal,loaded.projects);}catch{fail('workspace_history_requires_retained_project',409);}
 let event;try{event=appendJournalEvent(loaded.identity,journal,{operationId:body.operationId,kind:'reconcile',requestDigest,priorJournalDigest:loaded.row?.content_sha256??digest('empty')});}catch{fail('workspace_conflict',409);}
 return {...await persist(db,user,scope,loaded,journal,body.expectedGeneration),journalReceipt:event,duplicate:false};
}
export async function exportWorkspace(db,user,env,scope){
 const loaded=await load(db,user,env,scope);
 return {format:'devonstation-workspace-transfer',version:1,ownerSubject:user.subject,principalId:loaded.identity.principalId,scope,generation:loaded.row?.generation??0,snapshot:serializeJournal(loaded.identity,loaded.journal)};
}
function incomingJournal(loaded,user,scope,raw){
 let transfer,journal;try{
  transfer=validateWorkspaceTransfer(raw);
  if(transfer.ownerSubject!==user.subject||transfer.principalId!==loaded.identity.principalId||transfer.scope.scopeKind!==scope.scopeKind||transfer.scope.scopeId!==scope.scopeId)throw Error();
  journal=openJournal(loaded.identity,transfer.snapshot);
  if(!sameAuthority(journal.store.projects(loaded.identity),loaded.projects)||journal.store.actions(loaded.identity).some(a=>sensitiveSummary(a.summary)))throw Error();
 }catch{fail('workspace_backup_not_compatible',400);}
 return {transfer,journal};
}
export async function reviewWorkspaceRestore(db,user,env,scope,body){
 if(!exact(body,['backup']))fail('invalid_workspace_request',400);
 const loaded=await load(db,user,env,scope,true),{transfer,journal}=incomingJournal(loaded,user,scope,body.backup);
 return {scope,canRestore:!loaded.row,reviewDigest:reviewDigest(loaded,{backupDigest:digest(transfer)}),projects:loaded.projects,actions:journal.store.actions(loaded.identity).length,receipts:journal.store.receipts(loaded.identity).length,journalEvents:journal.events.length};
}
export async function restoreWorkspace(db,user,env,scope,body){
 if(!exact(body,['expectedGeneration','operationId','reviewDigest','backup'])||body.expectedGeneration!==0||!identifier(body.operationId)||typeof body.reviewDigest!=='string')fail('invalid_workspace_request',400);
 const loaded=await load(db,user,env,scope,true),{transfer,journal}=incomingJournal(loaded,user,scope,body.backup);
 const requestDigest=digest({kind:'restore',expectedGeneration:0,operationId:body.operationId,reviewDigest:body.reviewDigest,backupDigest:digest(transfer)});
 const prior=previousEvent(loaded,body.operationId,requestDigest);if(prior)return prior;
 if(loaded.row)fail('workspace_restore_requires_empty_journal',409);
 if(body.reviewDigest!==reviewDigest(loaded,{backupDigest:digest(transfer)}))fail('workspace_review_changed',409);
 let event;try{event=appendJournalEvent(loaded.identity,journal,{operationId:body.operationId,kind:'restore',requestDigest,priorJournalDigest:digest('empty')});}catch{fail('workspace_conflict',409);}
 return {...await persist(db,user,scope,loaded,journal,0),journalReceipt:event,duplicate:false};
}
