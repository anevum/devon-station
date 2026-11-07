import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {start,token} from '../tools/runtime-harness.mjs';
import {createMailPayloadCipher} from '../src/communications/mail-payload-crypto.mjs';
import {createExecutionLedger} from '../worker/ai-work-execution.mjs';
import {createExecutionController,executionPlanDigest} from '../tools/ai-work/execution-controller.mjs';
import {createExecutionProvider} from '../tools/ai-work/execution-provider.mjs';
const sessionId='sess_executionTest',turnId='turn_executionTest';
const root=type=>({type,session_id:sessionId,turn:{id:turnId,subagent_id:null}});
const defaultEvents=()=>[{type:'agent.session.created',session:{id:sessionId}},root('agent.session.turn.in_progress'),{type:'agent.session.turn.output_text.delta',delta:'PRIVATE_PROVIDER_OUTPUT <img src=x onerror=alert(1)>'},root('agent.session.turn.completed')];
function providerFixture({events=defaultEvents(),status='completed',onSubmit,failSubmit=false,badReadback=false}={}){
 const calls=[],payloads=[];let currentStatus=status;
 const fetchImpl=async(url,init={})=>{
  calls.push({url,method:init.method??'GET',headers:init.headers});
  if(init.method==='POST'&&!url.endsWith('/events')){
   const body=JSON.parse(init.body);payloads.push(body);await onSubmit?.(body);
   if(failSubmit)throw Error('PRIVATE_URL_AND_SECRET');
   return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
  }
  if(url.endsWith('/events'))return Response.json({accepted:true});
  if(badReadback)return Response.json({secret:'PRIVATE_PROVIDER_ERROR'});
  if(url.endsWith('/turns/'+turnId))return Response.json({object:'agent.session.turn',id:turnId,session_id:sessionId,subagent_id:null,status:currentStatus});
  if(url.endsWith('/'+sessionId))return Response.json({object:'agent.session',id:sessionId,status:currentStatus==='waiting'?'requires_action':currentStatus==='in_progress'?'in_progress':'idle',spend_control:{limit:35,consumed:4.75}});
  throw Error('Unexpected provider route');
 };
 const provider=createExecutionProvider({apiKey:'sk-'+'syntheticTestOnlyCredential',allowPaidExecution:true,fetchImpl});
 return {provider,calls,payloads,status:value=>{currentStatus=value;},submitCalls:()=>calls.filter(c=>c.method==='POST'&&!c.url.endsWith('/events')).length};
}
async function fixture(t,providerOptions={}){
 const dir=mkdtempSync(join(tmpdir(),'ds-execution-')),file=join(dir,'jobs.sqlite');
 const server=await start(file,{aiFixture:true,executionFixture:true,apiOnly:true});
 t.after(async()=>{assert.equal(server.externalCalls(),0);await server.close();rmSync(dir,{recursive:true,force:true});});
 const request=async(path,body,subject='test-owner')=>{
  const r=await fetch(server.url+'/api/ai-work/'+path,{method:body?'POST':'GET',headers:{'Cf-Access-Jwt-Assertion':token(subject),...(body?{Origin:server.url,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};
 };
 const jobId=crypto.randomUUID();await request('jobs',{jobId,projectSlug:'devon-station',profile:'sandbox-build',task:'PRIVATE_EXECUTION_TASK',spendLimitCents:50});
 await request('jobs/'+jobId+'/decision',{expectedRevision:1,decision:'approve-plan'});
 const cipher=createMailPayloadCipher({activeKeyId:server.env.AI_WORK_KEY_ID,keys:JSON.parse(server.env.AI_WORK_KEYS_JSON)});
 const ledger=createExecutionLedger({db:server.env.DB,cipher,ownerSubject:'test-owner',dispatchEnabled:true});
 const plan=await ledger.readPlan(jobId),digest=await executionPlanDigest(plan);
 let grant={id:crypto.randomUUID(),ownerSubject:'test-owner',jobId,planDigest:digest,authorized:true,limitCents:35,expiresAt:Date.now()+300000};
 const pf=providerFixture(providerOptions),options={ledger,provider:pf.provider,readApproval:async()=>grant,scopeAllowed:async slug=>JSON.parse(server.env.AI_WORK_PROJECTS_JSON).includes(slug)};
 const controller=createExecutionController(options);
 return {jobId,file,server,ledger,controller,request,pf,options,grant:value=>{grant=value;},getGrant:()=>grant};
}

test('private controller requires explicit service capability and a trusted separate spending approval',async t=>{
 const f=await fixture(t);
 assert.throws(()=>createExecutionController({}),/not_configured/);
 assert.throws(()=>createExecutionController({...f.options,readApproval:undefined}),/not_configured/);
 assert.throws(()=>createExecutionController({...f.options,ledger:{...f.ledger,dispatchEnabled:false}}),/not_configured/);
 const original=f.getGrant();
 for(const mutation of [null,{...original,authorized:false},{...original,ownerSubject:'other'},{...original,jobId:crypto.randomUUID()},{...original,planDigest:'wrong'},{...original,limitCents:0},{...original,limitCents:51},{...original,expiresAt:Date.now()-1}]){
  f.grant(mutation);await assert.rejects(f.controller.prepare(f.jobId,2),/authorization_required/);
 }
 assert.equal(f.pf.submitCalls(),0);assert.equal(await f.ledger.get(f.jobId),null);
});

test('durable prepared identity, capped isolated provider execution, private output and independent root readback',async t=>{
 const f=await fixture(t),prepared=await f.controller.prepare(f.jobId,2);assert.equal(prepared.phase,'authorized');
 const before=await f.ledger.get(f.jobId);assert(before.data.submissionId);assert.equal(before.data.sessionId,null);
 const result=await f.controller.dispatch(f.jobId);assert.equal(result.phase,'completed');assert.equal(result.providerOutcomeConfirmed,true);assert.equal(result.taskResultsVerified,false);
 assert.equal(result.sessionId,sessionId);assert.equal(result.turnId,turnId);assert.match(result.outputText,/PRIVATE_PROVIDER_OUTPUT/);
 assert.equal(result.usage.consumedCents,4.75);assert.equal(result.usage.bestEffort,true);assert.equal(result.outputComplete,true);
 assert.deepEqual(f.pf.payloads[0].spend_control,{limit:35});assert.deepEqual(f.pf.payloads[0].environment,{type:'openai_hosted'});
 assert.equal(f.pf.calls[0].headers['Idempotency-Key'],before.data.submissionId);
 assert.equal(f.pf.submitCalls(),1);
 const sql=new DatabaseSync(f.file),row=sql.prepare('SELECT * FROM ai_work_executions').get();sql.close();
 assert.doesNotMatch(JSON.stringify(row),/PRIVATE_EXECUTION_TASK|PRIVATE_PROVIDER_OUTPUT|sess_executionTest|syntheticTestOnlyCredential/);
 const exposed=await f.request('jobs/'+f.jobId);assert.equal(exposed.body.job.execution.phase,'completed');
 assert.doesNotMatch(JSON.stringify(exposed.body),/submissionId|cancelId|syntheticTestOnlyCredential|approval.*ownerSubject/);
 assert.equal((await f.request('jobs/'+f.jobId+'/execution',undefined,'nonowner')).status,403);
});

test('ambiguous create is never retried, even after reconstruction of the controller',async t=>{
 const f=await fixture(t,{failSubmit:true});await f.controller.prepare(f.jobId,2);
 const first=await f.controller.dispatch(f.jobId);assert.equal(first.phase,'unverified');assert.equal(first.sessionId,null);
 const next=createExecutionController(f.options);assert.equal((await next.dispatch(f.jobId)).phase,'unverified');
 assert.equal((await next.reconcile(f.jobId)).lastError,'provider_identity_missing');assert.equal(f.pf.submitCalls(),1);
 assert.doesNotMatch(JSON.stringify(await f.ledger.get(f.jobId)),/PRIVATE_URL_AND_SECRET/);
});

test('two competing dispatchers claim only one submission and cannot double-spend',async t=>{
 let release,entered;const gate=new Promise(r=>{release=r;}),entry=new Promise(r=>{entered=r;});
 const f=await fixture(t,{onSubmit:async()=>{entered();await gate;}});await f.controller.prepare(f.jobId,2);
 const first=f.controller.dispatch(f.jobId);await entry;
 const second=await createExecutionController(f.options).dispatch(f.jobId);assert.equal(second.phase,'submitting');assert.equal(f.pf.submitCalls(),1);
 release();await first;assert.equal(f.pf.submitCalls(),1);
});

test('approval/project revocation and cancelled plans prevent a provider submission',async t=>{
 const f=await fixture(t);await f.controller.prepare(f.jobId,2);
 const original=f.getGrant();f.grant({...original,authorized:false});await assert.rejects(f.controller.dispatch(f.jobId),/authorization_required/);assert.equal(f.pf.submitCalls(),0);
 f.grant(original);f.server.env.AI_WORK_PROJECTS_JSON='["rhen"]';await assert.rejects(f.controller.dispatch(f.jobId),/scope_or_plan_revoked/);assert.equal(f.pf.submitCalls(),0);
});

test('failure to persist the submission claim prevents any provider call',async t=>{
 const f=await fixture(t);await f.controller.prepare(f.jobId,2);
 const broken=createExecutionController({...f.options,ledger:{...f.ledger,replace:async()=>{throw Error('synthetic_storage_failure');}}});
 await assert.rejects(broken.dispatch(f.jobId),/storage_failure/);assert.equal(f.pf.submitCalls(),0);
});

test('session identity is persisted before output, and known interrupted work recovers without resubmission',async t=>{
 const f=await fixture(t,{events:[{type:'agent.session.created',session:{id:sessionId}},root('agent.session.turn.in_progress')],status:'in_progress'});
 await f.controller.prepare(f.jobId,2);const first=await f.controller.dispatch(f.jobId);assert.equal(first.phase,'running');assert.equal(first.outputComplete,false);
 f.pf.status('completed');const recovered=await createExecutionController(f.options).reconcile(f.jobId);assert.equal(recovered.phase,'completed');assert.equal(recovered.outputComplete,false);assert.equal(recovered.providerOutcomeConfirmed,true);assert.equal(f.pf.submitCalls(),1);
});

test('a completed stream alone or an idle session cannot certify job success',async t=>{
 const f=await fixture(t,{badReadback:true});await f.controller.prepare(f.jobId,2);
 const result=await f.controller.dispatch(f.jobId);assert.equal(result.phase,'unverified');assert.equal(result.providerOutcomeConfirmed,false);
 assert.equal(result.lastError,'provider_readback_unavailable');assert.equal(f.pf.submitCalls(),1);
});

test('cancellation of an authorized but unsubmitted job needs no provider call',async t=>{
 const f=await fixture(t);const run=await f.controller.prepare(f.jobId,2);
 const reply=await f.request('jobs/'+f.jobId+'/cancel',{expectedRevision:2,expectedExecutionRevision:run.revision});
 assert.equal(reply.status,200);assert.equal(reply.body.execution.phase,'cancelled');assert.equal(reply.body.execution.providerOutcomeConfirmed,false);
 assert.equal((await f.controller.dispatch(f.jobId)).phase,'cancelled');assert.equal(f.pf.calls.length,0);
});

test('active cancellation is requested first and only provider turn readback confirms it',async t=>{
 const f=await fixture(t,{events:[{type:'agent.session.created',session:{id:sessionId}},root('agent.session.turn.in_progress')],status:'in_progress'});
 await f.controller.prepare(f.jobId,2);await f.controller.dispatch(f.jobId);
 const run=await f.ledger.get(f.jobId);
 assert.equal((await f.request('jobs/'+f.jobId+'/cancel',{expectedRevision:2})).status,409);
 const response=await f.request('jobs/'+f.jobId+'/cancel',{expectedRevision:2,expectedExecutionRevision:run.revision});
 assert.equal(response.body.execution.phase,'cancel_requested');assert.equal((await f.request('jobs/'+f.jobId)).body.job.state,'ready');
 let result=await f.controller.cancel(f.jobId);assert.equal(result.phase,'cancel_requested');assert.equal(result.providerOutcomeConfirmed,false);
 f.pf.status('cancelled');result=await f.controller.reconcile(f.jobId);assert.equal(result.phase,'cancelled');assert.equal(result.providerOutcomeConfirmed,true);assert.equal(f.pf.submitCalls(),1);
});

test('malicious output stays private, bounded and unverified as task evidence',async t=>{
 const f=await fixture(t,{events:[{type:'agent.session.created',session:{id:sessionId}},root('agent.session.turn.in_progress'),{type:'agent.session.turn.output_text.delta',delta:'界'.repeat(50000)},root('agent.session.turn.completed')]});
 await f.controller.prepare(f.jobId,2);const result=await f.controller.dispatch(f.jobId);assert(new TextEncoder().encode(result.outputText).length<=65536);assert.equal(result.outputTruncated,true);assert.equal(result.outputComplete,false);assert.equal(result.taskResultsVerified,false);
});

test('owner/project boundaries protect execution records and ciphertext cannot be moved between records',async t=>{
 const f=await fixture(t);await f.controller.prepare(f.jobId,2);
 f.server.env.AI_WORK_PROJECTS_JSON='["rhen"]';assert.equal((await f.request('jobs/'+f.jobId+'/execution')).status,403);assert.deepEqual((await f.request('jobs')).body.jobs,[]);
 const sql=new DatabaseSync(f.file);sql.prepare("UPDATE ai_work_executions SET phase='completed'").run();sql.close();
 await assert.rejects(f.ledger.get(f.jobId),/payload_unavailable/);
});

test('provider default refuses paid execution and fixed readback routes reject forged identity and raw errors',async()=>{
 let calls=0;const provider=createExecutionProvider({apiKey:'sk-'+'syntheticTestOnlyCredential',fetchImpl:async()=>{calls++;throw Error('PRIVATE_SECRET');}});
 await assert.rejects(provider.run({task:'x',spendLimitCents:5,submissionId:crypto.randomUUID()},async()=>{}),/paid_execution_disabled/);assert.equal(calls,0);
 await assert.rejects(provider.readback('../../mail','bad'),/invalid_provider_identity/);assert.equal(calls,0);
 await assert.rejects(provider.readback(sessionId,turnId),error=>error.code==='provider_readback_unavailable'&&!String(error).includes('PRIVATE_SECRET'));assert.equal(calls,1);
});

test('changed authority after claim is blocked before transport, and cancelled plans cannot be reserved',async t=>{
 const f=await fixture(t);await f.controller.prepare(f.jobId,2);let reads=0;
 const controller=createExecutionController({...f.options,readApproval:async()=>{reads++;return reads===2?{...f.getGrant(),id:'changed-approval'}:f.getGrant();}});
 assert.equal((await controller.dispatch(f.jobId)).phase,'blocked');assert.equal(f.pf.submitCalls(),0);
});

test('cancellation in the claim-to-submit gap stops the owning dispatcher before transport',async t=>{
 const f=await fixture(t);await f.controller.prepare(f.jobId,2);let reads=0;
 const controller=createExecutionController({...f.options,readApproval:async()=>{
  if(++reads===2){const current=await f.ledger.get(f.jobId);await f.ledger.requestCancel(f.jobId,current.revision);}
  return f.getGrant();
 }});
 assert.equal((await controller.dispatch(f.jobId)).phase,'cancelled');assert.equal(f.pf.submitCalls(),0);
});

test('cancellation cannot relabel a concurrently completed provider turn',async t=>{
 const f=await fixture(t,{events:[{type:'agent.session.created',session:{id:sessionId}},root('agent.session.turn.in_progress')],status:'in_progress'});
 await f.controller.prepare(f.jobId,2);await f.controller.dispatch(f.jobId);const run=await f.ledger.get(f.jobId);
 await f.ledger.requestCancel(f.jobId,run.revision);f.pf.status('completed');
 const result=await f.controller.cancel(f.jobId);assert.equal(result.phase,'completed');assert.equal(result.providerOutcomeConfirmed,true);
});

test('provider readback rejects child/mismatched identities, changed caps, oversized data and redirects',async()=>{
 const valid={object:'agent.session',id:sessionId,status:'idle',spend_control:{limit:35,consumed:0}};
 for(const sample of [
  {object:'agent.session.turn',id:turnId,session_id:'sess_other',subagent_id:null,status:'completed'},
  {object:'agent.session.turn',id:turnId,session_id:sessionId,subagent_id:'child',status:'completed'},
  {object:'agent.session.turn',id:'turn_wrong',session_id:sessionId,subagent_id:null,status:'completed'},
 ]){
  const p=createExecutionProvider({apiKey:'sk-'+'syntheticTestOnlyCredential',fetchImpl:async url=>Response.json(url.includes('/turns/')?sample:valid)});
  await assert.rejects(p.readback(sessionId,turnId),/identity_unverified/);
 }
 for(const response of [new Response('PRIVATE_REDIRECT',{status:302,headers:{Location:'https://evil.example'}}),Response.json({raw:'x'.repeat(300000)}),new Response('PRIVATE_ERROR',{status:503})]){
  const p=createExecutionProvider({apiKey:'sk-'+'syntheticTestOnlyCredential',fetchImpl:async()=>response});
  await assert.rejects(p.readback(sessionId,turnId),err=>!String(err).includes('PRIVATE_'));
 }
});

test('execution detail authenticates the owning plan before returning output or recording cancellation',async t=>{
 const f=await fixture(t);await f.controller.prepare(f.jobId,2);
 const sql=new DatabaseSync(f.file);sql.prepare("UPDATE ai_work_jobs SET project_slug='rhen'").run();sql.close();
 for(const path of ['jobs/'+f.jobId,'jobs/'+f.jobId+'/execution']){
  const r=await f.request(path);assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE_EXECUTION_TASK|approval|sessionId/);
 }
 assert.equal((await f.request('jobs/'+f.jobId+'/cancel',{expectedRevision:2,expectedExecutionRevision:1})).status,503);
 assert.equal((await f.ledger.get(f.jobId)).phase,'authorized');
});

test('HTTP clients cannot inject spending authority, run state or private approval records',async t=>{
 const f=await fixture(t);await f.controller.prepare(f.jobId,2);
 for(const extra of [{authorized:true},{approval:{id:'forged'}},{phase:'completed'},{submissionId:'forged'}]){
  assert.equal((await f.request('jobs/'+f.jobId+'/cancel',{expectedRevision:2,expectedExecutionRevision:1,...extra})).status,400);
 }
 assert.equal((await f.request('jobs/'+f.jobId+'/execute',{expectedRevision:2,authorized:true})).status,503);
 assert.equal(f.pf.submitCalls(),0);
});

test('unbound provider output cannot enter a private job before session and root-turn identity are saved',async t=>{
 const f=await fixture(t,{events:[{type:'agent.session.turn.output_text.delta',delta:'UNBOUND_PRIVATE_OUTPUT'},...defaultEvents()]});
 await f.controller.prepare(f.jobId,2);const result=await f.controller.dispatch(f.jobId);
 assert.equal(result.phase,'unverified');assert.equal(result.sessionId,null);assert.equal(result.outputText,'');assert.equal(f.pf.submitCalls(),1);
});

test('independent concurrent jobs keep separate submissions, output and cancellation state',async t=>{
 const f=await fixture(t),secondId=crypto.randomUUID();
 await f.request('jobs',{jobId:secondId,projectSlug:'rhen',profile:'sandbox-build',task:'SECOND_PRIVATE_TASK',spendLimitCents:50});
 await f.request('jobs/'+secondId+'/decision',{expectedRevision:1,decision:'approve-plan'});
 const plan=await f.ledger.readPlan(secondId),digest=await executionPlanDigest(plan);
 const grants=new Map([[f.jobId,f.getGrant()],[secondId,{...f.getGrant(),id:crypto.randomUUID(),jobId:secondId,planDigest:digest}]]);
 let submissions=0;
 const provider={run:async(options,checkpoint)=>{
  submissions++;const sid='sess_'+options.submissionId.replaceAll('-',''),tid='turn_'+options.submissionId.replaceAll('-','');
  await checkpoint({type:'agent.session.created',session:{id:sid}},{sessionId:sid});
  await checkpoint({type:'agent.session.turn.in_progress',turn:{id:tid,subagent_id:null}},{sessionId:sid});
  await checkpoint({type:'agent.session.turn.output_text.delta',delta:options.task},{sessionId:sid});return {status:'unverified'};
 },readback:async(sid,tid)=>({sessionId:sid,turnId:tid,sessionStatus:'in_progress',turnStatus:'in_progress',limitCents:35,consumedCents:1}),cancel:async()=>({accepted:true})};
 const controller=createExecutionController({...f.options,provider,readApproval:async({jobId})=>grants.get(jobId)});
 await Promise.all([controller.prepare(f.jobId,2),controller.prepare(secondId,2)]);
 await Promise.all([controller.dispatch(f.jobId),controller.dispatch(secondId)]);
 const one=await f.ledger.get(f.jobId),two=await f.ledger.get(secondId);
 assert.notEqual(one.data.sessionId,two.data.sessionId);assert.notEqual(one.data.submissionId,two.data.submissionId);
 assert.equal(one.data.outputText,'PRIVATE_EXECUTION_TASK');assert.equal(two.data.outputText,'SECOND_PRIVATE_TASK');
 await f.ledger.requestCancel(f.jobId,one.revision);assert.equal((await f.ledger.get(secondId)).phase,'running');assert.equal(submissions,2);
});
