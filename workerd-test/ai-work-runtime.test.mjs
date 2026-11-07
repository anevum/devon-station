import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';import {Miniflare} from 'miniflare';
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=keys.publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'ai-fixture-key',alg:'RS256'});
const origin='https://station.example.test',issuer='https://ai-fixture.cloudflareaccess.com';
function token(sub='test-owner'){const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const data=enc({alg:'RS256',kid:jwk.kid})+'.'+enc({iss:issuer,aud:['ai-test'],sub,email:'owner@example.test',exp:Date.now()/1000+300});return data+'.'+sign('RSA-SHA256',Buffer.from(data),keys.privateKey).toString('base64url');}
const compatibilityDate=process.env.DS_WORKERD_COMPAT_DATE??'2026-07-30';
test(`workerd ${compatibilityDate}: real signed auth, native D1 encrypted jobs, CAS and restart recovery`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ds-ai-native-'));let external=0;
 const config={modules:true,modulesRoot:new URL('../',import.meta.url).pathname,scriptPath:new URL('./access-fixture.mjs',import.meta.url).pathname,
  compatibilityDate,compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],d1Persist:dir,
  bindings:{APP_ORIGIN:origin,OWNER_EMAIL:'owner@example.test',ACCESS_ISSUER:issuer,ACCESS_AUD:'ai-test',ACCESS_JWKS_URL:issuer+'/cdn-cgi/access/certs',
   AI_WORK_ENABLED:'true',AI_WORK_OWNER_SUB:'test-owner',AI_WORK_PROJECTS_JSON:'["devon-station"]',AI_WORK_KEY_ID:'ai-test',AI_WORK_KEYS_JSON:JSON.stringify({'ai-test':'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='})},
  outboundService:request=>{if(request.url===issuer+'/cdn-cgi/access/certs')return new Response(JSON.stringify({keys:[jwk]}));external++;throw Error('No provider or website request authorized');}};
 let mf=new Miniflare(config);
 const request=(path,body,sub)=>mf.dispatchFetch(origin+'/api/ai-work/'+path,{method:body?'POST':'GET',headers:{'Cf-Access-Jwt-Assertion':token(sub),...(body?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  let db=await mf.getD1Database('DB');const migration=await readFile(new URL('../worker/migrations/0010-ai-work-jobs.sql',import.meta.url),'utf8');
  for(const sql of migration.split('\n').filter(x=>!/^\s*--/.test(x)).join('\n').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  const p={jobId:crypto.randomUUID(),task:'NATIVE_PRIVATE_TASK',projectSlug:'devon-station',profile:'sandbox-build',spendLimitCents:50};
  assert.equal((await request('jobs',p)).status,200);
  assert.doesNotMatch((await db.prepare('SELECT payload FROM ai_work_jobs').first()).payload,/NATIVE_PRIVATE_TASK|sandbox-build/);
  assert.equal((await request('jobs',undefined,'other-owner-subject')).status,403);
  const responses=await Promise.all([request('jobs/'+p.jobId+'/decision',{expectedRevision:1,decision:'approve-plan'}),request('jobs/'+p.jobId+'/cancel',{expectedRevision:1})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  await mf.dispose();mf=new Miniflare(config);
  const saved=await(await request('jobs/'+p.jobId)).json();assert.equal(saved.job.task,p.task);assert.equal(saved.job.revision,2);assert.equal(saved.job.billingAuthorized,false);
  assert.equal((await request('jobs/'+p.jobId+'/execute',{expectedRevision:2})).status,503);
  db=await mf.getD1Database('DB');await db.prepare("UPDATE ai_work_jobs SET payload='tampered'").run();
  assert.equal((await request('jobs/'+p.jobId)).status,503);assert.equal(external,0);
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
