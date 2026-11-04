import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const script = readFileSync(new URL('../tools/mail-owner-canary-console.mjs', import.meta.url), 'utf8');
const liveOrigin = 'https://ds.devonakins.com';
const safeCsp = "default-src 'none'; connect-src 'self'; form-action 'none'";
const make = ({origin=liveOrigin,title='Devon Station',app=true,frame=false,csp=safeCsp,fetchImpl}={}) => {
  const events=[];const calls=[];
  const top={};const self=frame?{}:top;
  const context={
    location:{origin},window:{top,self},
    document:{title,querySelector(selector){
      if(selector==='.app main#view')return app?{}:null;
      if(selector==='meta[http-equiv="Content-Security-Policy"]')return csp?{getAttribute:()=>csp}:null;
      return null;
    }},
    console:{info:(label,item)=>{assert.equal(label,'DS-MAIL-ACCEPTANCE');events.push(item)}},
    fetch:async(path,options)=>{calls.push({path,options});return fetchImpl?.(path,options)??new Response(JSON.stringify({authenticated:true}),{headers:{'Content-Type':'application/json'}})}
  };
  return {context,events,calls};
};
const run=async x=>{await runInNewContext(script,x.context);return x};

test('fails before network on Cloudflare Access sign-in even if URL is the expected origin',async()=>{
  const x=await run(make({title:'Sign in ・ Cloudflare Access',app:false}));
  assert.equal(x.events[0].result,'NOT_APP');
  assert.equal(x.calls.length,0);
});
test('fails before network in wrong origin or nested iframe',async()=>{
  for(const options of [{origin:'https://chatgpt.com'}, {frame:true}]){
    const x=await run(make(options));
    assert.match(x.events[0].result,/WRONG_/);
    assert.equal(x.calls.length,0);
  }
});
test('honors deny-by-default CSP and refuses even session request without connect-src self',async()=>{
  for(const csp of ["default-src 'none'; connect-src 'none'", "default-src 'none'"]){
    const x=await run(make({csp}));
    assert.equal(x.events[0].result,'BLOCKED_BY_PAGE_CSP');
    assert.equal(x.calls.length,0);
  }
});
test('valid app checks owner session before canary and never sends or reads message bodies',async()=>{
  const x=await run(make({fetchImpl:(path)=>{
    if(path==='/api/session')return new Response(JSON.stringify({authenticated:true}),{headers:{'Content-Type':'application/json'}});
    return new Response(JSON.stringify({configured:true,provider:'purelymail',draftsEnabled:true,outgoingEnabled:false,outboxEnabled:false,privateMessage:'NOT_FOR_DIAGNOSTICS'}),{headers:{'Content-Type':'application/json'}});
  }}));
  assert.deepEqual(x.events.map(y=>y.result),['APP_CONFIRMED','OWNER_SESSION_VERIFIED','STATUS_RECEIVED']);
  assert.deepEqual(x.calls.map(y=>y.path),['/api/session','/api/mail/status']);
  assert.equal(x.calls[0].options.method,'GET');
  assert.equal(x.calls[1].options.method,'GET');
  assert.equal(x.calls[1].options.headers['Cloudflare-Workers-Version-Overrides'],'devon-station="1ba61404-f7f6-4b0b-8b55-6f9f52819e70"');
  assert.equal(x.events[2].detail.sendingDisabled,true);
  assert(!JSON.stringify(x.events).includes('NOT_FOR_DIAGNOSTICS'));
});
test('browser TypeError is identified without claiming provider login failure or attempting mail',async()=>{
  const x=await run(make({fetchImpl:()=>{throw new TypeError('Failed to fetch');}}));
  assert.deepEqual(x.events.map(y=>y.result),['APP_CONFIRMED','NETWORK_OR_CSP_BLOCK']);
  assert.equal(x.calls.length,1);
});
test('an Access HTML interstitial or expired session aborts without probing mailbox',async()=>{
  for(const response of [
    new Response('<html><title>Cloudflare Access</title></html>',{headers:{'Content-Type':'text/html'}}),
    new Response(JSON.stringify({authenticated:false}),{headers:{'Content-Type':'application/json'}}),
    new Response(JSON.stringify({error:'owner_sign_in_required'}),{status:401,headers:{'Content-Type':'application/json'}})
  ]) {
    const x=await run(make({fetchImpl:()=>response}));
    assert.equal(x.calls.length,1);
    assert.equal(x.events.length,2);
    assert.notEqual(x.events[1].result,'OWNER_SESSION_VERIFIED');
  }
});
