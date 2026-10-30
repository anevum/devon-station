/** Verify a Cloudflare Access JWT using the organization's pinned team domain/audience.
 * This is a reference implementation; validate configuration and threat model before deployment.
 * Never infer identity from a user-supplied email or role header.
 */
function fromBase64Url(input) {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('Invalid token encoding');
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - input.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
function jsonPart(input) { return JSON.parse(new TextDecoder().decode(fromBase64Url(input))); }
const keyCache=new Map();
export async function cachedJWKS(url,{refresh=false}={}) {
  const previous=keyCache.get(url),at=Date.now();
  if(previous&&at<previous.expires&&(!refresh||at-previous.created<60000))return previous.promise;
  if(keyCache.size>=8&&!keyCache.has(url))keyCache.delete(keyCache.keys().next().value);
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
  const promise=fetch(url,{redirect:'error',signal:controller.signal}).then(async r=>{
    if(!r.ok)throw new Error('JWKS unavailable');const data=await r.json();
    if(!Array.isArray(data?.keys)||data.keys.length>20)throw new Error('Invalid JWKS');return data;
  }).catch(e=>{keyCache.delete(url);throw e}).finally(()=>clearTimeout(timeout));
  keyCache.set(url,{promise,created:at,expires:at+5*60000});return promise;
}
export async function verifyAccessJWT(token, config, getJWKS = cachedJWKS) {
  if (typeof token !== 'string' || token.length > 12000) throw new Error('Missing/invalid token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const header = jsonPart(parts[0]);
  const claims = jsonPart(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) throw new Error('Unsupported JWT');
  if (!config?.issuer || !config?.audience || !config?.jwksUrl) throw new Error('Authentication is not configured');
  if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.issuer)||config.jwksUrl!==config.issuer+'/cdn-cgi/access/certs')throw new Error('Unpinned identity endpoint');
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== config.issuer || ![claims.aud].flat().includes(config.audience) ||
    typeof claims.exp !== 'number' || now >= claims.exp ||
    typeof claims.nbf === 'number' && now < claims.nbf ||
    typeof claims.iat === 'number' && claims.iat > now + 60 ||
    typeof claims.sub !== 'string' || !claims.sub) throw new Error('Invalid JWT claims');
  let jwks = await getJWKS(config.jwksUrl);
  const match=keys=>Array.isArray(keys?.keys)?keys.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig')):null;
  let jwk=match(jwks);
  if(!jwk){jwks=await getJWKS(config.jwksUrl,{refresh:true});jwk=match(jwks)}
  if (!jwk) throw new Error('Signing key unavailable');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64Url(parts[2]), data);
  if (!valid) throw new Error('JWT signature invalid');
  return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null };
}
export async function authorizedIdentity(request, env, ctx) {
  if (!env.ACCESS_ISSUER || !env.ACCESS_AUD) throw Object.assign(new Error('Identity not configured'), { status: 503 });
  // Direct Access-protected Workers receive trusted runtime identity in ctx.access.
  // This is not a request header or a browser-selected role. Pin the application
  // audience, then use the Access user UUID already provisioned in memberships.
  if(ctx?.access){
    if(ctx.access.aud!==env.ACCESS_AUD || typeof ctx.access.getIdentity!=='function')throw {status:401};
    let identity;
    try{identity=await ctx.access.getIdentity()}catch{throw {status:503}}
    const subject=identity?.user_uuid||identity?.sub;
    if(typeof subject!=='string'||!subject.trim()||subject.length>128)throw {status:401};
    return {subject,email:typeof identity.email==='string'?identity.email.trim().toLowerCase():null};
  }
  // Fallback for origins where Access supplies a signed application JWT. Both
  // the assertion header and CF_Authorization cookie undergo full verification.
  // Identity/email/role headers are never accepted as proof of authentication.
  if(!env.ACCESS_JWKS_URL)throw {status:503};
  let token = request.headers.get('Cf-Access-Jwt-Assertion');
  if(!token){
    const cookies=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('CF_Authorization='));
    if(cookies.length>1)throw {status:401};
    if(cookies.length===1)token=cookies[0].slice('CF_Authorization='.length);
  }
  if (!token) throw Object.assign(new Error('Access token required'), { status: 401 });
  try {
    return await verifyAccessJWT(token, { issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUD, jwksUrl: env.ACCESS_JWKS_URL });
  } catch { throw Object.assign(new Error('Invalid access token'), { status: 401 }); }
}