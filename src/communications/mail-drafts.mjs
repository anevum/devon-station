// COMMS-12: owner-scoped D1 drafts. No SMTP, autonomous send, or browser-held secrets.
// SQL parameters are bound, and the owner subject is supplied only by signed Access.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIL=/^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
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
   if(typeof address!=='string'||address.length<3||address.length>254||!MAIL.test(address)||
      address.includes('..')||seen.has(address.toLowerCase()))
     throw error('invalid_mail_draft_recipient',400);
   seen.add(address.toLowerCase());return address;
 });
 return Object.freeze({to,subject:value.subject,body:value.body});
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
 try{payload=validateDraftPayload({to,subject:row.subject,body:row.body_text});}
 catch{throw error('mail_draft_storage_invalid',502);}
 return Object.freeze({id:row.draft_id,revision:row.revision,to:payload.to,subject:payload.subject,
  body:payload.body,updatedAt:row.updated_at,from:'hello@devonakins.com'});
}
const SELECT='SELECT draft_id,revision,recipients_json,subject,body_text,updated_at,last_operation FROM comms_mail_drafts WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=?';
const INSERT='INSERT INTO comms_mail_drafts (installation_id,mailbox_id,owner_sub,draft_id,revision,recipients_json,subject,body_text,created_at,updated_at,last_operation) SELECT ?,?,?,?,1,\'[]\',\'\',\'\',?,?,? WHERE (SELECT COUNT(*) FROM comms_mail_drafts WHERE installation_id=? AND mailbox_id=? AND owner_sub=?)<20 ON CONFLICT(installation_id,mailbox_id,owner_sub,draft_id) DO NOTHING';
const UPDATE='UPDATE comms_mail_drafts SET recipients_json=?,subject=?,body_text=?,updated_at=?,last_operation=?,revision=revision+1 WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? AND revision=? AND revision<1000000000';
const REMOVE='DELETE FROM comms_mail_drafts WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? AND revision=?';
const REMOVE_SAFE=REMOVE+" AND NOT EXISTS (SELECT 1 FROM comms_outbox WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? AND state IN ('queued','claimed','uncertain'))";
const PENDING='SELECT 1 AS pending FROM comms_outbox WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? AND state IN (\'queued\',\'claimed\',\'uncertain\') LIMIT 1';
const changes=result=>result?.meta?.changes;
export function createD1DraftStore(db,{now=()=>new Date().toISOString(),protectPendingOutbox=false}={}){
 if(!db||typeof db.prepare!=='function')throw error('mail_drafts_storage_unavailable',503);
 const get=async(s,id)=> {
   try{return await db.prepare(SELECT).bind(...s,id).first();}
   catch{throw error('mail_draft_storage_failed',502);}
 };
 return Object.freeze({
  async read(scope,draftId){
   const row=await get(validScope(scope),validId(draftId));
   return row?mapRow(row):null;
  },
  async list(scope){
   const s=validScope(scope);
   let response;
   try{response=await db.prepare('SELECT draft_id,revision,recipients_json,subject,body_text,updated_at,last_operation FROM comms_mail_drafts WHERE installation_id=? AND mailbox_id=? AND owner_sub=? ORDER BY updated_at DESC,draft_id LIMIT 21').bind(...s).all();}
   catch{throw error('mail_draft_storage_failed',502);}
   if(!response||response.success===false||!Array.isArray(response.results)||
      response.results.length>MAX_DRAFTS)throw error('mail_draft_storage_invalid',502);
   return response.results.map(mapRow);
  },
  async create(scope,draftId){
   const s=validScope(scope),id=validId(draftId),at=now();
   if(typeof at!=='string'||!Number.isFinite(Date.parse(at)))throw error('mail_draft_clock_invalid',502);
   try{await db.prepare(INSERT).bind(...s,id,at,at,id,...s).run();}
   catch{throw error('mail_draft_storage_failed',502);}
   const row=await get(s,id);
   if(!row)throw error('mail_draft_limit',409);
   return mapRow(row);
  },
  async save(scope,{id,revision,operationId,to,subject,body}={}){
   const s=validScope(scope),key=validId(id),rev=validRevision(revision),operation=validId(operationId);
   const payload=validateDraftPayload({to,subject,body}),at=now();
   let result;
   try{result=await db.prepare(UPDATE).bind(JSON.stringify(payload.to),payload.subject,payload.body,
     at,operation,...s,key,rev).run();}
   catch{throw error('mail_draft_storage_failed',502);}
   const row=await get(s,key);
   if(!row)throw error('mail_draft_not_found',404);
   if(row.last_operation===operation && row.revision===rev+1){
     const stored=mapRow(row);
     if(JSON.stringify(stored.to)!==JSON.stringify(payload.to)||
        stored.subject!==payload.subject||stored.body!==payload.body)
       throw error('mail_draft_conflict',409);
     return stored;
   }
   if(changes(result)!==1)throw error('mail_draft_conflict',409);
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
