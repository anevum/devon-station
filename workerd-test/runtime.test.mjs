import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare} from 'miniflare';
const origin='https://station.example.test',scope='scopeKind=personal&scopeId=personal-a';
const compatibilityDate=process.env.DS_WORKERD_COMPAT_DATE??'2026-07-30';
if(!['2026-07-30','2026-10-28'].includes(compatibilityDate))throw Error('Unsupported synthetic workerd compatibility date');
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=keys.publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'fixture-key',alg:'RS256'});
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
function jwt(subject='test-subject',overrides={}){const data=enc({alg:'RS256',kid:jwk.kid})+'.'+enc({iss:'https://synthetic.cloudflareaccess.com',aud:['synthetic-audience'],sub:subject,email:'owner@example.test',exp:Math.floor(Date.now()/1000)+300,...overrides});return data+'.'+sign('RSA-SHA256',Buffer.from(data),keys.privateKey).toString('base64url');}
test(`workerd ${compatibilityDate}: signed owner, local D1 journal, source review and empty-target recovery contract`,async()=>{
 const schema=await readFile(new URL('../worker/schema.sql',import.meta.url),'utf8')+'\n'+await readFile(new URL('../worker/migrations/0003-scoped-workspace.sql',import.meta.url),'utf8');
 const options={modules:true,modulesRoot:new URL('../',import.meta.url).pathname,scriptPath:new URL('./fixture.mjs',import.meta.url).pathname,compatibilityDate,compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{APP_ORIGIN:origin,OWNER_EMAIL:'owner@example.test',FIXTURE_JWK:jwk,FIXTURE_SCHEMA:schema,WORKSPACE_GRANTS:[{subject:'test-subject',principalId:'owner-a',scopeKind:'personal',scopeId:'personal-a',role:'owner'}],WORKSPACE_PROJECT_GRANTS:[{principalId:'owner-a',scopeKind:'personal',scopeId:'personal-a',projectId:'project-a',area:'Devon Works'}]}};
 const mf=new Miniflare(options);let target;
 try{
  assert.equal((await mf.dispatchFetch(origin+'/fixture/init',{method:'POST'})).status,200);
  const request=async(path,body,token=jwt())=>mf.dispatchFetch(origin+path,{method:body?'POST':'GET',headers:{'Cf-Access-Jwt-Assertion':token,...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await request('/api/workspace?'+scope,undefined,jwt('other-subject'))).status,403);
  assert.equal((await request('/api/workspace?'+scope,undefined,jwt('test-subject',{exp:1}))).status,401);
  const read=await request('/api/workspace?'+scope);assert.equal(read.status,200);assert.equal((await read.json()).projects[0].projectId,'project-a');
  const proposal={expectedGeneration:0,input:{operationId:'fixture-propose',recordId:'fixture-action',projectId:'project-a',summary:'Review synthetic workerd evidence',expectedRevision:0}};
  const proposed=await request('/api/workspace/propose?'+scope,proposal);assert.equal(proposed.status,200);assert.equal((await proposed.json()).actions[0].status,'proposed');
  const decided=await request('/api/workspace/decide?'+scope,{expectedGeneration:1,input:{operationId:'fixture-decision',recordId:'fixture-action',decision:'approved',expectedRevision:1}});assert.equal(decided.status,200);assert.equal((await decided.json()).receipts.length,2);
  const backup=await (await request('/api/workspace/backup?'+scope)).json();const review=await request('/api/workspace/restore-review?'+scope,{backup});assert.equal(review.status,200);assert.equal((await review.json()).canRestore,false);
  const retry=await request('/api/workspace/propose?'+scope,proposal);assert.equal((await retry.json()).duplicate,true);
  target=new Miniflare(options);assert.equal((await target.dispatchFetch(origin+'/fixture/init',{method:'POST'})).status,200);
  const targetRequest=(path,body)=>target.dispatchFetch(origin+path,{method:body?'POST':'GET',headers:{'Cf-Access-Jwt-Assertion':jwt(),...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const preview=await (await targetRequest('/api/workspace/restore-review?'+scope,{backup})).json();assert.equal(preview.canRestore,true);
  const restored=await targetRequest('/api/workspace/restore?'+scope,{expectedGeneration:0,operationId:'restore-test',reviewDigest:preview.reviewDigest,backup});assert.equal(restored.status,200);const result=await restored.json();assert.equal(result.receipts.length,2);assert.equal(result.journalEvents[0].kind,'restore');
  assert.equal((await mf.dispatchFetch(origin+'/fixture/rename',{method:'POST'})).status,200);
  assert.equal((await request('/api/workspace?'+scope)).status,409);
  const sourceReview=await (await request('/api/workspace/review?'+scope)).json();assert.equal(sourceReview.changes[0].kind,'changed');
  const reconciled=await request('/api/workspace/reconcile?'+scope,{expectedGeneration:2,operationId:'source-review',reviewDigest:sourceReview.reviewDigest});assert.equal(reconciled.status,200);const updated=await reconciled.json();assert.equal(updated.receipts.length,2);assert.equal(updated.projects[0].title,'Updated synthetic project');
 }finally{if(target)await target.dispose();await mf.dispose();}
});
