import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildReleaseArtifacts} from '../tools/prepare-rb01-review.mjs';
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