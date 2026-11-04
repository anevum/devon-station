// DS011: manual, guarded upload of a SHA-pinned Communications acceptance version.
// It NEVER calls Cloudflare's deployment, secret, DNS, database, or policy mutation APIs.
// No remote action happens unless --upload and a matching explicit SHA approval are supplied.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const WORKER='devon-station-mail-acceptance';
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
 if(names.length!==manifest.candidate.moduleCount||names.length!==43 ||
    names.some(p=>!/^([a-z0-9.-]+\/)*[a-z0-9.-]+\.mjs$/.test(p)) ||
    !Object.hasOwn(modules,'index.mjs')||!Object.hasOwn(modules,'worker/mail-api.mjs'))
  refuse('module inventory differs from reviewed build');
 if(names.some(p=>typeof modules[p]!=='string'||
     sha256(modules[p])!==manifest.candidate.modulesSha256?.[p])||
    Object.keys(manifest.candidate.modulesSha256||{}).length!==names.length)
  refuse('module digest differs from reviewed build');
 const entry=modules['index.mjs'];
 if(!entry.startsWith("import {connect} from 'cloudflare:sockets';\n")||
    !entry.includes("export default createStation(assets,undefined,undefined,connect);")||
    !entry.includes('"privateDataLoaded":false')||
    !modules['worker/mail-api.mjs'].includes('/api/mail/diagnostics/imap-check')||
    !modules['worker/index.mjs'].includes('CF_VERSION_METADATA'))
  refuse('missing reviewed TLS, privacy, diagnostics or version entrypoint');
 return Object.freeze(modules);
}

export function verifyAcceptanceSettings(settings){
 if(!settings||!Array.isArray(settings.bindings)||
    settings.compatibility_date!=='2026-10-28'||
    !settings.compatibility_flags?.includes('nodejs_compat'))
  refuse('acceptance Worker runtime differs from reviewed runtime');
 const bindings=new Map();
 for(const b of settings.bindings){
  if(!b?.name||bindings.has(b.name)||!['plain_text','d1','secret_text','version_metadata'].includes(b.type))
   refuse('unexpected or duplicate acceptance binding');
  bindings.set(b.name,b);
 }
 if(knownNames.some(n=>!bindings.has(n)))refuse('required acceptance binding absent');
 for(const name of ['DB','MAIL_DB'])if(bindings.get(name).type!=='d1')
  refuse('wrong D1 binding type');
 if(bindings.get('MAIL_PAYLOAD_KEYS_JSON').type!=='secret_text')
  refuse('encryption secret binding absent');
 for(const name of ['MAIL_SEND_ENABLED','MAIL_SENDER_VERIFIED']){
  if(bindings.get(name)?.type!=='plain_text'||bindings.get(name).text!=='false')
   refuse('outgoing email must remain disabled');
 }
 if(bindings.get('APP_ORIGIN')?.text!==ORIGIN)refuse('acceptance APP_ORIGIN mismatch');
 if(bindings.has('MAIL_SMTP_PASSWORD'))refuse('acceptance Worker must have no SMTP password');
 if(bindings.get('MAIL_ENABLED')?.text!=='false'&&bindings.get('MAIL_ENABLED')?.text!=='true')
  refuse('invalid IMAP feature flag');
 const owner=bindings.get('OWNER_EMAIL')?.text;
 if(typeof owner!=='string'||!owner.includes('@'))refuse('owner identity binding absent');
 const inherited=[...bindings.values()].filter(b=>b.type!=='version_metadata')
  .map(b=>({name:b.name,type:'inherit'})).sort((a,b)=>a.name.localeCompare(b.name));
 return {owner,inherited,bindingCount:bindings.size};
}

export function verifyOwnerAccess(app,policies,owner){
 if(!app||app.id!==APP||app.type!=='self_hosted'||app.domain!==new URL(ORIGIN).hostname||
    !Array.isArray(policies)||policies.length!==1)
  refuse('unexpected owner Access app or policy count');
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
   'workers/pull_request_number':'36',
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
 const prefix='/accounts/'+accountId;
 const work=prefix+'/workers/scripts/'+WORKER;
 const settings=await cloudflareCall(fetchImpl,token,work+'/settings');
 const checked=verifyAcceptanceSettings(settings);
 const app=await cloudflareCall(fetchImpl,token,prefix+'/access/apps/'+APP);
 const ps=await cloudflareCall(fetchImpl,token,prefix+'/access/apps/'+APP+'/policies');
 verifyOwnerAccess(app,Array.isArray(ps)?ps:ps.items||[],checked.owner);
 const before=await cloudflareCall(fetchImpl,token,work+'/deployments');
 const liveId=before?.deployments?.[0]?.id;
 if(!UUID.test(liveId||''))refuse('could not anchor existing acceptance deployment');
 const {form}=buildVersionForm(modules,sourceSha,checked.inherited);
 const uploaded=await cloudflareCall(fetchImpl,token,work+'/versions?bindings_inherit=strict',
  {method:'POST',body:form});
 if(!UUID.test(uploaded?.id||''))refuse('no immutable Cloudflare version ID returned');
 const version=await cloudflareCall(fetchImpl,token,work+'/versions/'+uploaded.id);
 if(version.id!==uploaded.id||version?.metadata?.annotations?.['workers/commit_sha']!==sourceSha)
  refuse('uploaded version provenance readback did not match');
 const after=await cloudflareCall(fetchImpl,token,work+'/deployments');
 if(after?.deployments?.[0]?.id!==liveId)refuse('deployment changed during upload; manual review required');
 return {status:'VERSION_UPLOADED_NOT_DEPLOYED',versionId:uploaded.id,
  sourceCommit:sourceSha,existingDeploymentId:liveId,trafficUnchanged:true};
}

async function main(){
 const args=process.argv.slice(2);
 if(args.length!==1||!['--verify','--upload'].includes(args[0]))
  refuse('usage: node tools/comms-acceptance-upload.mjs --verify|--upload');
 const root=new URL('../',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('release-review/manifest.json',root),'utf8'));
 const bytes=readFileSync(new URL('release-review/candidate.modules.json',root));
 const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(root),encoding:'utf8'}).trim();
 const dirty=execFileSync('git',['status','--porcelain=v1','--untracked-files=no'],
  {cwd:fileURLToPath(root),encoding:'utf8'}).trim();
 if(dirty)refuse('tracked source checkout not clean');
 const modules=verifyReviewCandidate({manifest,candidateBytes:bytes,expectedSha:sha});
 if(args[0]==='--verify'){
  console.log(JSON.stringify({status:'OFFLINE_REVIEW_VERIFIED_NOT_DEPLOYED',sourceCommit:sha,
   moduleCount:Object.keys(modules).length,candidateSha256:sha256(bytes)}));
  return;
 }
 if(process.env.DS011_ALLOW_ACCEPTANCE_UPLOAD!=='true'||
    process.env.DS011_APPROVED_SOURCE_SHA!==sha)
  refuse('explicit matching acceptance-upload authorization missing');
 const result=await uploadAcceptanceVersion({
  token:process.env.CLOUDFLARE_API_TOKEN,
  accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
  sourceSha:sha,modules
 });
 console.log(JSON.stringify(result));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===fileURLToPath(new URL('file://'+process.argv[1])))
 main().catch(error=>{console.error(error.message);process.exitCode=1;});
