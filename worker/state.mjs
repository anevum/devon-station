/** Private owner workspace state: versioned, bounded, access-scoped, no PHI or source-of-truth writes. */
const AREAS = new Set(['Family & Home','Shinewell','Devon Works','Writing','ANEVUM','Incubator']);
const SECTIONS = new Set(['workspace','command','inbox','portfolio','works','infrastructure','writing','anevum','reviews','settings','global']);
const FEEDBACK_TYPES = new Set(['Design','Behavior','Feature','Bug']);
const PREFERENCES = {theme:['obsidian','slate'],accent:['cyan','teal','violet'],density:['compact','comfortable'],motion:['system','reduced'],contrast:['normal','high']};
const DEFAULTS = {theme:'obsidian',accent:'cyan',density:'compact',motion:'system',contrast:'normal'};
const idPattern = /^local:[a-zA-Z0-9-]{1,90}$/;
const secretPattern = /(?:sk-|ghp_|github_pat_|xox[baprs]-)[a-zA-Z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const sensitivePattern = /\b(?:patient|diagnosis|medical record|social security number|ssn|password|bank account|credit card number)\b/i;
const fail = (code,status=400)=>{const err=new Error(code);err.status=status;err.publicCode=code;throw err;};
const plain = x=>x&&typeof x==='object'&&!Array.isArray(x);
const limitedText=(x,max,field,min=0)=>{if(typeof x!=='string'||x.length>max||x.trim().length<min||/\u0000/.test(x)||secretPattern.test(x)||sensitivePattern.test(x))fail('invalid_'+field);return x.trim();};
const timestamp=x=>{if(typeof x!=='string'||x.length>35||!/^\d{4}-\d\d-\d\dT/.test(x)||!Number.isFinite(Date.parse(x)))fail('invalid_timestamp');return x;};
const unique=(items)=>{const ids=new Set();for(const x of items){if(ids.has(x.id))fail('duplicate_item_id');ids.add(x.id);}};
export function emptyState(){return {version:1,prefs:{...DEFAULTS},drafts:[],feedback:[],outcomes:[],history:[]};}
export function validateOwnerState(raw){
 if(!plain(raw)||raw.version!==1||!plain(raw.prefs))fail('invalid_state_version');
 for(const key of Object.keys(raw))if(!['version','prefs','drafts','feedback','outcomes','history'].includes(key))fail('unexpected_state_field');
 for(const key of Object.keys(raw.prefs))if(!(key in PREFERENCES))fail('invalid_preference');
 const prefs={};for(const [key,allowed] of Object.entries(PREFERENCES)){const value=raw.prefs[key]??DEFAULTS[key];if(!allowed.includes(value))fail('invalid_preference');prefs[key]=value;}
 if(!Array.isArray(raw.drafts)||raw.drafts.length>200||!Array.isArray(raw.feedback)||raw.feedback.length>100||!Array.isArray(raw.outcomes)||raw.outcomes.length>3||!Array.isArray(raw.history)||raw.history.length>30)fail('state_limit_exceeded');
 const drafts=raw.drafts.map(x=>{
  if(!plain(x)||!idPattern.test(x.id)||!AREAS.has(x.area)||!['Draft','Routed locally','Archived'].includes(x.state))fail('invalid_draft');
  // The owner's host must not silently claim Notion routing or accept arbitrary URLs.
  if(x.project!=null||x.destination!=null)fail('external_project_link_requires_source_sync');
  const d={id:x.id,title:limitedText(x.title,500,'draft',2),area:x.area,project:null,destination:null,state:x.state,createdAt:timestamp(x.createdAt)};
  if(x.updatedAt!=null)d.updatedAt=timestamp(x.updatedAt);
  return d;
 });unique(drafts);
 const feedback=raw.feedback.map(x=>{
  if(!plain(x)||!idPattern.test(x.id)||!SECTIONS.has(x.section)||!FEEDBACK_TYPES.has(x.category)||!['Open','Archived'].includes(x.state))fail('invalid_feedback');
  return {id:x.id,section:x.section,category:x.category,note:limitedText(x.note,1200,'feedback',3),state:x.state,createdAt:timestamp(x.createdAt)};
 });unique(feedback);
 const outcomes=raw.outcomes.map(x=>{if(typeof x!=='string'||x.length>80||!/^[a-zA-Z0-9_-]+$/.test(x))fail('invalid_outcome');return x;});
 if(new Set(outcomes).size!==outcomes.length)fail('duplicate_outcome');
 const history=raw.history.map(x=>{if(!plain(x))fail('invalid_history');return {action:limitedText(x.action,100,'history',1),at:timestamp(x.at)};});
 const clean={version:1,prefs,drafts,feedback,outcomes,history};
 if(JSON.stringify(clean).length>128000)fail('state_limit_exceeded',413);
 return clean;
}
export async function getOwnerState(db,subject){
 const found=await db.prepare('SELECT revision,payload,updated_at,last_operation FROM station_documents WHERE owner_sub=?').bind(subject).first();
 if(!found)return {revision:0,updatedAt:null,state:emptyState(),exists:false};
 return {revision:Number(found.revision),updatedAt:Number(found.updated_at),state:validateOwnerState(JSON.parse(found.payload)),exists:true,lastOperation:found.last_operation};
}
export async function saveOwnerState(db,subject,input){
 if(!plain(input)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.expectedRevision>1000000000)fail('invalid_revision');
 const op=input.operationId;
 if(typeof op!=='string'||!/^[-a-f0-9]{36}$/i.test(op))fail('invalid_operation_id');
 const action=limitedText(input.action??'Workspace updated',100,'action',1);
 const state=validateOwnerState(input.state),payload=JSON.stringify(state),now=Date.now();
 const shaBytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
 const hash=Array.from(new Uint8Array(shaBytes),b=>b.toString(16).padStart(2,'0')).join('');
 const current=await getOwnerState(db,subject);
 // An operation identifier represents one exact write, not permission to silently
 // discard a different payload on retry. Consult the durable audit, not only
 // the most recent operation on the document.
 const prior=await db.prepare('SELECT revision,content_sha256,action FROM station_write_audit WHERE owner_sub=? AND operation_id=?').bind(subject,op).first();
 if(prior){
  if(prior.content_sha256!==hash||prior.action!==action||Number(prior.revision)!==input.expectedRevision+1)fail('operation_id_reused',409);
  return {saved:true,revision:Number(prior.revision),currentRevision:current.revision,updatedAt:current.updatedAt,duplicate:true,superseded:current.revision!==Number(prior.revision)};
 }
 if(current.revision!==input.expectedRevision)fail('revision_conflict',409);
 const revision=current.revision+1;
 const statements=[
  db.prepare('INSERT INTO station_documents(owner_sub,revision,schema_version,payload,updated_at,last_operation) VALUES(?,?,1,?,?,?) ON CONFLICT(owner_sub) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at,last_operation=excluded.last_operation WHERE station_documents.revision=?').bind(subject,revision,payload,now,op,input.expectedRevision),
  db.prepare('INSERT INTO station_write_audit(owner_sub,operation_id,revision,action,content_sha256,created_at) SELECT owner_sub,?,revision,?,?,? FROM station_documents WHERE owner_sub=? AND revision=? AND last_operation=?').bind(op,action,hash,now,subject,revision,op)
 ];
 const results=await db.batch(statements);
 if(results[0]?.meta?.changes!==1||results[1]?.meta?.changes!==1)fail('revision_conflict',409);
 return {saved:true,revision,updatedAt:now,duplicate:false};
}
