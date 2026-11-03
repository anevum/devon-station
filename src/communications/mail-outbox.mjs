// Server-owned outbox adapter/dispatcher. No scheduler, HTTP send route or implicit retry.
import {prepareOutgoingPlainText} from './mail-outbound-wire.mjs';
import {createPurelymailSmtpTransport} from './mail-smtp-transport.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID=/^[a-z][a-z0-9-]{0,62}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const id=value=>{if(typeof value!=='string'||!UUID.test(value))fail('outbox_invalid_id');return value;};
const columns='installation_id=? AND mailbox_id=? AND owner_sub=? AND delivery_id=?';
const linkage='installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? AND draft_revision=?';
const revision=value=>{
 if(!Number.isSafeInteger(value)||value<1||value>1000000000)fail('outbox_invalid_draft_revision');
 return value;
};
const receipt=row=>({deliveryId:row.delivery_id,state:row.state,createdAt:row.created_at,updatedAt:row.updated_at,
 ...(typeof row.draft_id==='string'&&row.draft_revision!==null?
 {draftId:row.draft_id,draftRevision:row.draft_revision}:{})});
export function createD1Outbox(db,scope,{now=()=>new Date().toISOString()}={}){
 if(!db?.prepare||!ID.test(scope?.installationId)||!ID.test(scope?.mailboxId)||
  typeof scope?.ownerSub!=='string'||!scope.ownerSub||scope.ownerSub.length>256||/[\x00-\x1f\x7f]/.test(scope.ownerSub))fail('outbox_invalid_scope');
 const parts=[scope.installationId,scope.mailboxId,scope.ownerSub];
 const clock=()=>{const at=now();if(typeof at!=='string'||!Number.isFinite(Date.parse(at)))fail('outbox_invalid_clock');return at;};
 const get=deliveryId=>db.prepare('SELECT * FROM comms_outbox WHERE '+columns).bind(...parts,id(deliveryId)).first();
 return Object.freeze({
  async offer(deliveryId,payload){
   id(deliveryId);const text=JSON.stringify(payload),at=clock();
   if(new TextEncoder().encode(text).length>160*1024)fail('outbox_payload_limit');
   await db.prepare("INSERT INTO comms_outbox (installation_id,mailbox_id,owner_sub,delivery_id,payload_json,state,claim_id,created_at,updated_at) SELECT ?,?,?,?,?, 'queued',NULL,?,? WHERE (SELECT count(*) FROM comms_outbox WHERE installation_id=? AND mailbox_id=? AND owner_sub=?)<100 ON CONFLICT DO NOTHING")
    .bind(...parts,deliveryId,text,at,at,...parts).run();
   const row=await get(deliveryId);if(!row)fail('outbox_limit');
   if(row.payload_json!==text)fail('outbox_conflict');return receipt(row);
  },
  async offerLinkedDraft(deliveryId,{draftId,draftRevision,payload}={}){
   id(deliveryId);id(draftId);revision(draftRevision);
   if(!payload||!payload.draft||!Array.isArray(payload.draft.to)||
    typeof payload.draft.subject!=='string'||typeof payload.draft.body!=='string')
    fail('outbox_invalid_draft_payload');
   const encoded=JSON.stringify(payload),at=clock();
   if(new TextEncoder().encode(encoded).length>160*1024)fail('outbox_payload_limit');
   // One atomic INSERT SELECT checks the trusted owner-scoped draft revision
   // and inserts an immutable payload. A unique index serializes competing IDs.
   await db.prepare("INSERT OR IGNORE INTO comms_outbox (installation_id,mailbox_id,owner_sub,delivery_id,payload_json,state,claim_id,created_at,updated_at,draft_id,draft_revision) "+
    "SELECT ?,?,?,?,?,'queued',NULL,?,?,?,? FROM comms_mail_drafts WHERE "+
    "installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=? AND revision=? "+
    "AND recipients_json=? AND subject=? AND body_text=? "+
    "AND (SELECT COUNT(*) FROM comms_outbox WHERE installation_id=? AND mailbox_id=? AND owner_sub=?)<100")
    .bind(...parts,deliveryId,encoded,at,at,draftId,draftRevision,
     ...parts,draftId,draftRevision,JSON.stringify(payload.draft.to),
     payload.draft.subject,payload.draft.body,...parts).run();
   const own=await get(deliveryId);
   if(own){
    if(own.draft_id!==draftId||own.draft_revision!==draftRevision||
     own.payload_json!==encoded)fail('outbox_conflict');
    return receipt(own);
   }
   const linked=await db.prepare('SELECT delivery_id FROM comms_outbox WHERE '+linkage)
    .bind(...parts,draftId,draftRevision).first();
   if(linked)fail('outbox_draft_already_prepared');
   const current=await db.prepare('SELECT revision,recipients_json,subject,body_text FROM comms_mail_drafts WHERE installation_id=? AND mailbox_id=? AND owner_sub=? AND draft_id=?')
    .bind(...parts,draftId).first();
   if(!current||current.revision!==draftRevision||
    current.recipients_json!==JSON.stringify(payload.draft.to)||
    current.subject!==payload.draft.subject||current.body_text!==payload.draft.body)
    fail('outbox_draft_stale');
   fail('outbox_limit');
  },
  async read(deliveryId){const row=await get(deliveryId);return row?{...receipt(row),payload:JSON.parse(row.payload_json)}:null;},
  async list(){const result=await db.prepare('SELECT delivery_id,state,created_at,updated_at,draft_id,draft_revision FROM comms_outbox WHERE installation_id=? AND mailbox_id=? AND owner_sub=? ORDER BY created_at,delivery_id LIMIT 100').bind(...parts).all();return result.results.map(receipt);},
  async claim(deliveryId,claimId){
   const row=await db.prepare("UPDATE comms_outbox SET state='claimed',claim_id=?,updated_at=? WHERE "+columns+" AND state='queued' RETURNING *")
    .bind(id(claimId),clock(),...parts,id(deliveryId)).first();
   return row?{...receipt(row),payload:JSON.parse(row.payload_json)}:null;
  },
  async finish(deliveryId,claimId,state){
   if(!['accepted','rejected','failed','uncertain'].includes(state))fail('outbox_invalid_state');
   const row=await db.prepare('UPDATE comms_outbox SET state=?,updated_at=? WHERE '+columns+" AND state='claimed' AND claim_id=? RETURNING *")
    .bind(state,clock(),...parts,id(deliveryId),id(claimId)).first();
   if(!row)fail('outbox_transition_conflict');return receipt(row);
  }
 });
}
export function createOutboxDispatcher({store,draftStore,ownerSub,registry,context,mailboxId,from,connect,credentials,now=()=>new Date(),uuid=()=>crypto.randomUUID()}={}){
 // All constructor dependencies and scope are trusted server configuration.
 const prepare=(deliveryId,payload)=>prepareOutgoingPlainText({registry,context,mailboxId,from,
  deliveryId,draft:payload.draft,date:new Date(payload.date)});
 return Object.freeze({
  async enqueue({deliveryId,draft,approvedByOwner}={}){
   if(approvedByOwner!==true)fail('outbox_owner_approval_required');id(deliveryId);
   const prior=await store.read(deliveryId);
   const payload={from,draft:structuredClone(draft),date:prior?.payload.date??now().toISOString()};
   prepare(deliveryId,payload);return store.offer(deliveryId,payload);
  },
  async enqueueSavedDraft({deliveryId,draftId,draftRevision,approvedByOwner}={}){
   if(approvedByOwner!==true)fail('outbox_owner_approval_required');
   id(deliveryId);id(draftId);revision(draftRevision);
   if(!draftStore?.read||!store?.offerLinkedDraft||typeof ownerSub!=='string')
    fail('outbox_saved_draft_unavailable');
   // Idempotent replay of the same delivery ID does not create another message.
   const prior=await store.read(deliveryId);
   if(prior){
    if(prior.draftId!==draftId||prior.draftRevision!==draftRevision)fail('outbox_conflict');
    prepare(deliveryId,prior.payload);
    return store.offerLinkedDraft(deliveryId,{draftId,draftRevision,payload:prior.payload});
   }
   const saved=await draftStore.read({installationId:context.installationId,
    mailboxId,ownerSub},draftId);
   if(!saved||saved.revision!==draftRevision)fail('outbox_draft_stale');
   const payload={from,draft:{to:saved.to,subject:saved.subject,body:saved.body},date:now().toISOString()};
   prepare(deliveryId,payload);
   return store.offerLinkedDraft(deliveryId,{draftId,draftRevision,payload});
  },
  async submit({deliveryId,signal}={}){
   if(!signal||signal.aborted)fail('outbox_invalid_signal');id(deliveryId);
   const pending=await store.read(deliveryId);
   if(!pending||pending.state!=='queued')fail('outbox_not_queued');
   if(pending.payload.from!==from)fail('outbox_sender_mismatch');
   prepare(deliveryId,pending.payload); // Recheck entitlement BEFORE claiming or connecting.
   const claimId=id(uuid());let claimed=false;
   const transport=createPurelymailSmtpTransport({connect,credentials,claimDelivery:async key=>{
    const row=await store.claim(key,claimId);if(!row)fail('outbox_claim_conflict');claimed=true;
    return {deliveryId:key,status:'claimed',approvedByOwner:true,registry,context,mailboxId,from,
     draft:row.payload.draft,date:new Date(row.payload.date)};
   }});
   let outcome;
   try{outcome=await transport.submit({deliveryId,signal});}
   catch(error){
    if(!claimed)fail('outbox_claim_conflict');
    const state=error?.code==='smtp_delivery_uncertain'?'uncertain':error?.code==='smtp_rejected'?'rejected':'failed';
    try{return await store.finish(deliveryId,claimId,state);}catch{fail('outbox_confirmation_unavailable');}
   }
   // If this write fails after SMTP acceptance, leave claimed permanently non-retryable.
   // No catch may downgrade it to failed or requeue it.
   if(outcome?.accepted!==true)fail('outbox_confirmation_unavailable');
   try{return {...await store.finish(deliveryId,claimId,'accepted'),messageId:outcome.messageId,delivered:false};}
   catch{fail('outbox_confirmation_unavailable');}
  }
 });
}
