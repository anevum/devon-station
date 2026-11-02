import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare,createFetchMock} from 'miniflare';
const origin='https://station.example.test',scope='scopeKind=personal&scopeId=personal-a';
const compatibilityDate=process.env.DS_WORKERD_COMPAT_DATE??'2026-07-30';
if(!['2026-07-30','2026-10-28'].includes(compatibilityDate))throw Error('Unsupported synthetic workerd compatibility date');
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=keys.publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'fixture-key',alg:'RS256'});
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
function jwt(subject='test-subject',overrides={}){const data=enc({alg:'RS256',kid:jwk.kid})+'.'+enc({iss:'https://synthetic.cloudflareaccess.com',aud:['synthetic-audience'],sub:subject,email:'owner@example.test',exp:Math.floor(Date.now()/1000)+300,...overrides});return data+'.'+sign('RSA-SHA256',Buffer.from(data),keys.privateKey).toString('base64url');}

function accessRuntime(network){
 return new Miniflare({modules:true,modulesRoot:new URL('../',import.meta.url).pathname,
  scriptPath:new URL('./access-fixture.mjs',import.meta.url).pathname,
  compatibilityDate,compatibilityFlags:['nodejs_compat'],...network,
  bindings:{APP_ORIGIN:origin,OWNER_EMAIL:'owner@example.test',
   ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_AUD:'synthetic-audience',
   ACCESS_JWKS_URL:'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs',PUBLIC_SERVICE_WORKER:'true'}});
}
const protectedRoutes=[
 ['GET','/'],['HEAD','/'],['GET','/manifest.webmanifest'],
 ['GET','/api/session'],['GET','/api/workspaces'],['GET','/api/workspace?'+scope],
 ['POST','/api/workspace/propose?'+scope],['POST','/api/workspace/decide?'+scope],
 ['GET','/api/workspace/review?'+scope],['POST','/api/workspace/reconcile?'+scope],
 ['GET','/api/workspace/backup?'+scope],['POST','/api/workspace/restore-review?'+scope],
 ['POST','/api/workspace/restore?'+scope],['GET','/api/state'],['POST','/api/state'],
 ['GET','/api/portfolio'],['POST','/api/portfolio/refresh'],['GET','/api/notifications/config'],
 ['POST','/api/notifications/subscribe'],['POST','/api/notifications/unsubscribe'],
 ['POST','/api/notifications/test'],['GET','/api/unknown']
];

test(`workerd ${compatibilityDate}: native portfolio refresh refuses redirects without replacing the previous cache or forwarding credentials`,async()=>{
 const source='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',token='synthetic-read-only-token';
 const project={object:'page',id:'synthetic-project',url:'https://www.notion.so/synthetic',
  properties:{Project:{type:'title',title:[{plain_text:'Synthetic portfolio project'}]}}};
 const payload=()=>JSON.stringify({results:[project],has_more:false,next_cursor:null});
 let requests=0,followed=false;
 const mf=new Miniflare({modules:true,modulesRoot:new URL('../',import.meta.url).pathname,
  scriptPath:new URL('./portfolio-fixture.mjs',import.meta.url).pathname,
  compatibilityDate,compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  bindings:{NOTION_PORTFOLIO_SOURCE_ID:source,NOTION_READ_TOKEN:token},
  outboundService:request=>{
   if(new URL(request.url).hostname==='untrusted.example.test'){
    followed=true;return new Response(payload());
   }
   assert.equal(request.url,`https://api.notion.com/v1/data_sources/${source}/query`);
   assert.equal(request.method,'POST');assert.equal(request.headers.get('Authorization'),'Bearer '+token);
   requests++;
   if(requests===2)return new Response(payload(),{status:302,headers:{Location:'https://untrusted.example.test/collect'}});
   if(requests===3)return new Response('unavailable',{status:503});
   return new Response(payload(),{headers:{'Content-Type':'application/json'}});
  }});
 try{
  assert.equal((await mf.dispatchFetch(origin+'/init')).status,200);
  const first=await mf.dispatchFetch(origin+'/refresh');assert.equal(first.status,200);
  const cached=await first.json();assert.equal(cached.projects.length,1);assert.equal(cached.notionWrites,false);
  for(let i=0;i<2;i++){
   const denied=await mf.dispatchFetch(origin+'/refresh');assert.equal(denied.status,502);
   assert.deepEqual(await denied.json(),{error:'notion_provider_error'});
   assert.deepEqual(await(await mf.dispatchFetch(origin+'/cache')).json(),cached);
  }
  assert.equal(followed,false);assert.equal(requests,3);
  const retry=await mf.dispatchFetch(origin+'/refresh');assert.equal(retry.status,200);
  assert.equal((await retry.json()).projects[0].name,'Synthetic portfolio project');
  assert.equal(requests,4);assert.equal(followed,false);
 }finally{await mf.dispose()}
});

test(`workerd ${compatibilityDate}: default signed-JWT auth fetches pinned JWKS and rejects nonowners across protected routes`,async()=>{
 const mock=createFetchMock();mock.disableNetConnect();
 mock.get('https://synthetic.cloudflareaccess.com').intercept({path:'/cdn-cgi/access/certs'})
  .reply(200,JSON.stringify({keys:[jwk]}),{headers:{'Content-Type':'application/json'}});
 const mf=accessRuntime({fetchMock:mock});
 try{
  const owner=await mf.dispatchFetch(origin+'/',{headers:{'Cf-Access-Jwt-Assertion':jwt()}});
  assert.equal(owner.status,200,'real default verifier must fetch keys successfully inside workerd');
  assert.equal(await owner.text(),'SYNTHETIC_PRIVATE_SHELL');
  const session=await mf.dispatchFetch(origin+'/api/session',{headers:{Cookie:'CF_Authorization='+jwt()}});
  assert.equal(session.status,200);assert.equal((await session.json()).authenticated,true);
  const identities=[
   [{},401],
   [{'Cf-Access-Authenticated-User-Email':'owner@example.test','X-Owner-Email':'owner@example.test'},401],
   [{'Cf-Access-Jwt-Assertion':jwt('other-subject',{email:'nonowner@example.test'})},403],
   [{Cookie:'CF_Authorization='+jwt('other-subject',{email:'nonowner@example.test'})},403],
   [{'Cf-Access-Jwt-Assertion':jwt('test-subject',{exp:1})},401],
   [{'Cf-Access-Jwt-Assertion':jwt('test-subject',{aud:['unrelated-app']})},401],
   [{'Cf-Access-Jwt-Assertion':jwt()+'broken'},401],
   [{'Cf-Access-Jwt-Assertion':'invalid-assertion',Cookie:'CF_Authorization='+jwt()},401],
   [{Cookie:'CF_Authorization='+jwt()+'; CF_Authorization='+jwt()},401]
  ];
  for(const [headers,status] of identities){
   for(const [method,path] of protectedRoutes){
    const response=await mf.dispatchFetch(origin+path,{method,headers:{...headers,Origin:origin,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    assert.equal(response.status,status,`${method} ${path} must reject invalid/nonowner identity`);
    assert.equal(response.headers.get('Cache-Control'),'no-store, private');
    assert(!/SYNTHETIC_PRIVATE|authenticated|publicKey/.test(await response.text()));
   }
  }
  const sw=await mf.dispatchFetch(origin+'/sw.js');
  assert.equal(sw.status,200);assert.equal(await sw.text(),'// synthetic public worker');
  mock.assertNoPendingInterceptors(); // One key fetch only: subsequent checks use the real cache.
 }finally{await mf.dispose();await mock.close()}
});

test(`workerd ${compatibilityDate}: JWKS redirect fails closed without following Location and a later direct retry recovers`,async()=>{
 let requests=0,followed=false;
 // Return HTTP responses directly at the network boundary. Miniflare's
 // fetchMock adapter uses a host fetch which can itself follow redirects.
 const mf=accessRuntime({outboundService:request=>{
  if(request.url==='https://untrusted.example.test/keys'){
   followed=true;return Response.json({keys:[jwk]});
  }
  assert.equal(request.url,'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs');
  if(++requests===1)return new Response(JSON.stringify({keys:[jwk]}),{
   status:302,headers:{Location:'https://untrusted.example.test/keys','Content-Type':'application/json'}});
  return Response.json({keys:[jwk]});
 }});
 try{
  const headers={'Cf-Access-Jwt-Assertion':jwt()};
  const denied=await mf.dispatchFetch(origin+'/',{headers});
  assert.equal(denied.status,401);assert(!/SYNTHETIC_PRIVATE/.test(await denied.text()));
  assert.equal(followed,false,'identity keys must never be accepted from a redirect target');
  const retry=await mf.dispatchFetch(origin+'/',{headers});
  assert.equal(retry.status,200,'failed JWKS promise must be evicted so direct-key retry works');
  assert.equal(await retry.text(),'SYNTHETIC_PRIVATE_SHELL');assert.equal(followed,false);
  assert.equal(requests,2,'one rejected redirect followed by one direct retry');
 }finally{await mf.dispose()}
});
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

test('workerd ' + compatibilityDate + ': Newsroom D1 publication, signed subjects, immutable revisions, and revocation',async()=>{
 const newsOrg='synthetic_newsroom';
 const schema=await readFile(new URL('../worker/migrations/0004-newsroom-p1a.sql',import.meta.url),'utf8');
 const mf=new Miniflare({modules:true,modulesRoot:new URL('../',import.meta.url).pathname,
  scriptPath:new URL('./newsroom-fixture.mjs',import.meta.url).pathname,
  compatibilityDate,compatibilityFlags:['nodejs_compat'],d1Databases:['NEWSROOM_DB'],
  bindings:{APP_ORIGIN:origin,NEWSROOM_SYNTHETIC_ONLY:'true',NEWSROOM_ORG_ID:newsOrg,
   ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_AUD:'synthetic-audience',
   ACCESS_JWKS_URL:'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs'},
  outboundService:req=>{
   assert.equal(req.url,'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs');
   return Response.json({keys:[jwk]});
  }});
 try{
  const db=await mf.getD1Database('NEWSROOM_DB');
  await db.prepare('CREATE TABLE legacy_canary (id INTEGER PRIMARY KEY, val TEXT)').run();
  await db.prepare('INSERT INTO legacy_canary(id,val) VALUES(1,?)').bind('preserved').run();
  await db.exec(schema);
  await db.prepare('INSERT INTO nr_organizations(org_id,label) VALUES(?,?)').bind(newsOrg,'Fictional Newsroom').run();
  for(const [sub,role,active] of [['publisher','publisher',1],['reader','reader',1],['revoked','reader',0]])
   await db.prepare('INSERT INTO nr_memberships(org_id,subject,role,active,created_at) VALUES(?,?,?,?,?)')
    .bind(newsOrg,sub,role,active,Date.now()).run();
  const call=(sub,method,path,payload,headers={})=>mf.dispatchFetch(origin+path,{method,
   headers:{'Cf-Access-Jwt-Assertion':jwt(sub),
    ...(payload===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},
   ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  assert.equal((await mf.dispatchFetch(origin+'/api/newsroom/editions')).status,401);
  assert.equal((await call('publisher','GET','/api/newsroom/editions',undefined,
   {'Cf-Access-Jwt-Assertion':jwt('publisher',{aud:['wrong-audience']})})).status,401);
  assert.equal((await call('outsider','GET','/api/newsroom/editions')).status,404);
  assert.equal((await call('revoked','GET','/api/newsroom/editions')).status,404);
  const manifest={schemaVersion:1,articles:[{id:'article-one',title:'Synthetic Article',blocks:[
   {id:'block-heading',type:'heading',text:'A synthetic issue'},
   {id:'block-paragraph',type:'paragraph',text:'Reading never grants approval.'}]}]};
  const newIssue=await call('publisher','POST','/api/newsroom/drafts',
   {slug:'synthetic-edition',title:'Synthetic Edition',manifest});
  assert.equal(newIssue.status,201,await newIssue.clone().text());
  const id=(await newIssue.json()).editionId;
  assert.equal((await call('reader','GET','/api/newsroom/drafts/'+id)).status,404);
  assert.equal((await call('reader','POST','/api/newsroom/drafts',
   {slug:'fake-edition',title:'Forged Role',manifest},{'X-Role':'publisher'})).status,404);
  const publish=(generation,operationId)=>call('publisher','POST','/api/newsroom/drafts/'+id+'/publish',
   {expectedGeneration:generation,operationId});
  const first=await publish(1,'native-operation-0001');assert.equal(first.status,201,await first.clone().text());
  const v1=await first.json();assert.equal(v1.version,1);
  const repeated=await publish(1,'native-operation-0001');assert.equal(repeated.status,201);
  assert.deepEqual(await repeated.json(),v1);
  const archived=await call('reader','GET','/api/newsroom/editions/'+id+'/revisions/1');
  assert.equal(archived.status,200);assert.equal((await archived.json()).revision.sha256,v1.sha256);
  const edited=structuredClone(manifest);
  edited.articles[0].blocks[1].text='A later correction keeps the original anchor.';
  assert.equal((await call('publisher','PUT','/api/newsroom/drafts/'+id,
   {expectedGeneration:1,manifest:edited})).status,200);
  const second=await publish(2,'native-operation-0002');assert.equal(second.status,201,await second.clone().text());
  const v2=await second.json();assert.equal(v2.version,2);assert.notEqual(v1.sha256,v2.sha256);
  const old=await call('reader','GET','/api/newsroom/editions/'+id+'/revisions/1');
  assert.equal((await old.json()).revision.sha256,v1.sha256);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM nr_revisions').first()).n,2);
  await assert.rejects(()=>db.prepare('DELETE FROM nr_revisions WHERE revision_id=?').bind(v1.revisionId).run());
  const exported=await call('reader','GET','/api/newsroom/editions/'+id+'/export');
  assert.equal(exported.status,200);assert.equal((await exported.json()).revisions.length,2);
  assert.equal((await db.prepare('SELECT val FROM legacy_canary WHERE id=1').first()).val,'preserved');
  await db.prepare('UPDATE nr_memberships SET active=0 WHERE org_id=? AND subject=?')
   .bind(newsOrg,'reader').run();
  assert.equal((await call('reader','GET','/api/newsroom/editions/'+id+'/revisions/1')).status,404);
 }finally{await mf.dispose()}
});
