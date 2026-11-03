/**
 * Independent, offline, synthetic-only restore drill. Never wired to HTTP.
 * Requires a separately approved empty organization-scoped target and pre-provisioned
 * fictional active members; no Access, secrets, or real patient data are handled here.
 */
import {canonicalJSON,idValid,manifestBlocks,operationValid,sha256,slugValid,titleValid,validateManifest} from './newsroom-contract.mjs';
const sql=(db,query,...args)=>db.prepare(query).bind(...args);
const first=(db,query,...args)=>sql(db,query,...args).first();
const denied=()=>{throw Object.assign(new Error('synthetic_restore_denied'),{code:'synthetic_restore_denied'})};
const hex=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);

/** Validate everything before beginning any database write. */
export async function restoreSyntheticEdition(db,orgId,archive,{allowSyntheticRestore=false}={}){
 if(!allowSyntheticRestore||!idValid(orgId)||!archive||archive.kind!=='newsroom-published-edition'||archive.schemaVersion!==1||archive.orgId!==orgId)denied();
 const e=archive.edition;if(!e||!idValid(e.editionId)||!slugValid(e.slug)||!titleValid(e.title)||!Number.isSafeInteger(e.currentVersion))denied();
 const revisions=archive.revisions;if(!Array.isArray(revisions)||revisions.length<1||revisions.length>20||revisions.length!==e.currentVersion)denied();
 const operations=archive.operations;if(!Array.isArray(operations)||operations.length!==revisions.length)denied();
 const allowed=await first(db,"SELECT classification FROM nr_organizations WHERE org_id=? AND classification='nonclinical'",orgId);
 if(!allowed)denied();
 // Never merge or overwrite a target, even if the existing record is a draft.
 for(const table of ['nr_editions','nr_drafts','nr_revisions','nr_revision_blocks','nr_operations','nr_audit_events']){
  const exists=await first(db,`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`,orgId);if(exists?.n!==0)denied();
 }
 const actorSet=new Set(),revSet=new Set();let lastGen=0;
 for(const [i,r] of revisions.entries()){
  if(!r||!idValid(r.revisionId)||revSet.has(r.revisionId)||r.version!==i+1||!Number.isSafeInteger(r.sourceGeneration)||r.sourceGeneration<=lastGen||!Number.isSafeInteger(r.publishedAt)||r.publishedAt<1||!hex(r.sha256)||!idValid(r.publishedBy))denied();
  const actual=validateManifest(r.manifest);if(await sha256(canonicalJSON(actual))!==r.sha256)denied();
  lastGen=r.sourceGeneration;revSet.add(r.revisionId);actorSet.add(r.publishedBy);
 }
 for(const actor of actorSet){const row=await first(db,"SELECT role FROM nr_memberships WHERE org_id=? AND subject=? AND active=1 AND role IN ('publisher','owner')",orgId,actor);if(!row)denied();}
 const opSet=new Set();for(const op of operations){
  if(!op||!idValid(op.actorSub)||!operationValid(op.operationId)||op.action!=='publish'||!hex(op.requestSha256)||!revSet.has(op.resultId)||!Number.isSafeInteger(op.createdAt)||op.createdAt<1)denied();
  const rev=revisions.find(r=>r.revisionId===op.resultId);
  if(op.actorSub!==rev.publishedBy||op.requestSha256!==await sha256(canonicalJSON({editionId:e.editionId,generation:rev.sourceGeneration,action:'publish'})))denied();
  const key=op.actorSub+':'+op.operationId;if(opSet.has(key))denied();opSet.add(key);
 }
 const firstRev=revisions[0],at=firstRev.publishedAt;
 const commands=[
  sql(db,'INSERT INTO nr_editions(org_id,edition_id,slug,title,lifecycle,current_version,created_by,created_at) VALUES(?,?,?, ?,\'draft\',0,?,?)',orgId,e.editionId,e.slug,e.title,firstRev.publishedBy,at),
  sql(db,'INSERT INTO nr_drafts(org_id,edition_id,generation,last_published_generation,manifest_json,updated_by,updated_at) VALUES(?,?,?,0,?,?,?)',orgId,e.editionId,firstRev.sourceGeneration,canonicalJSON(validateManifest(firstRev.manifest)),firstRev.publishedBy,at)
 ];
 for(const [i,r] of revisions.entries()){
  const manifest=validateManifest(r.manifest);
  if(i>0)commands.push(sql(db,'UPDATE nr_drafts SET generation=?,manifest_json=?,updated_by=?,updated_at=? WHERE org_id=? AND edition_id=?',r.sourceGeneration,canonicalJSON(manifest),r.publishedBy,r.publishedAt,orgId,e.editionId));
  commands.push(sql(db,`INSERT INTO nr_revisions(org_id,revision_id,edition_id,version,source_generation,content_sha256,manifest_json,published_by,published_at)
   VALUES(?,?,?,?,?,?,?,?,?)`,orgId,r.revisionId,e.editionId,r.version,r.sourceGeneration,r.sha256,canonicalJSON(manifest),r.publishedBy,r.publishedAt));
  commands.push(...manifestBlocks(manifest).map(b=>sql(db,`INSERT INTO nr_revision_blocks(org_id,revision_id,block_id,article_id,ordinal,block_kind,body_text,source_uri)
   VALUES(?,?,?,?,?,?,?,?)`,orgId,r.revisionId,b.blockId,b.articleId,b.ordinal,b.kind,b.text,b.sourceUri)));
  commands.push(sql(db,'UPDATE nr_drafts SET last_published_generation=? WHERE org_id=? AND edition_id=?',r.sourceGeneration,orgId,e.editionId));
  commands.push(sql(db,"UPDATE nr_editions SET lifecycle='published',current_version=? WHERE org_id=? AND edition_id=?",r.version,orgId,e.editionId));
  commands.push(sql(db,'INSERT INTO nr_audit_events(org_id,audit_id,actor_sub,action,resource_id,created_at) VALUES(?,?,?,?,?,?)',orgId,crypto.randomUUID(),r.publishedBy,i?'correct':'publish',r.revisionId,r.publishedAt));
 }
 for(const op of operations)commands.push(sql(db,'INSERT INTO nr_operations(org_id,actor_sub,operation_id,action,request_sha256,result_id,created_at) VALUES(?,?,?,?,?,?,?)',orgId,op.actorSub,op.operationId,op.action,op.requestSha256,op.resultId,op.createdAt));
 // SQLite/D1 batch is atomic; failure cannot leave a half-restored edition.
 try{await db.batch(commands)}catch{denied()}
 return {restored:true,editionId:e.editionId,currentVersion:e.currentVersion,revisions:revisions.length};
}
