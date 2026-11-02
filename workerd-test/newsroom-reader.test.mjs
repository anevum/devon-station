import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare} from 'miniflare';

const date=process.env.DS_WORKERD_COMPAT_DATE??'2026-07-30';
if(!['2026-07-30','2026-10-28'].includes(date))throw Error('Unsupported synthetic workerd compatibility date');
const origin='https://synthetic-reader.example.test',org='fictional_newsroom_readers';
const issuer='https://synthetic-reader.cloudflareaccess.com',aud='reader-audience';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=keys.publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'fake-reader-key',alg:'RS256'});
const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt=(subject,claims={})=>{const h=enc({alg:'RS256',kid:jwk.kid});
 const p=enc({iss:issuer,aud,sub:subject,email:subject+'@synthetic.example',exp:Math.floor(Date.now()/1000)+300,...claims});
 const b=h+'.'+p;return b+'.'+sign('RSA-SHA256',Buffer.from(b),keys.privateKey).toString('base64url');};
async function migrate(db,name,n){
 const raw=await readFile(new URL('../worker/migrations/'+name,import.meta.url),'utf8');
 const stmts=raw.replace(/^\s*--[^\n]*$/gm,'').trim().split(/(?=^CREATE (?:TABLE|INDEX|TRIGGER)\b)/gm).map(x=>x.trim()).filter(Boolean);
 assert.equal(stmts.length,n);
 for(const stmt of stmts)await db.prepare(stmt).run();
}

test(`workerd ${date}: article reader + immutable paragraph conversation protect separate signed members`,async()=>{
 const mf=new Miniflare({modules:true,modulesRoot:new URL('../',import.meta.url).pathname,
  scriptPath:new URL('./newsroom-reader-fixture.mjs',import.meta.url).pathname,
  compatibilityDate:date,compatibilityFlags:['nodejs_compat'],d1Databases:['NEWSROOM_DB'],
  bindings:{APP_ORIGIN:origin,NEWSROOM_SYNTHETIC_ONLY:'true',NEWSROOM_ORG_ID:org,
   ACCESS_ISSUER:issuer,ACCESS_AUD:aud,ACCESS_JWKS_URL:issuer+'/cdn-cgi/access/certs'},
  outboundService:req=>{assert.equal(req.url,issuer+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]})}});
 try{
  const db=await mf.getD1Database('NEWSROOM_DB');
  await db.prepare('CREATE TABLE rb01_canary(value TEXT)').run();
  await db.prepare('INSERT INTO rb01_canary(value) VALUES(?)').bind('original').run();
  await migrate(db,'0004-newsroom-p1a.sql',14);await migrate(db,'0005-newsroom-conversations.sql',5);
  await db.prepare('INSERT INTO nr_organizations(org_id,label) VALUES(?,?)').bind(org,'Fictional news desk').run();
  for(const [subject,role,active] of [['publisher','publisher',1],['commenter','commenter',1],['reader','reader',1],['revoked','reader',0]])
   await db.prepare('INSERT INTO nr_memberships(org_id,subject,role,active,created_at) VALUES(?,?,?,?,?)')
    .bind(org,subject,role,active,Date.now()).run();
  const call=(subject,method,path,input,headers={})=>mf.dispatchFetch(origin+path,{method,headers:{...(subject?{'Cf-Access-Jwt-Assertion':jwt(subject)}:{}),
   ...(input===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},
   ...(input===undefined?{}:{body:JSON.stringify(input)})});
  const manifest={schemaVersion:1,articles:[{id:'story-one',title:'A fictional story',blocks:[
   {id:'section-one',type:'heading',text:'Starting point'},
   {id:'passage-one',type:'paragraph',text:'This paragraph is the immutable source for discussion.'}
  ]}]};
  const created=await call('publisher','POST','/api/newsroom/drafts',
   {slug:'sample-paper',title:'Synthetic edition',manifest});
  assert.equal(created.status,201,await created.clone().text());const id=(await created.json()).editionId;
  const published=await call('publisher','POST',`/api/newsroom/drafts/${id}/publish`,
   {expectedGeneration:1,operationId:'reader-native-publish-001'});
  assert.equal(published.status,201);const rev=(await published.json()).revisionId;
  const readerPath=`/newsroom/reader/${id}/revisions/1`;
  assert.equal((await call(null,'GET',readerPath)).status,401);
  for(const subject of ['revoked','outsider']){
   const denied=await call(subject,'GET',readerPath);
   assert.equal(denied.status,404);assert.doesNotMatch(await denied.text(),/Synthetic edition/);
  }
  assert.equal((await call('reader','GET',readerPath,undefined,{'Cf-Access-Jwt-Assertion':jwt('reader',{aud:'other-audience'})})).status,401);
  const read=await call('reader','GET',readerPath);
  assert.equal(read.status,200,await read.clone().text());const html=await read.text();
  assert.match(html,/data-can-reply="false"/);assert.match(html,new RegExp('data-revision="'+rev+'"'));
  assert.match(html,/data-block="passage-one"/);assert.match(html,/This paragraph is the immutable source for discussion/);
  const nonce=html.match(/<script nonce="([a-f0-9]{32})">/);assert.ok(nonce);
  assert.match(read.headers.get('Content-Security-Policy'),new RegExp("script-src 'nonce-"+nonce[1]+"'"));
  assert.equal(read.headers.get('Cache-Control'),'private, no-store');
  const withEditor=await call('commenter','GET',readerPath);
  assert.equal(withEditor.status,200);assert.match(await withEditor.text(),/data-can-reply="true"/);
  const old=await call('commenter','POST',`/api/newsroom/conversations/${rev}/passage-one/messages`,
   {operationId:'native-comment-001',text:'A fictional reader comment, not a decision.'});
  assert.equal(old.status,201,await old.clone().text());
  const reply=await call('publisher','POST',`/api/newsroom/conversations/${rev}/passage-one/messages`,
   {operationId:'native-comment-002',text:'An authorized fictional response.'});
  assert.equal(reply.status,201);
  const chat=await call('reader','GET',`/api/newsroom/conversations/${rev}/passage-one`);
  assert.equal(chat.status,200);assert.equal((await chat.json()).messages.length,2);
  assert.equal((await db.prepare('SELECT value FROM rb01_canary').first()).value,'original');
  await db.prepare('UPDATE nr_memberships SET active=0 WHERE org_id=? AND subject=?').bind(org,'commenter').run();
  assert.equal((await call('commenter','GET',readerPath)).status,404);
  assert.equal((await call('commenter','GET',`/api/newsroom/conversations/${rev}/passage-one`)).status,404);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').first()).n,2);
 }finally{await mf.dispose()}
});
