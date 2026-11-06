// DS011: manual, guarded upload of a SHA-pinned Communications acceptance version.
// It NEVER calls Cloudflare's deployment, secret, DNS, database, or policy mutation APIs.
// No remote action happens unless --upload and a matching explicit SHA approval are supplied.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Proposed next immutable release pin, pending explicit owner authorization.
// This draft source change is not permission to upload, activate, migrate or send.
export const APPROVED_RELEASE=Object.freeze({
 sourceCommit:'be6644f58297dedfcd1c1d60ec2aef17e64b0f35',
 candidateSha256:'07491e2aa5aa9dab75d8a1ce211645c70d367011310e481e4febd811bc764aa1'
});
const WORKER='devon-station-mail-acceptance';
const PRODUCTION_WORKER='devon-station';
const ORIGIN='https://devon-station-mail-acceptance.devonakins.workers.dev';
const APP='d75c6407-070e-4b43-8843-0216b166d712';
const SHA=/^[0-9a-f]{40}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256=value=>createHash('sha256').update(value).digest('hex');
const refuse=reason=>{throw new Error('DS011 acceptance refused: '+reason);};
const knownNames=['ACCESS_AUD','ACCESS_ISSUER','ACCESS_JWKS_URL','APP_ORIGIN','DB','MAIL_DB',
 'MAIL_DRAFTS_ENABLED','MAIL_ENABLED','MAIL_IMAP_ADDRESS','MAIL_OUTBOX_ENABLED',
 'MAIL_OWNER_SUB','MAIL_PAYLOAD_KEY_ID','MAIL_PAYLOAD_KEYS_JSON',
 'MAIL_SEND_ENABLED','MAIL_SENDER_VERIFIED','MAIL_SMTP_ADDRESS','OWNER_EMAIL'];

export function verifyReviewCandidate({manifest,candidateBytes,expectedSha}){
 if(!manifest||manifest.schemaVersion!==1||manifest.status!=='REVIEW_ONLY_NOT_DEPLOYED_OR_ACCEPTED')
  refuse('untrusted review manifest');
 if(!SHA.test(expectedSha)||manifest.sourceCommit!==expectedSha)refuse('source SHA mismatch');
 const bytes=Buffer.isBuffer(candidateBytes)?candidateBytes:Buffer.from(candidateBytes);
 if(sha256(bytes)!==manifest.candidate?.sha256)refuse('candidate bytes differ from pinned checksum');
 let modules;
 try{modules=JSON.parse(bytes.toString('utf8'));}catch{refuse('invalid module JSON');}
 const names=Object.keys(modules);
 if(names.length!==manifest.candidate.moduleCount||names.length!==44 ||
    names.some(p=>!/^([a-z0-9.-]+\/)*[a-z0-9.-]+\.mjs$/.test(p)) ||
    !Object.hasOwn(modules,'index.mjs')||!Object.hasOwn(modules,'worker/mail-api.mjs')||
    !Object.hasOwn(modules,'worker/mail-outbox-api.mjs')||
    !Object.hasOwn(modules,'src/communications/mail-sent-evidence.mjs'))
  refuse('module inventory differs from reviewed build');
 if(names.some(p=>typeof modules[p]!=='string'||
     sha256(modules[p])!==manifest.candidate.modulesSha256?.[p])||
    Object.keys(manifest.candidate.modulesSha256||{}).length!==names.length)
  refuse('module digest differs from reviewed build');
 const entry=modules['index.mjs'];
 if(!entry.startsWith("import {connect} from 'cloudflare:sockets';\n")||
    !entry.includes("export default createStation(assets,undefined,undefined,connect);")||
    !entry.includes(JSON.stringify('"privateDataLoaded":false').slice(1,-1))||
    !modules['worker/mail-api.mjs'].includes('/api/mail/diagnostics/imap-check')||
    !modules['worker/mail-outbox-api.mjs'].includes("from '../src/communications/mail-sent-evidence.mjs'")||
    !modules['src/communications/mail-sent-evidence.mjs'].includes('probePurelymailSent')||
    !modules['worker/index.mjs'].includes('CF_VERSION_METADATA'))
  refuse('missing reviewed TLS, privacy, diagnostics or version entrypoint');
 return Object.freeze(modules);
}

// Self-consistent candidate manifests establish integrity, not trusted provenance.
// This privileged boundary uses pins in the reviewed uploader, never artifact input.
export function verifyApprovedRelease({manifest,candidateBytes,expectedSha}){
 if(expectedSha!==APPROVED_RELEASE.sourceCommit||manifest?.sourceCommit!==APPROVED_RELEASE.sourceCommit)
  refuse('release is outside the immutable owner-approved source SHA');
 const bytes=Buffer.from(candidateBytes);
 if(sha256(bytes)!==APPROVED_RELEASE.candidateSha256)
  refuse('release bytes differ from the independently approved candidate digest');
 return verifyReviewCandidate({manifest,candidateBytes:bytes,expectedSha});
}

export function verifyAcceptanceSettings(settings){
 if(!settings||!Array.isArray(settings.bindings)||
    settings.compatibility_date!=='2026-10-28'||
    !settings.compatibility_flags?.includes('nodejs_compat'))
  refuse('acceptance Worker runtime differs from reviewed runtime');
 const bindings=new Map();
 for(const b of settings.bindings){
  if(!b?.name||bindings.has(b.name)||
     ![...knownNames,'MAIL_IMAP_PASSWORD','MAIL_SMTP_PASSWORD','CF_VERSION_METADATA'].includes(b.name)||
     (['MAIL_IMAP_PASSWORD','MAIL_SMTP_PASSWORD'].includes(b.name)&&b.type!=='secret_text')||
     (b.name==='CF_VERSION_METADATA'&&b.type!=='version_metadata')||
     !['plain_text','d1','secret_text','version_metadata'].includes(b.type))
   refuse('unexpected or duplicate acceptance binding');
  bindings.set(b.name,b);
 }
 if(knownNames.some(n=>!bindings.has(n)))refuse('required acceptance binding absent');
 for(const name of knownNames.filter(n=>!['DB','MAIL_DB','MAIL_PAYLOAD_KEYS_JSON'].includes(n)))
  if(bindings.get(name).type!=='plain_text')refuse('wrong plain-text configuration binding type');
 for(const name of ['MAIL_DRAFTS_ENABLED','MAIL_ENABLED','MAIL_OUTBOX_ENABLED'])
  if(!['true','false'].includes(bindings.get(name).text))refuse('invalid acceptance feature flag');
 for(const name of ['DB','MAIL_DB'])if(bindings.get(name).type!=='d1')
  refuse('wrong D1 binding type');
 if(bindings.get('MAIL_PAYLOAD_KEYS_JSON').type!=='secret_text')
  refuse('encryption secret binding absent');
 for(const name of ['MAIL_SEND_ENABLED','MAIL_SENDER_VERIFIED']){
  if(bindings.get(name)?.type!=='plain_text'||bindings.get(name).text!=='false')
   refuse('outgoing email must remain disabled');
 }
 if(bindings.get('APP_ORIGIN')?.text!==ORIGIN)refuse('acceptance APP_ORIGIN mismatch');
 for(const [name,expected] of [['MAIL_IMAP_ADDRESS','hello@devonakins.com'],
   ['MAIL_SMTP_ADDRESS','hello@devonakins.com']]){
  if(bindings.get(name)?.type!=='plain_text'||bindings.get(name)?.text!==expected)
   refuse('unexpected mail address binding');
 }
 if(typeof bindings.get('ACCESS_AUD')?.text!=='string'||!bindings.get('ACCESS_AUD').text||
    typeof bindings.get('MAIL_OWNER_SUB')?.text!=='string'||!bindings.get('MAIL_OWNER_SUB').text)
  refuse('missing signed owner identity configuration');
 // A previously provisioned SMTP password may remain bound, but the
 // independent send and sender-verification flags must both remain false.
 // Never read, return, or re-provision the secret during staging.
 if(bindings.get('MAIL_ENABLED')?.text!=='false'&&bindings.get('MAIL_ENABLED')?.text!=='true')
  refuse('invalid IMAP feature flag');
 const owner=bindings.get('OWNER_EMAIL')?.text;
 if(typeof owner!=='string'||!owner.includes('@'))refuse('owner identity binding absent');
 const inherited=[...bindings.values()].filter(b=>b.type!=='version_metadata')
  .map(b=>({name:b.name,type:'inherit'})).sort((a,b)=>a.name.localeCompare(b.name));
 return {owner,inherited,bindingCount:bindings.size};
}

// Never permit staging to inherit either production D1 database, or to change
// its own two isolated databases between preflight and uploaded-version readback.
function d1Binding(settings,name){
 const binding=settings?.bindings?.find(b=>b.name===name);
 const id=binding?.database_id??binding?.id;
 if(binding?.type!=='d1'||typeof id!=='string'||!UUID.test(id))
  refuse('missing or invalid D1 resource identity');
 if(binding.id&&binding.database_id&&binding.id!==binding.database_id)
  refuse('conflicting D1 resource identities');
 return id;
}
export function verifyDatabaseIsolation(acceptance,production,uploaded=null){
 const candidateIds=['DB','MAIL_DB'].map(n=>d1Binding(acceptance,n));
 const productionIds=['DB','MAIL_DB'].map(n=>d1Binding(production,n));
 if(new Set([...candidateIds,...productionIds]).size!==4)
  refuse('acceptance storage overlaps production or duplicates mail storage');
 if(uploaded){
  if(['DB','MAIL_DB'].some((n,i)=>d1Binding(uploaded,n)!==candidateIds[i]))
   refuse('uploaded version D1 database changed after preflight');
 }
 return true;
}
// Verify every inherited binding is exactly the reviewed runtime resource
// (without reading or comparing secret values); only version metadata is added.
export function verifyBindingParity(initial,uploaded){
 const current=new Map(initial?.bindings?.map(b=>[b.name,b])||[]);
 const actual=new Map(uploaded?.bindings?.map(b=>[b.name,b])||[]);
 if(current.size!==initial?.bindings?.length||actual.size!==uploaded?.bindings?.length||
   actual.size!==current.size+(current.has('CF_VERSION_METADATA')?0:1)||
   actual.get('CF_VERSION_METADATA')?.type!=='version_metadata')
  refuse('uploaded binding inventory differs from reviewed configuration');
 for(const [name,a] of current){
  const b=actual.get(name);
  if(!b||a.type!==b.type)refuse('uploaded binding type changed');
  if(a.type==='plain_text'&&a.text!==b.text)refuse('uploaded plain-text configuration changed');
  if(a.type==='d1'&&d1Binding(initial,name)!==d1Binding(uploaded,name))
   refuse('uploaded D1 binding changed');
 }
 return true;
}
export function verifyOwnerAccess(app,policies,owner,audience=null){
 if(!app||app.id!==APP||app.type!=='self_hosted'||app.domain!==new URL(ORIGIN).hostname||
    !Array.isArray(policies)||policies.length!==1)
  refuse('unexpected owner Access app or policy count');
 if(audience!==null&&(!audience||app.aud!==audience))
  refuse('Cloudflare Access audience differs from Worker binding');
 const p=policies[0];
 if(p.decision!=='allow'||!Array.isArray(p.include)||p.include.length!==1||
    p.include[0]?.email?.email!==owner||(p.exclude||[]).length||(p.require||[]).length)
  refuse('acceptance Access policy must allow only the configured owner email');
 return true;
}

export function buildVersionForm(modules,sourceSha,inherited){
 if(!SHA.test(sourceSha)||!Array.isArray(inherited)||!inherited.length)refuse('missing release inputs');
 const metadata={
  main_module:'index.mjs',
  compatibility_date:'2026-10-28',
  compatibility_flags:['nodejs_compat'],
  bindings:[...inherited,{type:'version_metadata',name:'CF_VERSION_METADATA'}],
  annotations:{'workers/commit_sha':sourceSha,
   'workers/repository_url':'https://github.com/devonalanakins/devon-station',
   'workers/pull_request_number':'44',
   'workers/message':'DS011 Communications acceptance only; never deploy or enable sending automatically'}
 };
 const form=new FormData();
 form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}),'metadata.json');
 for(const [name,source] of Object.entries(modules))
  form.append(name,new Blob([source],{type:'application/javascript+module'}),name);
 return {form,metadata};
}

const apiBase='https://api.cloudflare.com/client/v4';
async function cloudflareCall(fetchImpl,token,path,{method='GET',body}={}){
 let response;
 try{response=await fetchImpl(apiBase+path,{method,headers:{
   Authorization:'Bearer '+token,Accept:'application/json'},...(body?{body}:{})});}
 catch{refuse('Cloudflare API request unavailable');}
 if(!response.ok)refuse('Cloudflare returned an unsuccessful status');
 let data;
 try{data=await response.json();}catch{refuse('Cloudflare returned invalid JSON');}
 if(data?.success!==true||!data.result)refuse('Cloudflare API did not confirm success');
 return data.result;
}

export async function uploadAcceptanceVersion({fetchImpl=fetch,token,accountId,sourceSha,modules}){
 if(typeof token!=='string'||token.length<12||!(/^[a-f0-9]{32}$/i.test(accountId))||
    !SHA.test(sourceSha)||!modules)refuse('missing exact upload authorization');
 return uploadAcceptanceVersionWithRequest({
  request:(path,options)=>cloudflareCall(fetchImpl,token,path,options),accountId,sourceSha,modules
 });
}

// Shared orchestration: callers supply only a bounded API transport. The connected
// executor uses its existing authorization; no credential is moved into this process.
export async function preflightAcceptance(request,accountId){
 if(typeof request!=='function'||!(/^[a-f0-9]{32}$/.test(accountId)))
  refuse('invalid connected account or transport');
 const prefix='/accounts/'+accountId;
 const work=prefix+'/workers/scripts/'+WORKER;
 const settings=await request(work+'/settings');
 const checked=verifyAcceptanceSettings(settings);
 const app=await request(prefix+'/access/apps/'+APP);
 const ps=await request(prefix+'/access/apps/'+APP+'/policies');
 verifyOwnerAccess(app,Array.isArray(ps)?ps:ps.items||[],checked.owner,
  settings.bindings.find(b=>b.name==='ACCESS_AUD')?.text);
 const production=await request(
  prefix+'/workers/scripts/'+PRODUCTION_WORKER+'/settings');
 verifyDatabaseIsolation(settings,production);
 const before=await request(work+'/deployments');
 const liveId=before?.deployments?.[0]?.id;
 if(!UUID.test(liveId||''))refuse('could not anchor existing acceptance deployment');
 const productionDeployment=await request(prefix+'/workers/scripts/'+PRODUCTION_WORKER+'/deployments');
 const productionId=productionDeployment?.deployments?.[0]?.id;
 if(!UUID.test(productionId||''))refuse('could not anchor production deployment');
 const subdomain=await request(work+'/subdomain');
 if(subdomain?.enabled!==true||subdomain.previews_enabled!==false)
  refuse('acceptance preview URLs must remain disabled');
 return {work,settings,production,checked,liveId,productionId};
}
export async function uploadAcceptanceVersionWithRequest({request,accountId,sourceSha,modules}){
 if(!SHA.test(sourceSha)||!modules)refuse('missing exact upload inputs');
 const {work,settings,production,checked,liveId,productionId}=await preflightAcceptance(request,accountId);
 const {form}=buildVersionForm(modules,sourceSha,checked.inherited);
 const uploaded=await request(work+'/versions?bindings_inherit=strict',
  {method:'POST',body:form});
 if(!UUID.test(uploaded?.id||''))refuse('no immutable Cloudflare version ID returned');
 const version=await request(work+'/versions/'+uploaded.id);
 if(version.id!==uploaded.id||version?.annotations?.['workers/commit_sha']!==sourceSha)
  refuse('uploaded version provenance readback did not match');
 const resources=version?.resources;
 if(!resources?.bindings||!resources.script_runtime||
    !resources.bindings.some(b=>b.name==='CF_VERSION_METADATA'&&b.type==='version_metadata'))
  refuse('uploaded version omitted required runtime or version metadata binding');
 const confirmed=verifyAcceptanceSettings({
  bindings:resources.bindings,
  compatibility_date:resources.script_runtime.compatibility_date,
  compatibility_flags:resources.script_runtime.compatibility_flags
 });
 if(confirmed.owner!==checked.owner)
  refuse('uploaded version has changed owner authorization');
 verifyDatabaseIsolation(settings,production,resources);
 verifyBindingParity(settings,resources);
 const subdomain=await request(work+'/subdomain');
 if(subdomain?.enabled!==true||subdomain.previews_enabled!==false)
  refuse('acceptance preview configuration changed during upload');
 const productionAfter=await request('/accounts/'+accountId+'/workers/scripts/'+PRODUCTION_WORKER+'/deployments');
 if(productionAfter?.deployments?.[0]?.id!==productionId)
  refuse('production deployment changed during upload; manual review required');
 const after=await request(work+'/deployments');
 if(after?.deployments?.[0]?.id!==liveId)refuse('deployment changed during upload; manual review required');
 return {status:'VERSION_UPLOADED_NOT_DEPLOYED',versionId:uploaded.id,
  sourceCommit:sourceSha,existingDeploymentId:liveId,trafficUnchanged:true};
}

// In the privileged workflow, code must come from the trusted workflow commit,
// while the untrusted candidate is only parsed as data after exact-SHA verification.
export function approvedSourceForMode({mode,checkoutSha,manifestSha,approvedSha,trustedUploaderSha}){
 if(!SHA.test(checkoutSha))refuse('invalid local checkout identity');
 if(mode==='--verify'){
  if(manifestSha!==checkoutSha)refuse('review manifest is not from this checkout');
  return checkoutSha;
 }
 if(mode==='--upload'||mode==='--verify-approved'){
  if(!SHA.test(approvedSha)||manifestSha!==approvedSha)
   refuse('candidate SHA does not match explicit owner upload approval');
  if(!SHA.test(trustedUploaderSha)||checkoutSha!==trustedUploaderSha)
   refuse('uploader source is not the explicitly trusted checkout');
  return approvedSha;
 }
 refuse('unknown acceptance execution mode');
}

// Produce reviewed connector code offline. Candidate modules are a JSON string,
// never evaluated by the privileged executor. Both the whole bundle and every
// module are hashed again there before the first provider request.
export function buildConnectedAcceptanceCode({manifest,candidateBytes,expectedSha,
 expectedCandidateSha256,accountId,operation='PREFLIGHT_ONLY'}){
 if(!/^[a-f0-9]{32}$/.test(accountId)||
    !/^[a-f0-9]{64}$/.test(expectedCandidateSha256)||
    !['PREFLIGHT_ONLY','UPLOAD_VERSION_ONLY_NO_DEPLOY'].includes(operation))
  refuse('invalid explicit connected execution inputs');
 verifyReviewCandidate({manifest,candidateBytes,expectedSha});
 const candidateText=Buffer.from(candidateBytes).toString('utf8');
 if(sha256(candidateText)!==expectedCandidateSha256)
  refuse('candidate differs from independently pinned artifact digest');
 const constants={WORKER,PRODUCTION_WORKER,ORIGIN,APP,knownNames};
 const declarations=Object.entries(constants).map(([k,v])=>'const '+k+'='+JSON.stringify(v)+';').join('\n');
 const guards=[verifyAcceptanceSettings,d1Binding,verifyDatabaseIsolation,verifyBindingParity,
  verifyOwnerAccess,buildVersionForm,preflightAcceptance,uploadAcceptanceVersionWithRequest]
  .map(fn=>fn.toString()).join('\n');
 return `async () => {
 'use strict';
 ${declarations}
 const SHA=/^[0-9a-f]{40}$/;
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
 const refuse=reason=>{throw new Error('DS011 acceptance refused: '+reason);};
 ${guards}
 const approvedAccount=${JSON.stringify(accountId)};
 if(accountId!==approvedAccount)refuse('connected account differs from approved account');
 const sourceSha=${JSON.stringify(expectedSha)};
 const operation=${JSON.stringify(operation)};
 const candidateText=${JSON.stringify(candidateText)};
 const expectedDigest=${JSON.stringify(expectedCandidateSha256)};
 const moduleDigests=${JSON.stringify(manifest.candidate.modulesSha256)};
 const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),
  b=>b.toString(16).padStart(2,'0')).join('');
 if(await digest(candidateText)!==expectedDigest)refuse('connected candidate checksum mismatch');
 const modules=JSON.parse(candidateText);
 if(Object.keys(modules).length!==44||Object.keys(moduleDigests).length!==44)
  refuse('connected module inventory mismatch');
 for(const [name,source] of Object.entries(modules))
  if(typeof source!=='string'||await digest(source)!==moduleDigests[name])refuse('connected module checksum mismatch');
 const prefix='/accounts/'+approvedAccount;
 const work=prefix+'/workers/scripts/'+WORKER;
 const production=prefix+'/workers/scripts/'+PRODUCTION_WORKER;
 const app=prefix+'/access/apps/'+APP;
 const reads=new Set([work+'/settings',work+'/deployments',work+'/subdomain',production+'/settings',production+'/deployments',app,app+'/policies']);
 const request=async(path,{method='GET',body}={})=>{
  let options;
  if(method==='GET'&&(reads.has(path)||new RegExp('^'+work+'/versions/[a-f0-9-]{36}$').test(path)))
   options={method,path};
  else if(operation==='UPLOAD_VERSION_ONLY_NO_DEPLOY'&&method==='POST'&&path===work+'/versions?bindings_inherit=strict'){
   if(!(body instanceof FormData))refuse('version body is not reviewed multipart');
   const boundary='ds011-'+crypto.randomUUID();
   const parts=[];
   for(const [name,blob] of body.entries()){
    if(!/^[a-z0-9./-]+$/.test(name)||!(blob instanceof Blob))refuse('invalid multipart part');
    const value=await blob.text();
    if(value.includes(boundary))refuse('multipart boundary collision');
    parts.push('--'+boundary,'Content-Disposition: form-data; name="'+name+'"; filename="'+name+'"',
     'Content-Type: '+blob.type,'',value);
   }
   parts.push('--'+boundary+'--','');
   options={method:'POST',path:work+'/versions',query:{bindings_inherit:'strict'},
    body:parts.join('\\r\\n'),contentType:'multipart/form-data; boundary='+boundary,rawBody:true};
  }else refuse('connected API operation is outside the version-only allowlist');
  let response;
  try{response=await cloudflare.request(options);}catch{refuse('connected provider request failed; inspect versions before retry');}
  if(response?.success!==true||!response.result)refuse('connected provider did not confirm success; inspect versions before retry');
  return response.result;
 };
 if(operation==='PREFLIGHT_ONLY'){
  const checked=await preflightAcceptance(request,approvedAccount);
  return {status:'CONNECTED_PREFLIGHT_VERIFIED_NO_UPLOAD',sourceCommit:sourceSha,candidateSha256:expectedDigest,
   moduleCount:44,existingDeploymentId:checked.liveId,productionDeploymentId:checked.productionId};
 }
 const result=await uploadAcceptanceVersionWithRequest({request,accountId:approvedAccount,sourceSha,modules});
 return {...result,candidateSha256:expectedDigest};
}`;
}
async function main(){
 const args=process.argv.slice(2);
 if(args.length!==1||!['--verify','--verify-approved','--upload'].includes(args[0]))
  refuse('usage: node tools/comms-acceptance-upload.mjs --verify|--verify-approved|--upload');
 const root=new URL('../',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('release-review/manifest.json',root),'utf8'));
 const bytes=readFileSync(new URL('release-review/candidate.modules.json',root));
 const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(root),encoding:'utf8'}).trim();
 const dirty=execFileSync('git',['status','--porcelain=v1','--untracked-files=no'],
  {cwd:fileURLToPath(root),encoding:'utf8'}).trim();
 if(dirty)refuse('tracked source checkout not clean');
 const sourceSha=approvedSourceForMode({
  mode:args[0],checkoutSha:sha,manifestSha:manifest.sourceCommit,
  approvedSha:process.env.DS011_APPROVED_SOURCE_SHA,
  trustedUploaderSha:process.env.DS011_TRUSTED_UPLOADER_SHA
 });
 const modules=(args[0]==='--verify'?verifyReviewCandidate:verifyApprovedRelease)({manifest,candidateBytes:bytes,expectedSha:sourceSha});
 if(args[0]==='--verify'||args[0]==='--verify-approved'){
  console.log(JSON.stringify({status:'OFFLINE_REVIEW_VERIFIED_NOT_DEPLOYED',sourceCommit:sourceSha,
   ...(args[0]==='--verify-approved'?{trustedUploaderCommit:sha}:{}),
   moduleCount:Object.keys(modules).length,candidateSha256:sha256(bytes)}));
  return;
 }
 if(process.env.DS011_ALLOW_ACCEPTANCE_UPLOAD!=='true'||
    process.env.DS011_APPROVED_SOURCE_SHA!==sourceSha)
  refuse('explicit matching acceptance-upload authorization missing');
 const result=await uploadAcceptanceVersion({
  token:process.env.CLOUDFLARE_API_TOKEN,
  accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
  sourceSha,modules
 });
 console.log(JSON.stringify(result));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
 main().catch(error=>{console.error(error.message);process.exitCode=1;});
