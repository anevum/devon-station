// COMMS-11: convert bounded untrusted RFC 5322/MIME into inert, minimal owner-index fields.
// The parser may decode HTML only into text. Raw HTML, binary attachments, URLs, credentials,
// and arbitrary headers NEVER enter persistent D1 or the public client API.
import PostalMime from '../../vendor/postal-mime/postal-mime.mjs';
import {htmlToText} from '../../vendor/postal-mime/text-format.mjs';

const MAX_WIRE_BYTES=256*1024;
const MAX_BODY_CHARS=4096;
const MAX_SUBJECT_CHARS=512;
const SHORTENED_NOTE='\n\n[Message shortened. The full message remains with your email provider.]';
const forbidControls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
export class MimeSafeError extends Error {
 constructor(code){super(code);this.name='MimeSafeError';this.code=code;}
}
const fail=code=>{throw new MimeSafeError(code);};
function normalizedText(value,code){
 if(typeof value!=='string')fail(code);
 return value.replace(/\r\n?/g,'\n').replace(forbidControls,'\ufffd');
}
function safeText(value,max,code){
 const normal=normalizedText(value,code);
 if(normal.length>max)fail(code);
 return normal;
}
function sender(from){
 let entry=from;
 // RFC 5322 groups sometimes carry a single address.
 if(entry && Array.isArray(entry.group))entry=entry.group[0];
 const address=entry?.address;
 if(typeof address!=='string'||address.length===0||address.length>254||
    /[\x00-\x20\x7f<>]/.test(address) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address))
    fail('mime_invalid_from');
 return address;
}
/**
 * Bounded parser, safe for personal read-only indexing, NOT a full-fidelity message store.
 * Attachments are identified as unavailable in the reader; their bytes are not persisted.
 * No email content triggers a user action, and no HTML is sent to the DOM.
 */
export async function decodeSafeMime(raw){
 if(!(raw instanceof Uint8Array)||raw.byteLength<1||raw.byteLength>MAX_WIRE_BYTES)fail('mime_wire_limit');
 let message;
 try{
   message=await PostalMime.parse(raw,{
      maxNestingDepth:16,maxHeadersSize:65536,maxPartCount:48,
      maxRfc822NestingDepth:2,maxForwardedAddresses:96,
      attachmentEncoding:'arraybuffer'
   });
 }catch{fail('mime_parse_failed');}
 if(!message||typeof message!=='object'||!Array.isArray(message.attachments) ||
    message.attachments.length>48)fail('mime_parse_failed');
 const from=sender(message.from);
 const subject=safeText(message.subject??'',MAX_SUBJECT_CHARS,'mime_subject_limit').replace(/[\n\t]/g,' ');
 let text =typeof message.text==='string'?message.text:'';
 if(!text&&typeof message.html==='string'){
   // Rich HTML is converted to inert plain text, never inserted into an HTML document.
   try{text=htmlToText(message.html);}catch{fail('mime_html_conversion_failed');}
 }
 const note=message.attachments.length?
   '\n\n[Attachment content is not available in this read-only index.]':'';
 // This is a bounded read-only index, not full-fidelity storage. A long valid
 // body must not block every later UID; retain an explicitly marked preview.
 // Reserve both notices inside the existing bound and avoid splitting a pair.
 text=normalizedText(text,'mime_body_index_limit');
 if(text.length+note.length>MAX_BODY_CHARS){
   const budget=MAX_BODY_CHARS-note.length-SHORTENED_NOTE.length;
   text=text.slice(0,budget).replace(/[\uD800-\uDBFF]$/,'')+SHORTENED_NOTE;
 }
 text+=note;
 return Object.freeze({from,subject,text});
}
