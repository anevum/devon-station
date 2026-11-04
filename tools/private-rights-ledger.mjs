/**
 * Offline, privacy-safe rights evidence inventory for a privately staged
 * DevonStation R3 source tree. This is NOT a copyright ruling, license grant,
 * source publication approval, or production release gate.
 *
 * Only filenames, hashes and indicator names are included in the output;
 * source text and author-identifying lines never leave the private checkout.
 */
import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {STAGING_PATHS, PINNED_ACCESS_BLOB, gitBlobSha} from './stage-source-review.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const isSha=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const icons=['pwa/icons/apple-touch-icon.png','pwa/icons/icon-192.png','pwa/icons/icon-512.png'];
const fileSet=new Set(STAGING_PATHS);
const manifestName='SOURCE-STAGING-MANIFEST.json';
const fail=message=>{throw new Error('Private source review rejected: '+message);};
const normalize=p=>p.split(sep).join('/');

async function pathsInside(root,at=root,found=[]) {
  for(const entry of await readdir(at,{withFileTypes:true})) {
    const path=join(at,entry.name),name=normalize(relative(root,path)),stat=await lstat(path);
    if(stat.isSymbolicLink())fail('symlink present');
    if(stat.isDirectory()){await pathsInside(root,path,found);continue;}
    if(!stat.isFile() || stat.size>1_000_000)fail('unexpected input type or file size');
    found.push(name);
  }
  return found.sort();
}

function manualIndicators(path,text) {
  const result=[];
  if(/\bcopyright\b|©/iu.test(text))result.push('COPYRIGHT_MARKER');
  if(/SPDX-License-Identifier|@license\b/i.test(text))result.push('LICENSE_MARKER');
  // Informational signal only: absolute or package imports do not themselves
  // prove that source is vendored or improperly licensed.
  if(/\bfrom\s*['"](?!\.{1,2}\/|node:|https?:\/\/)[^'"]+['"]/i.test(text))result.push('PACKAGE_IMPORT_MARKER');
  return result;
}

export async function inspectPrivateRightsReview(stagedDir) {
  if(typeof stagedDir!=='string' || !stagedDir.trim())fail('staged directory required');
  const root=resolve(stagedDir),stat=await lstat(root);
  if(!stat.isDirectory() || stat.isSymbolicLink())fail('input must be a real directory');
  const paths=await pathsInside(root);
  const expected=new Set([...fileSet,manifestName]);
  if(paths.length!==expected.size || paths.some(path=>!expected.has(path)))fail('source file inventory changed');
  const bytes=await readFile(join(root,manifestName));
  if(bytes.length>300_000)fail('manifest too large');
  let manifest;
  try{manifest=JSON.parse(bytes.toString('utf8'));}catch{fail('invalid staging manifest');}
  if(manifest?.schemaVersion!==1 || manifest.project!=='DevonStation' ||
     manifest.reviewOnly!==true || manifest.publicPublicationAuthorized!==false ||
     manifest.productionReleaseAuthorized!==false ||
     manifest.sourceArchiveLicense!=='UNLICENSED' ||
     manifest.sourceVerifierGitBlob!==PINNED_ACCESS_BLOB ||
     manifest.stagedFileCount!==fileSet.size ||
     !Array.isArray(manifest.files) || manifest.files.length!==fileSet.size ||
     !Array.isArray(manifest.excludedUnapprovedAssets) ||
     JSON.stringify([...manifest.excludedUnapprovedAssets].sort())!==JSON.stringify([...icons].sort()))
    fail('missing or changed release protections');
  const entries=new Map();
  for(const f of manifest.files) {
    if(!f || !fileSet.has(f.path) || !isSha(f.sourceSha256) ||
       !isSha(f.stagedSha256) || entries.has(f.path))fail('unrecognized or duplicate manifest entry');
    entries.set(f.path,f);
  }
  const review=[];
  for(const path of STAGING_PATHS) {
    const item=entries.get(path);
    if(!item)fail('missing source evidence');
    const bytes=await readFile(join(root,path));
    if(sha(bytes)!==item.stagedSha256)fail('staged file hash mismatch');
    if(path==='worker/access.mjs' && gitBlobSha(bytes)!==PINNED_ACCESS_BLOB)fail('hardened verifier mismatch');
    if(path==='pwa/manifest.webmanifest') {
      let pwa;try{pwa=JSON.parse(bytes.toString('utf8'));}catch{fail('invalid PWA manifest');}
      if(!Array.isArray(pwa.icons) || pwa.icons.length!==0)fail('unreviewed PWA icons are referenced');
    }
    if(path==='src/index.html' && /apple-touch-icon|\/icons\//i.test(bytes.toString('utf8')))fail('unapproved HTML icon reference');
    if(path==='package.json') {
      let pkg;try{pkg=JSON.parse(bytes.toString('utf8'));}catch{fail('invalid source package');}
      if(pkg.license!=='UNLICENSED')fail('source license changed without a separate rights decision');
    }
    const text=bytes.toString('utf8');
    review.push({path,sourceSha256:item.sourceSha256,stagedSha256:item.stagedSha256,
      rightsStatus:'UNREVIEWED',thirdPartyStatus:'REVIEW_REQUIRED',
      indicators:manualIndicators(path,text)});
  }
  return {schemaVersion:1,project:'DevonStation',reviewOnly:true,
    publicPublicationAuthorized:false,productionReleaseAuthorized:false,
    sourceArchiveLicense:'UNLICENSED',filesReviewedForIntegrity:review.length,
    assetsExcluded:icons.map(path=>({path,rightsStatus:'UNVERIFIED',action:'EXCLUDE_OR_REPLACE'})),
    manualGates:['Confirm authorship and contribution rights for every file',
      'Review third-party and generated-code provenance, licenses and notices',
      'Select and explicitly authorize an OSI-approved distribution license',
      'Use only rights-cleared PWA artwork and verify installability separately'],
    files:review};
}

export async function writePrivateRightsLedger(stagedDir,outputFile) {
  if(typeof outputFile!=='string' || !outputFile.trim())fail('explicit output path required');
  const root=resolve(stagedDir),destination=resolve(outputFile);
  if(destination===root || destination.startsWith(root+sep) || root.startsWith(destination+sep))
    fail('review ledger must be stored outside source tree');
  const result=await inspectPrivateRightsReview(stagedDir);
  await writeFile(destination,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  return {fileCount:result.filesReviewedForIntegrity,rightsStatus:'UNREVIEWED',published:false};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [stagedDir,outputFile]=process.argv.slice(2);
  try{
    const result=await writePrivateRightsLedger(stagedDir,outputFile);
    console.log(JSON.stringify(result));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
