// COMMS-09 owner-only mail read APIs. No SMTP, implicit polling, credential responses or DNS changes.
// Deployment requires a separately approved isolated MAIL_DB binding and MAIL_IMAP_PASSWORD secret.
import {handleMailOutboxApi,mailSendingEnabled} from './mail-outbox-api.mjs';
import {createMailRegistry} from '../src/communications/mail-core.mjs';
import {createD1MailStore} from '../src/communications/mail-d1-store.mjs';
import {createReadOnlyImapProvider,parseUidValidity,parseUidNext} from '../src/communications/mail-imap-readonly.mjs';
import {PURELYMAIL} from '../src/communications/mail-onboarding.mjs';
import {createPurelymailImapConnector} from '../src/communications/mail-imap-transport.mjs';
import {decodeSafeMime} from '../src/communications/mail-mime-safe.mjs';
import {handleMailDraftApi,mailDraftsEnabled} from './mail-drafts-api.mjs';
import {listReadOnlyInbox, pollReadOnlyMailbox, listReadOnlyMailboxes} from '../src/communications/mail-readonly-service.mjs';

import {mailPayloadCipherFromEnv} from '../src/communications/mail-payload-crypto.mjs';
const payloadCipher=env=>{try{return mailPayloadCipherFromEnv(env);}catch{return null;}};
const MAILBOX = 'hello@devonakins.com';
// An explicit owner-only provider preflight, never a sync or background poll.
// Abort waiters enforce an upper bound even if an underlying socket promise stalls.
function bounded(signal,action){
  if(signal.aborted)return Promise.reject(Error('imap_probe_deadline'));
  return new Promise((resolve,reject)=>{
    let finished=false;
    const finish=(cb,value)=>{
      if(finished)return;
      finished=true;signal.removeEventListener('abort',abort);cb(value);
    };
    const abort=()=>finish(reject,Error('imap_probe_deadline'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(action).then(v=>finish(resolve,v),e=>finish(reject,e));
  });
}
async function probeReadOnlyImap({request,env,connect}){
  // This endpoint does not accept caller-supplied hostnames, mailbox paths, or
  // credentials. The trusted connector permits only the audited command grammar.
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(9000)]);
  const connector=createPurelymailImapConnector({
    connect,credentials:async username=>username===MAILBOX?env.MAIL_IMAP_PASSWORD:undefined,
    decodeMime:decodeSafeMime
  });
  let connection;
  try{
    connection=await bounded(signal,()=>connector.open({
      host:PURELYMAIL.incoming.host,port:PURELYMAIL.incoming.port,
      servername:PURELYMAIL.incoming.host,tlsRequired:true,rejectUnauthorized:true,
      username:MAILBOX,signal
    }));
    const examine=await bounded(signal,()=>connection.exchange('EXAMINE "INBOX"',{signal}));
    parseUidValidity(examine);
    parseUidNext(examine);
    if(signal.aborted)throw Error('imap_probe_deadline');
    return {imapAuthenticated:true,inboxReadOnly:true,messageContentRead:false,
      remoteMailboxModified:false,cacheModified:false,smtpContacted:false};
  }finally{
    if(connection)await bounded(AbortSignal.timeout(1000),()=>connection.close());
  }
}
const scope = Object.freeze({installationId:'personal',principalId:'owner'});
const status = (code,httpStatus=400)=>({status:httpStatus,body:{error:code}});
// Diagnostics must not SELECT, decrypt or return message contents.
// Metadata-only D1 checks cannot establish IMAP connectivity or payload recovery.
async function cacheDiagnostics(db) {
  const row=await db.prepare(`SELECT
    (SELECT COUNT(*) FROM comms_ro_messages WHERE installation_id=? AND mailbox_id=?) AS indexed_count,
    (SELECT revision FROM comms_ro_mailboxes WHERE installation_id=? AND mailbox_id=?) AS revision`)
    .bind('personal','hello','personal','hello').first();
  const revision=row?.revision??0;
  if(!row||!Number.isSafeInteger(row.indexed_count)||row.indexed_count<0||row.indexed_count>500||
    !Number.isSafeInteger(revision)||revision<0||revision>1_000_000_000||
    (row.indexed_count>0&&revision===0))throw Error('invalid_mail_cache_metadata');
  return {cacheReady:true,indexedCount:row.indexed_count,revision};
}
function isEnabled(env) {
  return env?.MAIL_ENABLED === 'true' && env.MAIL_IMAP_ADDRESS === MAILBOX &&
    typeof env.MAIL_OWNER_SUB === 'string' && env.MAIL_OWNER_SUB.length > 0 &&
    typeof env.MAIL_IMAP_PASSWORD === 'string' && env.MAIL_IMAP_PASSWORD.length > 0 &&
    !!payloadCipher(env) && env.MAIL_DB && typeof env.MAIL_DB.prepare === 'function' && typeof env.MAIL_DB.batch === 'function';
}
function registry(sendVerified=false) {
  return createMailRegistry({
    installations:[{id:'personal',domain:'devonakins.com'}],
    mailboxes:[{id:'hello',installationId:'personal',address:MAILBOX,provider:'purelymail',mode:'imap',sendVerified}],
    identities:[{mailboxId:'hello',address:MAILBOX,kind:'primary',sendVerified}],
    grants:[{installationId:'personal',principalId:'owner',mailboxId:'hello',capabilities:sendVerified?['read','sync','draft','send']:['read','sync','draft']}]
  });
}
const numberParam=(value, fallback, min, max) => {
  if(value===null)return fallback;
  if(!/^(0|[1-9][0-9]{0,5})$/.test(value))return null;
  const n=Number(value);return n>=min&&n<=max?n:null;
};
/** Signed owner check must already have run in createStation. This adds explicit subject binding. */
export async function handleMailApi({request,url,user,env,connect,readBody,workerVersionId=null}) {
  if(!user?.subject || !env?.MAIL_OWNER_SUB || user.subject !== env.MAIL_OWNER_SUB)
    return status('mail_owner_not_authorized',403);
  if(url.pathname.startsWith('/api/mail/outbox'))return handleMailOutboxApi({request,url,user,env,readBody,registry:registry(env.MAIL_SENDER_VERIFIED==='true'),connect});
  const ready=isEnabled(env) && typeof connect==='function';
  if(url.pathname==='/api/mail/status' && request.method==='GET')
    return {status:200,body:{configured:ready,address:MAILBOX,incomingVerified:false,outgoingEnabled:mailSendingEnabled(env,connect)&&mailDraftsEnabled(env),outboxEnabled:env.MAIL_OUTBOX_ENABLED==='true'&&typeof env.MAIL_DB?.prepare==='function',draftsEnabled:mailDraftsEnabled(env),provider:'purelymail',...(workerVersionId?{workerVersionId}:{})}};
  if(url.pathname.startsWith('/api/mail/drafts'))return handleMailDraftApi({request,url,user,env,readBody});
  if(!['/api/mail/mailboxes','/api/mail/inbox','/api/mail/sync','/api/mail/diagnostics','/api/mail/diagnostics/imap-check'].includes(url.pathname))
    return status('not_found',404);
  if(!ready)return status('mail_not_configured',503);
  try {
    if(url.pathname==='/api/mail/diagnostics/imap-check'){
      if(request.method!=='POST')return status('method_not_allowed',405);
      if(url.search)return status('invalid_mail_probe_request',400);
      let input;
      try{input=await readBody(request,32);}
      catch(error){return status(error?.status===413?'mail_probe_payload_too_large':'invalid_mail_probe_request',error?.status===413?413:400);}
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)
        return status('invalid_mail_probe_request',400);
      try{return {status:200,body:await probeReadOnlyImap({request,env,connect})};}
      catch{return status(request.signal.aborted?'mail_imap_probe_cancelled':'mail_imap_probe_failed',
        request.signal.aborted?504:502);}
    }
    if(url.pathname==='/api/mail/diagnostics') {
      if(request.method!=='GET')return status('method_not_allowed',405);
      if(url.search)return status('invalid_mail_diagnostics_request',400);
      return {status:200,body:{...await cacheDiagnostics(env.MAIL_DB),...(workerVersionId?{workerVersionId}:{})}};
    }
    const mailRegistry=registry(),store=createD1MailStore(env.MAIL_DB,{cipher:payloadCipher(env),ownerSub:user.subject});
    if(url.pathname==='/api/mail/mailboxes' && request.method==='GET') {
      return {status:200,body:{mailboxes:listReadOnlyMailboxes(mailRegistry,scope)}};
    }
    if(url.pathname==='/api/mail/inbox' && request.method==='GET') {
      const limit=numberParam(url.searchParams.get('limit'),25,1,50);
      const offset=numberParam(url.searchParams.get('offset'),0,0,5000);
      const revision=url.searchParams.get('revision');
      const expectedRevision=revision===null?null:
        /^(0|[1-9][0-9]{0,15})$/.test(revision)&&Number.isSafeInteger(Number(revision))?Number(revision):undefined;
      if(limit===null||offset===null||expectedRevision===undefined||url.searchParams.getAll('revision').length>1)return status('invalid_inbox_page',400);
      return {status:200,body:await listReadOnlyInbox({registry:mailRegistry,context:scope,mailboxId:'hello',store,limit,offset,expectedRevision})};
    }
    if(url.pathname==='/api/mail/sync' && request.method==='POST') {
      const connector=createPurelymailImapConnector({
        connect,
        credentials: async username=>username===MAILBOX?env.MAIL_IMAP_PASSWORD:undefined,
        decodeMime:decodeSafeMime
      });
      const result=await pollReadOnlyMailbox({
        registry:mailRegistry,context:scope,mailboxId:'hello',store,
        providers:{purelymail:createReadOnlyImapProvider({connector})},
        limit:10,timeoutMs:12000
      });
      return {status:200,body:result};
    }
    return status('method_not_allowed',405);
  } catch(error) {
    const code=error?.code;
    if(code==='mailbox_revision_conflict')return status(code,409);
    if(['invalid_inbox_page','invalid_readonly_poll_options'].includes(code))return status(code,400);
    // Avoid exposing provider credentials, IMAP line contents or SQL text to the caller or logs.
    return status('mail_operation_failed',502);
  }
}
