import test from 'node:test';
import assert from 'node:assert/strict';
import {mailSendingEnabled,handleMailOutboxApi} from '../worker/mail-outbox-api.mjs';

const from='hello@devonakins.com';
const env=Object.freeze({
 MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}),MAIL_OUTBOX_ENABLED:'true',MAIL_SEND_ENABLED:'true',MAIL_SENDER_VERIFIED:'true',
 MAIL_OWNER_SUB:'synthetic-owner',MAIL_DRAFTS_ENABLED:'true',MAIL_SMTP_ADDRESS:from,
 MAIL_SMTP_PASSWORD:'synthetic-password',MAIL_DB:{prepare(){}}
});
const connect=()=>assert.fail('No test may open an SMTP socket');

test('independent opt-in and verified owner/provider configuration required to enable sending',()=>{
 assert.equal(mailSendingEnabled(env,connect),true);
 for(const change of [
  {MAIL_SEND_ENABLED:undefined},{MAIL_OUTBOX_ENABLED:undefined},{MAIL_DRAFTS_ENABLED:undefined},
  {MAIL_SENDER_VERIFIED:undefined},{MAIL_SMTP_ADDRESS:'other@example.test'},
  {MAIL_SMTP_PASSWORD:undefined},{MAIL_SMTP_PASSWORD:'bad password'},
  {MAIL_SMTP_PASSWORD:''},{MAIL_SMTP_PASSWORD:'x'.repeat(257)},
  {MAIL_OWNER_SUB:''},{MAIL_DB:null}
 ])assert.equal(mailSendingEnabled({...env,...change},connect),false,JSON.stringify(Object.keys(change)));
 assert.equal(mailSendingEnabled(env,null),false);
});

test('wrong signed owner denied and absent provider configuration fails closed before D1/SMTP',async()=>{
 const base='https://station.example';
 const request=new Request(base+'/api/mail/outbox/submit',
  {method:'POST',headers:{Origin:base,'Content-Type':'application/json'},
   body:JSON.stringify({deliveryId:'123e4567-e89b-42d3-a456-426614174000',confirmedByOwner:true})});
 const readBody=()=>assert.fail('Disabled or unauthorized send must not read the request body');
 const args={request,url:new URL(request.url),env,readBody,registry:{},connect};
 assert.deepEqual(await handleMailOutboxApi({...args,user:{subject:'other'}}),
  {status:403,body:{error:'mail_owner_not_authorized'}});
 assert.deepEqual(await handleMailOutboxApi({...args,user:{subject:'synthetic-owner'},
  env:{...env,MAIL_OUTBOX_ENABLED:'false'}}),
  {status:503,body:{error:'mail_outbox_not_configured'}});
 assert.deepEqual(await handleMailOutboxApi({...args,user:{subject:'synthetic-owner'},
  env:{...env,MAIL_SEND_ENABLED:'false'}}),
  {status:503,body:{error:'mail_send_not_enabled'}});
});

test('submit requires a fresh explicit confirmation and properly formed delivery ID',async()=>{
 const base='https://station.example',user={subject:'synthetic-owner'};
 const run=body=>handleMailOutboxApi({
  request:new Request(base+'/api/mail/outbox/submit',{method:'POST'}),
  url:new URL(base+'/api/mail/outbox/submit'),env,user,
  readBody:async()=>body,registry:{},connect
 });
 for(const payload of [
  {deliveryId:'123e4567-e89b-42d3-a456-426614174000'},
  {deliveryId:'123e4567-e89b-42d3-a456-426614174000',confirmedByOwner:false},
  {deliveryId:'123e4567-e89b-42d3-a456-426614174000',confirmedByOwner:true,from:'other@example.test'}
 ])assert.deepEqual(await run(payload),{status:400,body:{error:'mail_send_confirmation_required'}});
 for(const bad of ['not-a-uuid','123E4567-e89b-42d3-a456-426614174000',null])
  assert.deepEqual(await run({deliveryId:bad,confirmedByOwner:true}),{status:400,body:{error:'outbox_invalid_id'}});
});

test('owner Sent-copy probe rejects unauthorized, missing and unattempted receipts before IMAP',async()=>{
 const id='123e4567-e89b-42d3-a456-426614174016';
 const request=new Request('https://station.example/api/mail/outbox/sent-check',
  {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deliveryId:id})});
 let reads=0;
 const db={prepare(sql){return {bind(){return {async first(){
   assert(sql.includes('comms_outbox'));
   return {delivery_id:id,state:'queued',created_at:'2026-11-04T00:00:00Z',updated_at:'2026-11-04T00:00:00Z',
    draft_id:id,draft_revision:2};
  }};}}}};
 const e={...env,MAIL_DB:db,MAIL_ENABLED:'true',MAIL_IMAP_ADDRESS:from,MAIL_IMAP_PASSWORD:'synthetic'};
 const opts={request,url:new URL(request.url),env:e,readBody:async()=>{reads++;return {deliveryId:id};},
  connect,registry:{},user:{subject:'synthetic-owner'}};
 assert.deepEqual(await handleMailOutboxApi({...opts,user:{subject:'nonowner'}}),
  {status:403,body:{error:'mail_owner_not_authorized'}});
 assert.equal(reads,0);
 assert.deepEqual(await handleMailOutboxApi({...opts,env:{...e,MAIL_IMAP_PASSWORD:undefined}}),
  {status:503,body:{error:'mail_sent_check_not_configured'}});
 assert.equal(reads,0);
 assert.deepEqual(await handleMailOutboxApi(opts),
  {status:409,body:{error:'mail_sent_check_receipt_unavailable'}});
 assert.equal(reads,1);
 assert.deepEqual(await handleMailOutboxApi({...opts,readBody:async()=>({deliveryId:id,mailbox:'INBOX'})}),
  {status:400,body:{error:'invalid_mail_sent_check_request'}});
 assert.equal(reads,1);
});
