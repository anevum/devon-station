// Owner-only, explicit, read-only Purelymail Sent metadata probe.
// SMTP does not imply a server-side Sent copy. A HEADER SEARCH is a candidate
// match, not an exact-header check, an SMTP receipt, or recipient delivery.
import {createPurelymailImapConnector} from './mail-imap-transport.mjs';
import {PURELYMAIL} from './mail-onboarding.mjs';

const DELIVERY=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function expectedSentMessageId(deliveryId){
 if(typeof deliveryId!=='string'||!DELIVERY.test(deliveryId))fail('imap_sent_invalid_delivery');
 return '<'+deliveryId+'@devonakins.com>';
}
export function countSentCandidates(response){
 if(typeof response!=='string'||!/^\* SEARCH(?: [1-9][0-9]{0,9})*$/.test(response))
  fail('imap_sent_invalid_search');
 if(response==='* SEARCH')return 0;
 const values=response.slice(9).split(' ').map(Number);
 if(values.length>10||values.some(n=>!Number.isSafeInteger(n)||n<1||n>0xffffffff)||
    new Set(values).size!==values.length)fail('imap_sent_invalid_search');
 return values.length;
}
function bounded(signal,fn){
 if(signal.aborted)return Promise.reject(Object.assign(new Error('imap_sent_deadline'),{code:'imap_sent_deadline'}));
 return new Promise((resolve,reject)=>{
  let finished=false;
  const done=(cb,value)=>{if(finished)return;finished=true;signal.removeEventListener('abort',abort);cb(value);};
  const abort=()=>done(reject,Object.assign(new Error('imap_sent_deadline'),{code:'imap_sent_deadline'}));
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(fn).then(v=>done(resolve,v),e=>done(reject,e));
 });
}
export async function probePurelymailSent({connect,password,deliveryId,signal}={}){
 const expected=expectedSentMessageId(deliveryId);
 if(typeof connect!=='function'||typeof password!=='string'||!signal)
  fail('imap_sent_unavailable');
 const username='hello@devonakins.com';
 const connector=createPurelymailImapConnector({
  connect,credentials:async address=>address===username?password:undefined,
  decodeMime:async()=>fail('imap_sent_body_forbidden')
 });
 let session;
 try{
  session=await bounded(signal,()=>connector.open({
   host:PURELYMAIL.incoming.host,port:PURELYMAIL.incoming.port,
   servername:PURELYMAIL.incoming.host,tlsRequired:true,rejectUnauthorized:true,
   username,signal,purpose:'sent-evidence'
  }));
  await bounded(signal,()=>session.exchange('EXAMINE "Sent"',{signal}));
  const found=await bounded(signal,()=>session.exchange(
   'UID SEARCH HEADER Message-ID "'+expected+'"',{signal}));
  return Object.freeze({sentFolderExamined:true,candidateCount:countSentCandidates(found),
   exactHeaderVerified:false,providerCopyConfirmed:false,recipientDeliveryConfirmed:false,
   automaticRetry:false});
 }finally{
  if(session)try{await bounded(AbortSignal.timeout(1000),()=>session.close());}catch{}
 }
}
