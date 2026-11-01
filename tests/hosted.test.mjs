import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {createStation} from '../worker/index.mjs';import {verifyAccessJWT} from '../worker/access.mjs';import {validEndpoint,vapidToken,sendGenericPush,PushDispatchError} from '../worker/notifications.mjs';
const origin='https://devon-station.example.test';
function db(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8'));
 return {
  prepare(sql){return {bind(...args){return {
   first:async()=>sqlite.prepare(sql).get(...args)??null,
   all:async()=>({results:sqlite.prepare(sql).all(...args)}),
   run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}})
  }}}},
  async batch(rows){sqlite.exec('BEGIN');try{const result=[];for(const row of rows)result.push(await row.run());sqlite.exec('COMMIT');return result}catch(e){sqlite.exec('ROLLBACK');throw e}},
  close:()=>sqlite.close()
 };
}
const user={subject:'synthetic-owner',email:'owner@example.test'};const env={APP_ORIGIN:origin,OWNER_EMAIL:user.email,ACCESS_AUD:'synthetic-aud',ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com',ACCESS_JWKS_URL:'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs'};
const assets={'/index.html':{type:'text/html',body:'PRIVATE_SNAPSHOT'},'/sw.js':{type:'text/javascript',body:'/* generic service worker */'}};
const request=(path,body,headers={})=>new Request(origin+path,body===undefined?{}:{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
test('unsigned or forged-header requests cannot read the private document or subscribe',async()=>{const app=createStation(assets);for(const path of ['/','/sw.js','/api/notifications/config']){const r=await app.fetch(new Request(origin+path,{headers:{'Cf-Access-Authenticated-User-Email':user.email,'X-User-Email':user.email}}),env,{});assert.equal(r.status,401);assert(!(await r.text()).includes('PRIVATE_SNAPSHOT'));}});
test('exact static service worker opt-in cannot reveal owner assets or API data',async()=>{
 const app=createStation(assets),e={...env,PUBLIC_SERVICE_WORKER:'true'};
 const path=origin+'/sw.js';
 const js=await app.fetch(new Request(path),e,{});
 assert.equal(js.status,200);
 assert.equal(js.headers.get('Service-Worker-Allowed'),'/');
 assert.equal(js.headers.get('Content-Type'),'text/javascript');
 assert.equal(js.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
 assert.equal(js.headers.get('Cache-Control'),'no-store');
 assert.equal(await js.text(),'/* generic service worker */');
 const head=await app.fetch(new Request(path,{method:'HEAD'}),e,{});
 assert.equal(head.status,200);
 assert.equal(await head.text(),'');
 for(const route of ['/','/index.html','/api/state','/api/notifications/config','/LICENSE.txt','/sw.js/','/sw.js?version=1']){
  const res=await app.fetch(new Request(origin+route),e,{});
  assert.equal(res.status,401,'owner-only route accidentally exposed: '+route);
  assert(!(await res.text()).includes('PRIVATE_SNAPSHOT'));
 }
 assert.equal((await app.fetch(new Request(path,{method:'POST'}),e,{})).status,405);
 assert.equal((await app.fetch(new Request('https://evil.example.test/sw.js'),e,{})).status,403);
 assert.equal((await app.fetch(new Request(path),{...env,PUBLIC_SERVICE_WORKER:'false'},{})).status,401);
 assert.equal((await app.fetch(new Request(path),env,{})).status,401);
 const wrong=createStation({...assets,'/sw.js':{type:'text/html',body:'PRIVATE_SNAPSHOT'}});
 const wrongRes=await wrong.fetch(new Request(path),e,{});
 assert.equal(wrongRes.status,404);
 assert(!(await wrongRes.text()).includes('PRIVATE_SNAPSHOT'));
});
test('an authenticated different identity is denied before asset access',async()=>{const app=createStation(assets,async()=>({...user,email:'other@example.test'}));assert.equal((await app.fetch(request('/'),env,{})).status,403);});
test('same-origin JSON is required for all subscription mutations',async()=>{const app=createStation(assets,async()=>user);const r=await app.fetch(request('/api/notifications/subscribe',{}, {Origin:'https://evil.test'}),env,{});assert.equal(r.status,403);});
test('push endpoint validation rejects local targets, credentials and lookalike domains',()=>{for(const u of ['http://web.push.apple.com/test','https://web.push.apple.com.evil.test/a','https://127.0.0.1/a','https://fcm.googleapis.com:444/a','https://u:p@fcm.googleapis.com/a','https://internal.invalid/a'])assert.equal(validEndpoint(u),null);assert.equal(validEndpoint('https://web.push.apple.com/Q/test'),'https://web.push.apple.com/Q/test');});
async function syntheticPushEnv(storage){
 const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const privateJwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
 const publicKey=Buffer.concat([Buffer.from([4]),Buffer.from(privateJwk.x,'base64url'),Buffer.from(privateJwk.y,'base64url')]).toString('base64url');
 return {...env,DB:storage,VAPID_PRIVATE_JWK:JSON.stringify(privateJwk),VAPID_PUBLIC_KEY:publicKey,VAPID_SUBJECT:'mailto:owner@example.test'};
}
test('real subscription SQL is owner scoped and a test records acceptance, not phone receipt',async()=>{const storage=db();try{const e=await syntheticPushEnv(storage);let sends=0;const app=createStation(assets,async()=>user,async(endpoint,options)=>{sends++;assert.equal(endpoint,'https://web.push.apple.com/Q/test');assert(!options.body);assert(options.headers.Authorization.startsWith('vapid t='));assert.equal(options.redirect,'manual','Cloudflare Workers only implements follow/manual; never follow sensitive VAPID Authorization redirects');return new Response(null,{status:201})});assert.equal((await app.fetch(request('/api/notifications/subscribe',{deviceId:'device-test-001',subscription:{endpoint:'https://web.push.apple.com/Q/test'}}),e,{})).status,200);const sent=await app.fetch(request('/api/notifications/test',{deviceId:'device-test-001'}),e,{});assert.equal(sent.status,202);assert.equal((await sent.json()).accepted,true);assert.equal((await app.fetch(request('/api/notifications/test',{deviceId:'device-test-001'}),e,{})).status,429);assert.equal(sends,1);const other=createStation(assets,async()=>({...user,subject:'other-sub'}));assert.equal((await other.fetch(request('/api/notifications/test',{deviceId:'device-test-001'}),e,{})).status,404);assert.equal((await app.fetch(request('/api/notifications/unsubscribe',{deviceId:'device-test-001'}),e,{})).status,200);assert.equal((await app.fetch(request('/api/notifications/test',{deviceId:'device-test-001'}),e,{})).status,404);}finally{storage.close()}});
test('incomplete VAPID setup is disabled and stores no iPhone subscription',async()=>{const storage=db();try{
 const app=createStation(assets,async()=>user);
 const incomplete={...env,DB:storage,VAPID_PUBLIC_KEY:'synthetic-public',VAPID_PRIVATE_JWK:'synthetic-private'};
 const config=await app.fetch(new Request(origin+'/api/notifications/config'),incomplete,{});
 assert.equal(config.status,200);
 assert.equal((await config.json()).configured,false,'missing VAPID_SUBJECT must not advertise usable push');
 const add=await app.fetch(request('/api/notifications/subscribe',{deviceId:'device-incomplete-001',subscription:{endpoint:'https://web.push.apple.com/Q/test'}}),incomplete,{});
 assert.equal(add.status,503,'an incomplete push server must not store a device subscription');
 assert.equal((await add.json()).error,'push_not_configured');
 assert.equal((await storage.prepare('SELECT COUNT(*) AS n FROM push_devices').bind().first()).n,0);
 const send=await app.fetch(request('/api/notifications/test',{deviceId:'device-incomplete-001'}),incomplete,{});
 assert.equal(send.status,503);
 assert.equal((await send.json()).error,'push_not_configured');
}finally{storage.close()}});
test('push sender reports safe, specific stages and refuses mismatched VAPID keys before any network call',async()=>{
 const endpoint='https://web.push.apple.com/Q/synthetic',e=await syntheticPushEnv();let calls=0;
 const transport=async()=>{calls++;throw Error('private-endpoint-and-header-must-never-leak')};
 const fail=async(config,code,send=transport)=>assert.rejects(sendGenericPush(endpoint,config,send),x=>x instanceof PushDispatchError&&x.code===code);
 await fail({...e,VAPID_PRIVATE_JWK:'not valid json'},'push_vapid_key_invalid');
 await fail({...e,VAPID_PUBLIC_KEY:'unrelated-public-key'},'push_vapid_pair_mismatch');
 const jwk=JSON.parse(e.VAPID_PRIVATE_JWK);delete jwk.d;
 await fail({...e,VAPID_PRIVATE_JWK:JSON.stringify(jwk)},'push_vapid_sign_failed');
 assert.equal(calls,0,'invalid signing configuration must never issue an outbound request');
 await fail(e,'push_transport_failed');
 assert.equal(calls,1);
 await fail(e,'push_transport_timeout',async()=>{throw Object.assign(Error('sensitive timeout details'),{name:'TimeoutError'})});
});
test('manual push failure returns only a safe code and leaves the device registered',async()=>{
 const storage=db();try{
  const e=await syntheticPushEnv(storage),app=createStation(assets,async()=>user,async()=>{throw Error('SENSITIVE URL OR TOKEN MUST NOT BE RETURNED')});
  assert.equal((await app.fetch(request('/api/notifications/subscribe',{deviceId:'device-private-001',subscription:{endpoint:'https://web.push.apple.com/Q/synthetic'}}),e,{})).status,200);
  const response=await app.fetch(request('/api/notifications/test',{deviceId:'device-private-001'}),e,{});
  assert.equal(response.status,502);const body=await response.json();
  assert.equal(body.error,'push_transport_failed');assert.equal(body.serviceStatus,502);
  assert(!JSON.stringify(body).includes('SENSITIVE'));
  assert(!JSON.stringify(body).includes('web.push.apple.com'));
  assert.equal((await storage.prepare('SELECT COUNT(*) AS n FROM push_devices WHERE active=1').bind().first()).n,1);
  assert.equal((await storage.prepare('SELECT service_status FROM push_delivery_log').bind().first()).service_status,502);
 }finally{storage.close()}
});
test('redirecting push endpoint is rejected without following and exposing VAPID credentials',async()=>{
 const storage=db();try{
  const e=await syntheticPushEnv(storage);let requested=0;
  const app=createStation(assets,async()=>user,async(endpoint,options)=>{
   requested++;
   assert.equal(new URL(endpoint).hostname,'web.push.apple.com');
   assert.equal(options.redirect,'manual');
   // A push service redirect must never cause our authorization header to be forwarded.
   return new Response(null,{status:302,headers:{Location:'https://example.invalid/exfiltrate'}});
  });
  assert.equal((await app.fetch(request('/api/notifications/subscribe',{deviceId:'device-redirect-001',subscription:{endpoint:'https://web.push.apple.com/Q/synthetic'}}),e,{})).status,200);
  const res=await app.fetch(request('/api/notifications/test',{deviceId:'device-redirect-001'}),e,{});
  assert.equal(res.status,502);const body=await res.json();
  assert.equal(body.accepted,false);assert.equal(body.error,'push_service_http_302');assert.equal(body.serviceStatus,302);
  assert.equal(requested,1,'must never follow the redirect');
  assert(!JSON.stringify(body).includes('example.invalid'));
 }finally{storage.close()}
});
test('Apple JSON rejection reason is reported through a fixed allowlist without leaking the upstream response',async()=>{
 const storage=db();try{
  const e=await syntheticPushEnv(storage);
  const appleError={reason:'BadJwtToken',details:'PRIVATE_UPSTREAM_RESPONSE_MUST_NOT_LEAK',endpoint:'https://web.push.apple.com/private'};
  const app=createStation(assets,async()=>user,async()=>new Response(JSON.stringify(appleError),{status:400,headers:{'Content-Type':'application/json; charset=utf-8'}}));
  assert.equal((await app.fetch(request('/api/notifications/subscribe',{deviceId:'device-apple-400',subscription:{endpoint:'https://web.push.apple.com/Q/synthetic'}}),e,{})).status,200);
  const response=await app.fetch(request('/api/notifications/test',{deviceId:'device-apple-400'}),e,{});
  assert.equal(response.status,502);const body=await response.json();
  assert.equal(body.error,'push_service_http_400_bad_jwt_token');assert.equal(body.serviceStatus,400);
  assert(!JSON.stringify(body).includes('PRIVATE_UPSTREAM'));assert(!JSON.stringify(body).includes('web.push.apple.com'));
  assert.equal((await storage.prepare('SELECT status,service_status FROM push_delivery_log').bind().first()).service_status,400);
  assert.equal((await storage.prepare('SELECT COUNT(*) AS n FROM push_devices WHERE active=1').bind().first()).n,1);
 }finally{storage.close()}
});
test('unknown or oversized provider messages never reach the owner response',async()=>{
 const configs=[
  {name:'unrecognized reason',body:JSON.stringify({reason:'UNTRUSTED_SECRET_VALUE'}),headers:{'Content-Type':'application/json'}},
  {name:'non-JSON response',body:'<html>confidential</html>',headers:{'Content-Type':'text/html'}},
  {name:'oversized JSON',body:JSON.stringify({reason:'BadTtl',details:'Z'.repeat(4096)}),headers:{'Content-Type':'application/json'}}
 ];
 for(const cfg of configs){
  const storage=db();try{
   const e=await syntheticPushEnv(storage),app=createStation(assets,async()=>user,async()=>new Response(cfg.body,{status:400,headers:cfg.headers}));
   await app.fetch(request('/api/notifications/subscribe',{deviceId:'device-unsafe-400',subscription:{endpoint:'https://web.push.apple.com/Q/synthetic'}}),e,{});
   const response=await app.fetch(request('/api/notifications/test',{deviceId:'device-unsafe-400'}),e,{});
   assert.equal(response.status,502,cfg.name);
   const body=await response.json();
   assert.equal(body.error,'push_service_http_400',cfg.name);
   assert(!JSON.stringify(body).includes('UNTRUSTED'));assert(!JSON.stringify(body).includes('confidential'));
  }finally{storage.close()}
 }
});
test('Apple known VAPID and Web Push headers are classified without forwarding raw JSON',async()=>{
 for(const [reason,wanted] of [['BadAuthorizationHeader','bad_authorization_header'],['BadTtl','bad_ttl'],['BadUrgency','bad_urgency'],['BadWebPushRequest','bad_web_push_request'],['BadWebPushTopic','bad_web_push_topic'],['VapidPkHashMismatch','vapid_key_mismatch']]){
  const storage=db();try{
   const e=await syntheticPushEnv(storage),app=createStation(assets,async()=>user,async()=>new Response(JSON.stringify({reason}),{status:400,headers:{'Content-Type':'application/json'}}));
   await app.fetch(request('/api/notifications/subscribe',{deviceId:'device-known-400',subscription:{endpoint:'https://web.push.apple.com/Q/synthetic'}}),e,{});
   const res=await app.fetch(request('/api/notifications/test',{deviceId:'device-known-400'}),e,{});
   assert.equal((await res.json()).error,'push_service_http_400_'+wanted);
  }finally{storage.close()}
 }
});
test('actual push-provider rejection keeps its HTTP status and is distinct from a local exception',async()=>{
 const storage=db();try{
  const e=await syntheticPushEnv(storage),app=createStation(assets,async()=>user,async()=>new Response('untrusted upstream text',{status:403}));
  assert.equal((await app.fetch(request('/api/notifications/subscribe',{deviceId:'device-upstream-001',subscription:{endpoint:'https://web.push.apple.com/Q/synthetic'}}),e,{})).status,200);
  const response=await app.fetch(request('/api/notifications/test',{deviceId:'device-upstream-001'}),e,{});
  assert.equal(response.status,502);const body=await response.json();
  assert.equal(body.error,'push_service_http_403');assert.equal(body.serviceStatus,403);
  assert(!JSON.stringify(body).includes('untrusted upstream text'));
  assert.equal((await storage.prepare('SELECT status,service_status FROM push_delivery_log').bind().first()).service_status,403);
 }finally{storage.close()}
});
test('VAPID uses a verifiable ES256 signature and the push-service origin audience',async()=>{const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const jwk=await crypto.subtle.exportKey('jwk',pair.privateKey);const now=Math.floor(Date.now()/1000);const token=await vapidToken('https://web.push.apple.com/Q/test',jwk,'mailto:owner@example.test',now);const parts=token.split('.');const payload=JSON.parse(Buffer.from(parts[1],'base64url'));assert.equal(payload.aud,'https://web.push.apple.com');assert.equal(payload.exp,now+43200);assert(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pair.publicKey,Buffer.from(parts[2],'base64url'),new TextEncoder().encode(parts.slice(0,2).join('.'))));});
test('Access JWT verifier accepts a real signature and rejects altered audience and expiry',async()=>{const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='synthetic-key';const part=x=>Buffer.from(JSON.stringify(x)).toString('base64url');async function token(patch={}){const claims={iss:env.ACCESS_ISSUER,aud:[env.ACCESS_AUD],sub:user.subject,email:user.email,exp:Math.floor(Date.now()/1000)+60,...patch};const unsigned=part({alg:'RS256',kid:jwk.kid})+'.'+part(claims);return unsigned+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(unsigned))).toString('base64url')}const config={issuer:env.ACCESS_ISSUER,audience:env.ACCESS_AUD,jwksUrl:env.ACCESS_JWKS_URL},keys=async()=>({keys:[jwk]});assert.equal((await verifyAccessJWT(await token(),config,keys)).subject,user.subject);await assert.rejects(verifyAccessJWT(await token({aud:['wrong']}),config,keys));await assert.rejects(verifyAccessJWT(await token({exp:1}),config,keys));});
test('protected responses do not cache private assets and reject unknown routes',async()=>{const app=createStation(assets,async()=>user);const response=await app.fetch(request('/'),env,{});assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store, private');assert(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));assert.equal((await app.fetch(request('/deployment/modules.json'),env,{})).status,404);});
