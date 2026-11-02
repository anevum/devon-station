import {presenceRestore} from './presence-core.mjs';
/* Encrypted Presence Studio portability. Passphrase never leaves this device.
 * The server stores only authenticated, owner-scoped opaque ciphertext.
 */
export const PRESENCE_VAULT_FORMAT='devon-station-presence-vault';
export const PRESENCE_VAULT_ITERATIONS=310000;
const AAD='devon-station-presence:v1';
const MAX_PLAINTEXT=480000;
const MAX_PAYLOAD=690000;
const fail=()=>{throw Error('Invalid encrypted Presence Studio backup.');};
const encode=bytes=>{
 let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const decode=(value,max)=>{
 if(typeof value!=='string'||value.length<1||value.length>Math.ceil(max*4/3)+4||!/^[A-Za-z0-9_-]+$/.test(value))fail();
 const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));
 if(raw.length>max)fail();
 const bytes=Uint8Array.from(raw,x=>x.charCodeAt(0));
 if(encode(bytes)!==value)fail();
 return bytes;
};
export function validatePresenceEnvelope(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||
  Object.keys(value).sort().join(',')!=='cipher,createdAt,format,iterations,iv,kdf,payload,salt,version')fail();
 if(value.format!==PRESENCE_VAULT_FORMAT||value.version!==1||value.cipher!=='AES-256-GCM'||
  value.kdf!=='PBKDF2-SHA256'||value.iterations!==PRESENCE_VAULT_ITERATIONS)fail();
 if(typeof value.createdAt!=='string'||value.createdAt.length>35||!Number.isFinite(Date.parse(value.createdAt)))fail();
 if(decode(value.salt,16).length!==16||decode(value.iv,12).length!==12||decode(value.payload,MAX_PAYLOAD).length<17)fail();
 return {format:value.format,version:1,cipher:value.cipher,kdf:value.kdf,iterations:value.iterations,
  salt:value.salt,iv:value.iv,payload:value.payload,createdAt:value.createdAt};
}
function validatePassphrase(text){if(typeof text!=='string'||text.length<14||text.length>256)throw Error('Use a passphrase between 14 and 256 characters.');return text;}
async function deriveKey(pass,salt){
 const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(validatePassphrase(pass)),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:PRESENCE_VAULT_ITERATIONS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
function validatePresenceState(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='drafts,snapshots,version'||raw.version!==1||!Array.isArray(raw.drafts)||!Array.isArray(raw.snapshots))throw Error('Invalid Presence Studio data.');
 if(raw.drafts.length>60||raw.snapshots.length>240)throw Error('Presence Studio backup exceeds the record limits.');
 const clean=presenceRestore(raw);
 if(clean.drafts.length!==raw.drafts.length||clean.snapshots.length!==raw.snapshots.length)throw Error('Presence Studio backup contains rejected or duplicate records.');
 const bytes=new TextEncoder().encode(JSON.stringify(clean));
 if(bytes.byteLength>MAX_PLAINTEXT)throw Error('Presence Studio data exceeds the encrypted backup limit.');
 return bytes;
}
export async function encryptPresenceVault(raw,passphrase){
 const payload=validatePresenceState(raw),salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
 const key=await deriveKey(passphrase,salt);
 const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(AAD),tagLength:128},key,payload));
 return validatePresenceEnvelope({format:PRESENCE_VAULT_FORMAT,version:1,cipher:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:PRESENCE_VAULT_ITERATIONS,salt:encode(salt),iv:encode(iv),payload:encode(cipher),createdAt:new Date().toISOString()});
}
export async function decryptPresenceVault(input,passphrase){
 validatePassphrase(passphrase);const envelope=validatePresenceEnvelope(input);
 try{
  const key=await deriveKey(passphrase,decode(envelope.salt,16));
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(envelope.iv,12),additionalData:new TextEncoder().encode(AAD),tagLength:128},key,decode(envelope.payload,MAX_PAYLOAD));
  const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(clear));
  validatePresenceState(parsed);return presenceRestore(parsed);
 }catch{throw Error('Passphrase incorrect or encrypted backup modified.');}
}
