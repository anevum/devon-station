/** Review-only RB01 packages. No Cloudflare calls, credentials, or deployment. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile, lstat} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const EXPECTED_MODULES = [
  'index.mjs', 'worker/index.mjs', 'worker/access.mjs',
  'worker/notifications.mjs', 'worker/state.mjs', 'worker/portfolio.mjs',
  'worker/workspace.mjs', 'worker/workspace-journal.mjs',
  'foundation/src/foundation.mjs', 'foundation/src/access-scope-bridge.mjs',
  'foundation/interop/approved-portfolio.mjs', 'src/workspace-backup.mjs'
];
const LEGACY_SHA256 = 'b2974dde4ca177420caecd810b8f008d582c93131317c6a822b5bb821c3c8c94';
const ACCESS_SHA256 = '1f3127c82f2079f82685f8f4ee56a82c390cf36dd7ef36273b4623e9ab3c9654';
const ACCESS_GIT_BLOB = '69ec253eddfe6ad26268bef2d2a270cd3faa947d';
const ALLOWED_ASSETS = [
  '/LICENSE.txt', '/index.html', '/manifest.webmanifest', '/sw.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const gitBlob = value => createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0' + value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
function insist(ok, message) { if (!ok) throw Error('RB01 review package refused: ' + message); }
export async function verifiedSourceCommit(checkoutRoot = root) {
  const git = args => execFileSync('git', args, {cwd: checkoutRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  let commit, entries;
  try {
    insist(!git(['status', '--porcelain=v1', '--untracked-files=all']).trim(), 'source checkout has uncommitted files');
    commit = git(['rev-parse', 'HEAD']).trim();
    insist(/^[a-f0-9]{40}$/.test(commit), 'source must have an exact commit');
    entries = git(['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0').filter(Boolean);
  } catch { throw Error('RB01 review package refused: source checkout is not clean and verifiable'); }
  // Check actual bytes, not just git status: assume-unchanged/skip-worktree
  // index flags can otherwise hide a local edit from ordinary diff checks.
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    insist(match, 'unsupported tracked source entry');
    try {
      const file = join(checkoutRoot, match[3]);
      const info = await lstat(file);
      insist(info.isFile() && !info.isSymbolicLink(), 'tracked source is not a regular file');
      const bytes = await readFile(file);
      const digest = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      insist(digest === match[2], 'tracked source bytes differ from the commit');
    } catch { throw Error('RB01 review package refused: tracked source bytes differ from the commit'); }
  }
  return commit;
}
function sortedDigestMap(entries) {
  return Object.fromEntries(entries.slice().sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, bytes]) => [name, sha256(bytes)]));
}
function unpackAssets(entry, requireHostedMarker = true) {
  const match = entry.match(/^import \{createStation\} from '\.\/worker\/index\.mjs';\nconst assets=(\{[^\n]*\});\nexport default createStation\(assets\);\n$/);
  insist(match, 'unexpected protected Worker entry template');
  const assets = JSON.parse(match[1]);
  insist(Object.keys(assets).length === 7 && Object.keys(assets).every(p => ALLOWED_ASSETS.includes(p)), 'unreviewed protected asset names');
  for (const asset of Object.values(assets)) {
    insist(asset && typeof asset.type === 'string' && typeof asset.body === 'string' && ['utf8', 'base64'].includes(asset.encoding), 'invalid asset encoding');
  }
  if (requireHostedMarker) insist(assets['/index.html'].body.includes('"privateDataLoaded":false'), 'hosted shell contains no private-data marker');
  insist(assets['/LICENSE.txt'].body.includes('GNU AFFERO GENERAL PUBLIC LICENSE'), 'AGPL license asset missing');
  return assets;
}
function entryFor(assets) {
  return "import {createStation} from './worker/index.mjs';\nconst assets=" + JSON.stringify(assets) + ";\nexport default createStation(assets);\n";
}
const fallbackHTML = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="robots" content="noindex,nofollow">',
  '<meta name="theme-color" content="#101926"><title>DevonStation | Guarded recovery mode</title>',
  '<link rel="icon" href="/icons/icon-192.png"><link rel="manifest" href="/manifest.webmanifest">',
  '<style>html{font-family:system-ui,sans-serif;color-scheme:dark;background:#101926;color:#f6f7fa}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:clamp(20px,5vw,48px);box-sizing:border-box}main{max-width:38rem;border:1px solid #455469;border-radius:20px;padding:clamp(22px,5vw,42px);background:#1b293b}h1{font-size:clamp(1.5rem,4vw,2rem)}p{line-height:1.65}a{color:#b6d5fa}small{color:#bbc6d3}a:focus-visible{outline:3px solid #f1d38c;outline-offset:4px}</style>',
  '</head><body><main role="main"><small>DEVONSTATION · GUARDED V0.3 FALLBACK</small>',
  '<h1>Temporary recovery mode</h1><p>New workspace editing and approvals are paused. Existing owner documents, the additive RB01 journal and decision receipts remain in private storage. This screen does not erase or restore data.</p>',
  '<p>Do not enter new work here. Resume normal use only after the current version is reaccepted. Notifications may remain registered under the existing settings.</p>',
  '<p><a href="/LICENSE.txt">License</a> · <a href="https://github.com/anevum/devon-station">Corresponding source</a></p>',
  '</main></body></html>'
].join('\n');
function describeBundle(modules, requireHostedMarker = true) {
  const assets = unpackAssets(modules['index.mjs'], requireHostedMarker);
  return {
    moduleCount: Object.keys(modules).length,
    assetCount: Object.keys(assets).length,
    modulesSha256: sortedDigestMap(Object.entries(modules)),
    assetsSha256: sortedDigestMap(Object.entries(assets).map(([path, value]) =>
      [path, Buffer.from(value.body, value.encoding === 'base64' ? 'base64' : 'utf8')]))
  };
}
export function buildReleaseArtifacts({candidate, legacyServer, accessModule, notificationsModule, sourceCommit}) {
  insist(/^[a-f0-9]{40}$/.test(sourceCommit), 'source must have an exact commit');
  insist(candidate && typeof candidate === 'object' && !Array.isArray(candidate), 'candidate JSON is invalid');
  insist(Object.keys(candidate).length === EXPECTED_MODULES.length && EXPECTED_MODULES.every(p => typeof candidate[p] === 'string'), 'candidate module graph changed');
  insist(sha256(legacyServer) === LEGACY_SHA256, 'legacy V0.3 entry fingerprint changed');
  insist(sha256(accessModule) === ACCESS_SHA256 && gitBlob(accessModule) === ACCESS_GIT_BLOB, 'reviewed hardened Access implementation changed');
  insist(candidate['worker/access.mjs'] === accessModule && candidate['worker/notifications.mjs'] === notificationsModule, 'candidate authentication or notifications differ from source');
  const assets = unpackAssets(candidate['index.mjs']);
  const guardedAssets = {...assets, '/index.html': {...assets['/index.html'], body: fallbackHTML}};
  const fallback = {
    'index.mjs': entryFor(guardedAssets),
    'worker/index.mjs': legacyServer,
    'worker/access.mjs': accessModule,
    'worker/notifications.mjs': notificationsModule
  };
  insist(!/\/api\/(?:workspace|state)/.test(fallbackHTML), 'fallback shell must not advertise RB01 APIs');
  for (const [name, modules] of [['candidate', candidate], ['fallback', fallback]]) {
    const value = JSON.stringify(modules);
    insist(!/https:\/\/app\.notion\.com\/p\/[a-f0-9]{32}/i.test(value) &&
      !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) &&
      !Object.values(modules).some(text => /"privateDataLoaded"\s*:\s*true/.test(text)), name + ' contains a forbidden private-data marker');
  }
  const candidateText = json(candidate);
  const fallbackText = json(fallback);
  const manifest = {
    schemaVersion: 1,
    status: 'REVIEW_ONLY_NOT_DEPLOYED_OR_ACCEPTED',
    license: 'AGPL-3.0-only',
    sourceCommit,
    sourceBranch: 'feature/ds011-rb01-integrated-review',
    provenance: {
      source: 'GitHub tracked checkout only; no private archives or provider exports',
      candidateBuilder: 'npm run build',
      reviewBuilder: 'node tools/prepare-rb01-review.mjs',
      pinnedLegacyServerSha256: LEGACY_SHA256,
      pinnedHardenedAccessSha256: ACCESS_SHA256,
      pinnedHardenedAccessGitBlob: ACCESS_GIT_BLOB
    },
    intendedIsolatedRuntime: {
      compatibilityDate: '2026-10-28',
      compatibilityFlags: ['nodejs_compat'],
      verifiedOnLiveOctoberRuntime: false,
      pinnedSyntheticWorkerdDate: '2026-07-30'
    },
    identityAndData: 'UNASSIGNED; independent Access origin, D1, identities and grants require separate approval',
    candidate: {file: 'candidate.modules.json', sha256: sha256(candidateText), ...describeBundle(candidate)},
    guardedFallback: {
      file: 'guarded-v03.modules.json', sha256: sha256(fallbackText),
      mode: 'Hardened V0.3 APIs with static read-only safety screen; degraded UI intentionally blocks editing',
      ...describeBundle(fallback, false)
    }
  };
  const manifestText = json(manifest);
  const files = {
    'candidate.modules.json': candidateText,
    'guarded-v03.modules.json': fallbackText,
    'manifest.json': manifestText
  };
  const sums = Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, body]) => sha256(body) + '  ' + name).join('\n') + '\n';
  return {files: {...files, 'SHA256SUMS': sums}, manifest};
}
async function main() {
  const sourceCommit = await verifiedSourceCommit();
  // Never trust an ignored deployment/modules.json left by an earlier build.
  // Both builders and the privacy scan use only this verified checkout.
  for (const script of ['build-hosted-shell.mjs', 'build-worker.mjs', 'verify-public-source.mjs']) {
    execFileSync(process.execPath, [join(root, 'tools', script), ...(script === 'build-worker.mjs' ? ['--shell'] : [])],
      {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  }
  const [candidateText, legacyServer, accessModule, notificationsModule] = await Promise.all([
    readFile(join(root, 'deployment/modules.json'), 'utf8'),
    readFile(join(root, 'legacy/v03/worker/index.mjs'), 'utf8'),
    readFile(join(root, 'worker/access.mjs'), 'utf8'),
    readFile(join(root, 'worker/notifications.mjs'), 'utf8')
  ]);
  const {files, manifest} = buildReleaseArtifacts({candidate: JSON.parse(candidateText), legacyServer, accessModule, notificationsModule, sourceCommit});
  insist(await verifiedSourceCommit() === sourceCommit, 'source changed while preparing the package');
  const dest = process.argv[2] ? resolve(process.argv[2]) : join(root, 'release-review');
  await mkdir(dest, {recursive: true});
  for (const [name, body] of Object.entries(files)) await writeFile(join(dest, name), body, {flag: 'w'});
  console.log('Review-only RB01 source ' + sourceCommit);
  console.log('Candidate SHA-256 ' + manifest.candidate.sha256 + ' (' + manifest.candidate.moduleCount + ' modules)');
  console.log('Guarded fallback SHA-256 ' + manifest.guardedFallback.sha256 + ' (' + manifest.guardedFallback.moduleCount + ' modules)');
  console.log('No target credentials, deployment, migration or real records are included.');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
