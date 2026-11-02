import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createStation} from '../worker/index.mjs';
import {verifyAccessJWT} from '../worker/access.mjs';
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=keys.publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'offline-browser',alg:'RS256'});
const config={issuer:'https://offline.cloudflareaccess.com',audience:'offline-browser',jwksUrl:'https://offline.cloudflareaccess.com/cdn-cgi/access/certs'};
export function token(subject='test-owner',overrides={}){const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const data=encode({alg:'RS256',kid:jwk.kid})+'.'+encode({iss:config.issuer,aud:[config.audience],sub:subject,email:'owner@example.test',exp:Date.now()/1000+300,...overrides});return data+'.'+sign('RSA-SHA256',Buffer.from(data),keys.privateKey).toString('base64url');}
export async function start(path){
 const sqlite=new DatabaseSync(path);sqlite.exec(readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8'));sqlite.exec(readFileSync(new URL('../worker/migrations/0003-scoped-workspace.sql',import.meta.url),'utf8'));
 const rows=[{id:'project-a',name:'Recovery acceptance',area:'Devon Works',record:'https://www.notion.so/synthetic-project-a'},{id:'project-b',name:'Portable workspace',area:'Devon Works',record:'https://www.notion.so/synthetic-project-b'}];
 sqlite.prepare('INSERT OR IGNORE INTO station_portfolio_cache(owner_sub,source_id,fetch_time,payload) VALUES(?,?,?,?)').run('test-owner','synthetic-source',1793448000000,JSON.stringify(rows));
 const DB={prepare(sql){return {bind(...args){return {first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}})};}}},async batch(items){sqlite.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const modules=JSON.parse(readFileSync(new URL('../deployment/modules.json',import.meta.url),'utf8'));
 const match=modules['index.mjs'].match(/const assets=(.*);\nexport default/s);const assets=JSON.parse(match[1]);
 const grants=[{subject:'test-owner',principalId:'owner-a',scopeKind:'personal',scopeId:'personal-a',role:'owner'}];
 let externalCalls=0;
 const app=createStation(assets,request=>verifyAccessJWT(request.headers.get('Cf-Access-Jwt-Assertion'),config,async()=>({keys:[jwk]})),async()=>{externalCalls++;throw Error('forbidden external operation');});
 let env;
 const server=createServer(async(req,res)=>{
  try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);const r=new Request(env.APP_ORIGIN+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{})});const response=await app.fetch(r,env,{});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 env={APP_ORIGIN:'http://127.0.0.1:'+server.address().port,OWNER_EMAIL:'owner@example.test',DB,WORKSPACE_GRANTS:grants,WORKSPACE_PROJECT_GRANTS:rows.map(p=>({principalId:'owner-a',scopeKind:'personal',scopeId:'personal-a',projectId:p.id,area:p.area}))};
 return {url:env.APP_ORIGIN,env,externalCalls:()=>externalCalls,close:async()=>{await new Promise(resolve=>server.close(resolve));sqlite.close();}};
}
