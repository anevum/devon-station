// COMMS-09 owner-only mail read APIs. No SMTP, implicit polling, credential responses or DNS changes.
// Deployment requires a separately approved isolated MAIL_DB binding and MAIL_IMAP_PASSWORD secret.
import {createMailRegistry} from '../src/communications/mail-core.mjs';
import {createD1MailStore} from '../src/communications/mail-d1-store.mjs';
import {createReadOnlyImapProvider} from '../src/communications/mail-imap-readonly.mjs';
import {createPurelymailImapConnector} from '../src/communications/mail-imap-transport.mjs';
import {decodeSinglePartPlainTextMime} from '../src/communications/mail-mime-text.mjs';
import {listReadOnlyInbox, pollReadOnlyMailbox, listReadOnlyMailboxes} from '../src/communications/mail-readonly-service.mjs';

const MAILBOX = 'hello@devonakins.com';
const scope = Object.freeze({installationId:'personal',principalId:'owner'});
const status = (code,httpStatus=400)=>({status:httpStatus,body:{error:code}});
function isEnabled(env) {
  return env?.MAIL_ENABLED === 'true' && env.MAIL_IMAP_ADDRESS === MAILBOX &&
    typeof env.MAIL_OWNER_SUB === 'string' && env.MAIL_OWNER_SUB.length > 0 &&
    typeof env.MAIL_IMAP_PASSWORD === 'string' && env.MAIL_IMAP_PASSWORD.length > 0 &&
    env.MAIL_DB && typeof env.MAIL_DB.prepare === 'function' && typeof env.MAIL_DB.batch === 'function';
}
function registry() {
  return createMailRegistry({
    installations:[{id:'personal',domain:'devonakins.com'}],
    mailboxes:[{id:'hello',installationId:'personal',address:MAILBOX,provider:'purelymail',mode:'imap',sendVerified:false}],
    identities:[{mailboxId:'hello',address:MAILBOX,kind:'primary',sendVerified:false}],
    grants:[{installationId:'personal',principalId:'owner',mailboxId:'hello',capabilities:['read','sync']}]
  });
}
const numberParam=(value, fallback, min, max) => {
  if(value===null)return fallback;
  if(!/^(0|[1-9][0-9]{0,5})$/.test(value))return null;
  const n=Number(value);return n>=min&&n<=max?n:null;
};
/** Signed owner check must already have run in createStation. This adds explicit subject binding. */
export async function handleMailApi({request,url,user,env,connect}) {
  if(!user?.subject || !env?.MAIL_OWNER_SUB || user.subject !== env.MAIL_OWNER_SUB)
    return status('mail_owner_not_authorized',403);
  const ready=isEnabled(env) && typeof connect==='function';
  if(url.pathname==='/api/mail/status' && request.method==='GET')
    return {status:200,body:{configured:ready,address:MAILBOX,incomingVerified:false,outgoingEnabled:false,provider:'purelymail'}};
  if(!['/api/mail/mailboxes','/api/mail/inbox','/api/mail/sync'].includes(url.pathname))
    return status('not_found',404);
  if(!ready)return status('mail_not_configured',503);
  try {
    const mailRegistry=registry(),store=createD1MailStore(env.MAIL_DB);
    if(url.pathname==='/api/mail/mailboxes' && request.method==='GET') {
      return {status:200,body:{mailboxes:listReadOnlyMailboxes(mailRegistry,scope)}};
    }
    if(url.pathname==='/api/mail/inbox' && request.method==='GET') {
      const limit=numberParam(url.searchParams.get('limit'),25,1,50);
      const offset=numberParam(url.searchParams.get('offset'),0,0,5000);
      if(limit===null||offset===null)return status('invalid_inbox_page',400);
      return {status:200,body:await listReadOnlyInbox({registry:mailRegistry,context:scope,mailboxId:'hello',store,limit,offset})};
    }
    if(url.pathname==='/api/mail/sync' && request.method==='POST') {
      const connector=createPurelymailImapConnector({
        connect,
        credentials: async username=>username===MAILBOX?env.MAIL_IMAP_PASSWORD:undefined,
        decodeMime:decodeSinglePartPlainTextMime
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
