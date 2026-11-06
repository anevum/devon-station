// DS011 COMMS-64: read-only evidence check for the one approved, inactive
// acceptance version. No POST, secret readback, migration, activation or SMTP.
import {
 preflightAcceptance,verifyAcceptanceSettings,
 verifyBindingParity,verifyDatabaseIsolation
} from './comms-acceptance-upload.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT=/^[0-9a-f]{32}$/;
const REFUSE=reason=>{throw new Error('DS011 inactive readback refused: '+reason);};

// Historical version 15 retains its original PR #36 source even when the next
// proposed uploader pin changes. Never relabel the old version as a new build.
// Baseline is deliberately immutable. A legitimate rollout or config change
// requires fresh independent review, not silently re-pinning to the new state.
export const INACTIVE_ANCHORS=Object.freeze({
 versionId:'523569b4-38d9-4cab-acbd-e84dd22a59aa',
 sourceCommit:'bba373f35f3cc913447e72fcdfff589cd6f3a073',
 acceptanceDeploymentId:'99577640-1f02-446f-8d38-88f723f51f82',
 acceptanceServingVersionId:'c31f8bd4-283d-457c-9779-87605927eec4',
 productionDeploymentId:'890cc9d9-533b-4b9a-b326-26a7c4f88402',
 productionServingVersionId:'ce64277b-124b-4177-825a-8b51d997152b',
 productionZeroVersionId:'1ba61404-f7f6-4b0b-8b55-6f9f52819e70'
});

export function verifyPinnedDeployment(response,{deploymentId,shares,forbiddenVersion}){
 const deployments=response?.deployments;
 const current=Array.isArray(deployments)?deployments[0]:null;
 if(!current||current.id!==deploymentId||!Array.isArray(current.versions))
  REFUSE('active deployment identity changed or cannot be verified');
 if(!shares||Object.keys(shares).length!==current.versions.length)
  REFUSE('active traffic allocation differs from pinned baseline');
 const seen=new Set();
 let total=0;
 for(const item of current.versions){
  if(!UUID.test(item?.version_id)||seen.has(item.version_id)||
     !Number.isFinite(item.percentage)||item.percentage<0||item.percentage>100||
     !Object.hasOwn(shares,item.version_id)||shares[item.version_id]!==item.percentage||
     item.version_id===forbiddenVersion)
   REFUSE('active traffic version or percentage differs from pinned baseline');
  seen.add(item.version_id);total+=item.percentage;
 }
 if(total!==100)REFUSE('active traffic allocation does not total 100%');
 return true;
}

function verifyProductionSendingOff(settings){
 const bindings=settings?.bindings;
 if(!Array.isArray(bindings))REFUSE('production settings absent');
 for(const name of ['MAIL_SEND_ENABLED','MAIL_SENDER_VERIFIED']){
  const found=bindings.filter(b=>b?.name===name);
  if(found.length!==1||found[0].type!=='plain_text'||found[0].text!=='false')
   REFUSE('production outgoing mail is enabled or unverified');
 }
 return true;
}

export async function readbackInactiveAcceptance({request,accountId}={}){
 if(typeof request!=='function'||typeof accountId!=='string'||!ACCOUNT.test(accountId))
  REFUSE('connected account or read-only request missing');
 const root='/accounts/'+accountId;
 const accept=root+'/workers/scripts/devon-station-mail-acceptance';
 const prod=root+'/workers/scripts/devon-station';
 const ownerApp=root+'/access/apps/d75c6407-070e-4b43-8843-0216b166d712';
 const allowed=new Set([
  accept+'/settings',accept+'/deployments',accept+'/subdomain',
  accept+'/versions/'+INACTIVE_ANCHORS.versionId,
  prod+'/settings',prod+'/deployments',ownerApp,ownerApp+'/policies'
 ]);
 const get=async path=>{
  if(!allowed.has(path))REFUSE('read-only endpoint outside explicit allowlist');
  return request(path,{method:'GET'});
 };
 // Established read-only preflight checks runtime, owner Access, preview URLs,
 // required encryption/feature bindings and four distinct D1 resources.
 const pre=await preflightAcceptance(get,accountId);
 if(pre.liveId!==INACTIVE_ANCHORS.acceptanceDeploymentId||
    pre.productionId!==INACTIVE_ANCHORS.productionDeploymentId)
  REFUSE('deployment anchor drift before readback');
 verifyProductionSendingOff(pre.production);

 const accShares={[INACTIVE_ANCHORS.acceptanceServingVersionId]:100};
 const prodShares={[INACTIVE_ANCHORS.productionServingVersionId]:100,
                   [INACTIVE_ANCHORS.productionZeroVersionId]:0};
 const checkDeployments=async()=>{
  const [acceptance,production]=await Promise.all([
   get(accept+'/deployments'),get(prod+'/deployments')
  ]);
  verifyPinnedDeployment(acceptance,{
   deploymentId:INACTIVE_ANCHORS.acceptanceDeploymentId,
   shares:accShares,forbiddenVersion:INACTIVE_ANCHORS.versionId
  });
  verifyPinnedDeployment(production,{
   deploymentId:INACTIVE_ANCHORS.productionDeploymentId,
   shares:prodShares,forbiddenVersion:INACTIVE_ANCHORS.versionId
  });
 };
 await checkDeployments();
 const version=await get(accept+'/versions/'+INACTIVE_ANCHORS.versionId);
 if(version?.id!==INACTIVE_ANCHORS.versionId||
    version?.annotations?.['workers/commit_sha']!==INACTIVE_ANCHORS.sourceCommit||
    version?.annotations?.['workers/pull_request_number']!=='36'||
    version?.annotations?.['workers/repository_url']!=='https://github.com/devonalanakins/devon-station')
  REFUSE('inactive version identity or approved source provenance mismatch');
 const resources=version?.resources;
 if(!resources?.script_runtime||!Array.isArray(resources.bindings))
  REFUSE('inactive version runtime or binding readback missing');
 const proposed={
  compatibility_date:resources.script_runtime.compatibility_date,
  compatibility_flags:resources.script_runtime.compatibility_flags,
  bindings:resources.bindings
 };
 const checked=verifyAcceptanceSettings(proposed);
 if(checked.owner!==pre.checked.owner)REFUSE('inactive version owner changed');
 verifyBindingParity(pre.settings,proposed);
 verifyDatabaseIsolation(pre.settings,pre.production,proposed);
 // Re-read current serving deployments after all other GETs to catch a
 // concurrent activation; no claim is made about future traffic.
 await checkDeployments();
 return Object.freeze({
  status:'INACTIVE_VERSION_VERIFIED_NO_ACTIVATION',
  versionId:INACTIVE_ANCHORS.versionId,
  sourceCommit:INACTIVE_ANCHORS.sourceCommit,
  acceptanceDeploymentId:INACTIVE_ANCHORS.acceptanceDeploymentId,
  productionDeploymentId:INACTIVE_ANCHORS.productionDeploymentId,
  acceptedVersionServingTraffic:false,
  acceptanceSendEnabled:false,
  productionSendEnabled:false,
  ownerAccessAndD1IsolationVerified:true,
  previewUrlsDisabled:true,
  evidenceScope:'GET_ONLY_AT_CHECK_TIME'
 });
}
