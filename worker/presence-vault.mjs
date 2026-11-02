/* Owner-authenticated, opaque Presence Studio ciphertext vault.
 * No plaintext social content, passphrase or Meta credentials may be accepted.
 * Requires reviewed additive migration 0004; not auto-migrated at request time.
 */
const fail=(code,status=400)=>{const error=new Error(code);error.publicCode=code;error.status=status;throw error;};
const isObject=x=>x&&typeof x==='object'&&!Array.isArray(x);
const encoded=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&/^[A-Za-z0-9_-]+$/.test(value);
export function validateVaultEnvelope(value){
 if(!isObject(value)||Object.keys(value).sort().join(',')!=='cipher,createdAt,format,iterations,iv,kdf,payload,salt,version'||
 value.format!=='devon-station-presence-vault'||value.version!==1||value.cipher!=='AES-256-GCM'||value.kdf!=='PBKDF2-SHA256'||value.iterations!==310000||
 !encoded(value.salt,24)||!encoded(value.iv,16)||!encoded(value.payload,920004)||
 value.salt.length!==22||value.iv.length!==16||value.payload.length<24||
 typeof value.createdAt!=='string'||value.createdAt.length>35||!Number.isFinite(Date.parse(value.createdAt)))fail('invalid_encrypted_envelope');
 return {format:value.format,version:1,cipher:value.cipher,kdf:value.kdf,iterations:value.iterations,salt:value.salt,iv:value.iv,payload:value.payload,createdAt:value.createdAt};
}
async function digest(payload){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');}
export async function readPresenceVault(db,subject){
 const row=await db.prepare('SELECT revision,envelope,updated_at FROM station_presence_vault WHERE owner_sub=?').bind(subject).first();
 if(!row)return {revision:0,exists:false,updatedAt:null,envelope:null};
 return {revision:Number(row.revision),exists:true,updatedAt:Number(row.updated_at),envelope:validateVaultEnvelope(JSON.parse(row.envelope))};
}
export async function savePresenceVault(db,subject,input){
 if(!isObject(input)||Object.keys(input).sort().join(',')!=='envelope,expectedRevision,operationId'||
 !Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.expectedRevision>1000000000||
 typeof input.operationId!=='string'||!/^[-a-f0-9]{36}$/i.test(input.operationId))fail('invalid_vault_write');
 const envelope=validateVaultEnvelope(input.envelope),payload=JSON.stringify(envelope),hash=await digest(payload),current=await readPresenceVault(db,subject),now=Date.now();
 const prior=await db.prepare('SELECT revision,content_sha256 FROM station_presence_vault_audit WHERE owner_sub=? AND operation_id=?').bind(subject,input.operationId).first();
 if(prior){
  if(prior.content_sha256!==hash||Number(prior.revision)!==input.expectedRevision+1)fail('operation_id_reused',409);
  return {saved:true,revision:Number(prior.revision),currentRevision:current.revision,updatedAt:current.updatedAt,duplicate:true,superseded:current.revision!==Number(prior.revision)};
 }
 if(current.revision!==input.expectedRevision)fail('revision_conflict',409);
 const revision=current.revision+1;
 const update=input.expectedRevision===0 ?
  db.prepare('INSERT INTO station_presence_vault(owner_sub,revision,envelope,updated_at,last_operation) VALUES(?,?,?,?,?) ON CONFLICT(owner_sub) DO NOTHING').bind(subject,revision,payload,now,input.operationId) :
  db.prepare('UPDATE station_presence_vault SET revision=?,envelope=?,updated_at=?,last_operation=? WHERE owner_sub=? AND revision=?').bind(revision,payload,now,input.operationId,subject,input.expectedRevision);
 const audit=db.prepare('INSERT INTO station_presence_vault_audit(owner_sub,operation_id,revision,content_sha256,created_at) SELECT owner_sub,?,?,?,? FROM station_presence_vault WHERE owner_sub=? AND revision=? AND last_operation=?').bind(input.operationId,revision,hash,now,subject,revision,input.operationId);
 const results=await db.batch([update,audit]);
 if(results[0]?.meta?.changes!==1||results[1]?.meta?.changes!==1)fail('revision_conflict',409);
 return {saved:true,revision,currentRevision:revision,updatedAt:now,duplicate:false};
}
