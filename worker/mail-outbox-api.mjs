// COMMS-16: explicit, owner-confirmed HTTP submission. No automatic send or retry.
// The existing signed-Access gate and same-origin JSON gate must run first.
import {createD1Outbox,createOutboxDispatcher} from '../src/communications/mail-outbox.mjs';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
import {mailPayloadCipherFromEnv} from '../src/communications/mail-payload-crypto.mjs';
import {probePurelymailSent} from '../src/communications/mail-sent-evidence.mjs';
const MAILBOX='hello@devonakins.com';
const response=(error,status)=>({status,body:{error}});
const payloadCipher=env=>{try{return mailPayloadCipherFromEnv(env);}catch{return null;}};

// Independent send flag: enabling the outbox and sender registry cannot start SMTP.
export function mailSendingEnabled(env,connect){
 return env?.MAIL_OUTBOX_ENABLED==='true' && env.MAIL_DRAFTS_ENABLED==='true' && env.MAIL_SEND_ENABLED==='true' &&
  env.MAIL_SENDER_VERIFIED==='true' && env.MAIL_SMTP_ADDRESS===MAILBOX &&
  typeof env.MAIL_OWNER_SUB==='string' && env.MAIL_OWNER_SUB.length>0 &&
  typeof env.MAIL_SMTP_PASSWORD==='string' && env.MAIL_SMTP_PASSWORD.length<=256 &&
  /^[\x21-\x7e]+$/.test(env.MAIL_SMTP_PASSWORD) &&
  typeof env.MAIL_DB?.prepare==='function' && typeof connect==='function' && !!payloadCipher(env);
}
export async function handleMailOutboxApi({request,url,user,env,readBody,registry,connect}){
 if(!user?.subject||user.subject!==env?.MAIL_OWNER_SUB)return response('mail_owner_not_authorized',403);
 if(env.MAIL_OUTBOX_ENABLED!=='true'||!env.MAIL_DB)return response('mail_outbox_not_configured',503);
 const cipher=payloadCipher(env);
 const store=createD1Outbox(env.MAIL_DB,{installationId:'personal',mailboxId:'hello',ownerSub:user.subject},{cipher});
 const service=()=>createOutboxDispatcher({store,draftStore:createD1DraftStore(env.MAIL_DB,{cipher}),ownerSub:user.subject,
  registry,context:{installationId:'personal',principalId:'owner'},
  mailboxId:'hello',from:MAILBOX,connect,credentials:async address=>address===MAILBOX?env.MAIL_SMTP_PASSWORD:undefined});
 let submitAttempted=false;
 try{
  if(url.pathname==='/api/mail/outbox'&&request.method==='GET')
   return {status:200,body:{outbox:await store.list(),sendingEnabled:mailSendingEnabled(env,connect)}};
  // Receipt-backed Sent is usable before migration 0009. Reads never initiate
  // provider I/O, enqueue, claim, resend, or change any record.
  const acceptedPath='/api/mail/outbox/accepted';
  if([acceptedPath,acceptedPath+'/page',acceptedPath+'/view'].includes(url.pathname)){
   if(url.search)return response('invalid_mail_history_request',400);
   const list=url.pathname===acceptedPath,view=url.pathname.endsWith('/view');
   if(request.method!==(list?'GET':'POST'))return response('method_not_allowed',405);
   if(!cipher)return response('mail_sent_history_unavailable',503);
   let input;
   if(!list){
    input=await readBody(request,320);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1)
     return response('invalid_mail_history_request',400);
    const before=input.before;
    if(view?(!Object.hasOwn(input,'deliveryId')||typeof input.deliveryId!=='string'||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.deliveryId)):
      (!before||typeof before!=='object'||Array.isArray(before)||Object.keys(before).length!==2||
       typeof before.acceptedAt!=='string'||before.acceptedAt.length>40||!Number.isFinite(Date.parse(before.acceptedAt))||
       typeof before.deliveryId!=='string'||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(before.deliveryId)))
     return response('invalid_mail_history_request',400);
   }
   try{
    if(view){
     const copy=await store.readAccepted(input.deliveryId);
     return copy?{status:200,body:{copy,providerIndependent:true}}:
      response('mail_sent_history_not_found',404);
    }
    return {status:200,body:{...await store.listAccepted(list?null:input.before),providerIndependent:true}};
   }catch{return response('mail_sent_history_unavailable',503);}
  }
  // Owner-only, provider-independent archive access; never touches SMTP/IMAP.
  // Missing migration fails closed, and no message contents enter list responses.
  if(url.pathname==='/api/mail/outbox/archive'&&request.method==='GET'){
   if(url.search)return response('invalid_mail_archive_request',400);
   if(!cipher)return response('mail_sent_archive_unavailable',503);
   try{return {status:200,body:{...await store.listArchived(),providerIndependent:true}};}
   catch{return response('mail_sent_archive_unavailable',503);}
  }
  if(url.pathname==='/api/mail/outbox/archive/view'&&request.method==='POST'){
   if(url.search)return response('invalid_mail_archive_request',400);
   if(!cipher)return response('mail_sent_archive_unavailable',503);
   const input=await readBody(request,256);
   if(!input||Object.keys(input).length!==1||typeof input.deliveryId!=='string'||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.deliveryId))
    return response('invalid_mail_archive_request',400);
   try{
    const archive=await store.readArchived(input.deliveryId);
    return archive?{status:200,body:{archive,providerIndependent:true}}:
     response('mail_sent_archive_not_found',404);
   }catch{return response('mail_sent_archive_unavailable',503);}
  }
  // Explicit owner-authorized read of older encrypted Sent metadata, no
  // provider I/O and no decrypted message contents.
  if(url.pathname==='/api/mail/outbox/archive/page'&&request.method==='POST'){
   if(url.search)return response('invalid_mail_archive_request',400);
   if(!cipher)return response('mail_sent_archive_unavailable',503);
   const input=await readBody(request,320);
   const before=input?.before;
   if(!input||Object.keys(input).length!==1||
      !before||typeof before!=='object'||Array.isArray(before)||
      Object.keys(before).length!==2||
      typeof before.acceptedAt!=='string'||before.acceptedAt.length>40||
      !Number.isFinite(Date.parse(before.acceptedAt))||
      typeof before.deliveryId!=='string'||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(before.deliveryId))
    return response('invalid_mail_archive_request',400);
   try{return {status:200,body:{...await store.listArchived(before),providerIndependent:true}};}
   catch{return response('mail_sent_archive_unavailable',503);}
  }
  // The probe cannot transmit, append, change flags or read MIME bodies. It
  // requires a matching signed-owner, saved-draft-linked attempted receipt.
  if(url.pathname==='/api/mail/outbox/sent-check'&&request.method==='POST'){
   if(url.search)return response('invalid_mail_sent_check_request',400);
   if(env.MAIL_ENABLED!=='true'||env.MAIL_IMAP_ADDRESS!==MAILBOX||
      typeof env.MAIL_IMAP_PASSWORD!=='string'||!env.MAIL_IMAP_PASSWORD||
      typeof connect!=='function'||!cipher)return response('mail_sent_check_not_configured',503);
   const input=await readBody(request,256);
   if(!input||Object.keys(input).length!==1||typeof input.deliveryId!=='string'||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.deliveryId))
    return response('invalid_mail_sent_check_request',400);
   const receipt=await store.readReceipt(input.deliveryId);
   if(!receipt?.draftId||!Number.isSafeInteger(receipt.draftRevision)||
      !['claimed','accepted','uncertain'].includes(receipt.state))
    return response('mail_sent_check_receipt_unavailable',409);
   try{
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(9000)]);
    const result=await probePurelymailSent({
     connect,password:env.MAIL_IMAP_PASSWORD,deliveryId:receipt.deliveryId,signal});
    return {status:200,body:{deliveryId:receipt.deliveryId,...result}};
   }catch{
    return response('mail_sent_check_unavailable',502);
   }
  }
  if(url.pathname==='/api/mail/outbox/prepare'&&request.method==='POST'){
   if(!cipher)return response('mail_payload_encryption_not_configured',503);
   if(env.MAIL_DRAFTS_ENABLED!=='true')return response('mail_drafts_not_configured',503);
   const input=await readBody(request,4096);
   if(Object.keys(input).some(key=>!['deliveryId','draftId','draftRevision','approvedByOwner'].includes(key)))
    return response('mail_outbox_invalid_prepare_request',400);
   const receipt=await service().enqueueSavedDraft(input);
   return {status:200,body:{receipt,sendingEnabled:mailSendingEnabled(env,connect)}};
  }
  if(url.pathname==='/api/mail/outbox/submit'&&request.method==='POST'){
   if(!mailSendingEnabled(env,connect))
    return response('mail_send_not_enabled',503);
   const input=await readBody(request,4096);
   if(input?.confirmedByOwner!==true ||
    Object.keys(input).some(key=>!['deliveryId','confirmedByOwner'].includes(key)))
    return response('mail_send_confirmation_required',400);
   if(typeof input.deliveryId!=='string'||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.deliveryId))
    return response('outbox_invalid_id',400);
   // Never submit a legacy/raw outbox row; only a persisted, saved-draft-linked snapshot.
   // A separately prepared immutable delivery is required; submit never enqueues.
   const prepared=await store.readReceipt(input.deliveryId);
   if(!prepared?.draftId||!Number.isSafeInteger(prepared.draftRevision))
    return response('mail_outbox_linked_delivery_required',409);
   // Any outcome after the claim is terminal or non-retryable, including uncertainty.
   submitAttempted=true;
   const signal=AbortSignal.any([request.signal,AbortSignal.timeout(20000)]);
   const receipt=await service().submit({deliveryId:input.deliveryId,signal});
   return {status:200,body:{receipt,deliveryConfirmed:false,automaticRetry:false}};
  }
  if(['/api/mail/outbox','/api/mail/outbox/prepare','/api/mail/outbox/submit','/api/mail/outbox/sent-check','/api/mail/outbox/archive','/api/mail/outbox/archive/view','/api/mail/outbox/archive/page'].includes(url.pathname))
   return response('method_not_allowed',405);
  return response('not_found',404);
 }catch(error){
  if(error?.code==='outbox_conflict')return response('outbox_conflict',409);
  if(error?.code==='outbox_draft_already_prepared')return response('outbox_draft_already_prepared',409);
  if(error?.code==='outbox_draft_stale')return response('outbox_draft_stale',409);
  if(['outbox_invalid_id','outbox_invalid_draft_revision',
   'outbox_invalid_draft_payload'].includes(error?.code))
   return response('mail_outbox_invalid_prepare_request',400);
  if(['outbox_not_queued','outbox_claim_conflict','outbox_transition_conflict'].includes(error?.code))
   return response('outbox_not_queued',409);
  if(error?.code==='outbox_confirmation_unavailable')
   return {status:503,body:{error:'mail_outbox_confirmation_unavailable',deliveryUncertain:true,automaticRetry:false}};
  if(error?.status===413)return response('mail_outbox_payload_too_large',413);
  if(error?.status===400)return response('invalid_mail_outbox_request',400);
  // Never expose SMTP replies, credential values, SQL, or message plaintext.
  if(submitAttempted)return {status:502,body:{error:'mail_send_operation_failed',
   deliveryUncertain:true,automaticRetry:false,checkOutboxStatus:true}};
  return response('mail_outbox_operation_failed',400);
 }
}
