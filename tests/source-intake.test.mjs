import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auditSourceIntake} from '../tools/source-intake.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'ds011-source-review-'));
  t.after(()=>rm(root,{force:true,recursive:true}));
  for(const path of ['src','worker','tools'])await mkdir(join(root,path));
  await writeFile(join(root,'src/index.html'),'<!doctype html><title>Sanitized</title>');
  await writeFile(join(root,'src/app.js'),'export const synthetic = true;');
  await writeFile(join(root,'worker/access.mjs'),'export function verified(){return true;}');
  await writeFile(join(root,'tools/build-hosted-shell.mjs'),'console.log("synthetic build");');
  await writeFile(join(root,'package.json'),JSON.stringify({name:'synthetic-test',license:'MIT'}));
  await writeFile(join(root,'LICENSE'),'Synthetic fixture; not a real license');
  return root;
}

test('a minimal synthetic import can pass automated preflight',async t=>{
  const root=await fixture(t);const result=await auditSourceIntake(root,{trustedVerifierPath:join(root,'worker/access.mjs')});
  assert.equal(result.automatedPreflightPassed,true);assert.equal(result.blockers.length,0);
});

test('rejects private inventories and deployment outputs by path',async t=>{
  const root=await fixture(t);
  await writeFile(join(root,'src/snapshot.json'),'{}');
  await mkdir(join(root,'deployment'));
  await writeFile(join(root,'deployment/modules.json'),'{}');
  const result=await auditSourceIntake(root);
  assert(result.blockers.some(x=>x.code==='PRIVATE_PATH'&&x.path==='src/snapshot.json'));
  assert(result.blockers.some(x=>x.code==='PRIVATE_PATH'&&x.path==='deployment/'));
});

test('rejects embedded private Notion identifiers without echoing them',async t=>{
  const root=await fixture(t);
  const marker='https://app.notion.com/p/'+'a'.repeat(32);
  await writeFile(join(root,'src/app.js'),'export const hidden='+JSON.stringify(marker));
  const result=await auditSourceIntake(root);
  assert(result.blockers.some(x=>x.code==='NOTION_PAGE_ID'&&x.path==='src/app.js'));
  assert.equal(JSON.stringify(result).includes(marker),false);
});

test('blocks any overwrite of the reviewed Access verifier that differs',async t=>{
  const root=await fixture(t);
  const reviewed=join(root,'worker/access.mjs');
  const alternate=join(root,'trusted.mjs');
  await writeFile(alternate,'export function verified(){return false;}');
  const result=await auditSourceIntake(root,{trustedVerifierPath:alternate});
  assert(result.blockers.some(x=>x.code==='AUTH_SOURCE_CONFLICT'));
  assert.equal(result.automatedPreflightPassed,false);
  assert.notEqual(reviewed,alternate);
});

test('requires license review and known image provenance',async t=>{
  const root=await fixture(t);
  await writeFile(join(root,'package.json'),JSON.stringify({license:'UNLICENSED'}));
  await rm(join(root,'LICENSE'));
  await mkdir(join(root,'pwa/icons'),{recursive:true});
  await writeFile(join(root,'pwa/icons/icon-192.png'),Buffer.from([137,80,78,71]));
  const result=await auditSourceIntake(root);
  assert(result.blockers.some(x=>x.code==='LICENSE_UNRESOLVED'));
  assert(result.blockers.some(x=>x.code==='LICENSE_TEXT_MISSING'));
  assert(result.manualReview.some(x=>x.code==='ICON_PROVENANCE'));
  assert.equal(result.automatedPreflightPassed,false);
});

test('rejects symlinks and credential-shaped values',async t=>{
  const root=await fixture(t);
  await symlink(join(root,'src/app.js'),join(root,'src/alias.js'));
  await writeFile(join(root,'src/app.js'),'const leaked="ghp_'+'x'.repeat(30)+'";');
  const result=await auditSourceIntake(root);
  assert(result.blockers.some(x=>x.code==='SYMLINK'));
  assert(result.blockers.some(x=>x.code==='TOKEN_SHAPED_VALUE'));
});
