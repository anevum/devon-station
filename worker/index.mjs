import {workspaceScopes,readWorkspace,mutateWorkspace,reviewWorkspaceSources,reconcileWorkspaceSources,exportWorkspace,reviewWorkspaceRestore,restoreWorkspace} from './workspace.mjs';
import {authorizedIdentity} from './access.mjs';
import {validEndpoint,deviceId,endpointHash,sendGenericPush,PushDispatchError} from './notifications.mjs';
import {getOwnerState,saveOwnerState} from './state.mjs';
import {getCachedPortfolio,refreshPortfolio} from './portfolio.mjs';
const common={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Strict-Transport-Security':'max-age=31536000','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
const csp="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'none'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const pushReady=env=>Boolean(env.DB&&env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_JWK&&env.VAPID_SUBJECT);
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{...common,'Content-Type':'application/json;charset=utf-8','Content-Security-Policy':csp}});
function publicServiceWorker(request,env,url,assets){
 // A separate, exact-path Cloudflare Access Bypass rule is ALSO required.
 // Never bypass Access for the private shell, APIs, manifests, or other assets.
 if(env.PUBLIC_SERVICE_WORKER!=='true'||url.pathname!=='/sw.js'||url.search)return null;
 if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405);
 const script=assets['/sw.js'];
 if(!script||script.encoding==='base64'||!/^((text|application)\/javascript)(;|$)/.test(script.type))return json({error:'not_found'},404);
 return new Response(request.method==='HEAD'?null:script.body,{
  headers:{...common,'Cache-Control':'no-store','Content-Type':script.type,
   'Content-Security-Policy':csp,'Cross-Origin-Resource-Policy':'same-origin',
   'Service-Worker-Allowed':'/'}
 });
}
async function readBody(request,limit=8192){
 // Bound bytes while reading instead of buffering an unbounded request first.
 if(Number(request.headers.get('Content-Length'))>limit)throw {status:413};
 const reader=request.body?.getReader();if(!reader)throw {status:400};
 let used=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;used+=value.byteLength;if(used>limit){await reader.cancel();throw {status:413}}chunks.push(value)}}
 finally{reader.releaseLock()}
 const bytes=new Uint8Array(used);let pos=0;for(const item of chunks){bytes.set(item,pos);pos+=item.byteLength}
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value}catch{throw {status:400}}
}
export function createStation(assets,auth=authorizedIdentity,transport=fetch){return {async fetch(request,env,ctx){try{
 const url=new URL(request.url);if(url.origin!==env.APP_ORIGIN)return json({error:'wrong_origin'},403);
 const publicScript=publicServiceWorker(request,env,url,assets);if(publicScript)return publicScript;
 let user;try{user=await auth(request,env,ctx)}catch{return json({error:'owner_sign_in_required'},401)}
 if(user?.email!==env.OWNER_EMAIL||!user.subject)return json({error:'owner_only'},403);
 if(!['GET','HEAD','POST','DELETE'].includes(request.method))return json({error:'method_not_allowed'},405);
 const writes=['POST','DELETE'].includes(request.method);if(writes&&(request.headers.get('Origin')!==url.origin||request.headers.get('Content-Type')?.split(';')[0]!=='application/json'))return json({error:'same_origin_json_required'},403);
 if(url.pathname==='/api/session'&&request.method==='GET')return json({authenticated:true,mode:'owner',version:'0.4.8',snapshot:true,persistentStorage:!!env.DB});
 if(url.pathname==='/api/workspaces'&&request.method==='GET')return json(await workspaceScopes(user,env));
 if(['/api/workspace','/api/workspace/propose','/api/workspace/decide','/api/workspace/review','/api/workspace/reconcile','/api/workspace/backup','/api/workspace/restore-review','/api/workspace/restore'].includes(url.pathname)){
  const scope={scopeKind:url.searchParams.get('scopeKind'),scopeId:url.searchParams.get('scopeId')};
  if(url.pathname==='/api/workspace'&&request.method==='GET')return json(await readWorkspace(env.DB,user,env,scope));
  if(request.method==='GET'&&url.pathname==='/api/workspace/review')return json(await reviewWorkspaceSources(env.DB,user,env,scope));
  if(request.method==='GET'&&url.pathname==='/api/workspace/backup')return json(await exportWorkspace(env.DB,user,env,scope));
  if(request.method==='POST'&&['/api/workspace/reconcile','/api/workspace/restore-review','/api/workspace/restore'].includes(url.pathname)){
   const handler=url.pathname.endsWith('/reconcile')?reconcileWorkspaceSources:url.pathname.endsWith('/restore-review')?reviewWorkspaceRestore:restoreWorkspace;
   return json(await handler(env.DB,user,env,scope,await readBody(request,url.pathname.endsWith('/reconcile')?8192:6*1024*1024)));
  }
  if(request.method==='POST'&&['/api/workspace/propose','/api/workspace/decide'].includes(url.pathname))return json(await mutateWorkspace(env.DB,user,env,scope,url.pathname.endsWith('/propose')?'propose':'decide',await readBody(request,8192)));
  return json({error:'method_not_allowed'},405);
 }
 if(url.pathname==='/api/portfolio'&&request.method==='GET'){if(!env.DB)return json({error:'storage_unavailable'},503);return json(await getCachedPortfolio(env.DB,user.subject,!!(env.NOTION_READ_TOKEN&&env.NOTION_PORTFOLIO_SOURCE_ID)));}
 if(url.pathname==='/api/portfolio/refresh'&&request.method==='POST'){if(!env.DB)return json({error:'storage_unavailable'},503);return json(await refreshPortfolio(env.DB,user.subject,env,transport));}
 if(url.pathname==='/api/state'&&request.method==='GET'){if(!env.DB)return json({error:'storage_unavailable'},503);const {lastOperation,...state}=await getOwnerState(env.DB,user.subject);return json(state);}
 if(url.pathname==='/api/state'&&request.method==='POST'){if(!env.DB)return json({error:'storage_unavailable'},503);const data=await readBody(request,131072);try{return json(await saveOwnerState(env.DB,user.subject,data));}catch(e){if(e.status===409)return json({error:'revision_conflict'},409);throw e;}}
 if(url.pathname==='/api/notifications/config'&&request.method==='GET')return json({configured:pushReady(env),publicKey:env.VAPID_PUBLIC_KEY??null,automaticAlerts:false,privacy:'Generic notifications only; no private content in push payloads.'});
 if(url.pathname.startsWith('/api/notifications/')&&!env.DB)return json({error:'notification_storage_unavailable'},503);
 if(url.pathname==='/api/notifications/subscribe'&&request.method==='POST'){
  if(!pushReady(env))return json({error:'push_not_configured'},503);
  const body=await readBody(request),id=deviceId(body.deviceId),endpoint=validEndpoint(body.subscription?.endpoint);if(!id||!endpoint)return json({error:'invalid_device_or_endpoint'},400);
  const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM push_devices WHERE owner_sub=? AND active=1').bind(user.subject).first();
  const existing=await env.DB.prepare('SELECT device_id FROM push_devices WHERE owner_sub=? AND device_id=? AND active=1').bind(user.subject,id).first();
  if((count?.n??0)>=10&&!existing)return json({error:'device_limit'},409);
  const hash=await endpointHash(endpoint),now=Date.now();
  await env.DB.batch([env.DB.prepare('DELETE FROM push_devices WHERE owner_sub=? AND endpoint_hash=? AND device_id<>?').bind(user.subject,hash,id),env.DB.prepare('INSERT INTO push_devices(owner_sub,device_id,endpoint_hash,endpoint,created_at,updated_at,active) VALUES(?,?,?,?,?,?,1) ON CONFLICT(owner_sub,device_id) DO UPDATE SET endpoint_hash=excluded.endpoint_hash,endpoint=excluded.endpoint,updated_at=excluded.updated_at,active=1').bind(user.subject,id,hash,endpoint,now,now)]);
  return json({subscribed:true});
 }
 if(url.pathname==='/api/notifications/unsubscribe'&&request.method==='POST'){const body=await readBody(request),id=deviceId(body.deviceId);if(!id)return json({error:'invalid_device'},400);await env.DB.prepare('DELETE FROM push_devices WHERE owner_sub=? AND device_id=?').bind(user.subject,id).run();return json({unsubscribed:true});}
 if(url.pathname==='/api/notifications/test'&&request.method==='POST'){
  if(!pushReady(env))return json({error:'push_not_configured'},503);
  const body=await readBody(request),id=deviceId(body.deviceId);if(!id)return json({error:'invalid_device'},400);
  const device=await env.DB.prepare('SELECT endpoint FROM push_devices WHERE owner_sub=? AND device_id=? AND active=1').bind(user.subject,id).first();if(!device)return json({error:'enable_this_device_first'},404);
  const now=Date.now();const reserve=await env.DB.prepare('UPDATE push_devices SET last_sent_at=? WHERE owner_sub=? AND device_id=? AND active=1 AND (last_sent_at IS NULL OR last_sent_at<?)').bind(now,user.subject,id,now-30000).run();if(reserve.meta?.changes!==1)return json({error:'wait_30_seconds'},429);
  let response,failureCode;
  try{response=await sendGenericPush(device.endpoint,env,transport)}
  catch(error){failureCode=error instanceof PushDispatchError?error.code:'push_sender_failed';response={status:502,ok:false}}
  const accepted=response.status===201||response.status===202||response.status===200;
  if(!accepted&&!failureCode)failureCode='push_service_http_'+response.status;
  await env.DB.prepare('INSERT INTO push_delivery_log(id,owner_sub,device_id,kind,status,service_status,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),user.subject,id,'manual-test',accepted?'accepted':'failed',response.status,now).run();
  if([404,410].includes(response.status))await env.DB.prepare('UPDATE push_devices SET active=0 WHERE owner_sub=? AND device_id=?').bind(user.subject,id).run();
  await env.DB.prepare('DELETE FROM push_delivery_log WHERE owner_sub=? AND created_at<?').bind(user.subject,now-30*86400000).run();
  return json({accepted,serviceStatus:response.status,...(failureCode?{error:failureCode}:{}),delivery:'Phone receipt must be checked on your device.'},accepted?202:502);
 }
 if(url.pathname.startsWith('/api/'))return json({error:'not_found'},404);
 if(!['GET','HEAD'].includes(request.method))return json({error:'method_not_allowed'},405);
 const path=url.pathname==='/'?'/index.html':url.pathname;const asset=assets[path];if(!asset)return json({error:'not_found'},404);
 const headers={...common,'Content-Type':asset.type,'Content-Security-Policy':csp};if(path==='/sw.js')headers['Service-Worker-Allowed']='/';
 const body=asset.encoding==='base64'?Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0)):asset.body;
 return new Response(request.method==='HEAD'?null:body,{headers});
 }catch(error){return json({error:error?.publicCode??(error?.status===413?'request_too_large':error?.status===409?'revision_conflict':error?.status===400?(error.publicCode??'invalid_json'):error?.status===502||error?.status===503?(error.publicCode??'request_failed'):'request_failed')},error?.status??500);}}};}
