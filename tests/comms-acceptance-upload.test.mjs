import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {APPROVED_RELEASE,verifyApprovedRelease,verifyReviewCandidate,verifyAcceptanceSettings,verifyOwnerAccess,verifyDatabaseIsolation,
 verifyBindingParity,approvedSourceForMode,buildVersionForm,uploadAcceptanceVersion,buildConnectedAcceptanceCode} from '../tools/comms-acceptance-upload.mjs';

const sha256=s=>createHash('sha256').update(s).digest('hex');
const sourceSha='a'.repeat(40);
const version='a1b2c3d4-1111-4444-8888-0123456789ab';
const deployed='bbbbbbbb-1111-4444-8888-111111111111';
const appId='d75c6407-070e-4b43-8843-0216b166d712';
const origin='https://devon-station-mail-acceptance.devonakins.workers.dev';
const owner='synthetic-owner@example.test';
const worker='devon-station-mail-acceptance';
const d1ids={
 acceptanceDB:'11111111-1111-4111-8111-111111111111',
 acceptanceMail:'22222222-2222-4222-8222-222222222222',
 productionDB:'33333333-3333-4333-8333-333333333333',
 productionMail:'44444444-4444-4444-8444-444444444444'
};
function fakeBundle(){
 const marker=JSON.stringify('"privateDataLoaded":false').slice(1,-1);
 const modules={
  'index.mjs':"import {connect} from 'cloudflare:sockets';\nconst s='"+marker+"';\nexport default createStation(assets,undefined,undefined,connect);\n",
  'worker/mail-api.mjs':"const path='/api/mail/diagnostics/imap-check';",
  'worker/mail-outbox-api.mjs':"import {probePurelymailSent} from '../src/communications/mail-sent-evidence.mjs';",
  'src/communications/mail-sent-evidence.mjs':"export function probePurelymailSent(){return false;}",
  'worker/index.mjs':"const v=env.CF_VERSION_METADATA?.id;"
 };
 for(let i=0;i<39;i++)modules['src/synthetic-'+i+'.mjs']='export const x='+i+';\n';
 const bytes=Buffer.from(JSON.stringify(modules));
 const manifest={schemaVersion:1,status:'REVIEW_ONLY_NOT_DEPLOYED_OR_ACCEPTED',
  sourceCommit:sourceSha,candidate:{sha256:sha256(bytes),moduleCount:44,
   modulesSha256:Object.fromEntries(Object.entries(modules).map(([p,s])=>[p,sha256(s)]))}};
 return {manifest,bytes,modules};
}
function settings(){
 const p=(name,text)=>({name,type:'plain_text',text});
 const bindings=[
  p('ACCESS_AUD','synthetic-audience'),p('ACCESS_ISSUER','https://synthetic-access.example.test'),
  p('ACCESS_JWKS_URL','https://synthetic-access.example.test/certs'),
  p('APP_ORIGIN',origin),{name:'DB',type:'d1',database_id:d1ids.acceptanceDB},
  {name:'MAIL_DB',type:'d1',database_id:d1ids.acceptanceMail},
  p('MAIL_DRAFTS_ENABLED','true'),p('MAIL_ENABLED','false'),
  p('MAIL_IMAP_ADDRESS','hello@devonakins.com'),p('MAIL_OUTBOX_ENABLED','true'),
  p('MAIL_OWNER_SUB','synthetic-subject'),p('MAIL_PAYLOAD_KEY_ID','a'),
  {name:'MAIL_PAYLOAD_KEYS_JSON',type:'secret_text'},p('MAIL_SEND_ENABLED','false'),
  p('MAIL_SENDER_VERIFIED','false'),p('MAIL_SMTP_ADDRESS','hello@devonakins.com'),
  p('OWNER_EMAIL',owner)
 ];
 return {compatibility_date:'2026-10-28',compatibility_flags:['nodejs_compat'],bindings};
}
function productionSettings(){
 const source=settings(),bindings=structuredClone(source.bindings);
 bindings.find(b=>b.name==='DB').database_id=d1ids.productionDB;
 bindings.find(b=>b.name==='MAIL_DB').database_id=d1ids.productionMail;
 return {...source,bindings};
}
const app=()=>({id:appId,type:'self_hosted',domain:new URL(origin).hostname,aud:'synthetic-audience'});
const policies=()=>[{decision:'allow',include:[{email:{email:owner}}],exclude:[],require:[]}];
test('staging review matches exact checked-out SHA, source module hashes, privacy entrypoint and TLS socket import',()=>{
 const {bytes,manifest}=fakeBundle();
 assert.equal(Object.keys(verifyReviewCandidate({manifest,candidateBytes:bytes,expectedSha:sourceSha})).length,44);
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
  {...x,bindings:[...x.bindings,{name:'MAIL_SMTP_PASSWORD',type:'plain_text',text:'DO_NOT_EXPOSE'}]},
  {...x,bindings:[...x.bindings,{name:'EXTRA_USER_TOKEN',type:'unknown_type'}]}
 ])assert.throws(()=>verifyAcceptanceSettings(changed),/refused:/);
});
test('retains existing SMTP secret metadata but never permits enabling outbound mail',()=>{
 const x=settings();
 x.bindings.push({name:'MAIL_SMTP_PASSWORD',type:'secret_text'});
 const safe=verifyAcceptanceSettings(x);
 assert.equal(safe.inherited.length,x.bindings.length);
 assert(safe.inherited.some(b=>b.name==='MAIL_SMTP_PASSWORD'&&b.type==='inherit'));
 const snapshot={...x,bindings:[...structuredClone(x.bindings),{name:'CF_VERSION_METADATA',type:'version_metadata'}]};
 assert.equal(verifyBindingParity(x,snapshot),true);
 for(const flag of ['MAIL_SEND_ENABLED','MAIL_SENDER_VERIFIED']){
  const bad=structuredClone(x);bad.bindings.find(b=>b.name===flag).text='true';
  assert.throws(()=>verifyAcceptanceSettings(bad),/outgoing email must remain disabled/);
 }
 const bad=structuredClone(x);
 bad.bindings.find(b=>b.name==='MAIL_SMTP_PASSWORD').type='plain_text';
 assert.throws(()=>verifyAcceptanceSettings(bad),/unexpected or duplicate acceptance binding/);
 const missing=structuredClone(snapshot);
 missing.bindings=missing.bindings.filter(b=>b.name!=='MAIL_SMTP_PASSWORD');
 assert.throws(()=>verifyBindingParity(x,missing),/binding inventory differs/);
});
test('review candidate rejects a missing Sent module or a broken import even with correct hashes',()=>{
 const {bytes,manifest}=fakeBundle();
 const modules=JSON.parse(bytes);
 delete modules['src/communications/mail-sent-evidence.mjs'];
 modules['src/legacy-placeholder.mjs']='export const unrelated=true;';
 const badBytes=Buffer.from(JSON.stringify(modules));
 const badManifest={...manifest,candidate:{sha256:sha256(badBytes),moduleCount:44,
  modulesSha256:Object.fromEntries(Object.entries(modules).map(([p,s])=>[p,sha256(s)]))}};
 assert.throws(()=>verifyReviewCandidate({manifest:badManifest,candidateBytes:badBytes,expectedSha:sourceSha}),/module inventory/);
 const disconnected=JSON.parse(bytes);
 disconnected['worker/mail-outbox-api.mjs']='// missing required import';
 const noImportBytes=Buffer.from(JSON.stringify(disconnected));
 const noImportManifest={...manifest,candidate:{sha256:sha256(noImportBytes),moduleCount:44,
  modulesSha256:Object.fromEntries(Object.entries(disconnected).map(([p,s])=>[p,sha256(s)]))}};
 assert.throws(()=>verifyReviewCandidate({manifest:noImportManifest,candidateBytes:noImportBytes,expectedSha:sourceSha}),/missing reviewed TLS/);
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
 assert.equal([...form.keys()].length,45);
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
  if(path.endsWith('/workers/scripts/devon-station/settings'))result=productionSettings();
  else if(path.endsWith('/settings'))result=settings();
  else if(path.endsWith('/access/apps/'+appId))result=app();
  else if(path.endsWith('/access/apps/'+appId+'/policies'))result=policies();
  else if(path.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
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
 assert.equal(requests.filter(x=>x.path.endsWith('/workers/scripts/devon-station/settings')).length,1);
 assert(requests.filter(x=>x.path.endsWith('/deployments')).length===4);
});
test('upload refuses missing authorization or mutated live deployment',async()=>{
 const {modules}=fakeBundle();
 await assert.rejects(uploadAcceptanceVersion({fetchImpl:()=>{throw Error('never called');},
  accountId:'not-an-id',token:'short',sourceSha,modules}),/authorization/);
 let count=0;
 const fetchImpl=async(url,options)=>{
  const path=new URL(url).pathname+new URL(url).search;
  let result;
  if(path.endsWith('/workers/scripts/devon-station/settings'))result=productionSettings();
  else if(path.endsWith('/settings'))result=settings();
  else if(path.endsWith('/access/apps/'+appId))result=app();
  else if(path.endsWith('/access/apps/'+appId+'/policies'))result=policies();
  else if(path.endsWith('/workers/scripts/devon-station/deployments'))result={deployments:[{id:deployed}]};
  else if(path.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
  else if(path.endsWith('/deployments'))result={deployments:[{id:++count===1?deployed:version}]};
  else if(path.endsWith('/versions?bindings_inherit=strict'))result={id:version};
  else if(path.endsWith('/versions/'+version))result={id:version,annotations:{'workers/commit_sha':sourceSha},resources:{bindings:[...settings().bindings,{name:'CF_VERSION_METADATA',type:'version_metadata'}],script_runtime:{compatibility_date:'2026-10-28',compatibility_flags:['nodejs_compat']}}};
  else throw Error('unexpected');
  return new Response(JSON.stringify({success:true,result}),{status:200});
 };
 await assert.rejects(uploadAcceptanceVersion({fetchImpl,accountId:'b'.repeat(32),
  token:'synthetic-restricted-token',sourceSha,modules}),/deployment changed/);
});

test('acceptance storage isolation proves all four D1 resources are distinct and unchanged after upload',()=>{
 const a=settings(),p=productionSettings();
 assert.equal(verifyDatabaseIsolation(a,p),true);
 assert.equal(verifyDatabaseIsolation(a,p,structuredClone(a)),true);
 const overlap=structuredClone(a);
 overlap.bindings.find(b=>b.name==='MAIL_DB').database_id=d1ids.productionDB;
 assert.throws(()=>verifyDatabaseIsolation(overlap,p),/storage overlaps production/);
 const duplicate=structuredClone(a);
 duplicate.bindings.find(b=>b.name==='MAIL_DB').database_id=d1ids.acceptanceDB;
 assert.throws(()=>verifyDatabaseIsolation(duplicate,p),/duplicates mail storage/);
 const changed=structuredClone(a);
 changed.bindings.find(b=>b.name==='DB').database_id=d1ids.productionMail;
 assert.throws(()=>verifyDatabaseIsolation(a,p,changed),/uploaded version D1 database changed/);
 const malformed=structuredClone(p);
 malformed.bindings.find(b=>b.name==='DB').database_id='not-a-uuid';
 assert.throws(()=>verifyDatabaseIsolation(a,malformed),/invalid D1 resource identity/);
});
test('uploaded runtime must preserve every inherited binding including owner, flags, addresses and D1',()=>{
 const initial=settings(),uploaded={...settings(),bindings:[...settings().bindings,{name:'CF_VERSION_METADATA',type:'version_metadata'}]};
 assert.equal(verifyBindingParity(initial,uploaded),true);
 for(const [name,newValue] of [['OWNER_EMAIL','other@example.test'],['MAIL_IMAP_ADDRESS','other@example.test'],['ACCESS_AUD','attacker-aud'],['MAIL_SEND_ENABLED','true']]){
  const changed=structuredClone(uploaded);changed.bindings.find(b=>b.name===name).text=newValue;
  assert.throws(()=>verifyBindingParity(initial,changed),/plain-text configuration changed/);
 }
 const secretChanged=structuredClone(uploaded);
 secretChanged.bindings.find(b=>b.name==='MAIL_PAYLOAD_KEYS_JSON').type='plain_text';
 assert.throws(()=>verifyBindingParity(initial,secretChanged),/binding type changed/);
 const dropped=structuredClone(uploaded);
 dropped.bindings=dropped.bindings.filter(b=>b.name!=='MAIL_DB');
 assert.throws(()=>verifyBindingParity(initial,dropped),/binding inventory differs/);
});
test('owner Access audience must match the configured Worker audience',()=>{
 assert.equal(verifyOwnerAccess(app(),policies(),owner,'synthetic-audience'),true);
 assert.throws(()=>verifyOwnerAccess(app(),policies(),owner,'unrelated-audience'),/audience differs/);
 assert.throws(()=>verifyOwnerAccess({...app(),aud:null},policies(),owner,'synthetic-audience'),/audience differs/);
});

test('privileged upload runner must use a separately approved candidate SHA and a trusted checkout',()=>{
 const current='b'.repeat(40),trusted='c'.repeat(40);
 assert.equal(approvedSourceForMode({mode:'--verify',checkoutSha:sourceSha,manifestSha:sourceSha}),sourceSha);
 assert.throws(()=>approvedSourceForMode({mode:'--verify',checkoutSha:current,manifestSha:sourceSha}),/not from this checkout/);
 const ok={mode:'--upload',checkoutSha:trusted,manifestSha:sourceSha,approvedSha:sourceSha,trustedUploaderSha:trusted};
 assert.equal(approvedSourceForMode(ok),sourceSha);
 assert.throws(()=>approvedSourceForMode({...ok,approvedSha:current}),/candidate SHA/);
 assert.throws(()=>approvedSourceForMode({...ok,trustedUploaderSha:current}),/trusted checkout/);
 assert.throws(()=>approvedSourceForMode({...ok,checkoutSha:'invalid'}),/invalid local checkout/);
 assert.throws(()=>approvedSourceForMode({...ok,mode:'--unsafe'}),/unknown acceptance execution mode/);
});

test('manual staging workflow never grants Cloudflare secrets to untrusted candidate build',()=>{
 const file=readFileSync(new URL('../.github/workflows/mail-acceptance-version-only.yml',import.meta.url),'utf8');
 const [review,upload]=file.split('  upload-version-only:');
 assert(review&&upload,'both review and upload jobs must exist');
 assert.match(review,/on:\s*\n  workflow_dispatch:/);
 assert.doesNotMatch(file,/^\s+(push|pull_request|schedule):/m);
 assert.match(file,/cancel-in-progress: false/);
 assert.match(review,/github\.ref == 'refs\/heads\/main'/);
 assert.match(review,/UPLOAD_VERSION_ONLY_NO_DEPLOY/);
 assert.match(review,/ref: \$\{\{ inputs\.source_sha \}\}/);
 assert.match(review,/node tools\/comms-acceptance-upload\.mjs --verify/);
 assert.doesNotMatch(review,/secrets\./);
 assert.match(upload,/environment:\s*\n\s+name: ds011-mail-acceptance/);
 assert.match(upload,/ref: \$\{\{ github\.workflow_sha \}\}/);
 assert.match(upload,/DS011_TRUSTED_UPLOADER_SHA: \$\{\{ github\.workflow_sha \}\}/);
 assert.match(upload,/DS011_MAIL_ACCEPTANCE_STAGE_ENABLED/);
 assert.match(upload,/DS011_CF_ACCEPTANCE_TOKEN/);
 assert.match(upload,/DS011_CF_ACCOUNT_ID/);
 assert.match(upload,/node tools\/comms-acceptance-upload\.mjs --verify-approved/);
 assert.doesNotMatch(upload,/sha256sum -c SHA256SUMS/);
 assert.match(upload,/gh api/);
 assert.match(upload,/node tools\/comms-acceptance-upload\.mjs --upload/);
 assert.doesNotMatch(upload,/npm ci|npm run build|node tools\/prepare-rb01-review/);
});

function connectedHarness(operation='PREFLIGHT_ONLY',alter=()=>{}){
 const {manifest,bytes,modules}=fakeBundle();
 const args={manifest,candidateBytes:bytes,expectedSha:sourceSha,
  expectedCandidateSha256:sha256(bytes),accountId:'b'.repeat(32),operation};
 const calls=[];
 const cloudflare={request:async options=>{
  calls.push(options);
  const path=options.path;
  let result;
  if(path.endsWith('/workers/scripts/devon-station/settings'))result=productionSettings();
  else if(path.endsWith('/settings'))result=settings();
  else if(path.endsWith('/access/apps/'+appId))result=app();
  else if(path.endsWith('/access/apps/'+appId+'/policies'))result=policies();
  else if(path.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
  else if(path.endsWith('/deployments'))result={deployments:[{id:deployed}]};
  else if(path.endsWith('/versions')&&options.method==='POST')result={id:version};
  else if(path.endsWith('/versions/'+version))result={id:version,annotations:{'workers/commit_sha':sourceSha},
   resources:{bindings:[...settings().bindings,{name:'CF_VERSION_METADATA',type:'version_metadata'}],
    script_runtime:{compatibility_date:'2026-10-28',compatibility_flags:['nodejs_compat']}}};
  else throw Error('unallowlisted API reached '+path);
  alter(options,result);
  return {success:true,result};
 }};
 const run=code=>vm.runInNewContext('('+code+')',{
  cloudflare,accountId:args.accountId,crypto:globalThis.crypto,TextEncoder,FormData,Blob,URL
 })();
 return {args,calls,run,modules};
}
test('connected preflight rehashes data, inspects boundaries and makes no mutations',async()=>{
 const h=connectedHarness();
 const code=buildConnectedAcceptanceCode(h.args);
 const result=await h.run(code);
 assert.equal(result.status,'CONNECTED_PREFLIGHT_VERIFIED_NO_UPLOAD');
 assert.equal(result.candidateSha256,h.args.expectedCandidateSha256);
 assert.equal(h.calls.length,7);
 assert(h.calls.every(c=>c.method==='GET'));
 assert.doesNotMatch(code,/Bearer |CLOUDFLARE_API_TOKEN|eval\(/);
});
test('connected version-only upload preserves exact multipart module bytes and strict binding inheritance',async()=>{
 const h=connectedHarness('UPLOAD_VERSION_ONLY_NO_DEPLOY');
 const result=await h.run(buildConnectedAcceptanceCode(h.args));
 assert.equal(result.status,'VERSION_UPLOADED_NOT_DEPLOYED');
 assert.equal(result.trafficUnchanged,true);
 const writes=h.calls.filter(c=>c.method!=='GET');
 assert.equal(writes.length,1);
 const upload=writes[0];
 assert(upload.path.endsWith('/workers/scripts/'+worker+'/versions'));
 assert.equal(upload.query.bindings_inherit,'strict');
 assert.equal(upload.rawBody,true);
 const form=await new Response(upload.body,{headers:{'content-type':upload.contentType}}).formData();
 assert.equal([...form.keys()].length,45);
 for(const [name,source] of Object.entries(h.modules))assert.equal(await form.get(name).text(),source);
 const metadata=JSON.parse(await form.get('metadata').text());
 assert.equal(metadata.annotations['workers/commit_sha'],sourceSha);
 assert(metadata.bindings.every(b=>['inherit','version_metadata'].includes(b.type)));
});
test('connected candidate corruption, wrong account, digest and approval fail before provider calls',async()=>{
 for(const mutate of [
  code=>code.replace('export const x=38;','export const x=37;'),
  code=>code.replace('const approvedAccount="'+'b'.repeat(32)+'"','const approvedAccount="'+'c'.repeat(32)+'"')
 ]){
  const h=connectedHarness();
  await assert.rejects(h.run(mutate(buildConnectedAcceptanceCode(h.args))),/checksum|account differs/);
  assert.equal(h.calls.length,0);
 }
 const h=connectedHarness();
 assert.throws(()=>buildConnectedAcceptanceCode({...h.args,expectedCandidateSha256:'0'.repeat(64)}),/pinned artifact/);
 assert.throws(()=>buildConnectedAcceptanceCode({...h.args,expectedSha:'c'.repeat(40)}),/source SHA/);
 assert.throws(()=>buildConnectedAcceptanceCode({...h.args,operation:'DEPLOY'}),/explicit connected execution/);
});
test('connected path refuses unsafe Access, overlapping storage and send configuration before upload',async()=>{
 for(const alter of [
  (o,r)=>{if(o.path.endsWith('/settings'))r.bindings.find(b=>b.name==='MAIL_SEND_ENABLED').text='true';},
  (o,r)=>{if(o.path.endsWith('/policies'))r[0].include=[{everyone:{}}];},
  (o,r)=>{if(o.path.endsWith('/workers/scripts/devon-station/settings'))r.bindings.find(b=>b.name==='DB').database_id=d1ids.acceptanceDB;}
 ]){
  const h=connectedHarness('UPLOAD_VERSION_ONLY_NO_DEPLOY',alter);
  await assert.rejects(h.run(buildConnectedAcceptanceCode(h.args)),/refused/);
  assert(h.calls.every(c=>c.method==='GET'));
 }
});
test('connected post-upload failure never deploys or retries the version',async()=>{
 const h=connectedHarness('UPLOAD_VERSION_ONLY_NO_DEPLOY',(o,r)=>{
  if(o.path.endsWith('/versions/'+version))r.annotations['workers/commit_sha']='c'.repeat(40);
 });
 await assert.rejects(h.run(buildConnectedAcceptanceCode(h.args)),/provenance/);
 assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
 assert(h.calls.every(c=>c.method==='GET'||c.path.endsWith('/versions')));
});

test('acceptance preflight rejects typed configuration and conflicting D1 identifiers',()=>{
 const typed=settings();typed.bindings.find(b=>b.name==='ACCESS_ISSUER').type='secret_text';
 assert.throws(()=>verifyAcceptanceSettings(typed),/plain-text configuration/);
 const flag=settings();flag.bindings.find(b=>b.name==='MAIL_OUTBOX_ENABLED').text='sometimes';
 assert.throws(()=>verifyAcceptanceSettings(flag),/feature flag/);
 const conflict=settings();conflict.bindings.find(b=>b.name==='DB').id=d1ids.productionDB;
 assert.throws(()=>verifyDatabaseIsolation(conflict,productionSettings()),/conflicting D1/);
});
test('connected executor refuses enabled preview URLs and invalid provider results without upload',async()=>{
 const h=connectedHarness('UPLOAD_VERSION_ONLY_NO_DEPLOY',(o,r)=>{
  if(o.path.endsWith('/subdomain'))r.previews_enabled=true;
 });
 await assert.rejects(h.run(buildConnectedAcceptanceCode(h.args)),/preview URLs/);
 assert(h.calls.every(c=>c.method==='GET'));
});
test('candidate source remains inert data in the connected executor',async()=>{
 const h=connectedHarness();
 const modules=JSON.parse(h.args.candidateBytes);
 modules['src/synthetic-38.mjs']='"; globalThis.candidateExecuted=true; throw Error("candidate code executed"); //';
 const bytes=Buffer.from(JSON.stringify(modules));
 const manifest={...h.args.manifest,candidate:{sha256:sha256(bytes),moduleCount:44,
  modulesSha256:Object.fromEntries(Object.entries(modules).map(([p,s])=>[p,sha256(s)]))}};
 const code=buildConnectedAcceptanceCode({...h.args,manifest,candidateBytes:bytes,expectedCandidateSha256:sha256(bytes)});
 const result=await h.run(code);
 assert.equal(result.status,'CONNECTED_PREFLIGHT_VERIFIED_NO_UPLOAD');
});


test('privileged release gate refuses self-consistent forged bytes labeled with the approved SHA',()=>{
 const {manifest,bytes}=fakeBundle();
 // All per-module and candidate checksums are internally valid; only the
 // independently reviewed digest distinguishes this forgery from approved bytes.
 const forged={...manifest,sourceCommit:APPROVED_RELEASE.sourceCommit};
 assert.equal(Object.keys(verifyReviewCandidate({manifest:forged,candidateBytes:bytes,
  expectedSha:APPROVED_RELEASE.sourceCommit})).length,44);
 assert.throws(()=>verifyApprovedRelease({manifest:forged,candidateBytes:bytes,
  expectedSha:APPROVED_RELEASE.sourceCommit}),/independently approved candidate digest/);
 assert.throws(()=>verifyApprovedRelease({manifest,candidateBytes:bytes,
  expectedSha:sourceSha}),/immutable owner-approved source SHA/);
 assert.throws(()=>verifyApprovedRelease({manifest:forged,candidateBytes:bytes,
  expectedSha:'b'.repeat(40)}),/immutable owner-approved source SHA/);
});

test('manual privileged workflow pins every external action to immutable source and limits approved SHA',()=>{
 for(const path of ['mail-acceptance-version-only.yml','mail-acceptance-uploader-review.yml']){
  const file=readFileSync(new URL('../.github/workflows/'+path,import.meta.url),'utf8');
  const actions=[...file.matchAll(/uses: (actions\/[a-z-]+)@([^\s]+)/g)];
  assert(actions.length>0);
  for(const [,name,ref] of actions)assert.match(ref,/^[a-f0-9]{40}$/,name+' must be immutable');
 }
 const file=readFileSync(new URL('../.github/workflows/mail-acceptance-version-only.yml',import.meta.url),'utf8');
 assert(file.includes(`test "$EXPECTED_SHA" = '${APPROVED_RELEASE.sourceCommit}'`));
 assert(file.includes(`test "$APPROVED_SHA" = '${APPROVED_RELEASE.sourceCommit}'`));
 assert(file.indexOf('--verify-approved')<file.indexOf('secrets.DS011_CF_ACCEPTANCE_TOKEN'));
});


test('actual privileged CLI rejects forged release bytes before credentials or provider transport',t=>{
 const root=mkdtempSync(join(tmpdir(),'ds-trusted-uploader-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'tools'));mkdirSync(join(root,'release-review'));
 writeFileSync(join(root,'tools/comms-acceptance-upload.mjs'),
  readFileSync(new URL('../tools/comms-acceptance-upload.mjs',import.meta.url)));
 const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init','--quiet']);git(['add','tools']);
 git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.test','commit','--quiet','-m','Synthetic trusted source']);
 const {manifest,bytes}=fakeBundle();
 writeFileSync(join(root,'release-review/manifest.json'),JSON.stringify({...manifest,sourceCommit:APPROVED_RELEASE.sourceCommit}));
 writeFileSync(join(root,'release-review/candidate.modules.json'),bytes);
 const run=spawnSync(process.execPath,['tools/comms-acceptance-upload.mjs','--upload'],{
  cwd:root,encoding:'utf8',env:{PATH:process.env.PATH,
   DS011_TRUSTED_UPLOADER_SHA:git(['rev-parse','HEAD']),
   DS011_APPROVED_SOURCE_SHA:APPROVED_RELEASE.sourceCommit,
   DS011_ALLOW_ACCEPTANCE_UPLOAD:'true'}});
 assert.equal(run.status,1);
 assert.match(run.stderr,/independently approved candidate digest/);
 assert.equal(run.stdout,'');
 assert.doesNotMatch(run.stderr,/missing exact upload authorization|Cloudflare/);
});


test('next-candidate workflow targets PR 44 and preserves the prior inactive version source',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/mail-acceptance-version-only.yml',import.meta.url),'utf8');
 assert.match(workflow,/pulls\/44/);assert.doesNotMatch(workflow,/pulls\/36/);
 const prior='bba373f35f3cc913447e72fcdfff589cd6f3a073';
 const {manifest,bytes}=fakeBundle();
 assert.throws(()=>verifyApprovedRelease({manifest:{...manifest,sourceCommit:prior},candidateBytes:bytes,expectedSha:prior}),/immutable owner-approved source SHA/);
 const readback=readFileSync(new URL('../tools/comms-acceptance-readback.mjs',import.meta.url),'utf8');
 assert(readback.includes("sourceCommit:'"+prior+"'"));
 assert(!readback.includes('sourceCommit:APPROVED_RELEASE.sourceCommit'));
});
