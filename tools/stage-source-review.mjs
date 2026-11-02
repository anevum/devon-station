/**
 * Prepare a LOCAL-only, icon-free review copy of the sanitized DevonStation source.
 * This does not license, publish, deploy, or authorize the application.
 * The existing reviewed Access module is pinned by its Git blob object ID.
 */
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve, dirname, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditSourceIntake} from './source-intake.mjs';

// Current reviewed verifier, including Workers-compatible no-follow JWKS fetch.
export const PINNED_ACCESS_BLOB='69ec253eddfe6ad26268bef2d2a270cd3faa947d';
const SOURCE_PATHS=Object.freeze([
 'package.json',
 ...['app.js','backup-core.mjs','backup-ui.js','cloud.js','core.mjs','diagnostics-core.mjs','index.html','pwa.js','style.css','sync-core.mjs'].map(x=>'src/'+x),
 ...['index.mjs','access.mjs','notifications.mjs','portfolio.mjs','schema.sql','state.mjs','migrations/0002-owner-state.sql'].map(x=>'worker/'+x),
 'pwa/manifest.webmanifest','pwa/sw.js',
 ...['application','client','internal-tool','website'].map(x=>'templates/'+x+'/brief.json'),
 'templates/project.schema.json',
 ...['access-acceptance','backup','body-limits','diagnostics','hosted-build','hosted','migration','portfolio','review','scaffold','state','sync-core','sync-review','tab-recovery'].map(x=>'tests/'+x+'.test.mjs'),
 ...['build-hosted-shell.mjs','build-worker.mjs','new-project.mjs','verify-public-source.mjs'].map(x=>'tools/'+x),
 ...['browser-backup-smoke.py','browser-diagnostics-smoke.py','browser-reconcile-smoke.py','browser-resolution-smoke.py','browser-smoke.py','browser-tabs-smoke.py'].map(x=>'tools/'+x)
]);
export const STAGING_PATHS=SOURCE_PATHS;
const hash=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest('hex');
export const gitBlobSha=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const repoPath=p=>p.split(sep).join('/');
const allowedExtras=new Set([
 '.gitignore','.github/workflows/verify-source.yml','README.md','SHA256SUMS','SOURCE-REVIEW.md','VERIFICATION.md',
 'pwa/icons/apple-touch-icon.png','pwa/icons/icon-192.png','pwa/icons/icon-512.png'
]);
const expectedBlocks=new Set(['AUTH_SOURCE_CONFLICT','LICENSE_TEXT_MISSING','LICENSE_UNRESOLVED']);
const expectedReview=new Set(['ICON_PROVENANCE']);

async function fileBytes(root,path) {
 const file=join(root,path);
 const stat=await lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1_000_000)throw Error('Source input type/size rejected: '+path);
 return readFile(file);
}
async function listFiles(root,at=root,files=[]) {
 const {readdir}=await import('node:fs/promises');
 for(const entry of await readdir(at,{withFileTypes:true})) {
  const full=join(at,entry.name),rel=repoPath(relative(root,full));
  const stat=await lstat(full);
  if(stat.isSymbolicLink())throw Error('Symlink source path rejected: '+rel);
  if(stat.isDirectory()){await listFiles(root,full,files);continue;}
  if(!stat.isFile())throw Error('Non-file input rejected: '+rel);
  files.push(rel);
 }
 return files.sort();
}
/**
 * Stage an explicit file inventory without unapproved icons, preserving the
 * reviewed verifier. A successful stage remains unlicensed and NOT publishable.
 */
export async function stageSourceReview({candidateDir,reviewedAccessFile,outputDir,expectedVerifierGitBlob=PINNED_ACCESS_BLOB}) {
 if(!candidateDir||!reviewedAccessFile||!outputDir)throw Error('Explicit candidate, reviewed verifier and output are required');
 const input=resolve(candidateDir), output=resolve(outputDir);
 const inStat=await lstat(input);
 if(!inStat.isDirectory()||inStat.isSymbolicLink())throw Error('Candidate is not a real directory');
 if(output===input||output.startsWith(input+sep)||input.startsWith(output+sep))throw Error('Source and staging paths must be disjoint');
 const existing=await listFiles(input);
 const allowed=new Set([...SOURCE_PATHS,...allowedExtras]);
 const unknown=existing.filter(p=>!allowed.has(p));
 if(unknown.length)throw Error('Unexpected candidate path(s): '+unknown.join(', '));
 for(const path of SOURCE_PATHS)if(!existing.includes(path))throw Error('Required reviewed source path missing: '+path);
 const reviewed=await readFile(resolve(reviewedAccessFile));
 if(gitBlobSha(reviewed)!==expectedVerifierGitBlob)throw Error('Reviewed Access verifier does not match pinned Git blob');
 const preflight=await auditSourceIntake(input,{trustedVerifierPath:reviewedAccessFile});
 const unexpectedBlock=preflight.blockers.find(x=>!expectedBlocks.has(x.code));
 const unexpectedReview=preflight.manualReview.find(x=>!expectedReview.has(x.code));
 if(unexpectedBlock||unexpectedReview)throw Error('Additional source privacy or rights concern: '+(unexpectedBlock?.code||unexpectedReview?.code));
 const blockCodes=new Set(preflight.blockers.map(x=>x.code));
 for(const code of expectedBlocks)if(!blockCodes.has(code))throw Error('Candidate differs from reviewed release-gated baseline: '+code);
 const sourceManifest=[];
 const outputBytes=new Map();
 for(const path of SOURCE_PATHS) {
  const original=await fileBytes(input,path);
  let published=original;
  let note='unchanged sanitized candidate';
  if(path==='worker/access.mjs') { published=reviewed;note='pinned hardened recovery verifier'; }
  if(path==='pwa/manifest.webmanifest') {
   const manifest=JSON.parse(original.toString('utf8'));
   if(!Array.isArray(manifest.icons)||manifest.icons.length!==2||!manifest.icons.every(x=>typeof x?.src==='string'&&x.src.startsWith('/icons/')))throw Error('Unexpected source PWA icon manifest');
   manifest.icons=[];
   published=Buffer.from(JSON.stringify(manifest)+'\n');note='unreviewed icons omitted; installability not accepted';
  }
  if(path==='src/index.html') {
   const html=original.toString('utf8');
   const link='<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">';
   if(!html.includes(link))throw Error('Expected PWA link absent: review source change');
   published=Buffer.from(html.replace(link,''));note='unapproved apple-touch icon reference removed';
  }
  outputBytes.set(path,published);
  sourceManifest.push({path,sourceSha256:hash('sha256',original),stagedSha256:hash('sha256',published),note});
 }
 // Only create output after inputs are checked. Never overwrite a prior review.
 await mkdir(output);
 for(const [path,bytes] of outputBytes){const dest=join(output,path);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes,{flag:'wx',mode:0o644});}
 const report={schemaVersion:1,project:'DevonStation',reviewOnly:true,publicPublicationAuthorized:false,productionReleaseAuthorized:false,
  sourceArchiveLicense:'UNLICENSED',sourceVerifierGitBlob:expectedVerifierGitBlob,
  excludedUnapprovedAssets:['pwa/icons/apple-touch-icon.png','pwa/icons/icon-192.png','pwa/icons/icon-512.png'],
  unresolvedGates:['authorship and third-party rights','OSI license selection and approval','PWA icon rights and device acceptance','real Access identities','isolated D1 restore','guarded live rollback'],
  stagedFileCount:sourceManifest.length,files:sourceManifest};
 await writeFile(join(output,'SOURCE-STAGING-MANIFEST.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 return report;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const [candidateDir,reviewedAccessFile,outputDir]=process.argv.slice(2);
 try {
  const result=await stageSourceReview({candidateDir,reviewedAccessFile,outputDir});
  console.log(JSON.stringify({stagedFileCount:result.stagedFileCount,reviewOnly:true,publicPublicationAuthorized:false,productionReleaseAuthorized:false,unresolvedGates:result.unresolvedGates},null,2));
 }catch(err){console.error('Safe stage declined: '+err.message);process.exitCode=1;}
}
