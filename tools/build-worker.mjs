import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
const base=new URL('../',import.meta.url),root=resolve(base.pathname),assets={},sourceDirectory=process.argv.includes('--shell')?'hosted-dist':'dist';
async function add(path){for(const entry of await readdir(path,{withFileTypes:true})){const file=resolve(path,entry.name);if(entry.isDirectory())await add(file);else{const name='/'+relative(resolve(root,sourceDirectory),file);if(!['/LICENSE.txt','/index.html','/manifest.webmanifest','/sw.js','/icons/icon-192.png','/icons/icon-512.png','/icons/apple-touch-icon.png'].includes(name))continue;const binary=name.endsWith('.png');assets[name]={type:name==='/LICENSE.txt'?'text/plain;charset=utf-8':binary?'image/png':name.endsWith('.webmanifest')?'application/manifest+json;charset=utf-8':name.endsWith('.js')?'text/javascript;charset=utf-8':'text/html;charset=utf-8',encoding:binary?'base64':'utf8',body:await readFile(file,binary?'base64':'utf8')}}}}
await add(resolve(root,sourceDirectory));const modules={'index.mjs':"import {connect} from 'cloudflare:sockets';\nimport {createStation} from './worker/index.mjs';\nconst assets="+JSON.stringify(assets)+";\nexport default createStation(assets,undefined,undefined,connect);\n"};for(const name of ['index.mjs','access.mjs','notifications.mjs','state.mjs','portfolio.mjs','workspace.mjs','workspace-journal.mjs'])modules['worker/'+name]=await readFile(resolve(root,'worker',name),'utf8');
for(const name of ['src/foundation.mjs','src/access-scope-bridge.mjs','interop/approved-portfolio.mjs'])modules['foundation/'+name]=await readFile(resolve(root,'foundation',name),'utf8');
modules['src/workspace-backup.mjs']=await readFile(resolve(root,'src/workspace-backup.mjs'),'utf8');
modules['worker/mail-api.mjs']=await readFile(resolve(root,'worker/mail-api.mjs'),'utf8');
modules['worker/mail-outbox-api.mjs']=await readFile(resolve(root,'worker/mail-outbox-api.mjs'),'utf8');
modules['worker/mail-drafts-api.mjs']=await readFile(resolve(root,'worker/mail-drafts-api.mjs'),'utf8');
for(const name of ['mail-onboarding.mjs','mail-core.mjs','mail-readonly-service.mjs','mail-imap-readonly.mjs','mail-imap-transport.mjs','mail-mime-text.mjs','mail-d1-store.mjs','mail-sqlite-store.mjs','mail-mime-safe.mjs','mail-drafts.mjs','mail-outbound-wire.mjs','mail-smtp-transport.mjs','mail-outbox.mjs','mail-payload-crypto.mjs']){
 modules['src/communications/'+name]=await readFile(resolve(root,'src','communications',name),'utf8');
}
for(const name of ['address-parser.mjs','base64-decoder.mjs','base64-encoder.mjs','chunk-writer.mjs','decode-strings.mjs','errors.mjs','html-entities.mjs','mime-node.mjs','otp-token.mjs','pass-through-decoder.mjs','postal-mime.mjs','qp-decoder.mjs','text-format.mjs','types.mjs']){
 modules['vendor/postal-mime/'+name]=await readFile(resolve(root,'vendor','postal-mime',name),'utf8');
}
await mkdir(resolve(root,'deployment'),{recursive:true});await writeFile(resolve(root,'deployment/modules.json'),JSON.stringify(modules));console.log('Built protected Worker with '+Object.keys(assets).length+' assets and '+Object.keys(modules).length+' modules');
