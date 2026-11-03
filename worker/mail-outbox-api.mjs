// Preparation/status only. No HTTP submit route and no production SMTP enablement.
import {createD1Outbox,createOutboxDispatcher} from '../src/communications/mail-outbox.mjs';
export async function handleMailOutboxApi({request,url,user,env,readBody,registry}){
 const response=(error,status)=>({status,body:{error}});
 if(!user?.subject||user.subject!==env?.MAIL_OWNER_SUB)return response('mail_owner_not_authorized',403);
 if(env.MAIL_OUTBOX_ENABLED!=='true'||!env.MAIL_DB)return response('mail_outbox_not_configured',503);
 const store=createD1Outbox(env.MAIL_DB,{installationId:'personal',mailboxId:'hello',ownerSub:user.subject});
 try{
  if(url.pathname==='/api/mail/outbox'&&request.method==='GET')return {status:200,body:{outbox:await store.list(),sendingEnabled:false}};
  if(url.pathname==='/api/mail/outbox/prepare'&&request.method==='POST'){
   const input=await readBody(request,148000);
   const service=createOutboxDispatcher({store,registry,context:{installationId:'personal',principalId:'owner'},mailboxId:'hello',from:'hello@devonakins.com'});
   const result=await service.enqueue(input);return {status:200,body:{receipt:result,sendingEnabled:false}};
  }
  return response('not_found',404);
 }catch(error){
  if(error?.code==='outbox_conflict')return response('outbox_conflict',409);
  // Neither provider messages, SQL nor queued personal content are exposed.
  return response('mail_outbox_operation_failed',400);
 }
}
