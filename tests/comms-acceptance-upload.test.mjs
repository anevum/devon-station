import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyReviewCandidate,verifyAcceptanceSettings,verifyOwnerAccess,buildVersionForm,
 uploadAcceptanceVersion} from '../tools/comms-acceptance-upload.mjs';

const sha256=s=>createHash('sha256').update(s).digest('hex');
const sourceSha='a'.repeat(40);
const version='a1b2c3d4-1111-4444-8888-0123456789ab';
const deployed='bbbbbbbb-1111-4444-8888-111111111111';
const appId='d75c6407-070e-4b43-8843-0216b166d712';
const origin='https://devon-station-mail-acceptance.devonakins.workers.dev';
const owner='synthetic-owner@example.test';
const worker='devon-station-mail-acceptance';
function fakeBundle(){
 const modules={
  'index.mjs':"import {connect} from 'cloudflare:sockets';\nconst s='\"privateDataLoaded\":false';\nexport default createStation(assets,undefined,undefined,connect);\n",
  'worker/mail-api.mjs':"const path='/api/mail/diagnostics/imap-check';",
  'worker/index.mjs':"const v=env.CF_VERSION_METADATA?.id;"
 };
 for(let i=0;i<40;i++)modules['src/synthetic-'+i+'.mjs']='export const x='+i+';\n';
 const bytes=Buffer.from(JSON.stringify(modules));
 const manifest={schemaVersion:1,status:'REVIEW_ONLY_NOT_DEPLOYED_OR_ACCEPTED',
  sourceCommit:sourceSha,candidate:{sha256:sha256(bytes),moduleCount:43,
   modulesSha256:Object.fromEntries(Object.entries(modules).map(([p,s])=>[p,sha256(s)]))}};
 return {manifest,bytes,modules};
}
function settings(){
 const p=(name,text)=>({name,type:'plain_text',text});
 const bindings=[
  p('ACCESS_AUD','synthetic-audience'),p('ACCESS_ISSUER','https://synthetic-access.example.test'),
  p('ACCESS_JWKS_URL','https://synthetic-access.example.test/certs'),
  p('APP_ORIGIN',origin),{name:'DB',type:'d1',database_id:'synthetic-main'},
  {name:'MAIL_DB',type:'d1',database_id:'synthetic-mail'},
  p('MAIL_DRAFTS_ENABLED','true'),p('MAIL_ENABLED','false'),
  p('MAIL_IMAP_ADDRESS','hello@devonakins.com'),p('MAIL_OUTBOX_ENABLED','true'),
  p('MAIL_OWNER_SUB','synthetic-subject'),p('MAIL_PAYLOAD_KEY_ID','a'),
  {name:'MAIL_PAYLOAD_KEYS_JSON',type:'secret_text'},p('MAIL_SEND_ENABLED','false'),
  p('MAIL_SENDER_VERIFIED','false'),p('MAIL_SMTP_ADDRESS','hello@devonakins.com'),
  p('OWNER_EMAIL',owner)
 ];
 return {compatibility_date:'2026-10-28',compatibility_flags:['nodejs_compat'],bindings};
}
const app=()=>({id:appId,type:'self_hosted',domain:new URL(origin).hostname});
const policies=()=>[{decision:'allow',include:[{email:{email:owner}}],exclude:[],require:[]}];
test('staging review matches exact checked-out SHA, source module hashes, privacy entrypoint and TLS socket import',()=>{
 const {bytes,manifest}=fakeBundle();
 assert.equal(Object.keys(verifyReviewCandidate({manifest,candidateBytes:bytes,expectedSha:sourceSha})).length,43);
 const bad=Buffer.from(bytes);bad[25]^=1;
 assert.throws(()=>verifyReviewCandidate({manifest,candidateBytes:bad,expectedSha:sourceSha}),/checksum/);
 assert.throws(()=>verifyReviewCandidate({manifest,candidateBytes:bytes,expectedSha:'b'.repeat(40)}),/source SHA/);
 const changed={...manifest,candidate:{...manifest.candidate,modulesSha256:{...manifest.candidate.modulesSha256,
  'worker/index.mjs':'0'.repeat(64)}}};
 assert.throws(()=>verifyReviewCandidate({manifest:changed,candidateBytes:bytes,expectedSha:sourceSha}),/module digest/);
});
test('staging preflight refuses send flags, missing encryption binding, public origin and unexpected binding types',()=>{
 const x=settings();
 const safe=verifyAcceptanceSettings(x);
 assert.equal(safe.owner,owner);assert.equal(safe.inherited.length,x.bindings.length);
 assert(safe.inherited.every(v=>v.type==='inherit'));
 for(const [name,value] of [['MAIL_SEND_ENABLED','true'],['MAIL_SENDER_VERIFIED','true'],
   ['APP_ORIGIN','https://unsafe.example.test']]){
  const changed=structuredClone(x);changed.bindings.find(b=>b.name===name).text=value;
  assert.throws(()=>verifyAcceptanceSettings(changed),/refused:/);
 }
 for(const changed of [
  {...x,bindings:x.bindings.filter(b=>b.name!=='MAIL_PAYLOAD_KEYS_JSON')},
  {...x,bindings:[...x.bindings,{name:'MAIL_SMTP_PASSWORD',type:'secret_text'}]},
  {...x,bindings:[...x.bindings,{name:'EXTRA_USER_TOKEN',type:'unknown_type'}]}
 ])assert.throws(()=>verifyAcceptanceSettings(changed),/refused:/);
});
test('Access policy preflight accepts only the named owner and denies public/bypass policy drift',()=>{
 verifyOwnerAccess(app(),policies(),owner);
 for(const bad of [
  [{decision:'bypass',include:[{everyone:{}}]}],
  [{decision:'allow',include:[{everyone:{}}]}],
  [{decision:'allow',include:[{email:{email:'other@example.test'}}]}],
  [{decision:'allow',include:[{email:{email:owner}}]},{decision:'allow',include:[{everyone:{}}]}]
 ])assert.throws(()=>verifyOwnerAccess(app(),bad,owner),/refused:/);
 assert.throws(()=>verifyOwnerAccess({...app(),domain:'unsafe.example.test'},policies(),owner),/refused:/);
});
test('version multipart includes reviewed module bytes, inherited secret names only, version metadata and source annotation',async()=>{
 const {modules}=fakeBundle(),checked=verifyAcceptanceSettings(settings());
 const {form,metadata}=buildVersionForm(modules,sourceSha,checked.inherited);
 assert.equal([...form.keys()].length,44);
 assert.equal(metadata.main_module,'index.mjs');
 assert.deepEqual(metadata.compatibility_flags,['nodejs_compat']);
 assert.equal(metadata.annotations['workers/commit_sha'],sourceSha);
 assert.deepEqual(metadata.bindings.at(-1),{type:'version_metadata',name:'CF_VERSION_METADATA'});
 assert(metadata.bindings.every(x=>x.type==='inherit'||x.type==='version_metadata'));
 assert.equal(await form.get('worker/mail-api.mjs').text(),modules['worker/mail-api.mjs']);
 assert.equal(JSON.parse(await form.get('metadata').text()).annotations['workers/commit_sha'],sourceSha);
 assert.doesNotMatch(JSON.stringify(metadata),/synthetic-audience|synthetic-subject|synthetic-owner@example.test/);
});
test('dry-run provider emulation proves only version upload, no deployment, secret, database, or Access mutations',async()=>{
 const {modules}=fakeBundle(),requests=[];
 const fetchImpl=async(url,options)=>{
  const path=new URL(url).pathname+new URL(url).search;
  requests.push({path,method:options.method,body:options.body});
  let result;
  if(path.endsWith('/settings'))result=settings();
  else if(path.endsWith('/access/apps/'+appId))result=app();
  else if(path.endsWith('/access/apps/'+appId+'/policies'))result=policies();
  else if(path.endsWith('/deployments'))result={deployments:[{id:deployed}]};
  else if(path.endsWith('/versions?bindings_inherit=strict')){
   assert.equal(options.method,'POST');
   assert(options.body instanceof FormData);
   result={id:version};
  }
  else if(path.endsWith('/versions/'+version))result={id:version,annotations:{'workers/commit_sha':sourceSha},resources:{bindings:[...settings().bindings,{name:'CF_VERSION_METADATA',type:'version_metadata'}],script_runtime:{compatibility_date:'2026-10-28',compatibility_flags:['nodejs_compat']}}};
  else throw Error('unexpected mock API '+path);
  return new Response(JSON.stringify({success:true,result}),{status:200,headers:{'content-type':'application/json'}});
 };
 const result=await uploadAcceptanceVersion({fetchImpl,accountId:'b'.repeat(32),token:'synthetic-restricted-token',
  sourceSha,modules});
 assert.deepEqual(result,{status:'VERSION_UPLOADED_NOT_DEPLOYED',versionId:version,sourceCommit:sourceSha,
  existingDeploymentId:deployed,trafficUnchanged:true});
 assert.equal(requests.filter(x=>x.method==='POST').length,1);
 assert.equal(requests.filter(x=>x.method==='POST')[0].path.endsWith('/versions?bindings_inherit=strict'),true);
 assert(requests.every(x=>!['PUT','PATCH','DELETE'].includes(x.method)));
 assert(requests.every(x=>!x.path.includes('/secrets')&&!x.path.includes('/d1/database')));
 assert(requests.filter(x=>x.path.endsWith('/deployments')).length===2);
});
test('upload refuses missing authorization or mutated live deployment',async()=>{
 const {modules}=fakeBundle();
 await assert.rejects(uploadAcceptanceVersion({fetchImpl:()=>{throw Error('never called');},
  accountId:'not-an-id',token:'short',sourceSha,modules}),/authorization/);
 let count=0;
 const fetchImpl=async(url,options)=>{
  const path=new URL(url).pathname+new URL(url).search;
  let result;
  if(path.endsWith('/settings'))result=settings();
  else if(path.endsWith('/access/apps/'+appId))result=app();
  else if(path.endsWith('/access/apps/'+appId+'/policies'))result=policies();
  else if(path.endsWith('/deployments'))result={deployments:[{id:++count===1?deployed:version}]};
  else if(path.endsWith('/versions?bindings_inherit=strict'))result={id:version};
  else if(path.endsWith('/versions/'+version))result={id:version,annotations:{'workers/commit_sha':sourceSha},resources:{bindings:[...settings().bindings,{name:'CF_VERSION_METADATA',type:'version_metadata'}],script_runtime:{compatibility_date:'2026-10-28',compatibility_flags:['nodejs_compat']}}};
  else throw Error('unexpected');
  return new Response(JSON.stringify({success:true,result}),{status:200});
 };
 await assert.rejects(uploadAcceptanceVersion({fetchImpl,accountId:'b'.repeat(32),
  token:'synthetic-restricted-token',sourceSha,modules}),/deployment changed/);
});
