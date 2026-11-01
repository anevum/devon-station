import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateProject} from '../src/core.mjs';
export async function scaffold({output,id,name,owner,approver,source,kind='website',repo=null}){
 if(!['website','application','internal-tool','client'].includes(kind))throw Error('Unsupported project kind');
 if(!/^[A-Z][A-Z0-9-]{2,40}$/.test(id??''))throw Error('Use an explicit stable project ID');
 const p={id,name,owner,approver,area:'Devon Works',status:'Captured',stage:'Scope',next:'Confirm the scope and acceptance criteria',gate:'No spend, deployment, invitations or ownership change authorized by scaffolding',source,repo,dataClass:kind==='website'?'public':'synthetic-only',hosting:[],dependencies:[],completionEvidence:[],maintenance:{owner,renewal:null,nextReview:null}};
 validateProject(p);if(!approver)throw Error('Named approver required');
 const dest=resolve(output);let exists=false;try{await readdir(dest);exists=true}catch(e){if(e.code!=='ENOENT')throw e}if(exists)throw Error('Output directory already exists; refusing to overwrite');
 await mkdir(dest,{recursive:true});await mkdir(resolve(dest,'.github/workflows'),{recursive:true});await mkdir(resolve(dest,'docs'),{recursive:true});
 const files={'project.json':JSON.stringify(p,null,2)+'\n','package.json':JSON.stringify({name:id.toLowerCase(),version:'0.1.0',private:true,type:'module',scripts:{test:'node --test',dev:'node server.mjs'},license:'UNLICENSED'},null,2)+'\n','index.html':'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Independent project starter</title><body><h1>Define one useful outcome.</h1><p>Local synthetic development. No data connections.</p></body></html>\n','server.mjs':"import http from 'node:http';import {readFile} from 'node:fs/promises';http.createServer(async(req,res)=>{res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(await readFile(new URL('./index.html',import.meta.url)))}).listen(3000,'127.0.0.1');\n",'.gitignore':'node_modules/\n.env*\n!.env.example\n.local/\ndata/\n*.sqlite*\n','docs/acceptance.md':'# Acceptance contract\n\nWrite the outcome, exclusion, one critical workflow and test evidence before release. Record source commit, environment, migration, approval, deployment, rollback, recovery point and maintenance owner. No source metadata may imply permission to deploy.\n','.github/workflows/verify.yml':'name: Verify\non: [push, pull_request, workflow_dispatch]\npermissions:\n  contents: read\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: node --check server.mjs\n'};
 for(const [path,data] of Object.entries(files))await writeFile(resolve(dest,path),data,{flag:'wx'});
 return {path:dest,project:p,files:Object.keys(files)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=Object.fromEntries(process.argv.slice(2).map(x=>{const at=x.indexOf('=');if(at<0)throw Error('Use --key=value arguments');return[x.slice(2,at),x.slice(at+1)]}));
 if(!args.output)throw Error('--output is required');console.log(JSON.stringify(await scaffold(args),null,2));
}
