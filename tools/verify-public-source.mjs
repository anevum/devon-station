import {readdir,readFile,stat} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';

const root=resolve(new URL('..',import.meta.url).pathname);
const forbiddenFiles=[
 'src/snapshot.json', 'PRIVATE-SOURCE-MANIFEST.json',
 'recovery/live-v03-modules.json','deployment/production-after-migration-2026-10-29.json',
];
const directSecrets=[
 {label:'private Notion page identifier',pattern:/https?:\/\/app\.notion\.com\/p\/[a-f0-9]{32}/i},
 {label:'embedded D1 database identity',pattern:/database_id[\"']?\s*[:=]\s*[\"'][0-9a-f-]{36}/i},
 {label:'token-shaped credential',pattern:/(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{20,}/},
 {label:'private key material',pattern:/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/},
 ];
const ignoreDirs=new Set(['node_modules','.git','deployment','dist','hosted-dist','release-review']);
const unreviewedLegacyCopy=/private evening review|live release differs from main|28 OCT 2026/i;
const scanText=(rel,text)=>{
 for(const {label,pattern} of directSecrets){if(pattern.test(text))throw Error(label+' in '+rel)}
 if(rel.startsWith('src/')&&unreviewedLegacyCopy.test(text))throw Error('Archived operational copy in '+rel);
};
let files=0;
async function inspect(dir){
 for(const item of await readdir(dir,{withFileTypes:true})){
  const abs=join(dir,item.name), rel=relative(root,abs).replaceAll('\\','/');
  if(item.isSymbolicLink()) throw Error('Unexpected symlink: '+rel);
  if(item.isDirectory()){
   if(!ignoreDirs.has(item.name))await inspect(abs);
   continue;
  }
  if(!item.isFile())throw Error('Unexpected file kind: '+rel);
  if(forbiddenFiles.includes(rel))throw Error('Private file in candidate: '+rel);
  ++files;
  const s=await stat(abs);
  if(s.size>200000 && !/\.png$/.test(rel))throw Error('Unexpected oversized source file: '+rel);
  if(/\.(mjs|js|json|html|md|css|py|sql|webmanifest|yml|yaml|txt)$/.test(rel)){
   const text=await readFile(abs,'utf8');
   scanText(rel,text);
  }
 }
}
await inspect(root);
// Generated outputs are not Git-tracked, but inspect them before preparing any release.
const deployment=join(root,'deployment');
try{
 const entries=await readdir(deployment);
 const unexpected=entries.filter(name=>name!=='modules.json'&&!/^v0[0-9]{1,2}-[a-z0-9-]+\.png$/i.test(name));
 if(unexpected.length)throw Error('Unexpected deployment artifact: '+unexpected.join(', '));
 const modules=JSON.parse(await readFile(join(deployment,'modules.json'),'utf8'));
 if(!modules||typeof modules!=='object'||Object.values(modules).some(value=>typeof value!=='string'))throw Error('Invalid generated Worker modules');
 for(const [name,value] of Object.entries(modules))scanText('deployment/modules.json:'+name,value);
 console.log('Generated Worker modules scanned: '+Object.keys(modules).length);
}catch(error){if(error?.code==='ENOENT')console.log('Generated Worker bundle not present; source only checked.');else throw error;}
const hosted=join(root,'hosted-dist/index.html');
try{
 const html=await readFile(hosted,'utf8');
 if(!html.includes('"privateDataLoaded":false'))throw Error('Hosted shell does not disable embedded private source');
 if(/"privateDataLoaded":true|app\.notion\.com\/p\/[a-f0-9]{32}/i.test(html))throw Error('Private identifiers in hosted bundle');
 console.log('Hosted shell verified as private-data free.');
}catch(error){if(error?.code==='ENOENT')console.log('Hosted build not present; source only checked.');else throw error;}
console.log('Privacy boundary check passed: '+files+' source files.');
