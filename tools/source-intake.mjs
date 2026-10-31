/**
 * Offline source-import preflight. This is a publication gate, not a license,
 * data-classification certification or deployment authorization.
 * Never print scanned file contents, identifiers or secret values.
 */
import { readdir, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, join, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sensitivePath = [
  /^src\/snapshot\.json$/i,
  /^deployment\//i,
  /^recovery\//i,
  /^hosted-dist\//i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:node_modules|\.git)(?:\/|$)/i,
  /\.(?:sqlite3?|db|pem|key|p12|pfx|zip|bak)$/i,
  /(^|\/)(?:private-source-manifest|live-v03-modules)\./i
];
const textExtensions = new Set(['.mjs','.js','.html','.css','.json','.md','.sql','.yml','.yaml','.webmanifest','.txt','.py']);
const sensitiveContent = [
  { code: 'NOTION_PAGE_ID', pattern: /https?:\/\/(?:www\.)?notion\.(?:so|com)\/(?:[a-zA-Z0-9_-]+-)?[a-f0-9]{32}\b|https?:\/\/app\.notion\.com\/p\/[a-f0-9]{32}\b/i },
  { code: 'PRIVATE_KEY', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { code: 'TOKEN_SHAPED_VALUE', pattern: /(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{20,}/ },
  { code: 'D1_IDENTIFIER', pattern: /\bdatabase_id["']?\s*[:=]\s*["'][0-9a-f-]{36}\b/i }
];
const required = ['src/index.html','src/app.js','worker/access.mjs','tools/build-hosted-shell.mjs','package.json'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = name => name.split(sep).join('/');

export async function auditSourceIntake(candidate, { trustedVerifierPath } = {}) {
  const root = resolve(candidate);
  const blockers = [];
  const manualReview = [];
  const inventory = [];
  const add = (code,path) => blockers.push({code,path});
  let totalBytes = 0;
  const visited = new Set();
  async function walk(folder) {
    for (const entry of await readdir(folder, {withFileTypes:true})) {
      const path = join(folder, entry.name);
      const rel = normalize(relative(root, path));
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) { add('SYMLINK',rel); continue; }
      if (stat.isDirectory()) {
        if (sensitivePath.some(pattern=>pattern.test(rel+'/'))) {add('PRIVATE_PATH',rel+'/');continue;}
        await walk(path); continue;
      }
      if (!stat.isFile()) { add('UNEXPECTED_TYPE',rel); continue; }
      if (sensitivePath.some(pattern=>pattern.test(rel))) {add('PRIVATE_PATH',rel);continue;}
      totalBytes += stat.size;
      if (totalBytes>10_000_000 || stat.size>1_000_000) {add('SIZE_LIMIT',rel);continue;}
      visited.add(rel);
      inventory.push({path:rel, bytes:stat.size});
      if (/^pwa\/icons\/.*\.(?:png|svg|webp|ico)$/i.test(rel)) manualReview.push({code:'ICON_PROVENANCE',path:rel});
      if (!textExtensions.has(extname(rel).toLowerCase())) continue;
      const bytes = await readFile(path);
      if (bytes.includes(0)) {add('BINARY_IN_TEXT',rel);continue;}
      const text = bytes.toString('utf8');
      for (const {code,pattern} of sensitiveContent) if (pattern.test(text)) add(code,rel);
    }
  }
  await walk(root);
  for (const path of required) if(!visited.has(path))add('REQUIRED_MISSING',path);
  let manifest;
  try { manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8')); }
  catch {add('PACKAGE_UNREADABLE','package.json');}
  if(manifest && (!manifest.license || manifest.license==='UNLICENSED'))add('LICENSE_UNRESOLVED','package.json');
  if (!visited.has('LICENSE') && !visited.has('LICENSE.md') && !visited.has('LICENSE.txt')) add('LICENSE_TEXT_MISSING','LICENSE');
  if (Object.keys(manifest?.dependencies||{}).length || Object.keys(manifest?.devDependencies||{}).length) manualReview.push({code:'DEPENDENCY_RIGHTS',path:'package.json'});
  if (trustedVerifierPath) {
    try {
      const [proposed,reviewed]=await Promise.all([readFile(join(root,'worker/access.mjs')),readFile(trustedVerifierPath)]);
      if (sha256(proposed)!==sha256(reviewed)) add('AUTH_SOURCE_CONFLICT','worker/access.mjs');
    } catch {add('AUTH_COMPARE_UNAVAILABLE','worker/access.mjs');}
  }
  inventory.sort((a,b)=>a.path.localeCompare(b.path));
  blockers.sort((a,b)=>a.code.localeCompare(b.code)||a.path.localeCompare(b.path));
  manualReview.sort((a,b)=>a.code.localeCompare(b.code)||a.path.localeCompare(b.path));
  return {automatedPreflightPassed:blockers.length===0, manualReviewRequired:manualReview.length>0, publicationAuthorized:false,
    scannedFiles:inventory.length,totalBytes,blockers,manualReview};
}

// CLI is for offline owner review only. An automated PASS cannot replace
// provenance, license, legal approval, independent security or release checks.
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const candidate=process.argv[2];
  const trustedVerifierPath=process.argv[3];
  if(!candidate){console.error('Usage: node tools/source-intake.mjs <candidate-directory> [trusted-verifier-file]');process.exitCode=2;}
  else {
    try {
      const result=await auditSourceIntake(candidate,{trustedVerifierPath});
      console.log(JSON.stringify(result,null,2));
      process.exitCode=(result.automatedPreflightPassed&&!result.manualReviewRequired)?0:1;
    }catch(error){console.error('Source intake unavailable: '+error.message);process.exitCode=2;}
  }
}
