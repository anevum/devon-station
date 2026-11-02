const encode=value=>btoa(String.fromCharCode(...value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const part=value=>encode(new TextEncoder().encode(JSON.stringify(value)));
export function validEndpoint(value){try{const u=new URL(value);const h=u.hostname;return value.length<=4096&&u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&!u.hash&&(h==='web.push.apple.com'||h.endsWith('.push.apple.com')||h==='fcm.googleapis.com'||h==='updates.push.services.mozilla.com'||h.endsWith('.notify.windows.com'))?u.href:null;}catch{return null;}}
export function deviceId(value){return typeof value==='string'&&/^[a-zA-Z0-9-]{8,80}$/.test(value)?value:null;}
export async function endpointHash(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
const tokenCache=new Map();
export async function vapidToken(endpoint,privateJwk,subject,now=Math.floor(Date.now()/1000)){const origin=new URL(endpoint).origin;const cacheKey=origin+'|'+privateJwk.x;const previous=tokenCache.get(cacheKey);if(previous&&previous.created+3600>now)return previous.token;const unsigned=part({typ:'JWT',alg:'ES256'})+'.'+part({aud:origin,exp:now+12*3600,sub:subject});const key=await crypto.subtle.importKey('jwk',privateJwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(unsigned));const token=unsigned+'.'+encode(new Uint8Array(signature));tokenCache.set(cacheKey,{token,created:now});return token;}
// Only Apple's documented error reasons are returned to the authenticated owner.
// Never copy the upstream JSON, push endpoint, authorization header or keys.
const SAFE_PUSH_REASONS=Object.freeze({
 BadTtl:'bad_ttl',BadUrgency:'bad_urgency',
 BadWebPushRequest:'bad_web_push_request',BadWebPushTopic:'bad_web_push_topic',
 VapidPkHashMismatch:'vapid_key_mismatch',IdleTimeout:'idle_timeout',
 BadAuthorizationHeader:'bad_authorization_header',BadJwtToken:'bad_jwt_token',
 BadVapidPublicKey:'bad_vapid_public_key',BadPath:'bad_path',
 MethodNotAllowed:'method_not_allowed',PayloadTooLarge:'payload_too_large',
 TooManyRequests:'too_many_requests',InternalServerError:'internal_server_error',
 ServiceUnavailable:'service_unavailable',Shutdown:'shutdown'
});
export async function safePushServiceFailure(response){
 const code='push_service_http_'+String(response?.status);
 if(!response||response.status<400||response.status>599)return code;
 if(!/^application\/json(?:;|$)/i.test(response.headers?.get('Content-Type')||''))return code;
 const length=response.headers?.get('Content-Length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>1024))return code;
 const reader=response.body?.getReader?.();
 if(!reader)return code;
 let size=0;const parts=[];
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;if(size>1024){await reader.cancel();return code;}
   parts.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const suffix=Object.hasOwn(SAFE_PUSH_REASONS,data?.reason)?SAFE_PUSH_REASONS[data.reason]:null;
  return suffix?code+'_'+suffix:code;
 }catch{return code}finally{reader.releaseLock()}
}
// These codes are intentionally fixed, non-sensitive labels: never expose JWK,
// JWT, endpoint, subscription, transport exception text or upstream body.
export class PushDispatchError extends Error {
 constructor(code){super(code);this.name='PushDispatchError';this.code=code;}
}
function jwkPublicKey(key){
 if(typeof key?.x!=='string'||typeof key?.y!=='string')throw Error('invalid coordinates');
 const decode=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));
 const x=decode(key.x),y=decode(key.y);
 if(x.length!==32||y.length!==32)throw Error('invalid curve coordinates');
 return encode(new Uint8Array([4,...x,...y]));
}
export async function sendGenericPush(endpoint,env,transport=fetch){
 if(!validEndpoint(endpoint))throw new PushDispatchError('push_endpoint_invalid');
 let key,publicKey;
 try{key=JSON.parse(env.VAPID_PRIVATE_JWK);publicKey=jwkPublicKey(key)}
 catch{throw new PushDispatchError('push_vapid_key_invalid')}
 // The subscription advertises the public key: it must match the signing key.
 if(publicKey!==env.VAPID_PUBLIC_KEY)throw new PushDispatchError('push_vapid_pair_mismatch');
 let jwt;
 try{jwt=await vapidToken(endpoint,key,env.VAPID_SUBJECT)}
 catch{throw new PushDispatchError('push_vapid_sign_failed')}
 // Manual test notifications don't require message replacement: avoid an optional\n // Topic header, whose base64url encoding Apple may reject with HTTP 400.\n // Cloudflare Workers rejects redirect:'error' before a network request. Manual
 // redirect handling is required so VAPID credentials never follow 3xx URLs.
 try{return await transport(endpoint,{method:'POST',headers:{Authorization:`vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,TTL:'300',Urgency:'normal'},redirect:'manual',signal:AbortSignal.timeout(10000)})}
 catch(error){throw new PushDispatchError(['TimeoutError','AbortError'].includes(error?.name)?'push_transport_timeout':'push_transport_failed')}
}
