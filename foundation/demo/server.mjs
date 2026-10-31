import { createServer } from 'node:http';
import { randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openSyntheticAdapter } from '../src/synthetic-adapter.mjs';

const owner = {principalId:'demo-owner',role:'owner',scopeKind:'personal',scopeId:'demo-scope'};
const otherOwner = {principalId:'other-owner',role:'owner',scopeKind:'personal',scopeId:'other-scope'};
const projects = [
  {projectId:'studio',scopeKind:'personal',scopeId:'demo-scope',title:'Creative Studio',freshness:'cached',source:{sourceSystem:'notion',sourceType:'project',sourceId:'synthetic-studio',sourceRevision:'rev1',sourceUrl:'https://www.notion.so/example',observedAt:'2026-01-01T00:00:00.000Z'}},
  {projectId:'home',scopeKind:'personal',scopeId:'demo-scope',title:'Home Systems',freshness:'cached',source:{sourceSystem:'notion',sourceType:'project',sourceId:'synthetic-home',sourceRevision:'rev1',sourceUrl:'https://www.notion.so/example',observedAt:'2026-01-01T00:00:00.000Z'}}
];
const assets = new Map(await Promise.all(['index.html','app.js','style.css'].map(async name=>[name,await readFile(new URL(name,import.meta.url),'utf8')])));
// Dependency injection is available only to trusted local test code, never request data.
export async function startDemo({db: suppliedDb, identity = owner, approvedSyntheticProjects} = {}) {
  // Test-injected projections are only allowed for the personal demo owner,
  // from trusted local tests. Never accept them over HTTP or with real data.
  if(approvedSyntheticProjects!==undefined &&
    (!Array.isArray(approvedSyntheticProjects) ||
      !Object.keys(owner).every(k=>identity?.[k]===owner[k]) ||
      Object.keys(identity).length!==4)) throw new Error('invalid synthetic project injection');
  if (![owner,otherOwner].some(allowed => Object.keys(allowed).every(k=>identity?.[k]===allowed[k]) && Object.keys(identity).length===4)) throw new Error('invalid synthetic identity');
  const db=suppliedDb ?? new DatabaseSync(':memory:');
  const token=randomBytes(32).toString('hex'), keys=generateKeyPairSync('ed25519');
  const activeProjects=approvedSyntheticProjects===undefined?projects:approvedSyntheticProjects;
  const otherProjects=projects.map(p=>({...p,scopeId:otherOwner.scopeId}));
  const store=openSyntheticAdapter({db,publicKey:keys.publicKey,issuer:'demo-issuer',audience:'demo-app',grants:[owner,otherOwner],seeds:[{identity:owner,projects:activeProjects},{identity:otherOwner,projects:otherProjects}]});
  // This test issuer is process-local, not an authentication mechanism for real users.
  const assertion=()=>{const now=Math.floor(Date.now()/1000);const payload=Buffer.from(JSON.stringify({iss:'demo-issuer',aud:'demo-app',sub:identity.principalId,scopeKind:identity.scopeKind,scopeId:identity.scopeId,iat:now,exp:now+60}));return `${payload.toString('base64url')}.${sign(null,payload,keys.privateKey).toString('base64url')}`;};
  let origin;
  const server=createServer(async (req,res)=>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'Cross-Origin-Resource-Policy':'same-origin'};
    const send=(status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{...headers,'Content-Type':type});res.end(body);};
    if(req.headers.host!==new URL(origin).host) return send(403,'Forbidden','text/plain');
    if(req.method==='GET' && ['/','/app.js','/style.css'].includes(req.url)) {
      const name=req.url==='/'?'index.html':req.url.slice(1);
      const body=name==='index.html'?assets.get(name).replace('__SESSION_TOKEN__',token):assets.get(name);
      return send(200,body,name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');
    }
    if((req.method!=='GET' && req.headers.origin!==origin) || req.headers['x-demo-token']!==token) return send(403,JSON.stringify({error:'Forbidden'}));
    if(req.method==='GET' && req.url==='/api/state') { try { return send(200,JSON.stringify(store.read(assertion()))); } catch { return send(503,JSON.stringify({error:'Synthetic workspace unavailable'})); } }
    if(req.method!=='POST' || !['/api/proposals','/api/decisions'].includes(req.url) || req.headers['content-type']!=='application/json') return send(404,JSON.stringify({error:'Not found'}));
    try {
      let size=0, chunks=[];
      for await (const chunk of req) { size+=chunk.length; if(size>4096) return send(413,JSON.stringify({error:'Request too large'})); chunks.push(chunk); }
      const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      if(!data || typeof data!=='object' || Array.isArray(data)) throw new Error('invalid');
      let receipt;
      if(req.url==='/api/proposals') {
        if(Object.keys(data).sort().join(',')!=='generation,operationId,projectId,recordId,summary') throw new Error('invalid');
        receipt=store.mutate(assertion(),data.generation,'propose',{operationId:data.operationId,recordId:data.recordId,projectId:data.projectId,summary:data.summary,expectedRevision:0}).receipt;
      } else {
        if(Object.keys(data).sort().join(',')!=='decision,generation,operationId,recordId,revision') throw new Error('invalid');
        receipt=store.mutate(assertion(),data.generation,'decide',{operationId:data.operationId,recordId:data.recordId,decision:data.decision,expectedRevision:data.revision}).receipt;
      }
      return send(200,JSON.stringify({receipt}));
    } catch { return send(400,JSON.stringify({error:'Could not save. Check the action and try again.'})); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  return {origin,close:()=>new Promise((resolve,reject)=>server.close(e=>{if(!suppliedDb)db.close();e?reject(e):resolve();}))};
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const demo=await startDemo(); console.log(`Synthetic demo: ${demo.origin}`); console.log('Local temporary data only. Press Ctrl+C to stop.');
}
