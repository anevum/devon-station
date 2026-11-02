/** Pure, reproducible edition schema. No identity, network, or browser state. */
const ident = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
const field = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => record(v) && Object.keys(v).every(k => expected.includes(k)) && expected.every(k => k in v);
const reject = () => { throw Object.assign(new Error('invalid_publication'), {status:400, publicCode:'invalid_publication'}); };

/** Return a safe, normalized, bounded value with a frozen external representation. */
export function validateManifest(value) {
 if(!keys(value,['schemaVersion','articles'])||value.schemaVersion!==1||!Array.isArray(value.articles)||value.articles.length<1||value.articles.length>4)reject();
 let total=0, count=0;const seen=new Set();
 const articles=value.articles.map(a=>{
  if(!keys(a,['id','title','blocks'])||!ident.test(a.id)||!field(a.title,1,160)||!Array.isArray(a.blocks)||a.blocks.length<1||a.blocks.length>32)reject();
  const blocks=a.blocks.map((b,i)=>{
   if(!record(b)||Object.keys(b).some(k=>!['id','type','text','sourceUri','ordinal'].includes(k))||!['id','type','text'].every(k=>k in b))reject();
   if((b.ordinal!==undefined&&b.ordinal!==i)||!ident.test(b.id)||seen.has(b.id)||!['heading','paragraph','figure'].includes(b.type)||!field(b.text,1,2400))reject();
   seen.add(b.id);count++;total+=b.text.length;
   if(count>48||total>16000)reject();
   let sourceUri;
   if(b.sourceUri!==undefined){if(typeof b.sourceUri!=='string'||b.sourceUri.length>1024)reject();
    try{const url=new URL(b.sourceUri);if(url.protocol!=='https:'||url.username||url.password||url.hash||/\s/.test(b.sourceUri))reject();sourceUri=url.toString();}
    catch{reject();}
   }
   return {id:b.id,type:b.type,text:b.text,...(sourceUri?{sourceUri}:{}),ordinal:i};
  });
  return {id:a.id,title:a.title,blocks};
 });
 if(new Set(articles.map(a=>a.id)).size!==articles.length)reject();
 return {schemaVersion:1,articles};
}
/** Canonical JSON used for digest, D1 storage, export and restore, v1. */
export function canonicalJSON(v){
 if(Array.isArray(v))return '['+v.map(canonicalJSON).join(',')+']';
 if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonicalJSON(v[k])).join(',')+'}';
 if(!['string','number','boolean'].includes(typeof v)&&v!==null)throw Error('uncanonical_value');
 return JSON.stringify(v);
}
export async function sha256(text){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('');}
export function manifestBlocks(manifest){return manifest.articles.flatMap(a=>a.blocks.map(b=>({articleId:a.id,blockId:b.id,ordinal:b.ordinal,kind:b.type,text:b.text,sourceUri:b.sourceUri??null})));}
export function idValid(id){return typeof id==='string'&&ident.test(id)}
export function operationValid(id){return typeof id==='string'&&/^[A-Za-z0-9_-]{8,96}$/.test(id)}
export function titleValid(text){return field(text,1,160)}
export function slugValid(s){return typeof s==='string'&&/^[a-z0-9][a-z0-9-]{1,89}$/.test(s)}
