import {executionError,executionTerminal,executionView} from '../../worker/ai-work-execution.mjs';
const bytes=new TextEncoder();
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail=code=>{throw executionError(code);};
export async function executionPlanDigest(plan){
 const data=JSON.stringify([1,plan.jobId,plan.revision,plan.projectSlug,plan.profile,plan.task,plan.spendLimitCents]);
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.encode(data)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const limitText=text=>{
 const encoded=bytes.encode(text);return encoded.length<=65536?{text,truncated:false}:{text:new TextDecoder().decode(encoded.slice(0,65533)),truncated:true};
};
// Runtime capability dependencies are private trusted callbacks, never browser/job input.
// There is no default approval reader and no default provider/dispatch implementation.
export function createExecutionController({ledger,provider,readApproval,scopeAllowed=async()=>false,clock=Date.now}={}){
 if(!ledger||ledger.dispatchEnabled!==true||!provider||typeof readApproval!=='function')fail('execution_service_not_configured');
 async function approvalFor(plan,digest){
  let scope=false;try{scope=await scopeAllowed(plan.projectSlug);}catch{}
  if(plan.state!=='ready'||scope!==true)fail('execution_scope_or_plan_revoked');
  let a;try{a=await readApproval({ownerSubject:ledger.ownerSubject,jobId:plan.jobId,planDigest:digest});}catch{fail('spending_authorization_required');}
  if(!a||!id(a.id)||a.ownerSubject!==ledger.ownerSubject||a.jobId!==plan.jobId||a.planDigest!==digest||
   a.authorized!==true||!Number.isSafeInteger(a.limitCents)||a.limitCents<1||a.limitCents>plan.spendLimitCents||
   !Number.isSafeInteger(a.expiresAt)||a.expiresAt<=clock())fail('spending_authorization_required');
  return {id:a.id,limitCents:a.limitCents,expiresAt:a.expiresAt};
 }
 async function prepare(jobId,expectedPlanRevision){
  const plan=await ledger.readPlan(jobId);if(plan.revision!==expectedPlanRevision)fail('execution_plan_changed');
  const digest=await executionPlanDigest(plan),approval=await approvalFor(plan,digest);
  const data={planDigest:digest,planRevision:plan.revision,projectSlug:plan.projectSlug,profile:plan.profile,
   task:plan.task,proposedLimitCents:plan.spendLimitCents,approval,submissionId:crypto.randomUUID(),cancelId:crypto.randomUUID(),
   sessionId:null,turnId:null,outputText:'',outputTruncated:false,outputComplete:false,providerOutcomeConfirmed:false,
   usage:null,evidence:[],lastError:null,cancelRequested:false,cancelRequestedAt:null};
  return executionView(await ledger.reserve(jobId,data));
 }
 async function update(jobId,fn){
  // CAS retries only local bookkeeping, never provider requests.
  for(let n=0;n<4;n++){
   const current=await ledger.get(jobId);if(!current)fail('execution_not_found');
   const change=await fn(current);if(!change)return current;
   try{return await ledger.replace(current,change.phase??current.phase,{...current.data,...change.data});}
   catch(error){if(error.publicCode!=='execution_revision_conflict'||n===3)throw error;}
  }
 }
 async function markUnknown(jobId,code){
  return update(jobId,current=>executionTerminal(current.phase)?null:{phase:current.data.cancelRequested?'cancel_requested':'unverified',data:{lastError:code,providerOutcomeConfirmed:false}});
 }
 async function reconcile(jobId){
  const current=await ledger.get(jobId);if(!current)fail('execution_not_found');
  if(current.phase==='authorized'||current.phase==='blocked'||current.phase==='cancelled'&&!current.data.sessionId)return executionView(current);
  const {sessionId,turnId}=current.data;
  if(!sessionId||!turnId)return executionView(await markUnknown(jobId,'provider_identity_missing'));
  let receipt;
  try{receipt=await provider.readback(sessionId,turnId);}
  catch{return executionView(await markUnknown(jobId,'provider_readback_unavailable'));}
  if(receipt?.sessionId!==sessionId||receipt.turnId!==turnId||receipt.limitCents!==current.data.approval.limitCents||
   !['queued','in_progress','waiting','completed','failed','cancelled'].includes(receipt.turnStatus)||
   !['idle','in_progress','requires_action','failed'].includes(receipt.sessionStatus)||
   !(receipt.consumedCents===null||typeof receipt.consumedCents==='number'&&Number.isFinite(receipt.consumedCents)&&receipt.consumedCents>=0))
   return executionView(await markUnknown(jobId,'provider_readback_mismatch'));
  const terminal=['completed','failed','cancelled'].includes(receipt.turnStatus);
  const saved=await update(jobId,row=>{
   if(row.data.providerOutcomeConfirmed&&executionTerminal(row.phase)){
    if(receipt.turnStatus===row.phase)return null;
    return {phase:'unverified',data:{providerOutcomeConfirmed:false,lastError:'provider_outcome_conflict'}};
   }
   // A concurrent cancellation request must survive nonterminal readback.
   // Readback confirms root lifecycle, never successful tool execution.
   const phase=terminal?receipt.turnStatus:row.data.cancelRequested?'cancel_requested':receipt.turnStatus==='waiting'?'waiting':'running';
   return {phase,data:{providerOutcomeConfirmed:terminal,lastError:null,usage:{consumedCents:receipt.consumedCents,bestEffort:true,overCap:receipt.consumedCents!==null&&receipt.consumedCents>receipt.limitCents},
    evidence:[{kind:'provider-root-turn-readback',at:clock(),status:receipt.turnStatus}]}};
  });
  return executionView(saved);
 }
 async function dispatch(jobId){
  let current=await ledger.get(jobId);if(!current)fail('execution_not_found');
  if(current.phase!=='authorized')return executionView(current); // Never replay a submission.
  const plan=await ledger.readPlan(jobId),digest=await executionPlanDigest(plan);
  const approval=await approvalFor(plan,digest);
  if(digest!==current.data.planDigest||approval.id!==current.data.approval.id||approval.limitCents!==current.data.approval.limitCents||approval.expiresAt!==current.data.approval.expiresAt)fail('spending_authorization_changed');
  // Persist submission identity/claim before any possible provider effect.
  current=await ledger.replace(current,'submitting',current.data,{requireReadyPlan:true});
  // Revalidate immediately before transport; do not infer permission from an old receipt.
  try{const fresh=await approvalFor(await ledger.readPlan(jobId),digest);if(JSON.stringify(fresh)!==JSON.stringify(approval))fail('spending_authorization_changed');}
  catch{return executionView(await update(jobId,row=>row.phase==='submitting'?{phase:'blocked',data:{lastError:'spending_authorization_revoked'}}:null));}
  const pending=await ledger.get(jobId);
  if(pending.phase!=='submitting'){
   if(pending.data.cancelRequested&&!pending.data.sessionId)return executionView(await ledger.replace(pending,'cancelled',{...pending.data,lastError:null}));
   return executionView(pending);
  }
  let buffer='',outputTruncated=false,lastFlush=clock(),count=0;
  async function checkpoint(event,receipt){
   count++;if(count>100000)throw executionError('event_limit_reached');
   const root=event.turn?.subagent_id===null;
   const turn=root&&event.turn?.id;
   if(turn!==false&&turn!==undefined&&turn!==null&&!id(turn))throw executionError('provider_identity_unverified');
   const row=await ledger.get(jobId);if(!row)throw executionError('execution_not_found');
   if(event.type==='agent.session.turn.output_text.delta'&&typeof event.delta==='string'&&(!event.turn||root)){
    if(!(receipt.sessionId??row.data.sessionId)||!(turn||row.data.turnId))throw executionError('provider_identity_unverified');
    const bounded=limitText(buffer+event.delta);buffer=bounded.text;outputTruncated||=bounded.truncated;
   }
   if(receipt.sessionId&&row.data.sessionId&&receipt.sessionId!==row.data.sessionId||turn&&row.data.turnId&&turn!==row.data.turnId)throw executionError('provider_identity_unverified');
   const identityChanged=receipt.sessionId&&receipt.sessionId!==row.data.sessionId||turn&&turn!==row.data.turnId;
   const end=/^agent\.session\.turn\.(completed|failed|cancelled)$/.test(event.type)&&root;
   if(!identityChanged&&!end&&bytes.encode(buffer).length<1024&&clock()-lastFlush<2000&&event.type!=='agent.session.requires_action')return;
   const chunk=buffer;buffer='';lastFlush=clock();
   await update(jobId,saved=>{
    if(executionTerminal(saved.phase))throw executionError('execution_already_terminal');
    const bounded=limitText(saved.data.outputText+chunk);
    const phase=saved.data.cancelRequested?'cancel_requested':event.type==='agent.session.requires_action'?'waiting':'running';
    return {phase,data:{sessionId:receipt.sessionId??saved.data.sessionId,turnId:turn||saved.data.turnId,
     outputText:bounded.text,outputTruncated:saved.data.outputTruncated||outputTruncated||bounded.truncated}};
   });
  }
  let outcome;
  try{outcome=await provider.run({task:current.data.task,spendLimitCents:current.data.approval.limitCents,submissionId:current.data.submissionId},checkpoint);}
  catch{return executionView(await markUnknown(jobId,'provider_submission_unverified'));}
  if(buffer){const chunk=buffer;await update(jobId,row=>{const bounded=limitText(row.data.outputText+chunk);return {data:{outputText:bounded.text,outputTruncated:row.data.outputTruncated||outputTruncated||bounded.truncated}};});}
  if(['completed','failed','cancelled'].includes(outcome?.status))await update(jobId,row=>({data:{outputComplete:!row.data.outputTruncated}}));
  // Even a completed stream must be independently retrieved against saved identities.
  return reconcile(jobId);
 }
 async function cancel(jobId){
  const current=await ledger.get(jobId);if(!current)fail('execution_not_found');
  if(executionTerminal(current.phase))return executionView(current);
  if(!current.data.cancelRequested)fail('owner_cancellation_required');
  if(!current.data.sessionId)return executionView(await markUnknown(jobId,'provider_identity_missing'));
  try{await provider.cancel(current.data.sessionId,current.data.cancelId);}
  catch{return executionView(await markUnknown(jobId,'provider_cancellation_unverified'));}
  return reconcile(jobId); // 2xx is only acceptance, never confirmed cancellation.
 }
 return Object.freeze({prepare,dispatch,reconcile,cancel});
}
