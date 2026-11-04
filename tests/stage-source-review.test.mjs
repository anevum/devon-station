import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {stageSourceReview,STAGING_PATHS,gitBlobSha} from '../tools/stage-source-review.mjs';

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'ds011-stage-source-'));
 t.after(()=>rm(root,{force:true,recursive:true}));
 const candidate=join(root,'candidate'),reviewed=join(root,'trusted-verifier.mjs'),output=join(root,'staged');
 await mkdir(candidate);
 for(const path of STAGING_PATHS){
  const dest=join(candidate,path);await mkdir(dirname(dest),{recursive:true});
  let data='// synthetic fixture, no real user source\n';
  if(path==='package.json')data=JSON.stringify({name:'synthetic-fixture',type:'module',license:'UNLICENSED'});
  if(path==='src/index.html')data='<!doctype html><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><main>Test</main>';
  if(path==='pwa/manifest.webmanifest')data=JSON.stringify({name:'Synthetic',icons:[{src:'/icons/icon-192.png'},{src:'/icons/icon-512.png'}]});
  if(path==='worker/access.mjs')data='// older test verifier\n';
  await writeFile(dest,data);
 }
 const good=Buffer.from('// hardened synthetic verifier\n');await writeFile(reviewed,good);
 return {root,candidate,reviewed,output,expectedVerifierGitBlob:gitBlobSha(good)};
}
const invoke=x=>stageSourceReview({candidateDir:x.candidate,reviewedAccessFile:x.reviewed,outputDir:x.output,expectedVerifierGitBlob:x.expectedVerifierGitBlob});

test('stages only allowlisted code while replacing older Access and omitting unreviewed PWA icon references',async t=>{
 const x=await fixture(t);
 const result=await invoke(x);
 assert.equal(result.publicPublicationAuthorized,false);
 assert.equal(result.productionReleaseAuthorized,false);
 assert.equal(result.stagedFileCount,STAGING_PATHS.length);
 assert.equal((await readFile(join(x.output,'worker/access.mjs'),'utf8')),'// hardened synthetic verifier\n');
 const manifest=JSON.parse(await readFile(join(x.output,'pwa/manifest.webmanifest'),'utf8'));
 assert.deepEqual(manifest.icons,[]);
 assert(!((await readFile(join(x.output,'src/index.html'),'utf8')).includes('apple-touch-icon')));
 assert.equal(result.files.find(f=>f.path==='worker/access.mjs').note,'pinned hardened recovery verifier');
});

test('cannot silently overwrite existing review output',async t=>{
 const x=await fixture(t);await mkdir(x.output);
 await assert.rejects(invoke(x),/EEXIST/);
});

test('rejects candidate symlinks and unexpected source files',async t=>{
 const x=await fixture(t);await writeFile(join(x.candidate,'unexpected-secret.json'),'{}');
 await assert.rejects(invoke(x),/Unexpected candidate path/);
 await rm(join(x.candidate,'unexpected-secret.json'));
 await symlink(join(x.candidate,'src/app.js'),join(x.candidate,'src/sneaky.js'));
 await assert.rejects(invoke(x),/Symlink source path/);
});

test('rejects any unreviewed private-data blocker instead of staging it',async t=>{
 const x=await fixture(t);
 await writeFile(join(x.candidate,'src/app.js'),'const page="https://app.notion.com/p/'+'a'.repeat(32)+'";');
 await assert.rejects(invoke(x),/Additional source privacy or rights concern: NOTION_PAGE_ID/);
});

test('pins expected verifier bytes rather than trusting the filename',async t=>{
 const x=await fixture(t);
 await writeFile(x.reviewed,'// changed synthetic verifier');
 await assert.rejects(invoke(x),/does not match pinned Git blob/);
});

test('fails closed when source HTML icon links change unexpectedly',async t=>{
 const x=await fixture(t);
 await writeFile(join(x.candidate,'src/index.html'),'<!doctype html><main>Different HTML</main>');
 await assert.rejects(invoke(x),/Expected PWA link absent/);
});
