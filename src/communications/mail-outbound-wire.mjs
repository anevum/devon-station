/**
 * Pure, fail-closed RFC 5322/MIME wire preparation for a future explicit SMTP outbox.
 * This module NEVER opens a network connection, sends a message, or grants permission.
 * All identity and registry parameters must come from trusted server configuration.
 */
import {evaluateFromIdentity} from './mail-core.mjs';
import {validateDraftPayload} from './mail-drafts.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTF8 = new TextEncoder();
const MAX_WIRE_BYTES = 160 * 1024;
const error = code => Object.assign(new Error(code), {code});
const byteLength = value => UTF8.encode(value).length;

function base64(bytes) {
  // Every 57 input bytes produce one <=76-character encoded line.
  const lines=[];
  for(let offset=0;offset<bytes.length;offset+=57){
    const part=bytes.subarray(offset,offset+57);
    lines.push(btoa(String.fromCharCode(...part)));
  }
  return lines.join('\r\n');
}

function subjectHeader(subject) {
  if(subject.length===0) return 'Subject:';
  if(/^[\x20-\x7e]+$/.test(subject) && subject.length<=69) return 'Subject: '+subject;
  const chunks=[];
  let chunk='';
  for(const point of subject){
    const candidate=chunk+point;
    if(byteLength(candidate)>42){
      if(!chunk) throw error('mail_outbound_invalid_unicode');
      chunks.push(chunk);
      chunk=point;
    }else chunk=candidate;
  }
  if(chunk)chunks.push(chunk);
  // Replacement-character conversion of an unmatched surrogate would silently
  // change the subject. Reject it instead of sending a different string.
  const words=chunks.map(text=>{
    const bytes=UTF8.encode(text);
    if(new TextDecoder('utf-8',{fatal:true}).decode(bytes)!==text)throw error('mail_outbound_invalid_unicode');
    return '=?UTF-8?B?'+base64(bytes)+'?=';
  });
  return 'Subject: '+words.join('\r\n ');
}

function recipientsHeader(recipients) {
  const lines=[];
  let current='To: ';
  for(const recipient of recipients){
    const piece=(current==='To: '||current===' '? '':', ')+recipient;
    if(current.length+piece.length>78 && current!=='To: ' && current!==' '){
      lines.push(current+',');
      current=' '+recipient;
    }else current+=piece;
  }
  lines.push(current);
  return lines.join('\r\n');
}

/**
 * A stable Message-ID helps correlate an outbox attempt but does NOT itself
 * prevent duplicate SMTP sends. A durable CAS outbox is required before shipping.
 */
export function prepareOutgoingPlainText({registry,context,mailboxId,from,draft,deliveryId,date}={}){
  if(typeof from!=='string'||!registry||!context||typeof mailboxId!=='string')
    throw error('mail_outbound_sender_unverified');
  let eligible;
  try{eligible=evaluateFromIdentity(registry,context,mailboxId,from);}
  catch{throw error('mail_outbound_sender_unverified');}
  if(eligible?.allowed!==true)throw error('mail_outbound_sender_unverified');
  if(!draft||typeof draft!=='object'||Array.isArray(draft)||
     ['cc','bcc','attachments','html'].some(key=>Object.hasOwn(draft,key))||
     (draft.from!==undefined && draft.from!==from))throw error('mail_outbound_unsupported_content');
  let payload;
  try{payload=validateDraftPayload(draft);}catch{throw error('mail_outbound_invalid_draft');}
  if(payload.to.length===0)throw error('mail_outbound_recipient_required');
  if(typeof deliveryId!=='string'||!UUID.test(deliveryId))throw error('mail_outbound_invalid_delivery_id');
  if(!(date instanceof Date)||!Number.isFinite(date.valueOf()))throw error('mail_outbound_invalid_date');
  if(/\r(?!\n)/.test(payload.body))throw error('mail_outbound_invalid_body');
  // All body data is base64; it cannot inject SMTP headers or dot terminators.
  const canonicalBody=payload.body.replace(/\r?\n/g,'\r\n');
  const bytes=UTF8.encode(canonicalBody);
  if(new TextDecoder('utf-8',{fatal:true}).decode(bytes)!==canonicalBody)
    throw error('mail_outbound_invalid_unicode');
  const domain=from.slice(from.lastIndexOf('@')+1);
  const messageId='<'+deliveryId.toLowerCase()+'@'+domain.toLowerCase()+'>';
  const headers=[
    'From: '+from,
    recipientsHeader(payload.to),
    subjectHeader(payload.subject),
    'Date: '+date.toUTCString().replace(/ GMT$/,' +0000'),
    'Message-ID: '+messageId,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ];
  const wire=headers.join('\r\n')+'\r\n\r\n'+base64(bytes)+'\r\n';
  if(byteLength(wire)>MAX_WIRE_BYTES)throw error('mail_outbound_too_large');
  return Object.freeze({envelopeFrom:from,envelopeTo:Object.freeze([...payload.to]),
    messageId,wire,byteLength:byteLength(wire),format:'text/plain; charset=UTF-8'});
}
