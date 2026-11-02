import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {createNewsroomHandler} from '../worker/newsroom.mjs';
import {createNewsroomConversationHandler} from '../worker/newsroom-conversations.mjs';
import {createNewsroomReaderHandler,renderNewsroomReader} from '../worker/newsroom-reader.mjs';

const origin='https://newsroom.synthetic.invalid',org='synthetic_readers';
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 sqlite.exec('CREATE TABLE unrelated_canary (id INTEGER PRIMARY KEY, value TEXT)');
 sqlite.prepare('INSERT INTO unrelated_canary VALUES(?,?)').run(1,'preserved');
 for(const name of ['0004-newsroom-p1a.sql','0005-newsroom-conversations.sql']){
  const schema=readFileSync(new URL('../worker/migrations/'+name,import.meta.url),'utf8');sqlite.exec(schema);
 }
 sqlite.prepare('INSERT INTO nr_organizations(org_id,label) VALUES(?,?)').run(org,'Synthetic readers');
 for(const [sub,role,active] of [['publisher','publisher',1],['reader','reader',1],['commenter','commenter',1],['revoked','reader',0]])
  sqlite.prepare('INSERT INTO nr_memberships(org_id,subject,role,active,created_at) VALUES(?,?,?,?,?)')
   .run(org,sub,role,active,Date.now());
 const db={prepare(query){let args=[];return{bind(...values){args=values;return this},first(){return sqlite.prepare(query).get(...args)??null},all(){return{results:sqlite.prepare(query).all(...args)}},run(){const r=sqlite.prepare(query).run(...args);return{meta:{changes:Number(r.changes)}}}}},async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const r=statements.map(s=>s.run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e}}};
 const env={APP_ORIGIN:origin,NEWSROOM_SYNTHETIC_ONLY:'true',NEWSROOM_DB:db,NEWSROOM_ORG_ID:org,ACCESS_AUD:'synthetic-audience',ACCESS_ISSUER:'https://synthetic.cloudflareaccess.com'};
 return {sqlite,env,api:createNewsroomHandler(),chat:createNewsroomConversationHandler(),reader:createNewsroomReaderHandler()};
}
const ctx=subject=>subject?{access:{aud:'synthetic-audience',getIdentity:async()=>({user_uuid:subject,email:subject+'@example.invalid'})}}:{};
async function call(f,handler,subject,method,path,input,extra){
 const r=new Request(origin+path,{method,headers:{...(input!==undefined?{Origin:origin,'Content-Type':'application/json'}:{}),...extra},...(input===undefined?{}:{body:JSON.stringify(input)})});
 return f[handler].fetch(r,f.env,ctx(subject));
}
const manifest={schemaVersion:1,articles:[{id:'article-one',title:'The privacy desk',blocks:[
 {id:'block-alpha',type:'heading',text:'A headline for readers'},
 {id:'block-beta',type:'paragraph',text:'Read the original paragraph before discussing it.'},
 {id:'block-gamma',type:'figure',text:'An illustrated care-improvement pathway.'}
]}]};
async function publish(f,source=manifest){
 const d=await call(f,'api','publisher','POST','/api/newsroom/drafts',{slug:'sample-edition',title:'An Original Newspaper',manifest:source});
 assert.equal(d.status,201,await d.clone().text());const editionId=(await d.json()).editionId;
 const p=await call(f,'api','publisher','POST','/api/newsroom/drafts/'+editionId+'/publish',{expectedGeneration:1,operationId:'synthetic-publish-0001'});
 assert.equal(p.status,201,await p.clone().text());return{editionId,...await p.json()};
}
const url=(e,version=1)=>'/newsroom/reader/'+e.editionId+'/revisions/'+version;

test('authorized reader receives a scoped, version-anchored and nonce-protected HTML edition',async()=>{
 const f=fixture(),e=await publish(f);
 const r=await call(f,'reader','reader','GET',url(e));assert.equal(r.status,200);
 const html=await r.text();const csp=r.headers.get('Content-Security-Policy');
 assert.match(csp,/script-src 'nonce-[0-9a-f]{32}'/);
 assert.match(csp,/connect-src 'self'/);assert.match(csp,/frame-ancestors 'none'/);
 assert.equal(r.headers.get('Cache-Control'),'private, no-store');
 assert.match(html,/CONTINUANCE/);assert.match(html,/data-can-reply="false"/);
 assert.match(html,new RegExp('data-revision="'+e.revisionId+'"'));
 assert.match(html,/data-block="block-beta"/);
 assert.match(html,/Skip to the publication/);assert.match(html,/aria-live="polite"/);
 assert.match(html,/Reading and discussion do not constitute authorization/);
 assert.doesNotMatch(html,/<script(?! nonce)/);
 const match=html.match(/<script nonce="([a-f0-9]{32})">([\s\S]*?)<\/script>/);
 assert.ok(match,'one static client script exists');assert.match(csp,new RegExp(match[1]));
 new Script(match[2]);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,0);
 assert.equal(f.sqlite.prepare('SELECT value FROM unrelated_canary WHERE id=1').get().value,'preserved');
});

test('commenter sees editor while reader never gains write capabilities through headers',async()=>{
 const f=fixture(),e=await publish(f);
 const forReader=await call(f,'reader','reader','GET',url(e),undefined,{'X-Role':'owner'});
 assert.match(await forReader.text(),/data-can-reply="false"/);
 const writer=await call(f,'reader','commenter','GET',url(e));assert.match(await writer.text(),/data-can-reply="true"/);
 const actualPost=await call(f,'chat','reader','POST',`/api/newsroom/conversations/${e.revisionId}/block-beta/messages`,{operationId:'synthetic-comment-001',text:'Forged role'},{'X-Role':'owner'});
 assert.equal(actualPost.status,404);
});

test('unknown, revoked, absent, forged or cross-organization identities never see publication text',async()=>{
 const f=fixture(),e=await publish(f);
 for(const [user,expected] of [[null,401],['unknown',404],['revoked',404]]){
  const r=await call(f,'reader',user,'GET',url(e));assert.equal(r.status,expected);assert.doesNotMatch(await r.text(),/An Original Newspaper/);
 }
 const user=await call(f,'reader','reader','GET',url(e),undefined,{Origin:'https://attacker.invalid'});
 assert.equal(user.status,200,'Origin header by itself is not auth for a GET');
 const foreign=fixture();foreign.env.NEWSROOM_ORG_ID='different_org';
 const denied=await call(foreign,'reader','reader','GET',url(e));assert.equal(denied.status,404);
 const wrong=await f.reader.fetch(new Request(origin+url(e)),f.env,{access:{aud:'unrelated',getIdentity:async()=>({user_uuid:'reader'})}});
 assert.equal(wrong.status,401);
 const rawHeaders=new Request(origin+url(e),{headers:{'Cf-Access-Authenticated-User-Email':'reader@example.invalid','X-Role':'owner'}});
 assert.equal((await f.reader.fetch(rawHeaders,f.env,{})).status,401);
});

test('route rejects unknown IDs, wrong origin, method, config and malformed revisions',async()=>{
 const f=fixture(),e=await publish(f);
 for(const path of ['/newsroom/reader/bogus/revisions/1','/newsroom/reader/'+e.editionId+'/revisions/0',
   '/newsroom/reader/'+e.editionId+'/revisions/9999999','/newsroom/reader/'+e.editionId+'/revisions/2']){
  const r=await call(f,'reader','reader','GET',path);assert.equal(r.status,404);
 }
 assert.equal((await call(f,'reader','reader','POST',url(e),{irrelevant:true})).status,405);
 assert.equal((await f.reader.fetch(new Request('https://different.invalid'+url(e)),f.env,ctx('reader'))).status,403);
 f.env.NEWSROOM_SYNTHETIC_ONLY='false';assert.equal((await call(f,'reader','reader','GET',url(e))).status,503);
});

test('untrusted article and paragraph content cannot create script, event handler, or unsafe source link',async()=>{
 const f=fixture();const injection='PUBLIC <img src=x onerror=alert(7)> & <script>alert(3)</script>';
 const source=structuredClone(manifest);source.articles[0].title=injection;
 source.articles[0].blocks[1].text=injection;
 source.articles[0].blocks[1].sourceUri='https://example.invalid/reference?q=1&x=2';
 const e=await publish(f,source);const html=await (await call(f,'reader','reader','GET',url(e))).text();
 assert.match(html,/PUBLIC &lt;img src=x onerror=alert\(7\)&gt;/);
 assert.match(html,/&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
 assert.doesNotMatch(html,/<img src=x onerror=/);
 assert.doesNotMatch(html,/src="javascript:/);
 assert.match(html,/https:\/\/example.invalid\/reference\?q=1&amp;x=2/);
 assert.equal(html.match(/<script nonce=/g)?.length,1);
});

test('revision corrections point at immutable revision IDs and preserve earlier reader links',async()=>{
 const f=fixture(),e=await publish(f);
 const corrected=structuredClone(manifest);corrected.articles[0].blocks[1].text='An explicit correction, on version two.';
 assert.equal((await call(f,'api','publisher','PUT','/api/newsroom/drafts/'+e.editionId,{expectedGeneration:1,manifest:corrected})).status,200);
 const next=await call(f,'api','publisher','POST','/api/newsroom/drafts/'+e.editionId+'/publish',{expectedGeneration:2,operationId:'synthetic-publish-0002'});
 assert.equal(next.status,201);const latest=await next.json();
 const old=await (await call(f,'reader','reader','GET',url(e))).text();
 const newer=await (await call(f,'reader','reader','GET',url(e,2))).text();
 assert.match(old,/Read the original paragraph before discussing it/);
 assert.doesNotMatch(old,/An explicit correction, on version two/);
 assert.match(newer,/An explicit correction, on version two/);
 assert.match(old,new RegExp('data-revision="'+e.revisionId+'"'));
 assert.match(newer,new RegExp('data-revision="'+latest.revisionId+'"'));
});

test('renderer outputs a safe page with no browser network action during page generation',()=>{
 const page=renderNewsroomReader({editionId:'demo-edition',title:'Sample issue'},
 {revisionId:'synthetic-revision',sha256:'a'.repeat(64),version:1,publishedAt:1790000000000,manifest},
 {canReply:true,nonce:'b'.repeat(32)});
 assert.match(page,/<button[^>]+data-block="block-beta"/);
 assert.match(page,/role="status"/);
 assert.match(page,/data-can-reply="true"/);
 assert.doesNotMatch(page,/https:\/\/cdn/);
 writeFileSync(new URL('../review/preview.html',import.meta.url),page);
});
