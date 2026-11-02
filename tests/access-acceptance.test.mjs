import test from 'node:test';
import assert from 'node:assert/strict';
import {createStation} from '../worker/index.mjs';
import {authorizedIdentity} from '../worker/access.mjs';

const origin='https://devon-station.example.test';
const env={
 APP_ORIGIN:origin, OWNER_EMAIL:'owner@example.test',
 ACCESS_ISSUER:'https://station-test.cloudflareaccess.com',
 ACCESS_AUD:'synthetic-devon-station-app-audience',
 ACCESS_JWKS_URL:'https://station-test.cloudflareaccess.com/cdn-cgi/access/certs'
};
const body='OWNER_ONLY_HTML_SENTINEL';
const app=createStation({'/index.html':{type:'text/html',encoding:'utf8',body}});
const part=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const now=()=>Math.floor(Date.now()/1000);

async function signer(){
 const kp=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const pub=await crypto.subtle.exportKey('jwk',kp.publicKey);pub.kid='station-synthetic-key';pub.use='sig';pub.alg='RS256';
 async function sign(claims={},header={}){
  const value={iss:env.ACCESS_ISSUER,aud:[env.ACCESS_AUD],exp:now()+300,nbf:now()-60,iat:now()-60,sub:'synthetic-station-owner-uuid',email:env.OWNER_EMAIL,...claims};
  const input=part({alg:'RS256',kid:pub.kid,...header})+'.'+part(value);
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',kp.privateKey,new TextEncoder().encode(input));
  return input+'.'+Buffer.from(signature).toString('base64url');
 }
 return {pub,sign};
}
const cookie=(jwt,extra={})=>new Request(origin+'/',{headers:{Cookie:'CF_Authorization='+jwt,...extra}});

test('signed owner Access JWT allows the hosted shell, while forgery, policy mismatches and old tokens fail closed',async t=>{
 const keys=await signer();
 const previous=globalThis.fetch;
 let jwksRequests=0;
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,env.ACCESS_JWKS_URL);
  assert.equal(options.redirect,'manual','JWKS must use a Workers-compatible no-follow transport');
  jwksRequests++;
  return new Response(JSON.stringify({keys:[keys.pub]}),{status:200});
 };
 t.after(()=>{globalThis.fetch=previous;});
 const token=await keys.sign();
 const signed=await app.fetch(cookie(token),env,{});
 assert.equal(signed.status,200);
 assert.equal(await signed.text(),body);
 assert.equal(signed.headers.get('Cache-Control'),'no-store, private');
 assert.equal((await (await app.fetch(new Request(origin+'/api/session',{headers:{'Cf-Access-Jwt-Assertion':token}}),env,{})).json()).authenticated,true);
 assert.equal(jwksRequests,1,'JWKS verification is cached, not refetched for every request');
 // Optional time claims may be absent and RFC 7519 permits fractional NumericDate.
 assert.equal((await app.fetch(cookie(await keys.sign({nbf:undefined,iat:undefined})),env,{})).status,200);
 assert.equal((await app.fetch(cookie(await keys.sign({exp:now()+300.25,nbf:now()-0.25,iat:now()-0.25})),env,{})).status,200);
 const cases=[
  [await keys.sign({email:'not-owner@example.test'}),403],
  [await keys.sign({aud:['other-audience']}),401],
  [await keys.sign({iss:'https://attacker.cloudflareaccess.com'}),401],
  [await keys.sign({exp:now()-1}),401],
  [await keys.sign({exp:'tomorrow'}),401],
  [await keys.sign({nbf:now()+3600}),401],
  [await keys.sign({nbf:'not-a-time'}),401],
  [await keys.sign({nbf:null}),401],
  [await keys.sign({nbf:[now()-60]}),401],
  [await keys.sign({nbf:{seconds:now()-60}}),401],
  [await keys.sign({iat:now()+3600}),401],
  [await keys.sign({iat:'not-a-time'}),401],
  [await keys.sign({iat:null}),401],
  [await keys.sign({iat:[now()-60]}),401],
  [await keys.sign({sub:''}),401],
  [await keys.sign({}, {alg:'HS256'}),401]
 ];
 for(const [candidate,expected] of cases){
  const r=await app.fetch(cookie(candidate),env,{});
  assert.equal(r.status,expected);
  assert(!(await r.text()).includes(body));
 }
 const broken=token.slice(0,-5)+'AAAAA';
 assert.equal((await app.fetch(cookie(broken),env,{})).status,401);
 assert.equal((await app.fetch(new Request(origin+'/',{headers:{'X-Owner-Email':env.OWNER_EMAIL,'Cf-Access-Authenticated-User-Email':env.OWNER_EMAIL}}),env,{})).status,401);
 assert.equal((await app.fetch(new Request(origin+'/',{headers:{Cookie:'CF_Authorization='+token+'; CF_Authorization='+token}}),env,{})).status,401);
 const wrongOrigin=await app.fetch(new Request('https://malicious.example.test/',{headers:{'Cf-Access-Jwt-Assertion':token}}),env,{});
 assert.equal(wrongOrigin.status,403);
});

test('state POST must satisfy same-origin JSON checks even with a valid trusted Access identity',async()=>{
 const context={access:{aud:env.ACCESS_AUD,getIdentity:async()=>({user_uuid:'synthetic-owner',email:env.OWNER_EMAIL})}};
 const allowed=await app.fetch(new Request(origin+'/api/session'),env,context);
 assert.equal(allowed.status,200);
 const mutations=[
  new Request(origin+'/api/state',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}}),
  new Request(origin+'/api/state',{method:'POST',body:'{}',headers:{Origin:'https://evil.example.test','Content-Type':'application/json'}}),
  new Request(origin+'/api/state',{method:'POST',body:'{}',headers:{Origin:origin,'Content-Type':'text/plain'}})
 ];
 for(const mutation of mutations)assert.equal((await app.fetch(mutation,env,context)).status,403);
 assert.equal((await app.fetch(new Request(origin+'/api/session'),env,{access:{aud:'incorrect-audience',getIdentity:context.access.getIdentity}})).status,401);
 assert.equal((await app.fetch(new Request(origin+'/api/session'),env,{access:{aud:env.ACCESS_AUD,getIdentity:async()=>({email:'not-owner@example.test',user_uuid:'some-other-subject'})}})).status,403);
 assert.equal((await app.fetch(new Request(origin+'/api/session'),env,{access:{aud:env.ACCESS_AUD,getIdentity:async()=>({email:env.OWNER_EMAIL,user_uuid:''})}})).status,401);
});
