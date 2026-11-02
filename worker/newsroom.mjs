/**
 * DS011-RB02-01A — source-only Newsroom edition route, not mounted in RB01.
 * Requires a separate synthetic-only DB and independently approved Access app.
 * The RB01 Worker entrypoint and owner-only guard are intentionally unchanged.
 */
import {authorizedIdentity} from './access.mjs';
import {canonicalJSON,idValid,manifestBlocks,operationValid,sha256,slugValid,titleValid,validateManifest} from './newsroom-contract.mjs';
import {renderNewsroomEdition} from './newsroom-render.mjs';

const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security':'max-age=31536000'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...headers,'Content-Type':'application/json;charset=utf-8'}});
const err=(status,code)=>({status,publicCode:code});
const resourceNotFound=()=>err(404,'not_found');
const sql=(db,query,...bind)=>db.prepare(query).bind(...bind);
const first=(db,query,...args)=>sql(db,query,...args).first();
const known= (v,required) => v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>required.includes(k))&&required.every(k=>Object.hasOwn(v,k));
function isAllowed(role,action){return ['owner','publisher'].includes(role)||action==='read'&&['reader','commenter'].includes(role);}
async function body(request){
 const limit=32768;
 if(Number(request.headers.get('Content-Length'))>limit)throw err(413,'request_too_large');
 if(!request.body)throw err(400,'invalid_json');
 const reader=request.body.getReader(),pieces=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw err(413,'request_too_large');}pieces.push(value)}}finally{reader.releaseLock()}
 const bytes=new Uint8Array(size);let offset=0;for(const p of pieces){bytes.set(p,offset);offset+=p.length}
 try{const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error();return payload;}catch{throw err(400,'invalid_json');}
}
async function member(db,orgId,subject){
 return first(db,`SELECT m.role FROM nr_memberships m JOIN nr_organizations o ON o.org_id=m.org_id
 WHERE o.org_id=? AND o.classification='nonclinical' AND m.subject=? AND m.active=1`,orgId,subject);
}
async function draft(db,org,id){return first(db,`SELECT d.generation,d.last_published_generation,d.manifest_json,e.current_version,e.title,e.lifecycle,e.slug
 FROM nr_drafts d JOIN nr_editions e ON e.org_id=d.org_id AND e.edition_id=d.edition_id
 WHERE d.org_id=? AND d.edition_id=?`,org,id)}
async function published(db,org,id,version){
 const row=await first(db,`SELECT e.title,e.slug,r.revision_id,r.version,r.source_generation,r.content_sha256,r.manifest_json,r.published_by,r.published_at
 FROM nr_editions e JOIN nr_revisions r ON r.org_id=e.org_id AND r.edition_id=e.edition_id
 WHERE e.org_id=? AND e.edition_id=? AND e.lifecycle='published' AND r.version=?`,org,id,version);
 if(!row)return null;
 return {edition:{editionId:id,title:row.title,slug:row.slug},revision:{revisionId:row.revision_id,version:row.version,sourceGeneration:row.source_generation,sha256:row.content_sha256,manifest:JSON.parse(row.manifest_json),publishedBy:row.published_by,publishedAt:row.published_at}};
}
const revisionById=(db,org,id)=>first(db,'SELECT edition_id,version FROM nr_revisions WHERE org_id=? AND revision_id=?',org,id);
async function list(db,org){const result=await sql(db,`SELECT edition_id,title,slug,current_version FROM nr_editions
 WHERE org_id=? AND lifecycle='published' ORDER BY created_at DESC LIMIT 30`,org).all();return {editions:(result.results??[]).map(r=>({editionId:r.edition_id,title:r.title,slug:r.slug,version:r.current_version}))};}
async function makeDraft(db,org,actor,payload){
 if(!known(payload,['slug','title','manifest'])||!slugValid(payload.slug)||!titleValid(payload.title))throw err(400,'invalid_publication');
 const normalized=validateManifest(payload.manifest),text=canonicalJSON(normalized);
 const id=crypto.randomUUID(),at=Date.now();
 try{await db.batch([
  sql(db,'INSERT INTO nr_editions(org_id,edition_id,slug,title,created_by,created_at) VALUES(?,?,?,?,?,?)',org,id,payload.slug,payload.title,actor,at),
  sql(db,'INSERT INTO nr_drafts(org_id,edition_id,generation,last_published_generation,manifest_json,updated_by,updated_at) VALUES(?,?,1,0,?,?,?)',org,id,text,actor,at),
  sql(db,'INSERT INTO nr_audit_events(org_id,audit_id,actor_sub,action,resource_id,created_at) VALUES(?,?,?,?,?,?)',org,crypto.randomUUID(),actor,'draft_create',id,at)
 ]);}catch{throw err(409,'draft_conflict')}
 return {editionId:id,generation:1,status:'draft'};
}
async function editDraft(db,org,actor,id,payload){
 if(!known(payload,['expectedGeneration','manifest'])||!Number.isSafeInteger(payload.expectedGeneration)||payload.expectedGeneration<1)throw err(400,'invalid_publication');
 const normalized=validateManifest(payload.manifest),text=canonicalJSON(normalized),at=Date.now();
 const [result]=await db.batch([
  sql(db,`UPDATE nr_drafts SET manifest_json=?,generation=generation+1,updated_by=?,updated_at=?
 WHERE org_id=? AND edition_id=? AND generation=? AND EXISTS(
 SELECT 1 FROM nr_editions WHERE org_id=? AND edition_id=? AND lifecycle!='withdrawn')`,text,actor,at,org,id,payload.expectedGeneration,org,id),
  sql(db,`INSERT INTO nr_audit_events(org_id,audit_id,actor_sub,action,resource_id,created_at)
   SELECT ?,?,?,?,?,? WHERE changes()=1`,org,crypto.randomUUID(),actor,'draft_update',id,at)
 ]);
 if(result.meta?.changes!==1)throw err(409,'draft_generation_conflict');
 return {editionId:id,generation:payload.expectedGeneration+1,status:'draft'};
}
async function publishDraft(db,org,actor,id,payload){
 if(!known(payload,['expectedGeneration','operationId'])||!Number.isSafeInteger(payload.expectedGeneration)||payload.expectedGeneration<1||!operationValid(payload.operationId))throw err(400,'invalid_publication');
 const hash=await sha256(canonicalJSON({editionId:id,generation:payload.expectedGeneration,action:'publish'}));
 const prior=await first(db,'SELECT action,request_sha256,result_id FROM nr_operations WHERE org_id=? AND actor_sub=? AND operation_id=?',org,actor,payload.operationId);
 async function replay(op){if(op.action!=='publish'||op.request_sha256!==hash)throw err(409,'operation_reused');const prev=await revisionById(db,org,op.result_id);if(!prev)throw err(503,'storage_unavailable');const entry=await published(db,org,prev.edition_id,prev.version);if(!entry)throw resourceNotFound();return {editionId:prev.edition_id,...entry.revision};}
 if(prior)return replay(prior);
 const current=await draft(db,org,id);if(!current||current.lifecycle==='withdrawn')throw resourceNotFound();
 if(current.generation!==payload.expectedGeneration||current.last_published_generation>=current.generation)throw err(409,'draft_generation_conflict');
 const normalized=validateManifest(JSON.parse(current.manifest_json));
 const manifestJSON=canonicalJSON(normalized),digest=await sha256(manifestJSON);
 const revId=crypto.randomUUID(),version=current.current_version+1,at=Date.now();
 const statements=[
  sql(db,`INSERT INTO nr_revisions(org_id,revision_id,edition_id,version,source_generation,content_sha256,manifest_json,published_by,published_at)
   VALUES(?,?,?,?,?,?,?,?,?)`,org,revId,id,version,payload.expectedGeneration,digest,manifestJSON,actor,at),
  ...manifestBlocks(normalized).map(b=>sql(db,`INSERT INTO nr_revision_blocks(org_id,revision_id,block_id,article_id,ordinal,block_kind,body_text,source_uri)
   VALUES(?,?,?,?,?,?,?,?)`,org,revId,b.blockId,b.articleId,b.ordinal,b.kind,b.text,b.sourceUri)),
  sql(db,'UPDATE nr_drafts SET last_published_generation=? WHERE org_id=? AND edition_id=?',payload.expectedGeneration,org,id),
  sql(db,"UPDATE nr_editions SET current_version=?,lifecycle='published' WHERE org_id=? AND edition_id=?",version,org,id),
  sql(db,'INSERT INTO nr_operations(org_id,actor_sub,operation_id,action,request_sha256,result_id,created_at) VALUES(?,?,?,?,?,?,?)',org,actor,payload.operationId,'publish',hash,revId,at),
  sql(db,'INSERT INTO nr_audit_events(org_id,audit_id,actor_sub,action,resource_id,created_at) VALUES(?,?,?,?,?,?)',org,crypto.randomUUID(),actor,version===1?'publish':'correct',revId,at)
 ];
 try{await db.batch(statements);}catch{
  const concurrent=await first(db,'SELECT action,request_sha256,result_id FROM nr_operations WHERE org_id=? AND actor_sub=? AND operation_id=?',org,actor,payload.operationId);
  if(concurrent)return replay(concurrent);
  throw err(409,'publish_conflict');
 }
 return {editionId:id,revisionId:revId,version,sourceGeneration:payload.expectedGeneration,sha256:digest,manifest:normalized,publishedBy:actor,publishedAt:at};
}
async function exportPublished(db,org,actor,id){
 const e=await first(db,"SELECT edition_id,title,slug,current_version FROM nr_editions WHERE org_id=? AND edition_id=? AND lifecycle='published'",org,id);
 if(!e)throw resourceNotFound();
 const rows=(await sql(db,'SELECT revision_id,version,source_generation,content_sha256,manifest_json,published_by,published_at FROM nr_revisions WHERE org_id=? AND edition_id=? ORDER BY version',org,id).all()).results??[];
 const revisions=[];
 for(const r of rows){const content=JSON.parse(r.manifest_json);if(await sha256(canonicalJSON(content))!==r.content_sha256)throw err(503,'storage_unavailable');
  revisions.push({revisionId:r.revision_id,version:r.version,sourceGeneration:r.source_generation,sha256:r.content_sha256,publishedBy:r.published_by,publishedAt:r.published_at,manifest:content});
 }
 const operations=(await sql(db,`SELECT o.actor_sub,o.operation_id,o.action,o.request_sha256,o.result_id,o.created_at FROM nr_operations o
  JOIN nr_revisions r ON r.org_id=o.org_id AND r.revision_id=o.result_id
  WHERE r.org_id=? AND r.edition_id=? ORDER BY o.created_at,o.operation_id`,org,id).all()).results??[];
 return {schemaVersion:1,kind:'newsroom-published-edition',orgId:org,edition:{editionId:e.edition_id,slug:e.slug,title:e.title,currentVersion:e.current_version},revisions,operations:operations.map(o=>({actorSub:o.actor_sub,operationId:o.operation_id,action:o.action,requestSha256:o.request_sha256,resultId:o.result_id,createdAt:o.created_at}))};
}
/**
 * An unattached route handler. No change to RB01 routes or owner-only access.
 * Call only in a separately authorized synthetic nonclinical Worker test scope.
 */
export function createNewsroomHandler({authenticate=authorizedIdentity}={}){
 return {async fetch(request,env,ctx){
  try{
   if(env?.NEWSROOM_SYNTHETIC_ONLY!=='true'||!env.NEWSROOM_DB||!idValid(env.NEWSROOM_ORG_ID))return json({error:'not_configured'},503);
   const url=new URL(request.url);
   if(url.origin!==env.APP_ORIGIN)return json({error:'wrong_origin'},403);
   if(!url.pathname.startsWith('/api/newsroom/'))return json({error:'not_found'},404);
   let user;try{user=await authenticate(request,env,ctx);}catch{return json({error:'sign_in_required'},401)}
   if(!user?.subject)return json({error:'sign_in_required'},401);
   const membership=await member(env.NEWSROOM_DB,env.NEWSROOM_ORG_ID,user.subject);
   if(!membership)return json({error:'not_found'},404);
   const method=request.method,write=['POST','PUT','PATCH','DELETE'].includes(method);
   if(write&&(request.headers.get('Origin')!==url.origin||request.headers.get('Content-Type')?.split(';')[0]!=='application/json'))return json({error:'same_origin_json_required'},403);
   if(!['GET','POST','PUT'].includes(method))return json({error:'method_not_allowed'},405);
   const org=env.NEWSROOM_ORG_ID,db=env.NEWSROOM_DB,role=membership.role,actor=user.subject;
   const parts=url.pathname.split('/').filter(Boolean);
   // GET /api/newsroom/editions
   if(parts.length===3&&parts[2]==='editions'&&method==='GET')return json(await list(db,org));
   // POST /api/newsroom/drafts
   if(parts.length===3&&parts[2]==='drafts'&&method==='POST'){
    if(!isAllowed(role,'publish'))throw resourceNotFound();return json(await makeDraft(db,org,actor,await body(request)),201);
   }
   // GET/PUT /api/newsroom/drafts/:id
   if(parts.length===4&&parts[2]==='drafts'&&idValid(parts[3])){
    if(!isAllowed(role,'publish'))throw resourceNotFound();
    if(method==='GET'){
     const row=await draft(db,org,parts[3]);if(!row)throw resourceNotFound();
     return json({editionId:parts[3],title:row.title,slug:row.slug,generation:row.generation,currentVersion:row.current_version,manifest:JSON.parse(row.manifest_json)});
    }
    if(method==='PUT')return json(await editDraft(db,org,actor,parts[3],await body(request)));
   }
   // POST /api/newsroom/drafts/:id/publish
   if(parts.length===5&&parts[2]==='drafts'&&parts[4]==='publish'&&idValid(parts[3])&&method==='POST'){
    if(!isAllowed(role,'publish'))throw resourceNotFound();return json(await publishDraft(db,org,actor,parts[3],await body(request)),201);
   }
   // GET /api/newsroom/editions/:id/revisions/:version(?format=html)
   if(parts.length===6&&parts[2]==='editions'&&parts[4]==='revisions'&&idValid(parts[3])&&/^[1-9][0-9]{0,5}$/.test(parts[5])&&method==='GET'){
    const entry=await published(db,org,parts[3],Number(parts[5]));if(!entry)throw resourceNotFound();
    if(url.searchParams.get('format')==='html'){
     const html=renderNewsroomEdition(entry.edition,entry.revision);
     return new Response(html,{headers:{...headers,'Content-Type':'text/html;charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'none'"}});
    }
    return json(entry);
   }
   // GET /api/newsroom/editions/:id/export
   if(parts.length===5&&parts[2]==='editions'&&parts[4]==='export'&&idValid(parts[3])&&method==='GET'){
    return json(await exportPublished(db,org,actor,parts[3]));
   }
   return json({error:'not_found'},404);
  }catch(e){return json({error:e?.publicCode??'request_failed'},e?.status??503)}
 }};
}
