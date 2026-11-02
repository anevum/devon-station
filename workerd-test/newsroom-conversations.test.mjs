import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare} from 'miniflare';
import {exportSyntheticConversations,restoreSyntheticConversations} from '../worker/newsroom-conversation-recovery.mjs';
import {restoreSyntheticEdition} from '../worker/newsroom-recovery.mjs';

const compatibilityDate=process.env.DS_WORKERD_COMPAT_DATE??'2026-07-30';
if(!['2026-07-30','2026-10-28'].includes(compatibilityDate))throw Error('Unsupported synthetic compatibility date');
const origin='https://fictional-newsroom.example.test',org='fictional_editorial_team';
const issuer='https://fictionalnewsroom.cloudflareaccess.com',audience='fictional-audience';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=keys.publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'fictional-newsroom-key',alg:'RS256'});
const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(subject='commenter',extra={}){
 const claims={iss:issuer,aud:audience,sub:subject,email:subject+'@fictional.example',exp:Math.floor(Date.now()/1000)+300,...extra};
 const input=encoded({alg:'RS256',kid:jwk.kid})+'.'+encoded(claims);
 return input+'.'+sign('RSA-SHA256',Buffer.from(input),keys.privateKey).toString('base64url');
}
async function migrate(db,filename,expectedCount){
 const source=await readFile(new URL('../worker/migrations/'+filename,import.meta.url),'utf8');
 // D1 exec parses by lines; apply each complete CREATE statement (including BEGIN/END triggers) individually.
 const ddl=source.replace(/^\s*--[^\n]*$/gm,'').trim().split(/(?=^CREATE (?:TABLE|INDEX|TRIGGER)\b)/gm).map(x=>x.trim()).filter(Boolean);
 assert.equal(ddl.length,expectedCount,'Unexpected migration statement count');
 for(const statement of ddl)await db.prepare(statement).run();
}

test(`workerd ${compatibilityDate}: two-member revision-anchored comments persist in native D1 and fail closed`,async()=>{
 let keyFetches=0;
 const mf=new Miniflare({modules:true,modulesRoot:new URL('../',import.meta.url).pathname,
  scriptPath:new URL('./newsroom-conversation-fixture.mjs',import.meta.url).pathname,
  compatibilityDate,compatibilityFlags:['nodejs_compat'],d1Databases:['NEWSROOM_DB'],
  bindings:{APP_ORIGIN:origin,NEWSROOM_SYNTHETIC_ONLY:'true',NEWSROOM_ORG_ID:org,
   ACCESS_ISSUER:issuer,ACCESS_AUD:audience,ACCESS_JWKS_URL:issuer+'/cdn-cgi/access/certs'},
  outboundService:request=>{
   assert.equal(request.url,issuer+'/cdn-cgi/access/certs');keyFetches++;
   return Response.json({keys:[jwk]});
  }});
 try{
  const db=await mf.getD1Database('NEWSROOM_DB');
  await db.prepare('CREATE TABLE unchanged_canary(value TEXT)').run();
  await db.prepare('INSERT INTO unchanged_canary(value) VALUES(?)').bind('untouched').run();
  await migrate(db,'0004-newsroom-p1a.sql',14);
  await migrate(db,'0005-newsroom-conversations.sql',5);
  await db.prepare('INSERT INTO nr_organizations(org_id,label) VALUES(?,?)').bind(org,'Synthetic newspaper').run();
  for(const [subject,role,active] of [['publisher','publisher',1],['commenter','commenter',1],['reader','reader',1],['revoked','commenter',0]])
   await db.prepare('INSERT INTO nr_memberships(org_id,subject,role,active,created_at) VALUES(?,?,?,?,?)')
    .bind(org,subject,role,active,Date.now()).run();
  const call=(subject,method,path,payload,headers={})=>mf.dispatchFetch(origin+path,{method,
   headers:{...(subject?{'Cf-Access-Jwt-Assertion':jwt(subject)}:{}),
    ...(payload===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},
   ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  const manifest={schemaVersion:1,articles:[{id:'article-one',title:'A fictional article',blocks:[
   {id:'block-one',type:'paragraph',text:'The exact source passage will remain unchanged.'}]}]};
  const draft=await call('publisher','POST','/api/newsroom/drafts',{slug:'fictional-issue',title:'Fictional Issue',manifest});
  assert.equal(draft.status,201,await draft.clone().text());const editionId=(await draft.json()).editionId;
  const pub=await call('publisher','POST',`/api/newsroom/drafts/${editionId}/publish`,{expectedGeneration:1,operationId:'fictional-publish-001'});
  assert.equal(pub.status,201,await pub.clone().text());const revisionId=(await pub.json()).revisionId;
  const path=`/api/newsroom/conversations/${revisionId}/block-one`;
  assert.equal((await call(null,'GET',path)).status,401);
  assert.equal((await call('commenter','GET',path,undefined,{'Cf-Access-Jwt-Assertion':jwt('commenter',{aud:'untrusted-audience'})})).status,401);
  assert.equal((await call('revoked','GET',path)).status,404);
  assert.equal((await call('outsider','GET',path)).status,404);
  assert.equal((await call('reader','POST',path+'/messages',{operationId:'fictional-op-001',text:'Forged claim'},{'X-Role':'publisher'})).status,404);
  const first=await call('commenter','POST',path+'/messages',{operationId:'fictional-op-001',text:'This is a synthetic question.'});
  assert.equal(first.status,201,await first.clone().text());const msg=await first.json();
  const same=await call('commenter','POST',path+'/messages',{operationId:'fictional-op-001',text:'This is a synthetic question.'});
  assert.equal(same.status,200);assert.equal((await same.json()).messageId,msg.messageId);
  const changed=await call('commenter','POST',path+'/messages',{operationId:'fictional-op-001',text:'A changed question.'});
  assert.equal(changed.status,409);
  const reply=await call('publisher','POST',path+'/messages',{operationId:'fictional-op-001',text:'A response from the other principal.'});
  assert.equal(reply.status,201,await reply.clone().text());
  const read=await call('reader','GET',path);assert.equal(read.status,200);
  const thread=await read.json();assert.equal(thread.anchor.text,manifest.articles[0].blocks[0].text);
  assert.deepEqual(thread.messages.map(x=>x.authorSub),['commenter','publisher']);
  const updated=structuredClone(manifest);updated.articles[0].blocks[0].text='A corrected second edition.';
  assert.equal((await call('publisher','PUT',`/api/newsroom/drafts/${editionId}`,{expectedGeneration:1,manifest:updated})).status,200);
  const v2=await call('publisher','POST',`/api/newsroom/drafts/${editionId}/publish`,{expectedGeneration:2,operationId:'fictional-publish-002'});
  assert.equal(v2.status,201);const rev2=(await v2.json()).revisionId;
  assert.equal((await(await call('reader','GET',path)).json()).messages.length,2);
  const newThread=await call('reader','GET',`/api/newsroom/conversations/${rev2}/block-one`);
  assert.equal(newThread.status,200);assert.equal((await newThread.json()).messages.length,0);
  // A second ephemeral native D1 is an empty conversation target with restored
  // identical publication sources and pre-provisioned fictional memberships.
  const archive=await exportSyntheticConversations(db,org,editionId,{allowSyntheticExport:true});
  assert.equal(archive.messages.length,2);
  const publicationResponse=await call('reader','GET',`/api/newsroom/editions/${editionId}/export`);
  assert.equal(publicationResponse.status,200);
  const publication=await publicationResponse.json();
  const target=new Miniflare({modules:true,modulesRoot:new URL('../',import.meta.url).pathname,
   scriptPath:new URL('./newsroom-conversation-fixture.mjs',import.meta.url).pathname,
   compatibilityDate,compatibilityFlags:['nodejs_compat'],d1Databases:['NEWSROOM_DB'],
   bindings:{APP_ORIGIN:origin,NEWSROOM_SYNTHETIC_ONLY:'true',NEWSROOM_ORG_ID:org,
    ACCESS_ISSUER:issuer,ACCESS_AUD:audience,ACCESS_JWKS_URL:issuer+'/cdn-cgi/access/certs'},
   outboundService:request=>{assert.equal(request.url,issuer+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]});}});
  try{
   const dest=await target.getD1Database('NEWSROOM_DB');
   await dest.prepare('CREATE TABLE independent_target_canary(value TEXT)').run();
   await dest.prepare('INSERT INTO independent_target_canary(value) VALUES(?)').bind('intact').run();
   await migrate(dest,'0004-newsroom-p1a.sql',14);
   await migrate(dest,'0005-newsroom-conversations.sql',5);
   await dest.prepare('INSERT INTO nr_organizations(org_id,label) VALUES(?,?)').bind(org,'Synthetic restored paper').run();
   for(const [subject,role] of [['publisher','publisher'],['commenter','commenter'],['reader','reader']])
    await dest.prepare('INSERT INTO nr_memberships(org_id,subject,role,active,created_at) VALUES(?,?,?,?,?)')
     .bind(org,subject,role,1,Date.now()).run();
   const editionRestore=await restoreSyntheticEdition(dest,org,publication,{allowSyntheticRestore:true});
   assert.equal(editionRestore.restored,true);
   const recovered=await restoreSyntheticConversations(dest,org,archive,{allowSyntheticRestore:true});
   assert.equal(recovered.messageCount,2);
   const secondExport=await exportSyntheticConversations(dest,org,editionId,{allowSyntheticExport:true});
   assert.deepEqual(secondExport,archive);
   assert.equal((await dest.prepare('SELECT value FROM independent_target_canary').first()).value,'intact');
   await assert.rejects(()=>restoreSyntheticConversations(dest,org,archive,{allowSyntheticRestore:true}));
   assert.equal((await dest.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').first()).n,2);
  }finally{await target.dispose()}
  await db.prepare('UPDATE nr_memberships SET active=0 WHERE org_id=? AND subject=?').bind(org,'commenter').run();
  assert.equal((await call('commenter','GET',path)).status,404);
  await assert.rejects(()=>db.prepare('DELETE FROM nr_thread_messages WHERE org_id=?').bind(org).run());
  assert.equal((await db.prepare('SELECT count(*) AS n FROM nr_thread_messages').first()).n,2);
  assert.equal((await db.prepare('SELECT value FROM unchanged_canary').first()).value,'untouched');
  assert(keyFetches>=1);
 }finally{await mf.dispose()}
});
