import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {createStation} from '../worker/index.mjs';
import {verifyAccessJWT} from '../worker/access.mjs';

const origin='https://station.example.test',owner={subject:'synthetic-owner',email:'owner@example.test'};
const scope={scopeKind:'personal',scopeId:'personal-a'};
const grant={subject:owner.subject,principalId:'owner-a',...scope,role:'owner'};
const projectGrant={principalId:grant.principalId,...scope,projectId:'project-a',area:'Devon Works'};
const project={id:'project-a',area:'Devon Works',name:'Synthetic recovery project',record:'https://www.notion.so/example-project',privateField:'excluded from workspace'};
export function database(path=':memory:'){
 const sqlite=new DatabaseSync(path);
 sqlite.exec(readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('../worker/migrations/0003-scoped-workspace.sql',import.meta.url),'utf8'));
 return {sqlite,close:()=>sqlite.close(),prepare(sql){return {bind(...args){return {first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}})};}}}};
}
const environment=DB=>({APP_ORIGIN:origin,OWNER_EMAIL:owner.email,DB,WORKSPACE_GRANTS:[grant],WORKSPACE_PROJECT_GRANTS:[projectGrant]});
const request=(path='/api/workspace',body,query=scope,headers={})=>new Request(origin+path+'?'+new URLSearchParams(query),body===undefined?{headers}:{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
function cache(DB,subject=owner.subject,rows=[project]){DB.sqlite.prepare('INSERT OR REPLACE INTO station_portfolio_cache(owner_sub,source_id,fetch_time,payload) VALUES(?,?,?,?)').run(subject,'synthetic-source',1793448000000,JSON.stringify(rows));}
const proposal=(generation=0,overrides={})=>({expectedGeneration:generation,input:{operationId:'op-propose',recordId:'action-a',projectId:'project-a',summary:'Review fabricated acceptance evidence',expectedRevision:0,...overrides}});
const decision=(generation=1,value='approved',overrides={})=>({expectedGeneration:generation,input:{operationId:'op-decide',recordId:'action-a',decision:value,expectedRevision:1,...overrides}});
function fixture(){const DB=database();cache(DB);let calls=0;const app=createStation({'/index.html':{type:'text/html',body:'<main>Recovered application fixture</main>'}},async()=>owner,async()=>{calls++;throw Error('external transport forbidden');});return {DB,app,env:environment(DB),calls:()=>calls};}
async function body(app,req,env,status=200){const response=await app.fetch(req,env,{});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}

test('unified Worker serves app and source-linked project, records approval and durable audit without external operations',async()=>{
 const f=fixture();try{
  assert.equal((await f.app.fetch(new Request(origin+'/'),f.env,{})).status,200);
  const initial=await body(f.app,request(),f.env);assert.equal(initial.generation,0);assert.equal(initial.projects[0].source.sourceUrl,project.record);assert(!JSON.stringify(initial).includes(project.privateField));
  const proposed=await body(f.app,request('/api/workspace/propose',proposal()),f.env);assert.equal(proposed.actions[0].status,'proposed');assert.equal(proposed.receipts.length,1);
  const approved=await body(f.app,request('/api/workspace/decide',decision()),f.env);assert.equal(approved.actions[0].status,'approved');assert.equal(approved.receipts[1].result,'approved');assert.equal(approved.execution,'record_only');assert.equal(f.calls(),0);
  assert.equal((await body(f.app,request(),f.env)).generation,2);
 }finally{f.DB.close();}
});
test('reject, duplicate retries, reused operation IDs and stale writes preserve a single auditable result',async()=>{
 const f=fixture();try{
  await body(f.app,request('/api/workspace/propose',proposal()),f.env);
  const rejected=await body(f.app,request('/api/workspace/decide',decision(1,'rejected')),f.env);assert.equal(rejected.actions[0].status,'rejected');
  const retry=await body(f.app,request('/api/workspace/propose',proposal()),f.env);assert.equal(retry.duplicate,true);assert.equal(retry.generation,2);assert.equal(retry.receipts.length,2);
  await body(f.app,request('/api/workspace/propose',proposal(2,{summary:'Changed payload'})),f.env,409);
  await body(f.app,request('/api/workspace/propose',proposal(0,{operationId:'another-op',recordId:'another-action'})),f.env,409);
  await body(f.app,request('/api/workspace/decide',decision(2,'approved',{operationId:'second-decision'})),f.env,409);
  assert.equal((await body(f.app,request(),f.env)).receipts.length,2);
 }finally{f.DB.close();}
});
test('state survives close/reopen of independent isolated SQLite connection',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ds-workspace-')),path=join(dir,'fabricated.sqlite');let DB=database(path);
 try{cache(DB);const app=createStation({},async()=>owner);await body(app,request('/api/workspace/propose',proposal()),environment(DB));DB.close();DB=database(path);
  const restored=await body(createStation({},async()=>owner),request(),environment(DB));assert.equal(restored.actions[0].summary,proposal().input.summary);assert.equal(restored.receipts.length,1);
  await body(app,request('/api/workspace/decide',decision()),environment(DB));
 }finally{DB.close();rmSync(dir,{recursive:true,force:true});}
});
test('additive scoped migration is repeatable and leaves recovered data and push rows unchanged',()=>{
 const DB=database();try{
  DB.sqlite.prepare('INSERT INTO station_documents(owner_sub,revision,payload,updated_at,last_operation) VALUES(?,?,?,?,?)').run(owner.subject,1,'{"synthetic":true}',1,'fixture-op');
  DB.sqlite.prepare('INSERT INTO push_devices(owner_sub,device_id,endpoint_hash,endpoint,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(owner.subject,'fixture-device','fixture-hash','https://web.push.apple.com/synthetic',1,1);
  cache(DB);
  const tables=['station_documents','push_devices','station_portfolio_cache'];
  const before=tables.map(name=>DB.sqlite.prepare('SELECT * FROM '+name).all());
  const migration=readFileSync(new URL('../worker/migrations/0003-scoped-workspace.sql',import.meta.url),'utf8');DB.sqlite.exec(migration);DB.sqlite.exec(migration);
  assert.deepEqual(tables.map(name=>DB.sqlite.prepare('SELECT * FROM '+name).all()),before);
 }finally{DB.close();}
});
test('subject, principal, business scope, origin and unknown-project isolation fail closed',async()=>{
 const f=fixture();try{
  const anon=createStation({});await body(anon,request(),f.env,401);
  const other=createStation({},async()=>({...owner,subject:'other-subject'}));await body(other,request(),f.env,403);
  assert.deepEqual((await body(other,request('/api/workspaces'),f.env)).scopes,[]);
  await body(f.app,request('/api/workspace',undefined,{scopeKind:'business',scopeId:'business-a'}),f.env,403);
  await body(f.app,request('/api/workspace/propose',proposal(),scope,{Origin:'https://evil.example.test'}),f.env,403);
  await body(f.app,request('/api/workspace/propose',proposal(0,{projectId:'unapproved'})),f.env,400);
  await body(f.app,request('/api/workspace/propose',{...proposal(),principalId:'intruder'}),f.env,400);
  await body(f.app,request('/api/workspace/propose',proposal()),f.env);
  const remapped={...f.env,WORKSPACE_GRANTS:[{...grant,principalId:'replacement'}],WORKSPACE_PROJECT_GRANTS:[{...projectGrant,principalId:'replacement'}]};
  await body(f.app,request(),remapped,503);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM station_workspace_state').get().n,1);
 }finally{f.DB.close();}
});
test('distinct approved subjects and business scopes keep journals separate',async()=>{
 const f=fixture();try{
  const second={subject:'synthetic-second',email:owner.email},business={scopeKind:'business',scopeId:'business-b'};
  const env={...f.env,WORKSPACE_GRANTS:[grant,{...grant,subject:second.subject,principalId:'second',...business}],WORKSPACE_PROJECT_GRANTS:[projectGrant,{...projectGrant,principalId:'second',...business}]};cache(f.DB,second.subject);
  await body(f.app,request('/api/workspace/propose',proposal()),env);
  const other=createStation({},async()=>second);
  assert.equal((await body(other,request('/api/workspace',undefined,business),env)).actions.length,0);
  await body(other,request('/api/workspace/propose',proposal(),business),env);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) n FROM station_workspace_state').get().n,2);
  await body(other,request(),env,403);
 }finally{f.DB.close();}
});
test('revoked scopes, removed project approval and altered source metadata stop reads and decisions',async()=>{
 const f=fixture();try{
  await body(f.app,request('/api/workspace/propose',proposal()),f.env);
  await body(f.app,request(),{...f.env,WORKSPACE_GRANTS:[]},403);
  await body(f.app,request('/api/workspace/decide',decision()),{...f.env,WORKSPACE_PROJECT_GRANTS:[]},409);
  cache(f.DB,owner.subject,[{...project,name:'Changed project'}]);await body(f.app,request(),f.env,409);
  cache(f.DB,owner.subject,[{...project,area:'Shinewell'}]);await body(f.app,request(),f.env,409);
 }finally{f.DB.close();}
});
test('refreshing observation time preserves authority; sensitive and malformed proposals never enter the journal',async()=>{
 const f=fixture();try{
  await body(f.app,request('/api/workspace/propose',proposal()),f.env);
  f.DB.sqlite.exec('UPDATE station_portfolio_cache SET fetch_time=fetch_time+1000');
  const refreshed=await body(f.app,request(),f.env);assert.equal(refreshed.actions.length,1);assert.equal(refreshed.projects[0].source.observedAt,new Date(1793448001000).toISOString());
  for(const summary of ['Synthetic patient record','password: fabricated-value','ghp_'+'x'.repeat(30)])await body(f.app,request('/api/workspace/propose',proposal(1,{operationId:'unsafe',recordId:'unsafe',summary})),f.env,400);
  assert.equal((await body(f.app,request(),f.env)).receipts.length,1);
 }finally{f.DB.close();}
});
test('integrity corruption, storage failure and racing compare-and-swap never return successful unpersisted receipts',async()=>{
 const f=fixture();try{
  await body(f.app,request('/api/workspace/propose',proposal()),f.env);
  const before=f.DB.sqlite.prepare('SELECT snapshot FROM station_workspace_state').get().snapshot;
  f.DB.sqlite.exec("CREATE TRIGGER fail_write BEFORE UPDATE ON station_workspace_state BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;");
  await body(f.app,request('/api/workspace/decide',decision()),f.env,500);
  assert.equal(f.DB.sqlite.prepare('SELECT snapshot FROM station_workspace_state').get().snapshot,before);
  f.DB.sqlite.exec('DROP TRIGGER fail_write');
  const results=await Promise.all([f.app.fetch(request('/api/workspace/decide',decision()),f.env,{}),f.app.fetch(request('/api/workspace/decide',decision(1,'rejected',{operationId:'racing-op'})),f.env,{})]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  f.DB.sqlite.exec("UPDATE station_workspace_state SET snapshot='{}'");await body(f.app,request(),f.env,503);
 }finally{f.DB.close();}
});
test('full signed synthetic Access validation precedes trusted scope mapping; forged and expired tokens denied',async()=>{
 const f=fixture(),keys=generateKeyPairSync('rsa',{modulusLength:2048});try{
  const jwk=keys.publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'workspace-test',alg:'RS256'});
  const config={issuer:'https://synthetic.cloudflareaccess.com',audience:'workspace-test',jwksUrl:'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs'};
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const token=(overrides={})=>{const data=encode({alg:'RS256',kid:jwk.kid})+'.'+encode({iss:config.issuer,aud:[config.audience],sub:owner.subject,email:owner.email,exp:Date.now()/1000+300,...overrides});return data+'.'+sign('RSA-SHA256',Buffer.from(data),keys.privateKey).toString('base64url');};
  const app=createStation({},req=>verifyAccessJWT(req.headers.get('Cf-Access-Jwt-Assertion'),config,async()=>({keys:[jwk]})));
  const signed=token();const req=jwt=>request('/api/workspace',undefined,scope,{'Cf-Access-Jwt-Assertion':jwt});
  await body(app,req(signed),f.env);await body(app,req(token({exp:1})),f.env,401);await body(app,req(token({sub:'not-granted'})),f.env,403);
  const parts=signed.split('.');parts[1]=encode({sub:owner.subject,email:owner.email,exp:Date.now()/1000+300});await body(app,req(parts.join('.')),f.env,401);
 }finally{f.DB.close();}
});
