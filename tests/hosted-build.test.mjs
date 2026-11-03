import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';
import {Script} from 'node:vm';
test('hosted packaging removes private inventory, has no embedded private source URLs, and contains all API modules',()=>{
 execFileSync(process.execPath,['tools/build-hosted-shell.mjs']);execFileSync(process.execPath,['tools/build-worker.mjs','--shell']);
 const src=readFileSync('hosted-dist/index.html','utf8');
 // Finance money formatting includes the JS String.replace `
 const match=src.match(/const SNAPSHOT=(\{.+?\});\s*const AREAS=/s);assert(match,'snapshot marker missing');
 const snap=JSON.parse(match[1]);
 assert.equal(snap.privateDataLoaded,false);assert.equal(snap.projects.length,0);assert.equal(snap.resources.length,0);
 assert(!/https:\/\/app\.notion\.com\/p\/[a-f0-9]{32}/i.test(src));
 assert(src.includes("connect-src 'self'"));assert(src.includes('Private storage connected')||src.includes('Private storage synced'));
 const bundle=JSON.parse(readFileSync('deployment/modules.json','utf8'));
 for(const name of ['index.mjs','worker/index.mjs','worker/access.mjs','worker/notifications.mjs','worker/state.mjs','worker/portfolio.mjs','worker/finance-readonly.mjs','worker/workspace.mjs','worker/workspace-journal.mjs','src/workspace-backup.mjs','foundation/src/foundation.mjs','foundation/src/access-scope-bridge.mjs','foundation/interop/approved-portfolio.mjs'])assert(Object.hasOwn(bundle,name),name);
 assert.equal(Object.keys(bundle).length,13);
 const assets=JSON.parse(bundle['index.mjs'].match(/const assets=(.*);\nexport default/s)[1]);
 for(const [name,size] of [['icon-192.png',192],['icon-512.png',512],['apple-touch-icon.png',180]]){
  const encoded=assets['/icons/'+name];assert.equal(encoded.type,'image/png');const bytes=Buffer.from(encoded.body,'base64');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);assert.deepEqual(bytes,readFileSync('pwa/icons/'+name));
 }
 assert.equal(assets['/LICENSE.txt'].body,readFileSync('LICENSE','utf8'));assert(src.includes('License and source'));
 assert(src.includes('station-finance'),'Finance section missing from hosted shell');
 assert(src.includes('StationFinance'),'Finance screen runtime missing from hosted shell');
 assert(src.includes('finance-grid'),'Finance responsive CSS missing from hosted shell');
 assert(src.includes('devonstation-financial-readonly-v1'),'Finance contract missing from hosted shell');
 const manifest=JSON.parse(assets['/manifest.webmanifest'].body);assert.equal(manifest.icons.length,2);assert(src.includes('rel="apple-touch-icon"'));
 assert(!bundle['index.mjs'].includes('privateDataLoaded\\":true'));
});
` token.
 // Literal insertion must never turn application source into trailing HTML.
 assert.equal((src.match(/<\/script>/g)||[]).length,1,'unexpected embedded closing script tag');
 const inline=src.match(/<script>([\s\S]*?)<\/script>/)?.[1];
 assert(inline,'hosted inline application script missing');
 assert(inline.includes("return (neg ? '-
 const match=src.match(/const SNAPSHOT=(\{.+?\});\s*const AREAS=/s);assert(match,'snapshot marker missing');
 const snap=JSON.parse(match[1]);
 assert.equal(snap.privateDataLoaded,false);assert.equal(snap.projects.length,0);assert.equal(snap.resources.length,0);
 assert(!/https:\/\/app\.notion\.com\/p\/[a-f0-9]{32}/i.test(src));
 assert(src.includes("connect-src 'self'"));assert(src.includes('Private storage connected')||src.includes('Private storage synced'));
 const bundle=JSON.parse(readFileSync('deployment/modules.json','utf8'));
 for(const name of ['index.mjs','worker/index.mjs','worker/access.mjs','worker/notifications.mjs','worker/state.mjs','worker/portfolio.mjs','worker/finance-readonly.mjs','worker/workspace.mjs','worker/workspace-journal.mjs','src/workspace-backup.mjs','foundation/src/foundation.mjs','foundation/src/access-scope-bridge.mjs','foundation/interop/approved-portfolio.mjs'])assert(Object.hasOwn(bundle,name),name);
 assert.equal(Object.keys(bundle).length,13);
 const assets=JSON.parse(bundle['index.mjs'].match(/const assets=(.*);\nexport default/s)[1]);
 for(const [name,size] of [['icon-192.png',192],['icon-512.png',512],['apple-touch-icon.png',180]]){
  const encoded=assets['/icons/'+name];assert.equal(encoded.type,'image/png');const bytes=Buffer.from(encoded.body,'base64');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);assert.deepEqual(bytes,readFileSync('pwa/icons/'+name));
 }
 assert.equal(assets['/LICENSE.txt'].body,readFileSync('LICENSE','utf8'));assert(src.includes('License and source'));
 assert(src.includes('station-finance'),'Finance section missing from hosted shell');
 assert(src.includes('StationFinance'),'Finance screen runtime missing from hosted shell');
 assert(src.includes('finance-grid'),'Finance responsive CSS missing from hosted shell');
 assert(src.includes('devonstation-financial-readonly-v1'),'Finance contract missing from hosted shell');
 const manifest=JSON.parse(assets['/manifest.webmanifest'].body);assert.equal(manifest.icons.length,2);assert(src.includes('rel="apple-touch-icon"'));
 assert(!bundle['index.mjs'].includes('privateDataLoaded\\":true'));
});
 : '
 const match=src.match(/const SNAPSHOT=(\{.+?\});\s*const AREAS=/s);assert(match,'snapshot marker missing');
 const snap=JSON.parse(match[1]);
 assert.equal(snap.privateDataLoaded,false);assert.equal(snap.projects.length,0);assert.equal(snap.resources.length,0);
 assert(!/https:\/\/app\.notion\.com\/p\/[a-f0-9]{32}/i.test(src));
 assert(src.includes("connect-src 'self'"));assert(src.includes('Private storage connected')||src.includes('Private storage synced'));
 const bundle=JSON.parse(readFileSync('deployment/modules.json','utf8'));
 for(const name of ['index.mjs','worker/index.mjs','worker/access.mjs','worker/notifications.mjs','worker/state.mjs','worker/portfolio.mjs','worker/finance-readonly.mjs','worker/workspace.mjs','worker/workspace-journal.mjs','src/workspace-backup.mjs','foundation/src/foundation.mjs','foundation/src/access-scope-bridge.mjs','foundation/interop/approved-portfolio.mjs'])assert(Object.hasOwn(bundle,name),name);
 assert.equal(Object.keys(bundle).length,13);
 const assets=JSON.parse(bundle['index.mjs'].match(/const assets=(.*);\nexport default/s)[1]);
 for(const [name,size] of [['icon-192.png',192],['icon-512.png',512],['apple-touch-icon.png',180]]){
  const encoded=assets['/icons/'+name];assert.equal(encoded.type,'image/png');const bytes=Buffer.from(encoded.body,'base64');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);assert.deepEqual(bytes,readFileSync('pwa/icons/'+name));
 }
 assert.equal(assets['/LICENSE.txt'].body,readFileSync('LICENSE','utf8'));assert(src.includes('License and source'));
 assert(src.includes('station-finance'),'Finance section missing from hosted shell');
 assert(src.includes('StationFinance'),'Finance screen runtime missing from hosted shell');
 assert(src.includes('finance-grid'),'Finance responsive CSS missing from hosted shell');
 assert(src.includes('devonstation-financial-readonly-v1'),'Finance contract missing from hosted shell');
 const manifest=JSON.parse(assets['/manifest.webmanifest'].body);assert.equal(manifest.icons.length,2);assert(src.includes('rel="apple-touch-icon"'));
 assert(!bundle['index.mjs'].includes('privateDataLoaded\\":true'));
});
) + whole"),
   'finance currency formatter corrupted by replacement-string expansion');
 assert(inline.includes('data-ws-project="${escape(p.projectId)}"'),
   'workspace source template disappeared from generated application');
 assert.doesNotThrow(()=>new Script(inline),'complete hosted script failed JS syntax validation');

 const match=src.match(/const SNAPSHOT=(\{.+?\});\s*const AREAS=/s);assert(match,'snapshot marker missing');
 const snap=JSON.parse(match[1]);
 assert.equal(snap.privateDataLoaded,false);assert.equal(snap.projects.length,0);assert.equal(snap.resources.length,0);
 assert(!/https:\/\/app\.notion\.com\/p\/[a-f0-9]{32}/i.test(src));
 assert(src.includes("connect-src 'self'"));assert(src.includes('Private storage connected')||src.includes('Private storage synced'));
 const bundle=JSON.parse(readFileSync('deployment/modules.json','utf8'));
 for(const name of ['index.mjs','worker/index.mjs','worker/access.mjs','worker/notifications.mjs','worker/state.mjs','worker/portfolio.mjs','worker/finance-readonly.mjs','worker/workspace.mjs','worker/workspace-journal.mjs','src/workspace-backup.mjs','foundation/src/foundation.mjs','foundation/src/access-scope-bridge.mjs','foundation/interop/approved-portfolio.mjs'])assert(Object.hasOwn(bundle,name),name);
 assert.equal(Object.keys(bundle).length,13);
 const assets=JSON.parse(bundle['index.mjs'].match(/const assets=(.*);\nexport default/s)[1]);
 for(const [name,size] of [['icon-192.png',192],['icon-512.png',512],['apple-touch-icon.png',180]]){
  const encoded=assets['/icons/'+name];assert.equal(encoded.type,'image/png');const bytes=Buffer.from(encoded.body,'base64');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);assert.deepEqual(bytes,readFileSync('pwa/icons/'+name));
 }
 assert.equal(assets['/LICENSE.txt'].body,readFileSync('LICENSE','utf8'));assert(src.includes('License and source'));
 assert(src.includes('station-finance'),'Finance section missing from hosted shell');
 assert(src.includes('StationFinance'),'Finance screen runtime missing from hosted shell');
 assert(src.includes('finance-grid'),'Finance responsive CSS missing from hosted shell');
 assert(src.includes('devonstation-financial-readonly-v1'),'Finance contract missing from hosted shell');
 const manifest=JSON.parse(assets['/manifest.webmanifest'].body);assert.equal(manifest.icons.length,2);assert(src.includes('rel="apple-touch-icon"'));
 assert(!bundle['index.mjs'].includes('privateDataLoaded\\":true'));
});
