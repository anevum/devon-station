import {runAgentJob,AgentWorkError} from './agents-client.mjs';
const BASE='https://api.openai.com/v1/agents/sessions';
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
async function boundedJson(response){
 if(!response.ok)throw new AgentWorkError('provider_readback_unavailable');
 if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw new AgentWorkError('provider_readback_unavailable');
 const reader=response.body?.getReader();if(!reader)throw new AgentWorkError('provider_readback_unavailable');
 let size=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
 try{
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144)throw Error();text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();return JSON.parse(text);
 }catch{throw new AgentWorkError('provider_readback_unavailable');}
 finally{try{await reader.cancel();}catch{}reader.releaseLock();}
}
// Explicitly constructed in a private service. Never instantiated by an HTTP route here.
export function createExecutionProvider({apiKey,allowPaidExecution=false,fetchImpl=fetch}={}){
 const headers=()=>{
  if(typeof apiKey!=='string'||!apiKey.startsWith('sk-')||apiKey.length<10)throw new AgentWorkError('api_key_required');
  return {Authorization:'Bearer '+apiKey,'OpenAI-Beta':'agents=v1','Content-Type':'application/json'};
 };
 async function request(url,init={}){
  let response;try{response=await fetchImpl(url,{...init,headers:{...headers(),...init.headers},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new AgentWorkError('provider_readback_unavailable');}
  return boundedJson(response);
 }
 return Object.freeze({
  async run({task,spendLimitCents,submissionId},onPrivateEvent){
   if(allowPaidExecution!==true)throw new AgentWorkError('paid_execution_disabled');
   if(!safeId(submissionId))throw new AgentWorkError('invalid_submission_id');
   return runAgentJob({task,spendLimitCents,apiKey},{onPrivateEvent,fetchImpl:(url,init)=>fetchImpl(url,{...init,headers:{...init.headers,'Idempotency-Key':submissionId}})});
  },
  async readback(sessionId,turnId){
   if(!safeId(sessionId)||!safeId(turnId))throw new AgentWorkError('invalid_provider_identity');
   const session=await request(BASE+'/'+sessionId);
   const turn=await request(BASE+'/'+sessionId+'/turns/'+turnId);
   // Reject cross-session, child turn and missing/changed provider spending limits.
   if(session?.object!=='agent.session'||session.id!==sessionId||turn?.object!=='agent.session.turn'||turn.id!==turnId||turn.session_id!==sessionId||turn.subagent_id!==null||
    !['idle','in_progress','requires_action','failed'].includes(session.status)||!['queued','in_progress','waiting','completed','failed','cancelled'].includes(turn.status)||
    !Number.isSafeInteger(session.spend_control?.limit)||session.spend_control.limit<1)throw new AgentWorkError('provider_identity_unverified');
   const consumed=session.spend_control.consumed;
   return {sessionId,turnId,turnStatus:turn.status,sessionStatus:session.status,limitCents:session.spend_control.limit,
    consumedCents:typeof consumed==='number'&&Number.isFinite(consumed)&&consumed>=0?consumed:null};
  },
  async cancel(sessionId,cancelId){
   if(!safeId(sessionId)||!safeId(cancelId))throw new AgentWorkError('invalid_provider_identity');
   // Acceptance is not cancellation confirmation; caller must retrieve the pinned turn.
   await request(BASE+'/'+sessionId+'/events',{method:'POST',headers:{'Idempotency-Key':cancelId},body:JSON.stringify({events:[{type:'agent.session.input.cancel'}]})});
   return {accepted:true};
  },
 });
}
