import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../src/pwa.js',import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<24;i++)await Promise.resolve()};

function browser({existing=false,registrationBlocked=false,lookupBlocked=false,insecure=false}={}){
 const controls=new Map(['notification-status','push-enable','push-test','push-disable','push-retry'].map(id=>[id,{id,textContent:'',disabled:true,hidden:true}]));
 const events={};
 const calls={register:0,existing:0,subscribe:0,config:0};
 let block=registrationBlocked;
 const swReg={
  active:{scriptURL:'https://station.example.test/sw.js'},
  pushManager:{
   async getSubscription(){if(lookupBlocked)throw Object.assign(new Error('The operation is insecure.'),{name:'SecurityError'});return null},
   subscribe(){calls.subscribe++;return Promise.resolve({toJSON:()=>({endpoint:'https://web.push.apple.com/Q/synthetic'})})}
  }
 };
 const serviceWorker={
  async getRegistration(){calls.existing++;return existing?swReg:null},
  async register(){calls.register++;if(block)throw Object.assign(new Error('The operation is insecure.'),{name:'SecurityError'});return swReg},
  ready:Promise.resolve(swReg)
 };
 const Notification={permission:'default'};
 const sandbox={
  location:{origin:'https://station.example.test',protocol:'https:'},
  isSecureContext:!insecure,
  navigator:{userAgent:'iPhone',platform:'iPhone',maxTouchPoints:5,serviceWorker,standalone:true},
  window:{PushManager(){},Notification},
  Notification,
  matchMedia:()=>({matches:true}),
  crypto:{randomUUID:()=> 'device-test-001'},
  localStorage:{getItem:()=>null,setItem(){}},
  document:{getElementById:id=>controls.get(id),addEventListener:(name,fn)=>{events[name]=fn}},
  URL,Uint8Array,atob,
  fetch:async path=>{if(path==='/api/notifications/config'){calls.config++;return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({configured:true,publicKey:'synthetic',automaticAlerts:false})}}throw Error('Unexpected fetch '+path)}
 };
 runInNewContext(source,sandbox,{filename:'src/pwa.js'});
 return {
  controls,calls,events,
  setBlocked(v){block=v},
  click(id){return events.click({target:{closest:()=>({id})}})},
  status(){return controls.get('notification-status').textContent}
 };
}

test('reuse an active installed service worker without repeating a blocked registration',async()=>{
 const b=browser({existing:true,registrationBlocked:true});
 await tick();
 assert.equal(b.calls.register,0);
 assert.equal(b.calls.config,1);
 assert.equal(b.controls.get('push-enable').disabled,false);
 assert.equal(b.controls.get('push-retry').hidden,true);
 assert.match(b.status(),/Notifications are off/);
});

test('show the service-worker security failure and offer a safe retry without requesting permission',async()=>{
 const b=browser({registrationBlocked:true});
 await tick();
 assert.equal(b.calls.register,1);
 assert.match(b.status(),/register service worker failed: The operation is insecure/);
 assert.equal(b.controls.get('push-enable').disabled,true);
 assert.equal(b.controls.get('push-retry').hidden,false);
 assert.equal(b.calls.subscribe,0);
 b.setBlocked(false);
 await b.click('push-retry');
 await tick();
 assert.equal(b.calls.register,2);
 assert.equal(b.calls.config,1);
 assert.equal(b.controls.get('push-enable').disabled,false);
 assert.equal(b.controls.get('push-retry').hidden,true);
 assert.equal(b.calls.subscribe,0);
});

test('attribute subscription lookup SecurityError to the correct stage',async()=>{
 const b=browser({existing:true,lookupBlocked:true});
 await tick();
 assert.match(b.status(),/Check existing push subscription failed: The operation is insecure/);
 assert.equal(b.controls.get('push-retry').hidden,false);
 assert.equal(b.controls.get('push-enable').disabled,true);
});

test('refuse insecure origins without calling service worker APIs',async()=>{
 const b=browser({insecure:true});
 await tick();
 assert.match(b.status(),/check service worker failed: This page is not running in a secure HTTPS context/);
 assert.equal(b.calls.existing,0);
 assert.equal(b.calls.register,0);
 assert.equal(b.controls.get('push-enable').disabled,true);
});
