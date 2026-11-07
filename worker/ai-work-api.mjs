import {createMailPayloadCipher} from '../src/communications/mail-payload-crypto.mjs';

// Deliberately no provider import, dispatcher, fetch, publication, or execution flag.
// This slice records private plans. A future dispatcher needs separate billing authority.
export const WORK_PROJECTS = Object.freeze({
 'devon-station':'DevonStation', 'devonakins-com':'DevonAkins.com',
 mizvo:'Mizvo', rhen:'Rhen', merit:'Merit',
});
export const WORK_PROFILES = Object.freeze({
 'sandbox-review':'Review supplied material in an isolated sandbox',
 'sandbox-build':'Prepare and test changes in an isolated sandbox',
});
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fail = (publicCode,status=400) => {throw {publicCode,status};};
const exact = (input,keys) => {
 if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!keys.includes(k)))fail('invalid_job_input');
};
function config(env,user){
 if(env.AI_WORK_ENABLED!=='true')fail('work_console_disabled',503);
 if(!env.AI_WORK_OWNER_SUB || user.subject!==env.AI_WORK_OWNER_SUB)fail('owner_only',403);
 if(!env.DB)fail('work_storage_unavailable',503);
 let allowed,cipher;
 try{
  allowed=JSON.parse(env.AI_WORK_PROJECTS_JSON);
  if(!Array.isArray(allowed)||!allowed.length||allowed.length>5||new Set(allowed).size!==allowed.length||allowed.some(x=>typeof x!=='string'||!Object.hasOwn(WORK_PROJECTS,x)))throw Error();
  cipher=createMailPayloadCipher({activeKeyId:env.AI_WORK_KEY_ID,keys:JSON.parse(env.AI_WORK_KEYS_JSON)});
 }catch{fail('work_configuration_unavailable',503);}
 return {allowed,cipher};
}
const context=(user,row)=>['ai-work',user.subject,row.job_id,row.project_slug,String(row.revision),row.state];
const summary=row=>({jobId:row.job_id,projectSlug:row.project_slug,revision:row.revision,state:row.state,createdAt:row.created_at,updatedAt:row.updated_at});
async function record(db,user,id){
 const row=await db.prepare('SELECT * FROM ai_work_jobs WHERE owner_sub=? AND job_id=?').bind(user.subject,id).first();
 if(!row)fail('job_not_found',404);return row;
}
async function open(cipher,row,user){
 try{return await cipher.open(row.payload,context(user,row));}catch{fail('work_payload_unavailable',503);}
}
const assertProject=(allowed,slug)=>{if(!allowed.includes(slug))fail('project_not_authorized',403);};
function inputPlan(body){
 exact(body,['jobId','projectSlug','profile','task','spendLimitCents','parentJobId']);
 if(!uuid(body.jobId)||typeof body.projectSlug!=='string'||typeof body.profile!=='string'||!Object.hasOwn(WORK_PROJECTS,body.projectSlug)||!Object.hasOwn(WORK_PROFILES,body.profile)||
  typeof body.task!=='string'||!body.task.trim()||new TextEncoder().encode(body.task).length>8192||
  /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.task)||
  !Number.isSafeInteger(body.spendLimitCents)||body.spendLimitCents<1||body.spendLimitCents>10000||
  (body.parentJobId!==undefined&&!uuid(body.parentJobId)))fail('invalid_job_input');
 // Catch common accidentally pasted credentials; no content can grant authority.
 if(/(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(body.task))fail('credentials_not_allowed');
 return {projectSlug:body.projectSlug,profile:body.profile,task:body.task.trim(),spendLimitCents:body.spendLimitCents,parentJobId:body.parentJobId??null};
}
export async function handleAiWorkApi({request,url,user,env,readBody}){
 const {allowed,cipher}=config(env,user),db=env.DB;
 const path=url.pathname,method=request.method;
 if(path==='/api/ai-work/config'&&method==='GET')return {projects:allowed.map(slug=>({slug,name:WORK_PROJECTS[slug]})),profiles:WORK_PROFILES,executionEnabled:false,publicSharing:false,billing:'Separate API authorization required'};
 if(path==='/api/ai-work/jobs'&&method==='GET'){
  const cursor=url.searchParams.get('cursor');let before=null;
  if(cursor){try{before=JSON.parse(atob(cursor));if(!Array.isArray(before)||before.length!==2||!Number.isSafeInteger(before[0])||before[0]<0||!uuid(before[1]))throw Error();}catch{fail('invalid_cursor');}}
  const filter=before?' AND (created_at < ? OR (created_at = ? AND job_id < ?))':'';
  const args=[user.subject,...(before?[before[0],before[0],before[1]]:[])];
  // Metadata only; do not decrypt private prompts to draw job lanes.
  const rows=(await db.prepare('SELECT job_id,project_slug,revision,state,created_at,updated_at FROM ai_work_jobs WHERE owner_sub=?'+filter+' ORDER BY created_at DESC,job_id DESC LIMIT 51').bind(...args).all()).results;
  const page=rows.slice(0,50),last=page.at(-1);
  return {jobs:page.filter(x=>allowed.includes(x.project_slug)).map(summary),nextCursor:rows.length>50?btoa(JSON.stringify([last.created_at,last.job_id])):null,executionEnabled:false,publicSharing:false};
 }
 if(path==='/api/ai-work/jobs'&&method==='POST'){
  const body=await readBody(request,12288),plan=inputPlan(body);assertProject(allowed,plan.projectSlug);
  if(plan.parentJobId){
   const parent=await record(db,user,plan.parentJobId);assertProject(allowed,parent.project_slug);
   if(parent.project_slug!==plan.projectSlug||!['cancelled','rejected'].includes(parent.state))fail('continuation_requires_closed_plan',409);
  }
  const now=Date.now(),data={...plan,output:[],evidence:[],history:[{state:'review',at:now}],billingAuthorized:false};
  const payload=await cipher.seal(data,context(user,{job_id:body.jobId,project_slug:plan.projectSlug,revision:1,state:'review'}));
  const inserted=await db.prepare(`INSERT OR IGNORE INTO ai_work_jobs(owner_sub,job_id,project_slug,revision,state,created_at,updated_at,payload) VALUES(?,?,?,1,'review',?,?,?)`).bind(user.subject,body.jobId,plan.projectSlug,now,now,payload).run();
  const row=await record(db,user,body.jobId),saved=await open(cipher,row,user);
  if(Object.keys(plan).some(k=>saved[k]!==plan[k]))fail('job_id_conflict',409);
  return {job:summary(row),created:inserted.meta?.changes===1};
 }
 const match=path.match(/^\/api\/ai-work\/jobs\/([0-9a-f-]+)(?:\/(decision|cancel|execute))?$/);
 if(!match||!uuid(match[1]))fail('not_found',404);
 const row=await record(db,user,match[1]);assertProject(allowed,row.project_slug);
 if(!match[2]&&method==='GET')return {job:{...summary(row),...await open(cipher,row,user)},executionEnabled:false,publicSharing:false};
 // No request or env flag can turn this into a billable endpoint.
 if(match[2]==='execute'&&method==='POST')fail('execution_not_connected',503);
 if(!['decision','cancel'].includes(match[2])||method!=='POST')fail('method_not_allowed',405);
 const body=await readBody(request,1024);exact(body,match[2]==='decision'?['expectedRevision','decision']:['expectedRevision']);
 if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision!==row.revision)fail('revision_conflict',409);
 let next;
 if(match[2]==='decision'){
  if(row.state!=='review'||!['approve-plan','reject'].includes(body.decision))fail('invalid_job_transition',409);
  next=body.decision==='approve-plan'?'ready':'rejected';
 }else{
  if(!['review','ready'].includes(row.state))fail('invalid_job_transition',409);
  next='cancelled';
 }
 const data=await open(cipher,row,user),now=Date.now();data.history.push({state:next,at:now});
 const payload=await cipher.seal(data,context(user,{...row,revision:row.revision+1,state:next}));
 const result=await db.prepare('UPDATE ai_work_jobs SET revision=revision+1,state=?,updated_at=?,payload=? WHERE owner_sub=? AND job_id=? AND revision=?').bind(next,now,payload,user.subject,row.job_id,row.revision).run();
 if(result.meta?.changes!==1)fail('revision_conflict',409);
 return {job:{...summary(row),state:next,updatedAt:now,revision:row.revision+1},executionEnabled:false,publicSharing:false};
}
