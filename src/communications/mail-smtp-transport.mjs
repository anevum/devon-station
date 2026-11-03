/**
 * SMTP submission transport (source-only). No HTTP route, UI or scheduler uses this.
 * A future persistent outbox must atomically reserve a user-approved delivery
 * before its trusted claimDelivery callback can return a claimed record.
 */
import {PURELYMAIL} from './mail-onboarding.mjs';
import {prepareOutgoingPlainText} from './mail-outbound-wire.mjs';

const enc=new TextEncoder();
const DECODER=new TextDecoder('utf-8',{fatal:true});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Match the canonical saved-draft recipient grammar. A narrower SMTP-only
// check would reject valid prepared messages *after* the one-time outbox claim.
const EMAIL=/^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const envelopeEmail=value=>typeof value==='string'&&value.length>=3&&value.length<=254&&
 EMAIL.test(value)&&!value.includes('..');
const MAX_LINE=512;
const MAX_REPLY_BYTES=8192;
const MAX_REPLY_LINES=32;
const MAX_WIRE_BYTES=160*1024;
const reject=code=>{throw Object.assign(new Error(code),{code});};
const authValue=value=>typeof value==='string'&&value.length>0&&value.length<=256&&/^[\x21-\x7e]+$/.test(value);
const isAbortSignal=value=>!!value&&typeof value.aborted==='boolean'&&typeof value.addEventListener==='function'&&typeof value.removeEventListener==='function';

export function createPurelymailSmtpTransport({connect,credentials,claimDelivery}={}){
  if(typeof connect!=='function'||typeof credentials!=='function'||typeof claimDelivery!=='function')
    reject('smtp_transport_unavailable');
  return Object.freeze({
    async submit({deliveryId,signal}={}){
      if(typeof deliveryId!=='string'||!UUID.test(deliveryId)||!isAbortSignal(signal)||signal.aborted)
        reject('smtp_submission_invalid');
      // Caller does not supply a message or arbitrary account. The trusted callback
      // must perform an atomic one-time outbox claim and confirm owner approval.
      let claim;
      try{claim=await claimDelivery(deliveryId);}catch{reject('smtp_delivery_not_approved');}
      if(!claim||claim.deliveryId!==deliveryId||claim.status!=='claimed'||claim.approvedByOwner!==true)
        reject('smtp_delivery_not_approved');
      const {from,registry,context,mailboxId,draft,date}=claim;
      if(!envelopeEmail(from)||!authValue(from))
        reject('smtp_sender_invalid');
      const prepared=prepareOutgoingPlainText({registry,context,mailboxId,from,draft,deliveryId,date});
      if(prepared.envelopeFrom!==from||prepared.envelopeTo.length<1||prepared.envelopeTo.length>20||
        prepared.envelopeTo.some(to=>!envelopeEmail(to))||prepared.byteLength>MAX_WIRE_BYTES||
        !prepared.wire.endsWith('\r\n')||/(^|\r\n)\./.test(prepared.wire)||
        /(?<!\r)\n|\r(?!\n)/.test(prepared.wire))reject('smtp_wire_invalid');
      let password;
      try{password=await credentials(from);}catch{reject('smtp_credentials_unavailable');}
      if(!authValue(password)||!authValue(from))reject('smtp_credentials_unavailable');
      const authToken=btoa('\0'+from+'\0'+password);
      if(('AUTH PLAIN '+authToken+'\r\n').length>MAX_LINE)reject('smtp_credentials_unavailable');
      let socket,reader,writer,buffer=new Uint8Array(0),closed=false;
      let dataMayHaveBeenSubmitted=false;
      const close=async()=>{
        if(closed)return;closed=true;
        try{await socket?.close?.();}catch{}
        try{reader?.releaseLock?.();}catch{}
        try{writer?.releaseLock?.();}catch{}
      };
      const abort=()=>{void close();};
      signal.addEventListener('abort',abort,{once:true});
      try{
        if(signal.aborted)reject('smtp_cancelled');
        // Implicit TLS with the Workers runtime's certificate validation;
        // never fall back to plaintext SMTP or STARTTLS port 587.
        socket=connect({hostname:PURELYMAIL.outgoing.host,port:465},{secureTransport:'on'});
        if(!socket||!socket.opened||!socket.readable||!socket.writable||typeof socket.close!=='function')
          reject('smtp_socket_unavailable');
        await socket.opened;
        if(closed||signal.aborted)reject('smtp_cancelled');
        reader=socket.readable.getReader();writer=socket.writable.getWriter();
        async function fill(){
          if(closed||signal.aborted)reject('smtp_cancelled');
          const {done,value}=await reader.read();
          if(done||!(value instanceof Uint8Array)||value.length===0)reject('smtp_stream_closed');
          if(buffer.length+value.length>MAX_REPLY_BYTES)reject('smtp_response_limit');
          const next=new Uint8Array(buffer.length+value.length);
          next.set(buffer);next.set(value,buffer.length);buffer=next;
        }
        async function line(){
          for(;;){
            for(let i=0;i<buffer.length;i++){
              if(buffer[i]===10&&(i===0||buffer[i-1]!==13))reject('smtp_invalid_framing');
              if(buffer[i]===13&&i+1<buffer.length&&buffer[i+1]!==10)reject('smtp_invalid_framing');
              if(buffer[i]===13&&i+1<buffer.length){
                if(i>MAX_LINE-2)reject('smtp_response_limit');
                const bytes=buffer.slice(0,i);buffer=buffer.slice(i+2);
                if(bytes.some(x=>x<32||x>126))reject('smtp_invalid_framing');
                return DECODER.decode(bytes);
              }
            }
            if(buffer.length>=MAX_LINE)reject('smtp_response_limit');
            await fill();
          }
        }
        async function reply(){
          const lines=[];let code=null;
          for(let i=0;i<MAX_REPLY_LINES;i++){
            const text=await line();
            const match=/^([2-5][0-9]{2})([ -])([\x20-\x7e]*)$/.exec(text);
            if(!match||code&&match[1]!==code)reject('smtp_invalid_reply');
            code=match[1];lines.push(match[3]);
            if(match[2]===' ')return {code:Number(code),lines};
          }
          reject('smtp_response_limit');
        }
        const send=async command=>{
          if(closed||signal.aborted)reject('smtp_cancelled');
          if(command.length+2>MAX_LINE||/\r|\n/.test(command))reject('smtp_command_limit');
          await writer.write(enc.encode(command+'\r\n'));
        };
        const expect=async accepted=>{const r=await reply();if(!accepted.includes(r.code))reject('smtp_rejected');return r;};
        await expect([220]);
        await send('EHLO devonakins.com');
        const hello=await expect([250]);
        if(!hello.lines.some(x=>/^AUTH(?:=|\s+)(?:[A-Z0-9-]+\s+)*PLAIN(?:\s|$)/i.test(x)))
          reject('smtp_auth_not_supported');
        await send('AUTH PLAIN '+authToken);
        await expect([235]);
        await send('MAIL FROM:<'+from+'>');
        await expect([250]);
        for(const to of prepared.envelopeTo){
          await send('RCPT TO:<'+to+'>');
          await expect([250,251,252]);
        }
        await send('DATA');
        await expect([354]);
        // Once DATA writing starts, a network failure may mean the remote server
        // accepted the message. Caller MUST NOT automatically retry uncertainty.
        dataMayHaveBeenSubmitted=true;
        await writer.write(enc.encode(prepared.wire+'.\r\n'));
        const final=await reply();
        if(final.code!==250){dataMayHaveBeenSubmitted=false;reject('smtp_rejected');}
        dataMayHaveBeenSubmitted=false;
        try{await send('QUIT');}catch{}
        return Object.freeze({accepted:true,messageId:prepared.messageId,deliveryId});
      }catch(error){
        // Never leak SMTP replies, account passwords, server banners or message text.
        if(dataMayHaveBeenSubmitted)reject('smtp_delivery_uncertain');
        if(error?.code==='smtp_auth_not_supported'||error?.code==='smtp_rejected')throw error;
        reject('smtp_transport_failed');
      }finally{signal.removeEventListener('abort',abort);await close();}
    }
  });
}
