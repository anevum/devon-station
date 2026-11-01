/* Only the separately hosted instance talks to its own notification API. */
(()=>{
 const hosted=location.protocol==='https:';if(!hosted)return;
 const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 const standalone=()=>matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
 let registration,config,error='',busy=false,initializing=false;const idKey='devon-station:push-device:v1';let currentId;
 try{currentId=localStorage.getItem(idKey);if(!/^[a-zA-Z0-9-]{8,80}$/.test(currentId??'')){currentId=crypto.randomUUID();localStorage.setItem(idKey,currentId)}}catch{currentId=crypto.randomUUID()}
 const supported='serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
 const unpack=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));
 async function api(path,data){const response=await fetch('/api/notifications/'+path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:undefined,body:data?JSON.stringify(data):undefined,credentials:'same-origin',cache:'no-store'});if(!response.headers.get('Content-Type')?.includes('application/json'))throw Error('Sign in again, then reopen Settings.');const value=await response.json();if(!response.ok)throw Error(value.error?.replaceAll('_',' ')??'Request failed');return value;}
 async function refresh(){const status=document.getElementById('notification-status');if(!status)return;let active=null;try{active=registration?await registration.pushManager.getSubscription():null}catch(e){error='Check existing push subscription failed: '+(e?.message||e?.name||'unknown error');}status.textContent=error||(!supported?'This browser does not support Web Push.':ios&&!standalone()?'On iPhone, add Devon Station to the Home Screen and open it there first.':!registration||!config?'Preparing this device…':!config.configured?'Server push configuration is incomplete.':Notification.permission==='denied'?'Notifications are blocked in this device’s settings.':active?'This browser has a push subscription. Use Send test to verify delivery.':'Notifications are off for this device.');const enable=document.getElementById('push-enable'),test=document.getElementById('push-test'),disable=document.getElementById('push-disable'),retry=document.getElementById('push-retry');if(retry){retry.hidden=!error;retry.disabled=busy||initializing;}if(enable)enable.disabled=busy||initializing||!!error||!supported||!registration||!config?.configured||(ios&&!standalone())||Notification.permission==='denied'||!!active;if(test)test.disabled=busy||initializing||!!error||!active;if(disable)disable.disabled=busy||initializing||!!error||!active;}
 globalThis.StationNotifications={panel:()=>`<section class="panel notification-panel"><span class="eyebrow">HOME SCREEN & NOTIFICATIONS</span><h2 style="margin:8px 0">Take your station with you.</h2><p class="tiny muted">iPhone: Safari → Share → Add to Home Screen → Open as Web App. Then open Devon Station from its icon.</p><p id="notification-status" class="info-note" role="status">Preparing this device…</p><div class="button-row" style="margin-top:15px"><button id="push-enable" disabled>Enable this device</button><button id="push-test" disabled>Send test</button><button id="push-disable" disabled>Disable this device</button><button id="push-retry" type="button" hidden>Retry setup</button></div><p class="tiny muted">Alerts show a generic message. Private details stay behind sign-in. Automatic alert sources are not connected yet.</p></section>`,mounted:()=>{refresh().catch(()=>{})}};
 async function initialize(){
  if(!supported||initializing)return;
  initializing=true;error='';let step='check service worker';
  try{
   if(globalThis.isSecureContext===false)throw Error('This page is not running in a secure HTTPS context');
   const existing=typeof navigator.serviceWorker.getRegistration==='function'?await navigator.serviceWorker.getRegistration('/'):null;
   // An installed iOS PWA can already have a running worker. Reusing it avoids
   // a redundant script fetch that may be blocked by the Access login boundary.
   if(existing?.active?.scriptURL&&new URL(existing.active.scriptURL).pathname==='/sw.js')registration=existing;
   else{step='register service worker';registration=await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});}
   step='wait for service worker activation';await navigator.serviceWorker.ready;
   step='load push configuration';config=await api('config');
  }catch(e){
   error=step+' failed: '+(e?.message||e?.name||'unknown error')+
    (e?.name==='SecurityError'?' Check the installed Home Screen app and retry after sign-in.':'');
  }finally{initializing=false;await refresh().catch(()=>{});}
 }
 if(supported)initialize().catch(()=>{});
 document.addEventListener('click',async event=>{const target=event.target.closest('button');if(!target||!['push-enable','push-test','push-disable','push-retry'].includes(target.id))return;if(target.id==='push-retry'){initialize().catch(()=>{});return;}error='';
  if(target.id==='push-enable'){
   if(!registration||!config?.configured||busy)return;busy=true;let subscription;
   try{const pending=registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:unpack(config.publicKey)});subscription=await pending;await api('subscribe',{deviceId:currentId,subscription:subscription.toJSON()});error='Device registered. Use Send test to check the phone receipt.';}catch(e){if(subscription)await subscription.unsubscribe().catch(()=>{});error=e.message;}finally{busy=false;refresh()}return;
  }
  if(busy)return;busy=true;try{if(target.id==='push-test'){const r=await api('test',{deviceId:currentId});error=r.accepted?'Push service accepted the test. Check your phone; receipt is not confirmed here.':'The push service rejected this test.';}else{await api('unsubscribe',{deviceId:currentId});const subscription=await registration.pushManager.getSubscription();await subscription?.unsubscribe();error='Notifications disabled for this device.'}}catch(e){error=e.message}finally{busy=false;refresh()}
 });
 if(typeof render==='function')render();
})();
