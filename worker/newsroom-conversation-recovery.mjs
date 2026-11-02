/**
 * Offline-only, explicitly synthetic Newsroom conversation export and restore.
 * Never mounted on HTTP, and never enabled for clinical or third-party content.
 * A published-edition archive must already be restored separately to the empty target.
 * Digest checks detect accidental changes, NOT an authenticated backup signature.
 */
import {canonicalJSON,idValid,operationValid,sha256} from './newsroom-contract.mjs';

const MAX_MESSAGES=500;
const MAX_REVISIONS=20;
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const object=(v,fields)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&
 Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
const sql=(db,query,...args)=>db.prepare(query).bind(...args);
const first=(db,query,...args)=>sql(db,query,...args).first();
const rows=async(db,query,...args)=>(await sql(db,query,...args).all()).results??[];
const denied=(action)=>{throw Object.assign(new Error(`synthetic_conversation_${action}_denied`),
 {code:`synthetic_conversation_${action}_denied`});};
function validText(v){return typeof v==='string'&&v.length>=1&&v.length<=1600&&v.trim()===v&&
 !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(v);}
async function memberAllowed(db,org,subject){
 const m=await first(db,`SELECT role FROM nr_memberships WHERE org_id=? AND subject=? AND active=1
   AND role IN ('commenter','publisher','owner')`,org,subject);
 return Boolean(m);
}
async function sourceState(db,org,editionId,action){
 const e=await first(db,`SELECT edition_id,current_version FROM nr_editions
 WHERE org_id=? AND edition_id=? AND lifecycle='published'`,org,editionId);
 if(!e||!Number.isSafeInteger(e.current_version)||e.current_version<1||e.current_version>MAX_REVISIONS)denied(action);
 const revs=await rows(db,`SELECT revision_id,version,content_sha256,manifest_json
 FROM nr_revisions WHERE org_id=? AND edition_id=? ORDER BY version`,org,editionId);
 if(revs.length!==e.current_version)denied(action);
 const revisions=[];
 for(const [i,r] of revs.entries()){
  if(!idValid(r.revision_id)||r.version!==i+1||!hex(r.content_sha256))denied(action);
  let document;try{document=JSON.parse(r.manifest_json);}catch{denied(action)}
  if(await sha256(canonicalJSON(document))!==r.content_sha256)denied(action);
  revisions.push({revisionId:r.revision_id,version:r.version,sha256:r.content_sha256});
 }
 return {edition:{editionId,currentVersion:e.current_version},revisions};
}
const requestHash=(r)=>sha256(canonicalJSON({action:'comment',revisionId:r.revisionId,blockId:r.blockId,text:r.text}));
const archiveDigest=a=>sha256(canonicalJSON(a));

/** Exports ALL messages for one edition, or fails; never silently truncates. */
export async function exportSyntheticConversations(db,orgId,editionId,{allowSyntheticExport=false}={}){
 if(!allowSyntheticExport||!idValid(orgId)||!idValid(editionId))denied('export');
 if(!await first(db,"SELECT org_id FROM nr_organizations WHERE org_id=? AND classification='nonclinical'",orgId))denied('export');
 const source=await sourceState(db,orgId,editionId,'export');
 const records=await rows(db,`SELECT m.message_id,m.revision_id,m.block_id,m.author_sub,
 m.operation_id,m.request_sha256,m.body_text,m.created_at,b.body_text AS anchor_text
 FROM nr_thread_messages m
 JOIN nr_revisions r ON r.org_id=m.org_id AND r.revision_id=m.revision_id
 JOIN nr_revision_blocks b ON b.org_id=m.org_id AND b.revision_id=m.revision_id AND b.block_id=m.block_id
 WHERE m.org_id=? AND r.edition_id=? ORDER BY r.version,m.created_at,m.message_id LIMIT ?`,
 orgId,editionId,MAX_MESSAGES+1);
 if(records.length>MAX_MESSAGES)denied('export');
 const messages=[];
 for(const m of records){
  const record={messageId:m.message_id,revisionId:m.revision_id,blockId:m.block_id,
   authorSub:m.author_sub,operationId:m.operation_id,requestSha256:m.request_sha256,
   text:m.body_text,createdAt:m.created_at,anchorSha256:await sha256(m.anchor_text)};
  if(!idValid(record.messageId)||!idValid(record.revisionId)||!idValid(record.blockId)||
   !idValid(record.authorSub)||!operationValid(record.operationId)||!validText(record.text)||
   !Number.isSafeInteger(record.createdAt)||record.createdAt<1||
   !hex(record.requestSha256)||record.requestSha256!==await requestHash(record))denied('export');
  messages.push(record);
 }
 const body={kind:'newsroom-synthetic-conversation-archive',schemaVersion:1,orgId,...source,messages};
 return {...body,archiveSha256:await archiveDigest(body)};
}

/**
 * Restore only into an organization with published sources restored FIRST and
 * zero existing messages. Database batch ensures all messages or none are written.
 * Members are pre-provisioned fictional active writers, NEVER created by import.
 */
export async function restoreSyntheticConversations(db,orgId,archive,{allowSyntheticRestore=false}={}){
 if(!allowSyntheticRestore||!idValid(orgId)||!object(archive,
  ['kind','schemaVersion','orgId','edition','revisions','messages','archiveSha256'])||
  archive.kind!=='newsroom-synthetic-conversation-archive'||archive.schemaVersion!==1||
  archive.orgId!==orgId||!hex(archive.archiveSha256))denied('restore');
 const {archiveSha256,...body}=archive;
 try{if(await archiveDigest(body)!==archiveSha256)denied('restore');}
 catch{denied('restore')}
 if(!object(archive.edition,['editionId','currentVersion'])||!idValid(archive.edition.editionId)||
  !Array.isArray(archive.revisions)||archive.revisions.length<1||archive.revisions.length>MAX_REVISIONS||
  !Array.isArray(archive.messages)||archive.messages.length>MAX_MESSAGES)denied('restore');
 if(!await first(db,"SELECT org_id FROM nr_organizations WHERE org_id=? AND classification='nonclinical'",orgId))denied('restore');
 // Fail before any write if another edition already has a comment in this org.
 if((await first(db,'SELECT COUNT(*) AS n FROM nr_thread_messages WHERE org_id=?',orgId))?.n!==0)denied('restore');
 const source=await sourceState(db,orgId,archive.edition.editionId,'restore');
 if(canonicalJSON(source)!==canonicalJSON({edition:archive.edition,revisions:archive.revisions}))denied('restore');
 const revisionSet=new Set(source.revisions.map(x=>x.revisionId));
 const seenIds=new Set(),seenOperations=new Set();
 const anchorCache=new Map(),authorCache=new Map();
 const statements=[];
 for(const m of archive.messages){
  if(!object(m,['messageId','revisionId','blockId','authorSub','operationId','requestSha256','text','createdAt','anchorSha256'])||
   !idValid(m.messageId)||!revisionSet.has(m.revisionId)||!idValid(m.blockId)||
   !idValid(m.authorSub)||!operationValid(m.operationId)||!validText(m.text)||
   !Number.isSafeInteger(m.createdAt)||m.createdAt<1||!hex(m.requestSha256)||
   !hex(m.anchorSha256)||m.requestSha256!==await requestHash(m))denied('restore');
  const opKey=m.authorSub+':'+m.operationId;
  if(seenIds.has(m.messageId)||seenOperations.has(opKey))denied('restore');
  seenIds.add(m.messageId);seenOperations.add(opKey);
  if(!authorCache.has(m.authorSub))authorCache.set(m.authorSub,await memberAllowed(db,orgId,m.authorSub));
  if(!authorCache.get(m.authorSub))denied('restore');
  const key=m.revisionId+':'+m.blockId;
  if(!anchorCache.has(key)){
   const row=await first(db,`SELECT b.body_text FROM nr_revision_blocks b
    JOIN nr_revisions r ON r.org_id=b.org_id AND r.revision_id=b.revision_id
    WHERE b.org_id=? AND b.revision_id=? AND b.block_id=? AND r.edition_id=?`,
    orgId,m.revisionId,m.blockId,archive.edition.editionId);
   anchorCache.set(key,row?await sha256(row.body_text):null);
  }
  if(!anchorCache.get(key)||anchorCache.get(key)!==m.anchorSha256)denied('restore');
  statements.push(sql(db,`INSERT INTO nr_thread_messages
   (org_id,message_id,revision_id,block_id,author_sub,operation_id,request_sha256,body_text,created_at)
   VALUES(?,?,?,?,?,?,?,?,?)`,orgId,m.messageId,m.revisionId,m.blockId,
   m.authorSub,m.operationId,m.requestSha256,m.text,m.createdAt));
 }
 // Deliberately not a network route. The caller must keep the target isolated
 // from concurrent writers for the duration of the empty-target preflight/batch.
 try{if(statements.length)await db.batch(statements)}catch{denied('restore')}
 return {restored:true,editionId:source.edition.editionId,messageCount:statements.length,
  archiveSha256};
}
