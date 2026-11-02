/**
 * DS011-RB02-01B: one immutable-edition-block discussion, source-only.
 * Explicitly unmounted in the existing RB01 and RB02-01A application routes.
 * Requires the independently authorized synthetic-only D1 and Access boundary.
 * A comment is NOT an authorization or a workflow dispatcher.
 */
import {authorizedIdentity} from './access.mjs';
import {canonicalJSON,idValid,operationValid,sha256} from './newsroom-contract.mjs';

const safeHeaders={
 'Cache-Control':'private, no-store',
 'Content-Type':'application/json;charset=utf-8',
 'X-Content-Type-Options':'nosniff',
 'Referrer-Policy':'no-referrer',
 'Strict-Transport-Security':'max-age=31536000',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
const respond=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:safeHeaders});
const failure=(status,code)=>({status,publicCode:code});
const notFound=()=>failure(404,'not_found');
const sql=(db,statement,...params)=>db.prepare(statement).bind(...params);
const first=(db,statement,...params)=>sql(db,statement,...params).first();

async function readBody(request){
 const limit=4096;
 if(Number(request.headers.get('Content-Length'))>limit)throw failure(413,'request_too_large');
 if(!request.body)throw failure(400,'invalid_json');
 const reader=request.body.getReader();let size=0;const parts=[];
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;
   if(size>limit){await reader.cancel();throw failure(413,'request_too_large')}
   parts.push(value);
  }
 }finally{reader.releaseLock()}
 const data=new Uint8Array(size);let at=0;
 for(const part of parts){data.set(part,at);at+=part.byteLength;}
 try{
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  if(!value||Array.isArray(value)||typeof value!=='object')throw Error();
  return value;
 }catch{throw failure(400,'invalid_json')}
}
function commentValid(text){
 return typeof text==='string'&&text.length>=1&&text.length<=1600&&
  text.trim()===text&&!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text);
}
function exact(value,expected){return !!value&&typeof value==='object'&&!Array.isArray(value)&&
 Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key));}
async function membership(db,org,subject){
 return first(db,`SELECT m.role FROM nr_memberships m
 JOIN nr_organizations o ON o.org_id=m.org_id
 WHERE o.org_id=? AND o.classification='nonclinical' AND m.subject=? AND m.active=1`,org,subject);
}
async function anchor(db,org,revision,block){
 const row=await first(db,`SELECT r.edition_id,r.version,r.content_sha256,b.article_id,b.body_text
 FROM nr_revision_blocks b JOIN nr_revisions r ON r.org_id=b.org_id AND r.revision_id=b.revision_id
 JOIN nr_editions e ON e.org_id=r.org_id AND e.edition_id=r.edition_id
 WHERE b.org_id=? AND b.revision_id=? AND b.block_id=? AND e.lifecycle='published'`,org,revision,block);
 if(!row)throw notFound();
 return {editionId:row.edition_id,revisionId:revision,version:row.version,
  revisionSha256:row.content_sha256,articleId:row.article_id,blockId:block,text:row.body_text};
}
async function messageList(db,org,revision,block){
 const result=await sql(db,`SELECT message_id,author_sub,body_text,created_at
 FROM nr_thread_messages WHERE org_id=? AND revision_id=? AND block_id=?
 ORDER BY rowid LIMIT 101`,org,revision,block).all();
 const rows=result.results??[];
 return {messages:rows.slice(0,100).map(row=>({messageId:row.message_id,authorSub:row.author_sub,
  text:row.body_text,createdAt:row.created_at})),truncated:rows.length>100};
}
async function replay(db,org,actor,operationId,hash,revision,block){
 const row=await first(db,`SELECT message_id,revision_id,block_id,body_text,request_sha256,created_at
 FROM nr_thread_messages WHERE org_id=? AND author_sub=? AND operation_id=?`,org,actor,operationId);
 if(!row)return null;
 if(row.request_sha256!==hash||row.revision_id!==revision||row.block_id!==block)throw failure(409,'operation_reused');
 return {messageId:row.message_id,revisionId:revision,blockId:block,
  authorSub:actor,text:row.body_text,createdAt:row.created_at,duplicate:true};
}
async function post(db,org,actor,revision,block,payload){
 if(!exact(payload,['operationId','text'])||!operationValid(payload.operationId)||!commentValid(payload.text))
  throw failure(400,'invalid_comment');
 const hash=await sha256(canonicalJSON({action:'comment',revisionId:revision,blockId:block,text:payload.text}));
 const prior=await replay(db,org,actor,payload.operationId,hash,revision,block);
 if(prior)return {status:200,data:prior};
 const messageId=crypto.randomUUID(),at=Date.now();
 try{await sql(db,`INSERT INTO nr_thread_messages
  (org_id,message_id,revision_id,block_id,author_sub,operation_id,request_sha256,body_text,created_at)
  VALUES(?,?,?,?,?,?,?,?,?)`,org,messageId,revision,block,actor,payload.operationId,hash,payload.text,at).run()}
 catch{
  const concurrent=await replay(db,org,actor,payload.operationId,hash,revision,block);
  if(concurrent)return {status:200,data:concurrent};
  throw failure(409,'comment_conflict');
 }
 return {status:201,data:{messageId,revisionId:revision,blockId:block,
  authorSub:actor,text:payload.text,createdAt:at,duplicate:false}};
}

export function createNewsroomConversationHandler({authenticate=authorizedIdentity}={}){
 return {async fetch(request,env,ctx){try{
  if(env?.NEWSROOM_SYNTHETIC_ONLY!=='true'||!env.NEWSROOM_DB||!idValid(env.NEWSROOM_ORG_ID))
   return respond({error:'not_configured'},503);
  const url=new URL(request.url);
  if(url.origin!==env.APP_ORIGIN)return respond({error:'wrong_origin'},403);
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts.length!==5&&parts.length!==6)return respond({error:'not_found'},404);
  if(parts[0]!=='api'||parts[1]!=='newsroom'||parts[2]!=='conversations'||
    !idValid(parts[3])||!idValid(parts[4]))return respond({error:'not_found'},404);
  const write=parts.length===6;
  if(write&&parts[5]!=='messages')return respond({error:'not_found'},404);
  if((write&&request.method!=='POST')||(!write&&request.method!=='GET'))
   return respond({error:'method_not_allowed'},405);
  if(write&&(request.headers.get('Origin')!==url.origin||
   request.headers.get('Content-Type')?.split(';')[0]!=='application/json'))
   return respond({error:'same_origin_json_required'},403);
  let user;try{user=await authenticate(request,env,ctx)}catch{return respond({error:'sign_in_required'},401)}
  if(!user?.subject)return respond({error:'sign_in_required'},401);
  const db=env.NEWSROOM_DB,org=env.NEWSROOM_ORG_ID;
  const m=await membership(db,org,user.subject);
  if(!m)return respond({error:'not_found'},404);
  if(write&&!['commenter','publisher','owner'].includes(m.role))return respond({error:'not_found'},404);
  const anchored=await anchor(db,org,parts[3],parts[4]);
  if(!write)return respond({anchor:anchored,...await messageList(db,org,parts[3],parts[4])});
  const outcome=await post(db,org,user.subject,parts[3],parts[4],await readBody(request));
  return respond(outcome.data,outcome.status);
 }catch(error){return respond({error:error?.publicCode??'request_failed'},error?.status??503)}}};
}
