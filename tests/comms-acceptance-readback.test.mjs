import test from 'node:test';
import assert from 'node:assert/strict';
import {
 INACTIVE_ANCHORS,verifyPinnedDeployment,readbackInactiveAcceptance
} from '../tools/comms-acceptance-readback.mjs';

const a=INACTIVE_ANCHORS;
const owner='synthetic-owner@example.test';
const accountId='b'.repeat(32);
const storage={
 acceptance:['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'],
 production:['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444']
};
const plain=(name,text)=>({name,type:'plain_text',text});
function settings(which){
 const [db,mail]=storage[which];
 return {
  compatibility_date:'2026-10-28',compatibility_flags:['nodejs_compat'],
  bindings:[
   plain('ACCESS_AUD','synthetic-access-audience'),
   plain('ACCESS_ISSUER','https://synthetic-access.example.test'),
   plain('ACCESS_JWKS_URL','https://synthetic-access.example.test/certs'),
   plain('APP_ORIGIN','https://devon-station-mail-acceptance.devonakins.workers.dev'),
   {name:'DB',type:'d1',database_id:db},
   {name:'MAIL_DB',type:'d1',database_id:mail},
   plain('MAIL_DRAFTS_ENABLED','true'),plain('MAIL_ENABLED','true'),
   plain('MAIL_IMAP_ADDRESS','hello@devonakins.com'),
   {name:'MAIL_IMAP_PASSWORD',type:'secret_text'},
   plain('MAIL_OUTBOX_ENABLED','true'),plain('MAIL_OWNER_SUB','synthetic-subject'),
   plain('MAIL_PAYLOAD_KEY_ID','a'),
   {name:'MAIL_PAYLOAD_KEYS_JSON',type:'secret_text'},
   plain('MAIL_SEND_ENABLED','false'),plain('MAIL_SENDER_VERIFIED','false'),
   plain('MAIL_SMTP_ADDRESS','hello@devonakins.com'),
   {name:'MAIL_SMTP_PASSWORD',type:'secret_text'},
   plain('OWNER_EMAIL',owner),
   {name:'CF_VERSION_METADATA',type:'version_metadata'}
  ]
 };
}
const acceptShares=()=>({deployments:[{
 id:a.acceptanceDeploymentId,
 versions:[{version_id:a.acceptanceServingVersionId,percentage:100}]
}]});
const prodShares=()=>({deployments:[{
 id:a.productionDeploymentId,versions:[
  {version_id:a.productionServingVersionId,percentage:100},
  {version_id:a.productionZeroVersionId,percentage:0}
 ]
}]});
function harness(mutate=()=>{}){
 const prefix='/accounts/'+accountId;
 const acc=prefix+'/workers/scripts/devon-station-mail-acceptance';
 const prod=prefix+'/workers/scripts/devon-station';
 const app=prefix+'/access/apps/d75c6407-070e-4b43-8843-0216b166d712';
 const snapshots={
  [acc+'/settings']:settings('acceptance'),
  [prod+'/settings']:settings('production'),
  [acc+'/subdomain']:{enabled:true,previews_enabled:false},
  [acc+'/deployments']:acceptShares(),
  [prod+'/deployments']:prodShares(),
  [app]:{id:'d75c6407-070e-4b43-8843-0216b166d712',
   domain:'devon-station-mail-acceptance.devonakins.workers.dev',
   type:'self_hosted',aud:'synthetic-access-audience'},
  [app+'/policies']:[{decision:'allow',include:[{email:{email:owner}}],exclude:[],require:[]}],
  [acc+'/versions/'+a.versionId]:{
   id:a.versionId,
   annotations:{'workers/commit_sha':a.sourceCommit,
    'workers/pull_request_number':'36',
    'workers/repository_url':'https://github.com/devonalanakins/devon-station'},
   resources:{
    bindings:structuredClone(settings('acceptance').bindings),
    script_runtime:{compatibility_date:'2026-10-28',compatibility_flags:['nodejs_compat']}
   }
  }
 };
 const calls=[];
 const request=async(path,options)=>{
  calls.push({path,method:options?.method});
  assert.equal(options?.method,'GET','no mutating calls permitted');
  assert(Object.hasOwn(snapshots,path),'unapproved endpoint '+path);
  const value=structuredClone(snapshots[path]);
  mutate({path,value,calls,paths:{acc,prod,app}});
  return value;
 };
 return {request,accountId,calls,paths:{acc,prod,app}};
}

test('approved version and unchanged older traffic pass a GET-only, no-secret readback',async()=>{
 const h=harness();
 const result=await readbackInactiveAcceptance(h);
 assert.equal(result.status,'INACTIVE_VERSION_VERIFIED_NO_ACTIVATION');
 assert.equal(result.versionId,a.versionId);
 assert.equal(result.sourceCommit,a.sourceCommit);
 assert.equal(result.acceptedVersionServingTraffic,false);
 assert.equal(result.acceptanceSendEnabled,false);
 assert.equal(result.productionSendEnabled,false);
 assert.equal(result.evidenceScope,'GET_ONLY_AT_CHECK_TIME');
 assert.equal(h.calls.length,12,'seven preflight reads, two initial traffic checks, one version, two final checks');
 assert(h.calls.every(c=>c.method==='GET'));
 assert(!JSON.stringify(result).includes(owner));
 assert(!JSON.stringify(result).includes('synthetic-subject'));
});

test('zero traffic for the approved candidate is not sufficient if it appears in the active deployment',async()=>{
 const h=harness(({path,value,paths})=>{
  if(path===paths.acc+'/deployments')value.deployments[0].versions.push({version_id:a.versionId,percentage:0});
 });
 await assert.rejects(readbackInactiveAcceptance(h),/traffic allocation differs/);
 assert(h.calls.every(c=>c.method==='GET'));
});

test('changed traffic weights or unexpected version identity fail closed',async()=>{
 for(const mutate of [
  ({path,value,paths})=>{if(path===paths.prod+'/deployments')value.deployments[0].versions[0].percentage=99;},
  ({path,value,paths})=>{if(path===paths.acc+'/deployments')value.deployments[0].versions[0].version_id=a.versionId;},
  ({path,value,paths})=>{if(path===paths.acc+'/deployments')value.deployments[0].id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';}
 ]){
  const h=harness(mutate);
  await assert.rejects(readbackInactiveAcceptance(h),/drift|traffic|deployment/);
  assert(h.calls.every(c=>c.method==='GET'));
 }
});

test('version provenance, runtime and encrypted binding drift are rejected without mutations',async()=>{
 for(const mutate of [
  ({path,value})=>{if(path.endsWith('/versions/'+a.versionId))value.annotations['workers/commit_sha']='c'.repeat(40);},
  ({path,value})=>{if(path.endsWith('/versions/'+a.versionId))value.annotations['workers/pull_request_number']='44';},
  ({path,value})=>{if(path.endsWith('/versions/'+a.versionId))value.resources.script_runtime.compatibility_date='2026-12-01';},
  ({path,value})=>{if(path.endsWith('/versions/'+a.versionId))value.resources.bindings.find(b=>b.name==='MAIL_PAYLOAD_KEYS_JSON').type='plain_text';},
  ({path,value})=>{if(path.endsWith('/versions/'+a.versionId))value.resources.bindings.find(b=>b.name==='MAIL_DB').database_id=storage.production[0];}
 ]){
  const h=harness(mutate);
  await assert.rejects(readbackInactiveAcceptance(h),/refused:/);
  assert(h.calls.every(c=>c.method==='GET'));
 }
});

test('disabled sending, private Access policy and disabled preview are mandatory',async()=>{
 for(const mutate of [
  ({path,value,paths})=>{if(path===paths.prod+'/settings')value.bindings.find(b=>b.name==='MAIL_SEND_ENABLED').text='true';},
  ({path,value,paths})=>{if(path===paths.acc+'/settings')value.bindings.find(b=>b.name==='MAIL_SENDER_VERIFIED').text='true';},
  ({path,value,paths})=>{if(path===paths.app+'/policies')value[0].include=[{everyone:{}}];},
  ({path,value,paths})=>{if(path===paths.acc+'/subdomain')value.previews_enabled=true;}
 ]){
  const h=harness(mutate);
  await assert.rejects(readbackInactiveAcceptance(h),/refused:/);
  assert(h.calls.every(c=>c.method==='GET'));
 }
});

test('final traffic read detects activation between candidate inspection and completion',async()=>{
 let acceptanceReads=0;
 const h=harness(({path,value,paths})=>{
  if(path===paths.acc+'/deployments'&&++acceptanceReads===3)
   value.deployments[0].versions[0].version_id=a.versionId;
 });
 await assert.rejects(readbackInactiveAcceptance(h),/traffic/);
 assert.equal(acceptanceReads,3);
 assert(h.calls.every(c=>c.method==='GET'));
});

test('invalid account and injection outside the read allowlist are rejected',async()=>{
 const h=harness();
 await assert.rejects(readbackInactiveAcceptance({...h,accountId:'not-an-id'}),/connected account/);
 assert.equal(h.calls.length,0);
 assert.throws(()=>verifyPinnedDeployment(acceptShares(),{
  deploymentId:a.acceptanceDeploymentId,
  shares:{[a.acceptanceServingVersionId]:100},forbiddenVersion:a.acceptanceServingVersionId
 }),/active traffic/);
 assert.throws(()=>verifyPinnedDeployment(prodShares(),{
  deploymentId:a.productionDeploymentId,
  shares:{[a.productionServingVersionId]:100,[a.productionZeroVersionId]:0},
  forbiddenVersion:a.productionZeroVersionId
 }),/active traffic/);
});
