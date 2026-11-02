import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
const tick=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
const initial={version:1,prefs:{},drafts:[{id:'synthetic-note',title:'Preserve this local test note'}],feedback:[],outcomes:[],history:[]};
const denied=(status=401,type='basic')=>({status,type,ok:false,headers:{get:()=> 'text/html'},json(){throw Error('Private sign-in HTML must never be parsed');}});
const json=value=>({status:200,ok:true,headers:{get:()=> 'application/json'},json:async()=>copy(value)});
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
function assertTransport(calls){
 assert(calls.length>0);
 for(const {options} of calls){
  assert.equal(options.headers['X-Requested-With'],'XMLHttpRequest');
  assert.equal(options.redirect,'manual');
  assert.equal(options.credentials,'same-origin');
  assert.equal(options.cache,'no-store');
 }
}
function cloud(transport){
 const controls=new Map(['local-state','cloud-status-mobile','cloud-import','portfolio-refresh'].map(id=>[id,{textContent:'',hidden:true,disabled:false,events:{},addEventListener(name,handler){this.events[name]=handler;}}]));
 const calls=[];
 const sandbox={location:{origin:'https://station.example.test'},local:copy(initial),SNAPSHOT:{projects:[]},DEFAULTS:{},KEY:'synthetic-state',TAB_RECOVERY_KEY:'synthetic-recovery',
  sessionStorage:storage(),localStorage:storage(),crypto:{randomUUID:()=> 'synthetic-operation'},
  document:{getElementById:id=>controls.get(id)},refreshRecoveryHealth(){},applyPrefs(){},render(){},
  restoreLocal:value=>copy(value),syncEqual:(a,b)=>JSON.stringify(a)===JSON.stringify(b),readConfirmedSnapshot:()=>null,trustedLegacyTabBaseline:()=>null,shouldAdoptRemote:()=>false,
  fetch:async(path,options)=>{calls.push({path,options});return transport(path,options);}};
 runInNewContext(source('cloud.js'),sandbox);
 return {sandbox,controls,calls,status:()=>controls.get('local-state').textContent};
}

test('private sync recognizes revoked sessions and opaque/HTTP redirects without parsing sign-in HTML or losing device notes',async()=>{
 for(const response of [denied(401),denied(403),denied(302),denied(0,'opaqueredirect')]){
  const b=cloud(()=>response);await tick();
  assert.equal(b.sandbox.StationCloud.ready,false);
  assert.equal(b.sandbox.StationCloud.diagnostics.mode,'blocked');
  assert.match(b.status(),/Sign-in required.*device changes preserved/);
  assert.deepEqual(copy(b.sandbox.local),initial);
  assertTransport(b.calls);assert.equal(b.calls.length,1,'no automatic retry or write after authentication failure');
 }
});

test('expiry during a save preserves the pending note and stops queued writes instead of acknowledging a login response',async()=>{
 const b=cloud((path,options)=>path==='/api/state'?(options.method==='POST'?denied(401):json({revision:7,state:initial})):json({configured:true,projects:[]}));
 await tick();assert.equal(b.sandbox.StationCloud.ready,true);
 b.sandbox.local.drafts.push({id:'pending-synthetic-note',title:'Unsynced note must survive'});
 b.sandbox.StationCloud.onLocalChange();await tick();
 assert.equal(b.sandbox.StationCloud.ready,false);
 assert.equal(b.sandbox.StationCloud.diagnostics.pending,true);
 assert.equal(b.sandbox.StationCloud.diagnostics.revision,7);
 assert.equal(b.sandbox.local.drafts.length,2);assert.match(b.status(),/Sign-in required/);
 assert.equal(b.calls.filter(x=>x.options.method==='POST').length,1);
 b.sandbox.StationCloud.onLocalChange();await tick();
 assert.equal(b.calls.filter(x=>x.options.method==='POST').length,1,'blocked sync must not retry the write');
 assertTransport(b.calls);
});

test('a portfolio refresh losing authorization preserves its previous projection and blocks further sync writes',async()=>{
 let refresh=false;
 const projects=[{id:'synthetic-project',name:'Previously loaded test projection'}];
 const b=cloud(path=>path==='/api/state'?json({revision:7,state:initial}):refresh?denied(403):json({configured:true,projects}));
 await tick();assert.equal(b.sandbox.StationCloud.ready,true);
 refresh=true;await b.controls.get('portfolio-refresh').events.click();
 assert.equal(b.sandbox.StationCloud.ready,false);assert.match(b.status(),/Sign-in required/);
 assert.deepEqual(copy(b.sandbox.SNAPSHOT.projects),projects);assert.deepEqual(copy(b.sandbox.local),initial);
 assertTransport(b.calls);
});

test('workspace requests fail closed on expired or redirected sessions with a clear safe error and no private action controls',async()=>{
 for(const response of [denied(401),denied(403),denied(302),denied(0,'opaqueredirect')]){
  const root={innerHTML:'',setAttribute(){}};const calls=[];
  const sandbox={document:{getElementById:id=>id==='station-workspace'?root:null,addEventListener(){}},URLSearchParams,fetch:async(path,options)=>{calls.push({path,options});return response;}};
  runInNewContext(source('workspace-ui.js'),sandbox);await tick();
  assert.match(root.innerHTML,/Your session or scope is no longer authorized/);
  assert(!root.innerHTML.includes('id="ws-proposal"'));assert(!root.innerHTML.includes('data-ws-decision'));
  assertTransport(calls);assert.equal(calls.length,1);
 }
});
