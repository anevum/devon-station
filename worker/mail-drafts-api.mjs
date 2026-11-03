// COMMS-12: draft CRUD only; never connects to a provider or sends an email.
// Caller authenticates signed Cloudflare Access and validates Origin before this handler.
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
const status=(error,httpStatus)=>({status:httpStatus,body:{error}});
const KNOWN_ERRORS=new Set([
 'invalid_mail_draft_id','invalid_mail_draft_revision','invalid_mail_draft_payload',
 'invalid_mail_draft_recipient','invalid_mail_draft_scope','mail_draft_not_found',
 'mail_draft_conflict','mail_draft_limit','mail_drafts_storage_unavailable'
]);
export const mailDraftsEnabled=env=>env?.MAIL_DRAFTS_ENABLED==='true' &&
 !!env.MAIL_DB && typeof env.MAIL_DB.prepare==='function' &&
 typeof env.MAIL_OWNER_SUB==='string' && env.MAIL_OWNER_SUB.length>0;
export async function handleMailDraftApi({request,url,user,env,readBody}){
 if(!user?.subject || user.subject!==env?.MAIL_OWNER_SUB)return status('mail_owner_not_authorized',403);
 if(!mailDraftsEnabled(env))return status('mail_drafts_not_configured',503);
 const store=createD1DraftStore(env.MAIL_DB);
 const scope={installationId:'personal',mailboxId:'hello',ownerSub:user.subject};
 try{
  if(url.pathname==='/api/mail/drafts' && request.method==='GET')
   return {status:200,body:{drafts:await store.list(scope)}};
  if(url.pathname==='/api/mail/drafts/create' && request.method==='POST'){
   const body=await readBody(request,4096);
   return {status:200,body:{draft:await store.create(scope,body.id)}};
  }
  if(url.pathname==='/api/mail/drafts/save' && request.method==='POST'){
   const body=await readBody(request,148000);
   return {status:200,body:{draft:await store.save(scope,body)}};
  }
  if(url.pathname==='/api/mail/drafts/delete' && request.method==='POST'){
   const body=await readBody(request,4096);
   return {status:200,body:await store.remove(scope,body)};
  }
  return status('method_not_allowed',405);
 }catch(e){
  if(KNOWN_ERRORS.has(e?.code))return status(e.code,e.status??400);
  if(e?.status===413)return status('mail_draft_payload_too_large',413);
  if(e?.status===400)return status('invalid_mail_draft_payload',400);
  // Unexpected DB errors are sanitized to avoid exposing personal drafts or SQL.
  return status('mail_draft_storage_failed',502);
 }
}
