// Portable private D1 ledger. No network, credentials, automatic schema creation or dispatcher.
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const EXECUTION_PHASES=Object.freeze(['authorized','submitting','running','waiting','unverified','cancel_requested','cancelled','completed','failed','blocked']);
export const executionTerminal=phase=>['cancelled','completed','failed','blocked'].includes(phase);
export function executionError(code,status=409){return Object.assign(new Error(code),{publicCode:code,status});}
const fail=(code,status)=>{throw executionError(code,status);};
const ctx=(owner,row)=>['ai-work-execution',owner,row.job_id,String(row.revision),row.phase];
export async function executionPlan(db,cipher,owner,jobId){
 if(!ID.test(jobId??''))fail('invalid_job_input',400);
 const row=await db.prepare('SELECT * FROM ai_work_jobs WHERE owner_sub=? AND job_id=?').bind(owner,jobId).first();
 if(!row)fail('job_not_found',404);
 let data;try{data=await cipher.open(row.payload,['ai-work',owner,row.job_id,row.project_slug,String(row.revision),row.state]);}catch{fail('work_payload_unavailable',503);}
 return {...data,jobId:row.job_id,projectSlug:row.project_slug,revision:row.revision,state:row.state};
}
export function createExecutionLedger({db,cipher,ownerSubject,clock=Date.now,dispatchEnabled=false}){
 if(!db||!cipher||typeof ownerSubject!=='string'||!ownerSubject||ownerSubject.length>128)fail('execution_configuration_unavailable',503);
 async function get(jobId){
  if(!ID.test(jobId??''))fail('invalid_job_input',400);
  const row=await db.prepare('SELECT * FROM ai_work_executions WHERE owner_sub=? AND job_id=?').bind(ownerSubject,jobId).first();
  if(!row)return null;
  let data;try{data=await cipher.open(row.payload,ctx(ownerSubject,row));}catch{fail('execution_payload_unavailable',503);}
  return {jobId:row.job_id,revision:row.revision,phase:row.phase,updatedAt:row.updated_at,data};
 }
 async function reserve(jobId,data){
  const row={job_id:jobId,revision:1,phase:'authorized'},now=clock();
  const payload=await cipher.seal(data,ctx(ownerSubject,row));
  // Authorization cannot race a plan cancellation or modification.
  await db.prepare(`INSERT OR IGNORE INTO ai_work_executions(owner_sub,job_id,revision,phase,updated_at,payload)
   SELECT ?,?,1,'authorized',?,? WHERE EXISTS(SELECT 1 FROM ai_work_jobs WHERE owner_sub=? AND job_id=? AND revision=? AND state='ready')`)
   .bind(ownerSubject,jobId,now,payload,ownerSubject,jobId,data.planRevision).run();
  const saved=await get(jobId);if(!saved)fail('execution_plan_changed');
  if(saved.data.planDigest!==data.planDigest||saved.data.approval.id!==data.approval.id)fail('execution_already_reserved');
  return saved;
 }
 async function replace(current,phase,data,{requireReadyPlan=false}={}){
  if(!EXECUTION_PHASES.includes(phase))fail('invalid_execution_phase',400);
  const row={job_id:current.jobId,revision:current.revision+1,phase},now=clock();
  const payload=await cipher.seal(data,ctx(ownerSubject,row));
  const result=await db.prepare('UPDATE ai_work_executions SET revision=revision+1,phase=?,updated_at=?,payload=? WHERE owner_sub=? AND job_id=? AND revision=?'+
   (requireReadyPlan?" AND EXISTS(SELECT 1 FROM ai_work_jobs WHERE owner_sub=? AND job_id=? AND revision=? AND state='ready')":''))
   .bind(phase,now,payload,ownerSubject,current.jobId,current.revision,...(requireReadyPlan?[ownerSubject,current.jobId,data.planRevision]:[])).run();
  if(result.meta?.changes!==1)fail('execution_revision_conflict');
  return {jobId:current.jobId,revision:row.revision,phase,updatedAt:now,data};
 }
 async function requestCancel(jobId,expectedRevision){
  const current=await get(jobId);if(!current)fail('execution_not_found',404);
  if(current.revision!==expectedRevision)fail('execution_revision_conflict');
  if(executionTerminal(current.phase)||current.phase==='cancel_requested')return current;
  const notSubmitted=current.phase==='authorized';
  return replace(current,notSubmitted?'cancelled':'cancel_requested',{...current.data,cancelRequested:true,
   ...(notSubmitted?{lastError:null,providerOutcomeConfirmed:false}:{}),cancelRequestedAt:clock()});
 }
 return Object.freeze({ownerSubject,dispatchEnabled,get,reserve,replace,requestCancel,readPlan:jobId=>executionPlan(db,cipher,ownerSubject,jobId)});
}
export function executionView(record){
 if(!record)return null;
 const d=record.data;
 return {jobId:record.jobId,revision:record.revision,phase:record.phase,updatedAt:record.updatedAt,
  proposedLimitCents:d.proposedLimitCents,approvedLimitCents:d.approval.limitCents,
  sessionId:d.sessionId,turnId:d.turnId,outputText:d.outputText,outputTruncated:d.outputTruncated,
  outputComplete:d.outputComplete,providerOutcomeConfirmed:d.providerOutcomeConfirmed,
  taskResultsVerified:false,usage:d.usage,lastError:d.lastError,cancelRequested:d.cancelRequested,
  evidence:d.evidence};
}
