import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {financeNormalizeSnapshot,financeDisplayMoney} from '../src/finance-view.mjs';

const code=readFileSync(new URL('../src/finance-ui.js',import.meta.url),'utf8');

class Element {
  constructor(tag='div'){
    this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this._text='';this.id='';
    this.listeners={};this.isConnected=true;this.disabled=false;this.className='';this.type='';
  }
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}
  set innerHTML(_){throw Error('Unsafe HTML injection attempted');}
  setAttribute(name,value){this.attributes[name]=value;}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=[...children];this._text='';}
  querySelector(selector){
    if(!selector.startsWith('#'))throw Error('Unexpected query '+selector);
    const id=selector.slice(1);
    const walk=(el)=>el.id===id?el:el.children.map(walk).find(Boolean)||null;
    return walk(this);
  }
  addEventListener(kind,cb){this.listeners[kind]=cb;}
  click(){return this.listeners.click?.();}
}
function fixture(){return {
 schema:'devonstation-financial-readonly-v1',mode:'read_only',fetchedAt:'2026-11-03T17:00:00.000Z',
 sources:{mercury:{status:'available',readOnly:true,accounts:[{label:'Checking',kind:'checking',status:'active',currentCents:'0',availableCents:'0'}]},
 alpaca:{status:'available',readOnly:true,mode:'paper',accountStatus:'active',equityCents:'100000',cashCents:'5000',buyingPowerCents:'5000',positionsCount:2,tpd:{status:'unavailable_pending_reconciliation',valuePct:null}}},
 capabilities:{moneyMovement:false,orderSubmission:false,liveTrading:false,unverifiedTPD:false},combinedNetWorthCents:null,
};}
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function harness(upstream=()=>json(fixture())){
 const root=new Element();root.id='station-finance';const calls=[];
 const document={createElement:(tag)=>new Element(tag),querySelector:(q)=>q==='#station-finance'?root:null};
 const fetch=async(url,options)=>{calls.push({url,options});return upstream(url,options)};
 const context={document,fetch,AbortController,Response,financeNormalizeSnapshot,financeDisplayMoney};
 runInNewContext(code,context,{filename:'finance-ui.js'});
 return {root,calls,ui:context.StationFinance};
}
async function settle(){for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));}

test('owner finance screen requests only same-origin GET and presents two distinct source cards',async()=>{
 const {ui,root,calls}=harness();ui.mounted('finance');await settle();
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/finance/summary');
 assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'manual');
 assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.cache,'no-store');
 const text=root.textContent;
 assert.match(text,/Mercury banking/);assert.match(text,/Alpaca research/);
 assert.match(text,/PAPER \/ SIMULATED/);assert.match(text,/\$0\.00/);
 assert.match(text,/TPD%/);assert.match(text,/Not available/);
 assert.match(text,/No payments, transfers, orders/);assert(!text.includes('net worth: $'));
});
test('untrusted bank account label never creates markup',async()=>{
 const f=fixture();f.sources.mercury.accounts[0].label='<img src=x onerror=alert(1)>';
 const {ui,root}=harness(()=>json(f));ui.mounted('finance');await settle();
 assert.match(root.textContent,/<img src=x onerror=alert\(1\)>/);
 const tags=[];const walk=(e)=>{tags.push(e.tagName);e.children.forEach(walk)};walk(root);
 assert(!tags.includes('IMG'));
});
test('manual refresh is read-only and never caches results to localStorage',async()=>{
 const {ui,root,calls}=harness();ui.mounted('finance');await settle();
 root.querySelector('#finance-refresh').click();await settle();
 assert.equal(calls.length,2);
 assert(calls.every(x=>x.options.method==='GET'));
});
test('provider sign-in redirect and invalid response never display balances',async()=>{
 for(const upstream of [()=>new Response('',{status:401}),()=>new Response('<html>signin</html>',{headers:{'Content-Type':'text/html'}})]){
  const {ui,root}=harness(upstream);ui.mounted('finance');await settle();
  assert(!root.textContent.includes('$1,000.00'));assert.match(root.textContent,/(Sign-in|could not be verified)/);
 }
});
test('invalid contract cannot inject private details into error message',async()=>{
 const f=fixture();f.sources.alpaca.mode='live';f.secret='SECRET-NEVER-RENDER';
 const {ui,root}=harness(()=>json(f));ui.mounted('finance');await settle();
 assert.match(root.textContent,/failed safety validation/);
 assert(!root.textContent.includes('SECRET'));
});
test('leaving finance aborts an in-flight fetch and cannot expose stale data',async()=>{
 let resolveGet;const pending=new Promise(resolve=>resolveGet=resolve);
 const {ui,root,calls}=harness(()=>pending);
 ui.mounted('finance');ui.mounted('command');resolveGet(json(fixture()));await settle();
 assert(calls[0].options.signal.aborted);
 assert(!root.textContent.includes('$1,000.00'));
});
