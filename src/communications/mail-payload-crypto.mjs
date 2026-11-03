// Server-side envelope encryption. Keys belong in Worker secrets, never D1 or the browser.
// This protects a database export; a compromised Worker with its keys can still read mail.
const encoder=new TextEncoder();
const fail=()=>{throw Object.assign(new Error('mail_payload_unavailable'),{code:'mail_payload_unavailable'});};
const keyId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,31}$/.test(value);
const b64=bytes=>{
 let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));
 return btoa(text);
};
function bytes(text,length){
 if(typeof text!=='string'||text.length>230000||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))fail();
 let out;try{out=Uint8Array.from(atob(text),x=>x.charCodeAt(0));}catch{fail();}
 if((length!==undefined&&out.length!==length)||b64(out)!==text)fail();
 return out;
}
function aad(context){
 if(!Array.isArray(context)||context.length<1||context.length>8||
  context.some(x=>typeof x!=='string'||!x||x.length>256||/[\x00-\x1f\x7f]/.test(x)))fail();
 return encoder.encode(JSON.stringify(['devonstation-mail-payload',1,...context]));
}
export function createMailPayloadCipher({activeKeyId,keys}={}){
 if(!keyId(activeKeyId)||!keys||typeof keys!=='object'||Array.isArray(keys)||
  Object.keys(keys).length<1||Object.keys(keys).length>4||!Object.hasOwn(keys,activeKeyId))fail();
 // Copy and validate before any asynchronous work; errors never echo key material.
 const material=new Map(Object.entries(keys).map(([id,key])=>{
  if(!keyId(id))fail();return [id,bytes(key,32)];
 }));
 const imported=new Map();
 const key=async id=>{
  if(!material.has(id))fail();
  if(!imported.has(id))imported.set(id,crypto.subtle.importKey('raw',material.get(id),'AES-GCM',false,['encrypt','decrypt']));
  return imported.get(id);
 };
 return Object.freeze({
  async seal(value,context){
   try{
    const text=JSON.stringify(value);if(typeof text!=='string')fail();
    const plaintext=encoder.encode(text);
    if(plaintext.length>160*1024)fail();
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,
     additionalData:aad(context),tagLength:128},await key(activeKeyId),plaintext));
    return JSON.stringify({v:1,alg:'A256GCM',kid:activeKeyId,iv:b64(iv),ct:b64(ciphertext)});
   }catch{fail();}
  },
  async open(serialized,context){
   try{
    if(typeof serialized!=='string'||serialized.length>230000)fail();
    const e=JSON.parse(serialized);
    if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).sort().join(',')!=='alg,ct,iv,kid,v'||
     e.v!==1||e.alg!=='A256GCM'||!keyId(e.kid))fail();
    const iv=bytes(e.iv,12),ciphertext=bytes(e.ct);
    if(ciphertext.length<16||ciphertext.length>160*1024+16)fail();
    const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv,
     additionalData:aad(context),tagLength:128},await key(e.kid),ciphertext);
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
   }catch{fail();}
  }
 });
}
// Strict opt-in: a configured keyring never falls back to reading plaintext.
export function mailPayloadCipherFromEnv(env){
 try{return createMailPayloadCipher({activeKeyId:env?.MAIL_PAYLOAD_KEY_ID,
  keys:JSON.parse(env?.MAIL_PAYLOAD_KEYS_JSON)});}catch{fail();}
}
