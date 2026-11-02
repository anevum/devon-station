/** Client-side encryption of a scoped journal transfer. Passphrases never leave the client. */
const WS_BACKUP_MAX=6*1024*1024,WS_BACKUP_ROUNDS=310000,WS_BACKUP_AAD='devonstation-workspace-backup:v1';
const wsBackupFail=()=>{throw Error('workspace_backup_invalid_or_unlock_failed');};
const wsBackupObject=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const wsBackupIdentifier=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(x);
export function validateWorkspaceTransfer(value){
 if(!wsBackupObject(value,['format','version','ownerSubject','principalId','scope','generation','snapshot'])||value.format!=='devonstation-workspace-transfer'||value.version!==1||typeof value.ownerSubject!=='string'||!value.ownerSubject.length||value.ownerSubject.length>128||value.ownerSubject.trim()!==value.ownerSubject||/[\u0000-\u001f\u007f]/.test(value.ownerSubject)||!wsBackupIdentifier(value.principalId)||!wsBackupObject(value.scope,['scopeKind','scopeId'])||!['personal','business','creative'].includes(value.scope.scopeKind)||!wsBackupIdentifier(value.scope.scopeId)||!Number.isSafeInteger(value.generation)||value.generation<0||typeof value.snapshot!=='string'||new TextEncoder().encode(value.snapshot).length>5*1024*1024)wsBackupFail();
 if(new TextEncoder().encode(JSON.stringify(value)).length>WS_BACKUP_MAX)wsBackupFail();
 return structuredClone(value);
}
function wsBackupPassphrase(value){if(typeof value!=='string'||value.length<14||value.length>256)wsBackupFail();return value;}
function wsBackupEncode(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function wsBackupDecode(text,max){
 if(typeof text!=='string'||text.length>Math.ceil(max*4/3)||!/^[A-Za-z0-9_-]+$/.test(text))wsBackupFail();
 const binary=atob(text.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-text.length%4)%4));
 const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(bytes.length>max||wsBackupEncode(bytes)!==text)wsBackupFail();return bytes;
}
async function wsBackupKey(passphrase,salt){
 const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(wsBackupPassphrase(passphrase)),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:WS_BACKUP_ROUNDS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptWorkspaceBackup(raw,passphrase){
 const transfer=validateWorkspaceTransfer(raw);wsBackupPassphrase(passphrase);
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await wsBackupKey(passphrase,salt);
 const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(WS_BACKUP_AAD),tagLength:128},key,new TextEncoder().encode(JSON.stringify(transfer)));
 return {format:'devonstation-workspace-backup',version:1,cipher:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:WS_BACKUP_ROUNDS,salt:wsBackupEncode(salt),iv:wsBackupEncode(iv),payload:wsBackupEncode(new Uint8Array(bytes))};
}
export async function decryptWorkspaceBackup(envelope,passphrase){
 try{
  wsBackupPassphrase(passphrase);
  if(!wsBackupObject(envelope,['format','version','cipher','kdf','iterations','salt','iv','payload'])||envelope.format!=='devonstation-workspace-backup'||envelope.version!==1||envelope.cipher!=='AES-256-GCM'||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==WS_BACKUP_ROUNDS)wsBackupFail();
  const salt=wsBackupDecode(envelope.salt,16),iv=wsBackupDecode(envelope.iv,12),payload=wsBackupDecode(envelope.payload,WS_BACKUP_MAX+16);
  if(salt.length!==16||iv.length!==12||payload.length<16)wsBackupFail();
  const key=await wsBackupKey(passphrase,salt),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(WS_BACKUP_AAD),tagLength:128},key,payload);
  return validateWorkspaceTransfer(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain)));
 }catch{wsBackupFail();}
}
if(typeof window!=='undefined')globalThis.StationWorkspaceBackup={encrypt:encryptWorkspaceBackup,decrypt:decryptWorkspaceBackup};
