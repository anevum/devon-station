// COMMS-12: owner-scoped D1 drafts. No SMTP, autonomous send, or browser-held secrets.
// SQL parameters are bound, and the owner subject is supplied only by signed Access.
import {validateReplyContext} from './mail-core.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIL=/^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
// One canonical recipient grammar for D1 drafts, MIME preparation and SMTP envelope.
export const isValidMailAddress=value=>typeof value==='string'&&value.length>=3&&value.length<=254&&
 MAIL.test(value)&&!value.includes('..');
const ID=/^[a-z][a-z0-9-]{0,62}$/;
const MAX_DRAFTS=20;
const error=(code,status)=>Object.assign(new Error(code),{code,status});
function validScope(scope){
 if(!scope||!ID.test(scope.installationId)||!ID.test(scope.mailboxId)||
   typeof scope.ownerSub!=='string'||scope.ownerSub.length<1||scope.ownerSub.length>256||
   /[\x00-\x1f\x7f]/.test(scope.ownerSub))throw error('invalid_mail_draft_scope',403);
 return [scope.installationId,scope.mailboxId,scope.ownerSub];
}
function validId(id){
 if(typeof id!=='string'||!UUID.test(id))throw error('invalid_mail_draft_id',400);
 return id.toLowerCase();
}
function validRevision(revision){
 if(!Number.isSafeInteger(revision)||revision<1||revision>1_000_000_000)
  throw error('invalid_mail_draft_revision',400);
 return revision;
}
export function validateDraftPayload(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.to)||
   value.to.length>20||typeof value.subject!=='string'||typeof value.body!=='string'||
   value.subject.length>512||value.body.length>32768||
   /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value.subject)||
   /[\x00\u202a-\u202e\u2066-\u2069]/.test(value.body))
  throw error('invalid_mail_draft_payload',400);
 const seen=new Set();
 const to=value.to.map(address=>{
   if(!isValidMailAddress(address)||seen.has(address.toLowerCase()))
     throw error('invalid_mail_draft_recipient',400);
   seen.add(address.toLowerCase());return address;
 });
 let reply={};
 if(Object.hasOwn(value,'replyContext')){
  try{reply={replyContext:validateReplyContext(value.replyContext)};}catch{throw error('invalid_mail_draft_payload',400);}
 }
 return Object.freeze({to,subject:value.subject,body:value.body,...reply});
}
function mapRow(row){
 if(!row||typeof row.draft_id!=='string'||!UUID.test(row.draft_id)||
    !Number.isSafeInteger(row.revision)||row.revision<1||
    typeof row.recipients_json!=='string'||typeof row.subject!=='string'||
    typeof row.body_text!=='string'||typeof row.updated_at!=='string')
  throw error('mail_draft_storage_invalid',502);
 let to;
 try{to=JSON.parse(row.recipients_json);}catch{throw error('mail_draft_storage_invalid',502);}
 let payload;
 try{payload=validateDraftPayload({to,subject:row.subject,body:row.body_text,
  ...(Object.hasOwn(row,'replyContext')?{replyContext:row.replyContext}:{})});}
 catch{throw error('mail_draft_storage_invalid',502);}
 return Object.freeze({id:row.draft_id,revision:row.revision,to:payload.to,subject:payload.subject,
  body:payload.body,...(payload.replyContext?{replyContext:payload.replyContext}:{}),updatedAt:row.updated_at,from:'hello@devonakins.com'});
}
const SELECT='SELECT draft_id,revision,recipients_json,subject,body_text,updated_at,last_operation FROM comms_mail_drafts WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=?';
const INSERT='INSERT INTO comms_mail_drafts (installation_id,mailbox_id,owner_sub,draft_id,revision,recipients_json,subject,body_text,created_at,updated_at,last_operation) SELECT ?,?,?,?,1,\'[]\',\'\',\'\',?,?,? WHERE (SELECT COUNT(*) FROM comms_mail_drafts WHERE installation_id=? AND mailbox_id=? AND owner_sub=?)<20 ON CONFLICT(installation_id,mailbox_id,owner_sub,draft_id) DO NOTHING';
const UPDATE='UPDATE comms_mail_drafts SET recipients_json=?,subject=?,body_text=?,updated_at=?,last_operation=?,revision=revision+1 WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? AND revision=? AND revision<1000000000';
const UPDATE_SAFE=UPDATE+" AND NOT EXISTS (SELECT 1 FROM comms_outbox WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=?)";
const REMOVE='DELETE FROM comms_mail_drafts WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? AND revision=?';
const REMOVE_SAFE=REMOVE+" AND NOT EXISTS (SELECT 1 FROM comms_outbox WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? AND state IN ('queued','claimed','uncertain'))";
const PENDING='SELECT 1 AS pending FROM comms_outbox WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? AND state IN (\'queued\',\'claimed\',\'uncertain\') LIMIT 1';
const changes=result=>result?.meta?.changes;
export function createD1DraftStore(db,{now=()=>new Date().toISOString(),protectPendingOutbox=false,protectLinkedOutbox=false,cipher}={}){
 if(!db||typeof db.prepare!=='function')throw error('mail_drafts_storage_unavailable',503);
 const decode=async(s,row)=>{
  if(!cipher)return mapRow(row);
  if(row.subject!==''||row.body_text!=='')throw error('mail_draft_storage_invalid',502);
  const payload=await cipher.open(row.recipients_json,['draft',...s,row.draft_id]);
  const valid=validateDraftPayload(payload);
  return mapRow({...row,recipients_json:JSON.stringify(valid.to),subject:valid.subject,body_text:valid.body,
   ...(valid.replyContext?{replyContext:valid.replyContext}:{})});
 };
 const encode=(s,id,payload)=>{
  if(!cipher&&payload.replyContext)throw error('invalid_mail_draft_payload',400);
  return cipher?cipher.seal(payload,['draft',...s,id]):JSON.stringify(payload.to);
 };
 const get=async(s,id)=> {
   try{return await db.prepare(SELECT).bind(...s,id).first();}
   catch{throw error('mail_draft_storage_failed',502);}
 };
 return Object.freeze({
  async read(scope,draftId){
   const row=await get(validScope(scope),validId(draftId));
   return row?decode(validScope(scope),row):null;
  },
  async list(scope){
   const s=validScope(scope);
   let response;
   try{response=await db.prepare('SELECT draft_id,revision,recipients_json,subject,body_text,updated_at,last_operation FROM comms_mail_drafts WHERE installation_id=? AND mailbox_id=? AND owner_sub=? ORDER BY updated_at DESC,draft_id LIMIT 21').bind(...s).all();}
   catch{throw error('mail_draft_storage_failed',502);}
   if(!response||response.success===false||!Array.isArray(response.results)||
      response.results.length>MAX_DRAFTS)throw error('mail_draft_storage_invalid',502);
   return Promise.all(response.results.map(row=>decode(s,row)));
  },
  async create(scope,draftId){
   const s=validScope(scope),id=validId(draftId),at=now();
   if(typeof at!=='string'||!Number.isFinite(Date.parse(at)))throw error('mail_draft_clock_invalid',502);
   const encoded=await encode(s,id,{to:[],subject:'',body:''});
   try{await db.prepare(cipher?INSERT.replace("'[]'",'?'):INSERT).bind(...s,id,...(cipher?[encoded]:[]),at,at,id,...s).run();}
   catch{throw error('mail_draft_storage_failed',502);}
   const row=await get(s,id);
   if(!row)throw error('mail_draft_limit',409);
   return decode(s,row);
  },
  async save(scope,{id,revision,operationId,to,subject,body,replyContext}={}){
   const s=validScope(scope),key=validId(id),rev=validRevision(revision),operation=validId(operationId);
   const payload=validateDraftPayload({to,subject,body,...(replyContext!==undefined?{replyContext}:{})}),at=now();
   const encoded=await encode(s,key,payload);
   let result;
   try{result=await db.prepare(protectLinkedOutbox?UPDATE_SAFE:UPDATE)
     .bind(encoded,cipher?'':payload.subject,cipher?'':payload.body,
      at,operation,...s,key,rev,...(protectLinkedOutbox?[...s,key]:[])).run();}
   catch{throw error('mail_draft_storage_failed',502);}
   const row=await get(s,key);
   if(!row)throw error('mail_draft_not_found',404);
   if(row.last_operation===operation && row.revision===rev+1){
     const stored=await decode(s,row);
     if(JSON.stringify(stored.to)!==JSON.stringify(payload.to)||
        stored.subject!==payload.subject||stored.body!==payload.body||
        JSON.stringify(stored.replyContext)!==JSON.stringify(payload.replyContext))
       throw error('mail_draft_conflict',409);
     return stored;
   }
    if(changes(result)!==1){
     // A previous save can be replayed idempotently; all NEW revisions are
     // refused once a delivery snapshot exists, regardless of SMTP state.
     if(row.revision===rev&&protectLinkedOutbox){
      let linked;
      try{linked=await db.prepare('SELECT 1 AS linked FROM comms_outbox WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? LIMIT 1').bind(...s,key).first();}
      catch{throw error('mail_draft_storage_failed',502);}
      if(linked)throw error('mail_draft_delivery_locked',409);
     }
     throw error('mail_draft_conflict',409);
    }
   throw error('mail_draft_storage_invalid',502);
  },
  async remove(scope,{id,revision}={}){
   const s=validScope(scope),key=validId(id),rev=validRevision(revision);
   let result;
   try{result=await db.prepare(protectPendingOutbox?REMOVE_SAFE:REMOVE)
    .bind(...s,key,rev,...(protectPendingOutbox?[...s,key]:[])).run();}
   catch{throw error('mail_draft_storage_failed',502);}
   if(changes(result)===1)return {deleted:true};
   const row=await get(s,key);
   if(!row)throw error('mail_draft_not_found',404);
   if(row.revision!==rev)throw error('mail_draft_conflict',409);
   if(protectPendingOutbox){
    // The DELETE itself is atomic with the NOT EXISTS guard; this lookup only
    // distinguishes a blocked deletion from a stale revision for the owner.
    let pending;
    try{pending=await db.prepare(PENDING).bind(...s,key).first();}
    catch{throw error('mail_draft_storage_failed',502);}
    if(pending)throw error('mail_draft_pending_delivery',409);
   }
   throw error('mail_draft_conflict',409);
  }
 });
}
