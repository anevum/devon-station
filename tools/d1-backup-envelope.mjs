/** Portable offline encryption only. No provider, filesystem, export or restore. */
import {randomBytes,pbkdf2,createCipheriv,createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';
const derive=promisify(pbkdf2),MAX=64*1024*1024,ROUNDS=310000;
const keys=['format','version','cipher','kdf','iterations','kind','length','salt','iv'];
const fail=()=>{throw Error('d1_backup_invalid_or_unlock_failed');};
const phrase=value=>{if(typeof value!=='string'||value.length<14||value.length>256||!value.trim())fail();};
const kind=value=>{if(!['d1-sql','sqlite'].includes(value))fail();};
const encode=value=>Buffer.from(value).toString('base64url');
function decode(value,max){
  if(typeof value!=='string'||value.length>Math.ceil(max*4/3)||!/^[A-Za-z0-9_-]+$/.test(value))fail();
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length>max||encode(bytes)!==value)fail();return bytes;
}
async function keyFor(passphrase,salt){
  const password=Buffer.from(passphrase,'utf8');
  try{return await derive(password,salt,ROUNDS,32,'sha256');}
  finally{password.fill(0);}
}
function header(values){return Object.fromEntries(keys.map(key=>[key,values[key]]));}
const aad=value=>Buffer.from('devonstation-whole-database:v1\0'+JSON.stringify(header(value)));

/** Seals caller-approved opaque bytes. Does not validate SQL or attest provenance. */
export async function encryptD1Backup(bytes,passphrase,{kind:contentKind}={}){
  let key,plain;
  try{
    phrase(passphrase);kind(contentKind);
    if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>MAX)fail();
    plain=Buffer.from(bytes); // Freeze input before asynchronous key derivation.
    const salt=randomBytes(16),iv=randomBytes(12);
    const envelope={format:'devonstation-d1-backup',version:1,cipher:'AES-256-GCM',
      kdf:'PBKDF2-SHA256',iterations:ROUNDS,kind:contentKind,length:plain.length,
      salt:encode(salt),iv:encode(iv)};
    key=await keyFor(passphrase,salt);
    const cipher=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});cipher.setAAD(aad(envelope));
    const payload=Buffer.concat([cipher.update(plain),cipher.final()]);
    return {...envelope,payload:encode(payload),tag:encode(cipher.getAuthTag())};
  }catch{fail();}finally{key?.fill(0);plain?.fill(0);}
}

/** Returns plaintext only after authentication. Caller owns its private lifecycle. */
export async function decryptD1Backup(envelope,passphrase){
  let key,partial;
  try{
    phrase(passphrase);
    const allowed=[...keys,'payload','tag'];
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||
      Object.keys(envelope).length!==allowed.length||!allowed.every(k=>Object.hasOwn(envelope,k)))fail();
    if(envelope.format!=='devonstation-d1-backup'||envelope.version!==1||
      envelope.cipher!=='AES-256-GCM'||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==ROUNDS||
      !Number.isSafeInteger(envelope.length)||envelope.length<1||envelope.length>MAX)fail();
    kind(envelope.kind);
    const salt=decode(envelope.salt,16),iv=decode(envelope.iv,12),tag=decode(envelope.tag,16),payload=decode(envelope.payload,MAX);
    if(salt.length!==16||iv.length!==12||tag.length!==16||payload.length!==envelope.length)fail();
    key=await keyFor(passphrase,salt);
    const decipher=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});
    decipher.setAAD(aad(envelope));decipher.setAuthTag(tag);
    partial=decipher.update(payload);
    const final=decipher.final();
    return {kind:envelope.kind,bytes:Buffer.concat([partial,final])};
  }catch{fail();}finally{key?.fill(0);partial?.fill(0);}
}
