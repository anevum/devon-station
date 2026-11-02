import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildReleaseArtifacts,verifiedSourceCommit} from '../tools/prepare-rb01-review.mjs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const sha = value => createHash('sha256').update(value).digest('hex');
const modules = [
  'index.mjs', 'worker/index.mjs', 'worker/access.mjs',
  'worker/notifications.mjs', 'worker/state.mjs', 'worker/portfolio.mjs',
  'worker/workspace.mjs', 'worker/workspace-journal.mjs',
  'foundation/src/foundation.mjs', 'foundation/src/access-scope-bridge.mjs',
  'foundation/interop/approved-portfolio.mjs', 'src/workspace-backup.mjs'
];
function syntheticCandidate() {
  const assets = Object.fromEntries([
    '/LICENSE.txt', '/index.html', '/manifest.webmanifest', '/sw.js',
    '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'
  ].map(path => [path, {type: 'text/plain', encoding: 'utf8', body:
    path === '/LICENSE.txt' ? 'GNU AFFERO GENERAL PUBLIC LICENSE' :
    path === '/index.html' ? 'const SNAPSHOT={"privateDataLoaded":false}' : 'synthetic'}]));
  const candidate = Object.fromEntries(modules.map(path => [path, '// synthetic fixture ' + path]));
  candidate['index.mjs'] = "import {createStation} from './worker/index.mjs';\nconst assets=" + JSON.stringify(assets) + ";\nexport default createStation(assets);\n";
  candidate['worker/access.mjs'] = read('worker/access.mjs');
  candidate['worker/notifications.mjs'] = read('worker/notifications.mjs');
  return candidate;
}
function prepare(candidate = syntheticCandidate()) {
  return buildReleaseArtifacts({candidate, legacyServer: read('legacy/v03/worker/index.mjs'),
    accessModule: read('worker/access.mjs'), notificationsModule: read('worker/notifications.mjs'),
    sourceCommit: 'a'.repeat(40)});
}
test('review-only package is deterministic, SHA-256 listed and retains the hardened Access module', () => {
  const first = prepare(); const second = prepare();
  assert.deepEqual(first.files, second.files);
  assert.equal(first.manifest.status, 'REVIEW_ONLY_NOT_DEPLOYED_OR_ACCEPTED');
  assert.equal(first.manifest.candidate.moduleCount, 12);
  assert.equal(first.manifest.guardedFallback.moduleCount, 4);
  assert.equal(first.manifest.intendedIsolatedRuntime.compatibilityFlags[0], 'nodejs_compat');
  assert.equal(first.manifest.intendedIsolatedRuntime.verifiedOnLiveOctoberRuntime, false);
  const fallback = JSON.parse(first.files['guarded-v03.modules.json']);
  assert.equal(fallback['worker/access.mjs'], read('worker/access.mjs'));
  assert.equal(fallback['worker/index.mjs'], read('legacy/v03/worker/index.mjs'));
  assert(!fallback['index.mjs'].includes('const SNAPSHOT='));
  assert.match(fallback['index.mjs'], /Guarded recovery mode/);
  assert.match(fallback['index.mjs'], /read-only safety screen|New workspace editing and approvals are paused/i);
  for (const line of first.files.SHA256SUMS.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  ([a-z0-9.-]+)$/.exec(line);
    assert(match); assert.equal(match[1], sha(first.files[match[2]]));
  }
});
test('changed authentication, legacy source, missing modules and embedded private marker fail closed', () => {
  const altered = syntheticCandidate(); altered['worker/access.mjs'] += '\n// changed';
  assert.throws(() => prepare(altered), /authentication|hardened|verifier/i);
  const incomplete = syntheticCandidate(); delete incomplete['worker/workspace.mjs'];
  assert.throws(() => prepare(incomplete), /module graph/);
  const privateCandidate = syntheticCandidate(); privateCandidate['worker/index.mjs'] = '"privateDataLoaded":true';
  assert.throws(() => prepare(privateCandidate), /private-data marker/);
});

function fixture(t,complete=false) {
  const dir=mkdtempSync(join(tmpdir(),'ds-release-provenance-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const git=args=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(['init','--quiet','--initial-branch=synthetic-review']);
  if(complete){
    const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
    const paths=execFileSync('git',['ls-files','-z'],{cwd:sourceRoot,encoding:'utf8'}).split('\0').filter(Boolean);
    for(const path of paths){mkdirSync(dirname(join(dir,path)),{recursive:true});copyFileSync(join(sourceRoot,path),join(dir,path));}
  }else{
    writeFileSync(join(dir,'.gitignore'),'deployment/\n');
    writeFileSync(join(dir,'source.txt'),'Synthetic tracked source\n');
  }
  git(['add','.']);
  git(['-c','user.name=Synthetic Release Test','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--quiet','-m','Synthetic provenance fixture']);
  return {dir,git,commit:git(['rev-parse','HEAD']).trim()};
}

test('source verification refuses tracked, staged and untracked edits without echoing their contents',async t=>{
  const f=fixture(t);assert.equal(await verifiedSourceCommit(f.dir),f.commit);
  writeFileSync(join(f.dir,'source.txt'),'Fabricated uncommitted content\n');
  await assert.rejects(verifiedSourceCommit(f.dir),/not clean and verifiable/);
  f.git(['add','source.txt']);
  await assert.rejects(verifiedSourceCommit(f.dir),/not clean and verifiable/);
  f.git(['reset','--hard',f.commit]);
  writeFileSync(join(f.dir,'unreviewed.txt'),'Fabricated untracked content\n');
  await assert.rejects(verifiedSourceCommit(f.dir),error=>/not clean and verifiable/.test(error.message)&&!error.message.includes('Fabricated'));
});

test('actual blob verification catches edits hidden by assume-unchanged index flags',async t=>{
  const f=fixture(t);f.git(['update-index','--assume-unchanged','source.txt']);
  writeFileSync(join(f.dir,'source.txt'),'Fabricated hidden edit\n');
  assert.equal(f.git(['status','--porcelain']).trim(),'');
  await assert.rejects(verifiedSourceCommit(f.dir),/tracked source bytes differ/);
});

test('clean-checkout CLI rebuilds a tampered ignored bundle and produces identical review artifacts',async t=>{
  const f=fixture(t,true);
  const run=()=>execFileSync(process.execPath,['tools/prepare-rb01-review.mjs'],{cwd:f.dir,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  run();
  const manifest=JSON.parse(readFileSync(join(f.dir,'release-review/manifest.json'),'utf8'));
  assert.equal(manifest.sourceCommit,f.commit);
  const first=readFileSync(join(f.dir,'release-review/SHA256SUMS'),'utf8');
  const candidate=JSON.parse(readFileSync(join(f.dir,'deployment/modules.json'),'utf8'));
  candidate['worker/state.mjs']+='\n// fabricated stale bundle alteration';
  writeFileSync(join(f.dir,'deployment/modules.json'),JSON.stringify(candidate));
  assert.equal(await verifiedSourceCommit(f.dir),f.commit,'ignored build output is not a tracked-source edit');
  run();
  assert.equal(readFileSync(join(f.dir,'release-review/SHA256SUMS'),'utf8'),first);
  assert(!readFileSync(join(f.dir,'release-review/candidate.modules.json'),'utf8').includes('fabricated stale bundle alteration'));
});
