/** Scoped decision journal. No external-operation dispatcher exists here. */
import {createHash} from 'node:crypto';
import {createFoundation,restoreFoundation} from '../foundation/src/foundation.mjs';
import {createAccessScopeBridge} from '../foundation/src/access-scope-bridge.mjs';
import {approvedProjectsForIdentity} from '../foundation/interop/approved-portfolio.mjs';
import {getCachedPortfolio} from './portfolio.mjs';

const fail=(code,status)=>{throw Object.assign(new Error(code),{status,publicCode:code});};
const digest=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function bridge(user,env){
 try{return createAccessScopeBridge({verifyAssertion:async()=>user,grants:env.WORKSPACE_GRANTS??[]});}
 catch{fail('workspace_not_authorized',403);}
}
// user is supplied exclusively by createStation AFTER hardened Access validation.
async function identityFor(user,env,scope){
 try{return await bridge(user,env).authorize('verified-station-request',scope);}
 catch{fail('workspace_not_authorized',403);}
}
export async function workspaceScopes(user,env){
 bridge(user,env); // Validate the entire server-owned grant configuration.
 const scopes=[];
 for(const grant of env.WORKSPACE_GRANTS??[]){
  if(grant.subject!==user.subject)continue;
  const scope={scopeKind:grant.scopeKind,scopeId:grant.scopeId};
  await identityFor(user,env,scope);scopes.push(scope);
 }
 return {scopes,execution:'record_only'};
}
async function load(db,user,env,scope){
 const identity=await identityFor(user,env,scope);
 if(!db)fail('workspace_storage_unavailable',503);
 if(!Array.isArray(env.WORKSPACE_PROJECT_GRANTS))fail('workspace_not_authorized',403);
 const projectGrants=env.WORKSPACE_PROJECT_GRANTS.filter(g=>g.principalId===identity.principalId&&g.scopeKind===identity.scopeKind&&g.scopeId===identity.scopeId);
 const portfolio=await getCachedPortfolio(db,user.subject,false);
 let projects;
 try{projects=approvedProjectsForIdentity({identity,portfolio,projectGrants}).projects;}
 catch{fail('workspace_source_requires_review',409);}
 const row=await db.prepare('SELECT principal_id,generation,snapshot,content_sha256 FROM station_workspace_state WHERE owner_sub=? AND scope_kind=? AND scope_id=?').bind(user.subject,scope.scopeKind,scope.scopeId).first();
 let store;
 try{
  if(row){
   if(row.principal_id!==identity.principalId||row.content_sha256!==digest(row.snapshot)||!Number.isSafeInteger(row.generation)||row.generation<1)throw Error();
   store=restoreFoundation({identity,serialized:row.snapshot});
   // Source removal, metadata changes or revoked project grants require deliberate
   // reconciliation. Never silently keep an approval against stale authority.
   const authority=p=>p.map(({freshness,source:{observedAt,...source},...rest})=>({...rest,source}));
   if(!same(authority(store.projects(identity)),authority(projects)))fail('workspace_source_requires_review',409);
  }else store=createFoundation({identity,projects});
 }catch(error){if(error.publicCode)throw error;fail('workspace_integrity_failure',503);}
 return {identity,store,row,projects};
}
function view({identity,store,row,projects}){
 return {scope:{scopeKind:identity.scopeKind,scopeId:identity.scopeId},generation:row?.generation??0,
  projects,actions:store.actions(identity),receipts:store.receipts(identity),execution:'record_only'};
}
export async function readWorkspace(db,user,env,scope){return view(await load(db,user,env,scope));}
export async function mutateWorkspace(db,user,env,scope,kind,body){
 if(!body||Object.keys(body).length!==2||!Object.hasOwn(body,'expectedGeneration')||!Object.hasOwn(body,'input')||!Number.isSafeInteger(body.expectedGeneration)||body.expectedGeneration<0)fail('invalid_workspace_request',400);
 if(kind==='propose'&&typeof body.input?.summary==='string'&&/\b(?:patient|diagnosis|medical record|social security number|ssn|password|bank account|credit card number)\b|(?:sk-|ghp_|github_pat_|xox[baprs]-)[a-zA-Z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(body.input.summary))fail('invalid_workspace_action',400);
 const loaded=await load(db,user,env,scope),{identity,store,row}=loaded;
 let receipt;
 try{receipt=store[kind](identity,body.input);}
 catch(error){fail(/conflict/.test(error.message)?'workspace_conflict':'invalid_workspace_action',/conflict/.test(error.message)?409:400);}
 const snapshot=store.export(identity);
 if(row&&snapshot===row.snapshot)return {...view(loaded),receipt,duplicate:true};
 if((row?.generation??0)!==body.expectedGeneration)fail('workspace_conflict',409);
 const generation=body.expectedGeneration+1;
 const statement=row
  ? db.prepare('UPDATE station_workspace_state SET generation=?,snapshot=?,content_sha256=? WHERE owner_sub=? AND scope_kind=? AND scope_id=? AND principal_id=? AND generation=? AND content_sha256=?').bind(generation,snapshot,digest(snapshot),user.subject,scope.scopeKind,scope.scopeId,identity.principalId,row.generation,row.content_sha256)
  : db.prepare('INSERT OR IGNORE INTO station_workspace_state(owner_sub,scope_kind,scope_id,principal_id,generation,snapshot,content_sha256) VALUES(?,?,?,?,?,?,?)').bind(user.subject,scope.scopeKind,scope.scopeId,identity.principalId,generation,snapshot,digest(snapshot));
 // Single-statement compare-and-swap commits action + receipt + retry ledger
 // atomically. No schema creation/migration occurs during an HTTP request.
 const result=await statement.run();
 if(result.meta?.changes!==1)fail('workspace_conflict',409);
 return {...view({...loaded,row:{generation}}),receipt,duplicate:false};
}
