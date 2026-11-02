/**
 * Portable, self-controlled owner-state recovery. No credentials or Notion data.
 * All encryption happens inside the browser. This is not the D1 disaster-recovery export.
 */
const BACKUP_FORMAT='devon-station-owner-backup';
const BACKUP_VERSION=1;
const BACKUP_ITERATIONS=310000;
const BACKUP_AAD='devon-station-owner-state:v1';
const BACKUP_AREAS=new Set(['Family & Home','Shinewell','Devon Works','Writing','ANEVUM','Incubator']);
const BACKUP_SECTIONS=new Set(['workspace','command','inbox','portfolio','works','infrastructure','writing','anevum','reviews','settings','global']);
const BACKUP_PREFS={theme:['obsidian','slate'],accent:['cyan','teal','violet'],density:['compact','comfortable'],motion:['system','reduced'],contrast:['normal','high']};
const BACKUP_FEEDBACK=new Set(['Design','Behavior','Feature','Bug']);
const BACKUP_SECRET=/(?:sk-|ghp_|github_pat_|xox[baprs]-)[a-zA-Z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const BACKUP_SENSITIVE=/\b(?:patient|diagnosis|medical record|social security number|ssn|password|bank account|credit card number)\b/i;
function backupFail(code){throw new Error(code)}
function backupText(value,max,min=0){if(typeof value!=='string'||value.length>max||value.trim().length<min||/\u0000/.test(value)||BACKUP_SECRET.test(value)||BACKUP_SENSITIVE.test(value))backupFail('backup_contains_unsupported_content');return value.trim()}
function backupDate(value){if(typeof value!=='string'||value.length>35||!/^\d{4}-\d\d-\d\dT/.test(value)||!Number.isFinite(Date.parse(value)))backupFail('backup_contains_invalid_date');return value;}
function backupObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function backupAllowedKeys(value,allowed){for(const key of Object.keys(value))if(!allowed.includes(key))backupFail('backup_contains_unexpected_field')}
/** Validate the exact owner-state subset supported by the hosted private API. */
export function validatePortableBackupState(raw){
 if(!backupObject(raw)||raw.version!==1||!backupObject(raw.prefs))backupFail('invalid_backup_state');
 backupAllowedKeys(raw,['version','prefs','drafts','feedback','outcomes','history']);
 backupAllowedKeys(raw.prefs,Object.keys(BACKUP_PREFS));
 const prefs={};for(const [key,valid] of Object.entries(BACKUP_PREFS)){const value=raw.prefs[key];if(!valid.includes(value))backupFail('invalid_backup_preference');prefs[key]=value;}
 if(!Array.isArray(raw.drafts)||raw.drafts.length>200||!Array.isArray(raw.feedback)||raw.feedback.length>100||!Array.isArray(raw.outcomes)||raw.outcomes.length>3||!Array.isArray(raw.history)||raw.history.length>30)backupFail('backup_state_limit_exceeded');
 const drafts=raw.drafts.map(x=>{
  if(!backupObject(x)||!/^local:[A-Za-z0-9-]{1,90}$/.test(x.id)||!BACKUP_AREAS.has(x.area)||!['Draft','Routed locally','Archived'].includes(x.state)||x.project!=null||x.destination!=null)backupFail('invalid_backup_draft');
  backupAllowedKeys(x,['id','title','area','project','destination','state','createdAt','updatedAt']);
  const result={id:x.id,title:backupText(x.title,500,2),area:x.area,project:null,destination:null,state:x.state,createdAt:backupDate(x.createdAt)};
  if(x.updatedAt!=null)result.updatedAt=backupDate(x.updatedAt);
  return result;
 });
 const feedback=raw.feedback.map(x=>{
  if(!backupObject(x)||!/^local:[A-Za-z0-9-]{1,90}$/.test(x.id)||!BACKUP_SECTIONS.has(x.section)||!BACKUP_FEEDBACK.has(x.category)||!['Open','Archived'].includes(x.state))backupFail('invalid_backup_feedback');
  backupAllowedKeys(x,['id','section','category','note','state','createdAt']);
  return {id:x.id,section:x.section,category:x.category,note:backupText(x.note,1200,3),state:x.state,createdAt:backupDate(x.createdAt)};
 });
 for(const values of [drafts,feedback])if(new Set(values.map(x=>x.id)).size!==values.length)backupFail('duplicate_backup_record');
 const outcomes=raw.outcomes.map(x=>{if(typeof x!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(x))backupFail('invalid_backup_outcome');return x});
 if(new Set(outcomes).size!==outcomes.length)backupFail('duplicate_backup_outcome');
 const history=raw.history.map(x=>{if(!backupObject(x))backupFail('invalid_backup_history');backupAllowedKeys(x,['action','at']);return {action:backupText(x.action,100,1),at:backupDate(x.at)}});
 const state={version:1,prefs,drafts,feedback,outcomes,history};
 if(new TextEncoder().encode(JSON.stringify(state)).byteLength>128000)backupFail('backup_state_limit_exceeded');
 return state;
}
function backupPassphrase(value){if(typeof value!=='string'||value.length<14||value.length>256)backupFail('passphrase_must_be_14_to_256_characters');return value;}
function backupEncode(bytes){let s='';for(let i=0;i<bytes.byteLength;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function backupDecode(value,max){if(typeof value!=='string'||value.length>Math.ceil(max*4/3)+4||!/^[A-Za-z0-9_-]+$/.test(value))backupFail('invalid_backup_envelope');const s=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));if(s.length>max)backupFail('invalid_backup_envelope');return Uint8Array.from(s,c=>c.charCodeAt(0));}
async function backupKey(passphrase,salt){const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(backupPassphrase(passphrase)),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:BACKUP_ITERATIONS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
/** The returned envelope can be downloaded or stored by the owner without exposing its contents. */
export async function encryptPortableBackup(raw,passphrase){
 const state=validatePortableBackupState(raw);backupPassphrase(passphrase);
 const salt=crypto.getRandomValues(new Uint8Array(16));const iv=crypto.getRandomValues(new Uint8Array(12));
 const key=await backupKey(passphrase,salt);const payload=new TextEncoder().encode(JSON.stringify(state));
 const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(BACKUP_AAD),tagLength:128},key,payload));
 return {format:BACKUP_FORMAT,version:BACKUP_VERSION,cipher:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:BACKUP_ITERATIONS,salt:backupEncode(salt),iv:backupEncode(iv),payload:backupEncode(ciphertext),createdAt:new Date().toISOString()};
}
/** Decryption failure never reveals whether a guess matched a partial password. */
export async function decryptPortableBackup(envelope,passphrase){
 backupPassphrase(passphrase);
 if(!backupObject(envelope)||JSON.stringify(envelope).length>350000)backupFail('invalid_backup_envelope');
 backupAllowedKeys(envelope,['format','version','cipher','kdf','iterations','salt','iv','payload','createdAt']);
 if(envelope.format!==BACKUP_FORMAT||envelope.version!==1||envelope.cipher!=='AES-256-GCM'||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==BACKUP_ITERATIONS)backupFail('unsupported_backup_format');
 backupDate(envelope.createdAt);
 const salt=backupDecode(envelope.salt,16),iv=backupDecode(envelope.iv,12),payload=backupDecode(envelope.payload,175000);
 if(salt.byteLength!==16||iv.byteLength!==12||payload.byteLength<16)backupFail('invalid_backup_envelope');
 try{
  const key=await backupKey(passphrase,salt);
  const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(BACKUP_AAD),tagLength:128},key,payload);
  const decoded=new TextDecoder('utf-8',{fatal:true}).decode(decrypted);
  return validatePortableBackupState(JSON.parse(decoded));
 }catch{backupFail('backup_unlock_failed_or_file_modified')}
}
