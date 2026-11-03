import test from 'node:test';
import assert from 'node:assert/strict';
import {financeDisplayMoney,financeNormalizeSnapshot} from '../src/finance-view.mjs';

const safe = () => ({
  schema:'devonstation-financial-readonly-v1',mode:'read_only',fetchedAt:'2026-11-03T17:00:00.000Z',
  sources:{
    mercury:{status:'available',readOnly:true,accounts:[{label:'Checking',kind:'checking',status:'active',currentCents:'0',availableCents:'0',accountNumber:'DO_NOT_RENDER'}]},
    alpaca:{status:'available',readOnly:true,mode:'paper',accountStatus:'active',equityCents:'100004',cashCents:'2500',buyingPowerCents:'3000',positionsCount:2,tpd:{status:'unavailable_pending_reconciliation',valuePct:null},secret:'DO_NOT_RENDER'},
  },
  capabilities:{moneyMovement:false,orderSubmission:false,liveTrading:false,unverifiedTPD:false},combinedNetWorthCents:null,
  secret:'DO_NOT_RENDER',
});

test('pure display formats money precisely without floating-point math',()=>{
  assert.equal(financeDisplayMoney('0'),'$0.00');
  assert.equal(financeDisplayMoney('100004'),'$1,000.04');
  assert.equal(financeDisplayMoney('-2503'),'-$25.03');
  assert.equal(financeDisplayMoney('12345678901234567'),'$123,456,789,012,345.67');
});
test('rejects malformed cents or unsafe number conversions',()=>{
  for(const v of ['1.5','NaN','1e5','-0','',null,1000,{},'0<script>'])assert.throws(()=>financeDisplayMoney(v));
});
test('unfunded bank remains available and zero is displayed honestly',()=>{
  const s=financeNormalizeSnapshot(safe());
  assert.equal(s.mercury.status,'available');
  assert.equal(financeDisplayMoney(s.mercury.accounts[0].currentCents),'$0.00');
  assert.equal(s.combinedNetWorth,null);
  assert(!JSON.stringify(s).includes('DO_NOT_RENDER'));
});
test('paper equity never contaminates bank balance, TPD is explicitly pending',()=>{
  const s=financeNormalizeSnapshot(safe());
  assert.equal(s.alpaca.account.tpdStatus,'awaiting_reconciliation');
  assert.equal(s.alpaca.account.equityCents,'100004');
  assert.equal(s.mercury.accounts[0].currentCents,'0');
  assert.equal(s.combinedNetWorth,null);
});
test('unconfigured sources do not become zero or simulated account balances',()=>{
  const x=safe();x.sources.mercury={status:'not_configured',readOnly:true};x.sources.alpaca={status:'not_configured',readOnly:true};
  const v=financeNormalizeSnapshot(x);
  assert.deepEqual(v.mercury.accounts,[]);assert.equal(v.alpaca.account,null);
});
test('rejects capabilities that permit money movement or unverified performance',()=>{
  for(const key of ['moneyMovement','orderSubmission','liveTrading','unverifiedTPD']){
    const x=safe();x.capabilities[key]=true;assert.throws(()=>financeNormalizeSnapshot(x));
  }
});
test('rejects missing status, owner data contract and malformed broker provenance',()=>{
  for(const modifier of [
    x=>{x.schema='v2'},x=>{x.mode='write'},x=>{x.combinedNetWorthCents='0'},
    x=>{x.sources.mercury.readOnly=false},x=>{x.sources.alpaca.mode='live'},
    x=>{x.sources.alpaca.tpd.valuePct='0.1'},x=>{x.sources.alpaca.positionsCount=-1},
    x=>{x.sources.mercury.accounts[0].currentCents='1.005'},x=>{x.fetchedAt='not-a-date'},
  ]){
    const x=safe();modifier(x);assert.throws(()=>financeNormalizeSnapshot(x));
  }
});
test('text from provider is data only, no raw extra fields',()=>{
  const x=safe();x.sources.mercury.accounts[0].label='<img src=x onerror=alert(1)>';
  const s=financeNormalizeSnapshot(x);
  assert.equal(s.mercury.accounts[0].label,x.sources.mercury.accounts[0].label);
  assert(!('secret' in s));assert(!('accountNumber' in s.mercury.accounts[0]));
});
test('bank source rejects oversized account count',()=>{
  const x=safe();x.sources.mercury.accounts=Array(1001).fill(x.sources.mercury.accounts[0]);
  assert.throws(()=>financeNormalizeSnapshot(x));
});
