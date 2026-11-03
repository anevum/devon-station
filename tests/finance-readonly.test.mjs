import test from 'node:test';
import assert from 'node:assert/strict';
import {financialSummary,mercuryProjection,alpacaPaperProjection,cents} from '../worker/finance-readonly.mjs';

const user={subject:'synthetic-signed-subject',email:'owner@example.test'};
const env={FINANCE_OWNER_SUBJECT:user.subject,FINANCE_READ_MODE:'read_only',
 MERCURY_FINANCE_READ_TOKEN:'synthetic-bank-token',ALPACA_FINANCE_MODE:'paper',
 ALPACA_FINANCE_PAPER_KEY:'synthetic-paper-key',ALPACA_FINANCE_PAPER_SECRET:'synthetic-paper-secret'};
const mercury={accounts:[{id:'synthetic-account-1',name:'Checking 0000',kind:'checking',status:'active',
 availableBalance:0,currentBalance:0,accountNumber:'DO_NOT_EXPOSE',routingNumber:'DO_NOT_EXPOSE',legalBusinessName:'DO_NOT_EXPOSE'}]};
const alpaca={status:'ACTIVE',equity:'1200.04',cash:'980.01',buying_power:'980.01',
 account_number:'DO_NOT_EXPOSE',id:'DO_NOT_EXPOSE'};
const positions=[{symbol:'AAPL',qty:'1',secret:'DO_NOT_EXPOSE'}];
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function transport({errorMercury=false,errorAlpaca=false}={}){
 const calls=[];
 const get=async(url,opts)=>{
  calls.push({url,opts});
  assert.equal(opts.method,'GET');assert.equal(opts.redirect,'manual');
  assert.equal(opts.cache,'no-store');
  if(url.startsWith('https://api.mercury.com'))return errorMercury?new Response('denied',{status:401}):json(mercury);
  if(url==='https://paper-api.alpaca.markets/v2/account')return errorAlpaca?new Response('offline',{status:502}):json(alpaca);
  if(url==='https://paper-api.alpaca.markets/v2/positions')return json(positions);
  throw Error('unexpected upstream');
 };
 return {get,calls};
}

test('zero-balance Mercury is valid as a read-only projection',async()=>{
 const mock=transport(),result=await financialSummary(env,user,mock.get);
 assert.equal(result.sources.mercury.status,'available');
 assert.equal(result.sources.mercury.accounts[0].currentCents,'0');
 assert.equal(result.sources.alpaca.mode,'paper');
 assert.equal(result.sources.alpaca.equityCents,'120004');
 assert.equal(result.sources.alpaca.tpd.valuePct,null);
 assert.equal(result.combinedNetWorthCents,null);
 assert.deepEqual(result.capabilities,{moneyMovement:false,orderSubmission:false,liveTrading:false,unverifiedTPD:false});
 assert(!JSON.stringify(result).includes('DO_NOT_EXPOSE'));
 assert(!JSON.stringify(result).includes('synthetic-bank-token'));
 assert(mock.calls.every(x=>x.opts.method==='GET'));
 assert(mock.calls.every(x=>x.url.startsWith('https://api.mercury.com/api/v1/accounts?')||x.url.startsWith('https://paper-api.alpaca.markets/v2/')));
});

test('failed provider does not conceal independently available source',async()=>{
 const mock=transport({errorMercury:true}),r=await financialSummary(env,user,mock.get);
 assert.equal(r.sources.mercury.status,'unavailable');
 assert.equal(r.sources.alpaca.status,'available');
 assert(!JSON.stringify(r).includes('denied'));
});

test('missing credentials make zero upstream calls',async()=>{
 const mock=transport(),r=await financialSummary({FINANCE_OWNER_SUBJECT:user.subject,FINANCE_READ_MODE:'read_only'},user,mock.get);
 assert.equal(r.sources.mercury.status,'not_configured');
 assert.equal(r.sources.alpaca.status,'not_configured');
 assert.equal(mock.calls.length,0);
});

test('live mode refuses broker requests',async()=>{
 const mock=transport();const r=await financialSummary({...env,ALPACA_FINANCE_MODE:'live'},user,mock.get);
 assert.equal(r.sources.alpaca.status,'live_access_not_authorized');
 assert.equal(mock.calls.length,1);
 assert(mock.calls[0].url.startsWith('https://api.mercury.com'));
});

test('owner binding rejects before any upstream calls',async()=>{
 const mock=transport();
 await assert.rejects(financialSummary(env,{...user,subject:'other-user'},mock.get),e=>e.status===403);
 await assert.rejects(financialSummary({...env,FINANCE_OWNER_SUBJECT:undefined},user,mock.get),e=>e.status===403);
 await assert.rejects(financialSummary({...env,FINANCE_READ_MODE:'off'},user,mock.get),e=>e.status===503);
 assert.equal(mock.calls.length,0);
});

test('malformed, duplicated and incomplete account evidence fails closed',()=>{
 assert.throws(()=>mercuryProjection({accounts:[mercury.accounts[0],mercury.accounts[0]]}));
 assert.throws(()=>mercuryProjection({...mercury,hasMore:true}));
 assert.throws(()=>mercuryProjection({accounts:[{...mercury.accounts[0],currentBalance:null}]}));
 assert.throws(()=>mercuryProjection({accounts:[{...mercury.accounts[0],availableBalance:Infinity}]}));
 assert.throws(()=>mercuryProjection({accounts:[{...mercury.accounts[0],name:'x\nscript'}]}));
 assert.throws(()=>mercuryProjection({accounts:[{...mercury.accounts[0],status:'unrecognized'}]}));
});

test('monetary parsing preserves cents and rejects fractions, NaN and exponent',()=>{
 assert.equal(cents('1200.04'),'120004');assert.equal(cents('-20.01'),'-2001');
 assert.equal(cents(0),'0');assert.equal(cents('0.1'),'10');
 for(const bad of ['1.001','NaN','1e5','10000000000000000',NaN,Infinity,null,{}])assert.throws(()=>cents(bad));
});

test('Alpaca paper projector rejects malformed evidence',()=>{
 assert.throws(()=>alpacaPaperProjection({...alpaca},[{symbol:'<script>'}]));
 assert.throws(()=>alpacaPaperProjection({...alpaca,equity:'NaN'},[]));
 assert.throws(()=>alpacaPaperProjection({...alpaca,status:'UNKNOWN'},[]));
});

test('upstream error response bodies never leak into result',async()=>{
 const mocked=async()=>new Response('private-stacktrace-and-account-identifiers',{status:503});
 const r=await financialSummary(env,user,mocked);
 assert.equal(r.sources.mercury.status,'unavailable');assert.equal(r.sources.alpaca.status,'unavailable');
 assert(!JSON.stringify(r).includes('private-stacktrace'));
});

test('oversized upstream body fails closed independently',async()=>{
 const mock=transport();
 const huge=async(url,opts)=>url.startsWith('https://api.mercury.com')
  ?json({accounts:[{id:'x',name:'X'.repeat(1300000)}]}):mock.get(url,opts);
 const r=await financialSummary(env,user,huge);
 assert.equal(r.sources.mercury.status,'unavailable');
 assert.equal(r.sources.alpaca.status,'available');
});
