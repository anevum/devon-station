/**
 * DS011-RB01: cross-branch recovered Worker contract test only.
 * No deployment, live Access session, production DB, or owner data.
 * The original recovered Worker and hardened Access verifier are imported
 * from a separately pinned checkout; neither is duplicated or modified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAccessScopeBridge} from '../src/access-scope-bridge.mjs';

const load = async (name) => {
  const file=process.env[name];
  if (!file) throw new Error(name+' must point to the separate pinned recovery checkout');
  return import(pathToFileURL(resolve(file)).href);
};
const [{verifyAccessJWT},{createStation}]=await Promise.all([
  load('RECOVERED_ACCESS_MODULE'),load('RECOVERED_STATION_MODULE')
]);
const config=Object.freeze({
  issuer:'https://ds011-test.cloudflareaccess.com',
  audience:'ds011-generated-test-audience',
  jwksUrl:'https://ds011-test.cloudflareaccess.com/cdn-cgi/access/certs'
});
const scope=Object.freeze({scopeKind:'personal',scopeId:'personal-test'});
const ownerEmail='owner@example.test';
const origin='https://ds011.example.test';
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');

async function harness() {
  const keys=await webcrypto.subtle.generateKey({
    name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'
  },true,['sign','verify']);
  const jwk=await webcrypto.subtle.exportKey('jwk',keys.publicKey);
  Object.assign(jwk,{kid:'synthetic-rsa-key',alg:'RS256',use:'sig'});
  let verifications=0;
  const verifyAssertion=token=>verifyAccessJWT(token,config,async url=>{
    assert.equal(url,config.jwksUrl);
    verifications++;
    return {keys:[jwk]};
  });
  const bridge=createAccessScopeBridge({
    verifyAssertion,
    grants:[{
      subject:'provider-subject-test',principalId:'owner-test',
      scopeKind:scope.scopeKind,scopeId:scope.scopeId,role:'owner'
    }]
  });
  const sign=async (overrides={})=>{
    const now=Date.now()/1000;
    const claims={
      iss:config.issuer,aud:[config.audience],sub:'provider-subject-test',
      exp:now+300,iat:now-60,nbf:now-60,
      email:'untrusted-client@example.test',role:'admin',...overrides
    };
    const data=encode({alg:'RS256',kid:jwk.kid})+'.'+encode(claims);
    const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(data));
    return data+'.'+Buffer.from(signature).toString('base64url');
  };
  // This is a test-only, server-configured bridge. It does not replace the
  // recovered Worker's default authorizedIdentity or constitute production auth.
  const auth=async request=>{
    const assertion=request.headers.get('Cf-Access-Jwt-Assertion');
    const identity=await bridge.authorize(assertion,scope);
    return {subject:identity.principalId,email:ownerEmail};
  };
  const station=createStation({},auth,()=>{throw new Error('Network transport must not run');});
  const env={APP_ORIGIN:origin,OWNER_EMAIL:ownerEmail};
  const request=(path,token,method='GET',extra={})=>{
    const headers={'X-User-Email':ownerEmail,'X-User-Role':'owner',...extra};
    if(token!==undefined)headers['Cf-Access-Jwt-Assertion']=token;
    return new Request(origin+path,{method,headers});
  };
  return {sign,bridge,station,env,request,verificationCount:()=>verifications};
}

test('signed synthetic Access subject opens the real recovered Worker session',async()=>{
  const h=await harness();
  const response=await h.station.fetch(h.request('/api/session',await h.sign()),h.env,{});
  assert.equal(response.status,200);
  const session=await response.json();
  assert.equal(session.authenticated,true);
  assert.equal(session.mode,'owner');
  assert.equal(session.version,'0.4.8');
  assert.equal(session.persistentStorage,false);
  assert.equal(h.verificationCount(),1);
});

test('forged, missing, expired and wrong-audience assertions never open session',async()=>{
  const h=await harness();
  const valid=await h.sign();
  const [header,payload,signature]=valid.split('.');
  const forgedBody={...JSON.parse(Buffer.from(payload,'base64url').toString('utf8')),sub:'provider-subject-test',role:'owner'};
  const forged=header+'.'+encode(forgedBody)+'.'+signature;
  const tokens=[
    undefined,'unsigned','',forged,
    await h.sign({sub:'other-provider-subject'}),
    await h.sign({aud:['wrong-audience']}),
    await h.sign({iss:'https://different.cloudflareaccess.com'}),
    await h.sign({exp:Date.now()/1000-1}),
    await h.sign({nbf:'tomorrow'})
  ];
  for(const token of tokens){
    const response=await h.station.fetch(h.request('/api/session',token),h.env,{});
    assert.equal(response.status,401,'invalid identity must be denied');
    assert.equal((await response.json()).error,'owner_sign_in_required');
  }
});

test('a verified personal owner cannot request an unrelated business or personal scope',async()=>{
  const h=await harness();
  const signed=await h.sign();
  for(const invalid of [
    {scopeKind:'business',scopeId:'personal-test'},
    {scopeKind:'personal',scopeId:'another-owner'},
    {scopeKind:'creative',scopeId:'personal-test'}
  ]) await assert.rejects(h.bridge.authorize(signed,invalid),/access denied/);
  assert.deepEqual(await h.bridge.authorize(signed,scope),{
    principalId:'owner-test',role:'owner',...scope
  });
});

test('recovered Worker keeps origin, no-database and write boundaries intact',async()=>{
  const h=await harness(), token=await h.sign();
  const wrongOrigin=new Request('https://other.example.test/api/session',{
    headers:{'Cf-Access-Jwt-Assertion':token}
  });
  assert.equal((await h.station.fetch(wrongOrigin,h.env,{})).status,403);
  const noData=await h.station.fetch(h.request('/api/state',token),h.env,{});
  assert.equal(noData.status,503);
  assert.equal((await noData.json()).error,'storage_unavailable');
  const write=await h.station.fetch(h.request('/api/state',token,'POST',{
    Origin:origin,'Content-Type':'application/json'
  }),h.env,{});
  assert.equal(write.status,503);
  assert.equal((await write.json()).error,'storage_unavailable');
});
