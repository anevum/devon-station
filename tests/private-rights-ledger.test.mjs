import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {STAGING_PATHS,PINNED_ACCESS_BLOB,gitBlobSha} from '../tools/stage-source-review.mjs';
import {inspectPrivateRightsReview,writePrivateRightsLedger} from '../tools/private-rights-ledger.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'ds011-rights-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const staged=join(root,'staged');await mkdir(staged);
  const access=await readFile(new URL('../worker/access.mjs',import.meta.url));
  assert.equal(gitBlobSha(access),PINNED_ACCESS_BLOB,'regression: trusted recovery verifier changed');
  const files=[];
  for(const path of STAGING_PATHS) {
    let content=Buffer.from('// fabricated source review sample\n');
    if(path==='worker/access.mjs')content=access;
    if(path==='package.json')content=Buffer.from(JSON.stringify({name:'synthetic',license:'UNLICENSED'}));
    if(path==='pwa/manifest.webmanifest')content=Buffer.from(JSON.stringify({name:'Synthetic',icons:[]}));
    if(path==='src/index.html')content=Buffer.from('<!doctype html><title>Only a synthetic test</title>');
    await mkdir(dirname(join(staged,path)),{recursive:true});
    await writeFile(join(staged,path),content);
    files.push({path,sourceSha256:sha(content),stagedSha256:sha(content),note:'fabricated'});
  }
  const manifest={
    schemaVersion:1,project:'DevonStation',reviewOnly:true,
    publicPublicationAuthorized:false,productionReleaseAuthorized:false,
    sourceArchiveLicense:'UNLICENSED',sourceVerifierGitBlob:PINNED_ACCESS_BLOB,
    excludedUnapprovedAssets:['pwa/icons/apple-touch-icon.png','pwa/icons/icon-192.png','pwa/icons/icon-512.png'],
    unresolvedGates:['rights','real identity'],stagedFileCount:files.length,files
  };
  const manifestPath=join(staged,'SOURCE-STAGING-MANIFEST.json');
  await writeFile(manifestPath,JSON.stringify(manifest));
  return {root,staged,manifest,manifestPath};
}

test('inventories all 49 synthetic staged files while refusing publication rights',async t=>{
  const f=await fixture(t);
  const result=await inspectPrivateRightsReview(f.staged);
  assert.equal(result.filesReviewedForIntegrity,STAGING_PATHS.length);
  assert.equal(result.publicPublicationAuthorized,false);
  assert.equal(result.productionReleaseAuthorized,false);
  assert(result.files.every(file=>file.rightsStatus==='UNREVIEWED' && file.thirdPartyStatus==='REVIEW_REQUIRED'));
  assert.equal(result.assetsExcluded.length,3);
  assert.deepEqual(result.files.map(file=>file.path),STAGING_PATHS);
});

test('writes only a private new review ledger outside staged source',async t=>{
  const f=await fixture(t),out=join(f.root,'review-only.json');
  const result=await writePrivateRightsLedger(f.staged,out);
  assert.equal(result.published,false);
  const report=JSON.parse(await readFile(out,'utf8'));
  assert.equal(report.files.length,STAGING_PATHS.length);
  assert.equal((await stat(out)).mode & 0o777,0o600);
  await assert.rejects(writePrivateRightsLedger(f.staged,out),/EEXIST/);
  await assert.rejects(writePrivateRightsLedger(f.staged,join(f.staged,'rights.json')),/outside source tree/);
});

test('rejects changed staged code, missing source, and unexpected private paths',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.staged,'src/app.js'),'tampered');
  await assert.rejects(inspectPrivateRightsReview(f.staged),/hash mismatch/);
  await writeFile(join(f.staged,'src/app.js'),'// fabricated source review sample\n');
  await writeFile(join(f.staged,'hidden.json'),'{}');
  await assert.rejects(inspectPrivateRightsReview(f.staged),/source file inventory changed/);
  await rm(join(f.staged,'hidden.json'));
  await rm(join(f.staged,'src/app.js'));
  await assert.rejects(inspectPrivateRightsReview(f.staged),/source file inventory changed/);
});

test('rejects a symlink even when its target appears on the staging allowlist',async t=>{
  const f=await fixture(t);
  await symlink(join(f.staged,'src/app.js'),join(f.staged,'alias.js'));
  await assert.rejects(inspectPrivateRightsReview(f.staged),/symlink present/);
});

test('blocks any manual tampering with release flags or hardened verifier',async t=>{
  const f=await fixture(t);
  f.manifest.publicPublicationAuthorized=true;
  await writeFile(f.manifestPath,JSON.stringify(f.manifest));
  await assert.rejects(inspectPrivateRightsReview(f.staged),/changed release protections/);
  f.manifest.publicPublicationAuthorized=false;
  await writeFile(f.manifestPath,JSON.stringify(f.manifest));
  await writeFile(join(f.staged,'worker/access.mjs'),'// old untrusted source');
  await assert.rejects(inspectPrivateRightsReview(f.staged),/hash mismatch/);
});

test('blocks reintroduced PWA icons even if the source hash manifest is updated',async t=>{
  const f=await fixture(t);
  const path='pwa/manifest.webmanifest';
  const altered=Buffer.from(JSON.stringify({name:'Synthetic',icons:[{src:'/icons/icon-192.png'}]}));
  await writeFile(join(f.staged,path),altered);
  f.manifest.files.find(item=>item.path===path).stagedSha256=sha(altered);
  await writeFile(f.manifestPath,JSON.stringify(f.manifest));
  await assert.rejects(inspectPrivateRightsReview(f.staged),/unreviewed PWA icons/);
});

test('reports third-party indicators without echoing source content',async t=>{
  const f=await fixture(t);
  const path='src/app.js';
  const marker='Copyright 2020 external example; SPDX-License-Identifier: MIT';
  const changed=Buffer.from('// '+marker+'\n');
  await writeFile(join(f.staged,path),changed);
  f.manifest.files.find(item=>item.path===path).stagedSha256=sha(changed);
  await writeFile(f.manifestPath,JSON.stringify(f.manifest));
  const result=await inspectPrivateRightsReview(f.staged);
  assert.deepEqual(result.files.find(item=>item.path===path).indicators,['COPYRIGHT_MARKER','LICENSE_MARKER']);
  assert(!JSON.stringify(result).includes(marker));
  assert.equal(result.publicPublicationAuthorized,false);
});
