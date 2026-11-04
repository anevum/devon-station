// Offline handoff to the existing connected Cloudflare executor. No API calls,
// tokens or secret values. Never automatically execute the generated code.
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {verifiedSourceCommit} from './prepare-rb01-review.mjs';
import {buildConnectedAcceptanceCode} from './comms-acceptance-upload.mjs';

const mode=process.argv[2];
if(process.argv.length!==3||!['--preflight','--upload-version-only'].includes(mode))
 throw Error('Usage: node tools/prepare-comms-connected.mjs --preflight|--upload-version-only (offline only)');
const checkout=await verifiedSourceCommit();
if(checkout!==process.env.DS011_TRUSTED_UPLOADER_SHA)
 throw Error('Connected handoff requires an explicitly pinned, clean trusted uploader checkout');
const root=new URL('../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('release-review/manifest.json',root),'utf8'));
const candidateBytes=await readFile(new URL('release-review/candidate.modules.json',root));
const operation=mode==='--preflight'?'PREFLIGHT_ONLY':'UPLOAD_VERSION_ONLY_NO_DEPLOY';
const code=buildConnectedAcceptanceCode({manifest,candidateBytes,
 expectedSha:process.env.DS011_APPROVED_SOURCE_SHA,
 expectedCandidateSha256:process.env.DS011_APPROVED_CANDIDATE_SHA256,
 accountId:process.env.CLOUDFLARE_ACCOUNT_ID,operation});
if(await verifiedSourceCommit()!==checkout)throw Error('Source changed during connected handoff');
const dest=new URL('release-review/connected-'+(mode==='--preflight'?'preflight':'version-only')+'.js',root);
await writeFile(dest,code,{flag:'w'});
console.log(JSON.stringify({status:'OFFLINE_CONNECTED_CODE_PREPARED_NOT_EXECUTED',operation,
 trustedUploaderCommit:checkout,sourceCommit:manifest.sourceCommit,
 candidateSha256:manifest.candidate.sha256,path:fileURLToPath(dest)}));
