import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';
test('hosted packaging removes private inventory, has no embedded private source URLs, and contains all API modules',()=>{
 execFileSync(process.execPath,['tools/build-hosted-shell.mjs']);execFileSync(process.execPath,['tools/build-worker.mjs','--shell']);
 const src=readFileSync('hosted-dist/index.html','utf8');
 const match=src.match(/const SNAPSHOT=(\{.+?\});\s*const AREAS=/s);assert(match,'snapshot marker missing');
 const snap=JSON.parse(match[1]);
 assert.equal(snap.privateDataLoaded,false);assert.equal(snap.projects.length,0);assert.equal(snap.resources.length,0);
 assert(!/https:\/\/app\.notion\.com\/p\/[a-f0-9]{32}/i.test(src));
 assert(src.includes("connect-src 'self'"));assert(src.includes('Private storage connected')||src.includes('Private storage synced'));
 const bundle=JSON.parse(readFileSync('deployment/modules.json','utf8'));
 for(const name of ['index.mjs','worker/index.mjs','worker/access.mjs','worker/notifications.mjs','worker/state.mjs','worker/portfolio.mjs','worker/workspace.mjs','worker/workspace-journal.mjs','src/workspace-backup.mjs','foundation/src/foundation.mjs','foundation/src/access-scope-bridge.mjs','foundation/interop/approved-portfolio.mjs'])assert(Object.hasOwn(bundle,name),name);
 for(const name of ['worker/mail-api.mjs',...['mail-onboarding.mjs','mail-core.mjs','mail-readonly-service.mjs','mail-imap-readonly.mjs','mail-imap-transport.mjs','mail-mime-text.mjs','mail-d1-store.mjs','mail-sqlite-store.mjs','mail-mime-safe.mjs','mail-drafts.mjs'].map(name=>'src/communications/'+name)])assert(Object.hasOwn(bundle,name),name);
 for(const name of ['address-parser.mjs','base64-decoder.mjs','base64-encoder.mjs','chunk-writer.mjs','decode-strings.mjs','errors.mjs','html-entities.mjs','mime-node.mjs','otp-token.mjs','pass-through-decoder.mjs','postal-mime.mjs','qp-decoder.mjs','text-format.mjs','types.mjs'])assert(Object.hasOwn(bundle,'vendor/postal-mime/'+name),name);
 assert(Object.hasOwn(bundle,'worker/mail-drafts-api.mjs'));
 assert.equal(Object.keys(bundle).length,42);
 assert.match(bundle['index.mjs'],/^import \{connect\} from 'cloudflare:sockets';/);
 const assets=JSON.parse(bundle['index.mjs'].match(/const assets=(.*);\nexport default/s)[1]);
 for(const [name,size] of [['icon-192.png',192],['icon-512.png',512],['apple-touch-icon.png',180]]){
  const encoded=assets['/icons/'+name];assert.equal(encoded.type,'image/png');const bytes=Buffer.from(encoded.body,'base64');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);assert.deepEqual(bytes,readFileSync('pwa/icons/'+name));
 }
 assert.equal(assets['/LICENSE.txt'].body,readFileSync('LICENSE','utf8'));assert(src.includes('License and source'));
 const manifest=JSON.parse(assets['/manifest.webmanifest'].body);assert.equal(manifest.icons.length,2);assert(src.includes('rel="apple-touch-icon"'));
 assert(!bundle['index.mjs'].includes('privateDataLoaded\\":true'));
});
