import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createNewsroomHandler} from '../worker/newsroom.mjs';
import {createNewsroomConversationHandler} from '../worker/newsroom-conversations.mjs';
import {exportSyntheticConversations,restoreSyntheticConversations} from '../worker/newsroom-conversation-recovery.mjs';
import {restoreSyntheticEdition} from '../worker/newsroom-recovery.mjs';
import {canonicalJSON,sha256} from '../worker/newsroom-contract.mjs';

const ORIGIN='https://synthetic-newsroom.invalid',ORG='fictional_editorial_team';
const manifest={schemaVersion:1,articles:[{id:'article-one',title:'Our fictional paper',blocks:[
 {id:'block-one',type:'paragraph',text:'Reading an edition never grants approval.'},
 {id:'block-two',type:'paragraph',text:'Our second published paragraph is separate.'}
]}]};
const sqlFiles=['0004-newsroom-p1a.sql','0005-newsroom-conversations.sql'];
function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 sqlite.exec('CREATE TABLE unrelated_canary (id INTEGER PRIMARY KEY, value TEXT)');
 sqlite.prepare('INSERT INTO unrelated_canary VALUES(?,?)').run(1,'preserved');
 for(const file of sqlFiles){const schema=readFileSync(new URL('../worker/migrations/'+file,import.meta.url),'utf8');sqlite.exec(schema);sqlite.exec(schema);}
 sqlite.prepare('INSERT INTO nr_organizations(org_id,label) VALUES(?,?)').run(ORG,'Fictional Editorial');
 for(const [subject,role,active] of [['publisher','publisher',1],['reader','reader',1],['commenter','commenter',1],['revoked','commenter',0]])
  sqlite.prepare('INSERT INTO nr_memberships(org_id,subject,role,active,created_at) VALUES(?,?,?,?,?)').run(ORG,subject,role,active,Date.now());
 const db={prepare(query){let args=[];return{bind(...values){args=values;return this},first(){return sqlite.prepare(query).get(...args)??null},all(){return{results:sqlite.prepare(query).all(...args)}},run(){const r=sqlite.prepare(query).run(...args);return{meta:{changes:Number(r.changes)}}}}},async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const r=statements.map(s=>s.run());sqlite.exec('COMMIT');return r;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 const env={APP_ORIGIN:ORIGIN,NEWSROOM_SYNTHETIC_ONLY:'true',NEWSROOM_DB:db,NEWSROOM_ORG_ID:ORG,ACCESS_AUD:'fake-audience',ACCESS_ISSUER:'https://fictional.cloudflareaccess.com'};
 return{sqlite,env,editions:createNewsroomHandler(),chat:createNewsroomConversationHandler()};
}
async function request(l,component,subject,method,path,input,extraHeaders={},extraCtx={}){
 const r=new Request(ORIGIN+path,{method,headers:{...(input!==undefined?{Origin:ORIGIN,'Content-Type':'application/json'}:{}),...extraHeaders},...(input===undefined?{}:{body:JSON.stringify(input)})});
 const ctx=subject?{access:{aud:'fake-audience',getIdentity:async()=>({user_uuid:subject,email:subject+'@example.invalid'})},...extraCtx}:extraCtx;
 const res=await l[component].fetch(r,l.env,ctx);const text=await res.text();let value;
 try{value=JSON.parse(text)}catch{value=text}
 return{status:res.status,body:value,headers:res.headers};
}
async function published(l){
 const created=await request(l,'editions','publisher','POST','/api/newsroom/drafts',{slug:'synthetic-edition',title:'Synthetic Edition',manifest});
 assert.equal(created.status,201,JSON.stringify(created.body));
 const id=created.body.editionId;
 const post=await request(l,'editions','publisher','POST',`/api/newsroom/drafts/${id}/publish`,{expectedGeneration:1,operationId:'synthetic-publish-0001'});
 assert.equal(post.status,201,JSON.stringify(post.body));
 return{id,revisionId:post.body.revisionId,version:1};
}
const path=(revision,block='block-one')=>`/api/newsroom/conversations/${revision}/${block}`;
const postPayload=(op='synthetic-op-001',text='A fictional observation, not approval.')=>({operationId:op,text});

test('one immutable anchored thread is durable across two distinct signed synthetic members',async()=>{
 const l=fixture(),e=await published(l),p=path(e.revisionId);
 const first=await request(l,'chat','commenter','POST',p+'/messages',postPayload());
 assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(first.body.duplicate,false);
 const read=await request(l,'chat','reader','GET',p);
 assert.equal(read.status,200);assert.equal(read.body.anchor.revisionId,e.revisionId);
 assert.equal(read.body.anchor.version,1);assert.equal(read.body.anchor.text,manifest.articles[0].blocks[0].text);
 assert.equal(read.body.messages.length,1);assert.equal(read.body.messages[0].authorSub,'commenter');
 const second=await request(l,'chat','publisher','POST',p+'/messages',postPayload('synthetic-op-002','A reply from a separate verified user.'));
 assert.equal(second.status,201);
 const next=await request(l,'chat','commenter','GET',p);assert.equal(next.body.messages.length,2);
 assert.deepEqual(next.body.messages.map(m=>m.authorSub),['commenter','publisher']);
 assert.equal(next.body.truncated,false);
 assert.equal(l.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,2);
 assert.equal(l.sqlite.prepare('SELECT value FROM unrelated_canary WHERE id=1').get().value,'preserved');
});

test('reader cannot publish a comment or forge role; inactive or unknown subjects cannot read',async()=>{
 const l=fixture(),e=await published(l),p=path(e.revisionId);
 const reader=await request(l,'chat','reader','POST',p+'/messages',postPayload(),{'X-Role':'owner'});
 assert.equal(reader.status,404);
 const revoked=await request(l,'chat','revoked','GET',p);assert.equal(revoked.status,404);
 const outsider=await request(l,'chat','outsider','GET',p);assert.equal(outsider.status,404);
 const anonymous=await request(l,'chat',null,'GET',p);assert.equal(anonymous.status,401);
 const audience=await request(l,'chat','reader','GET',p,undefined,{}, {access:{aud:'wrong',getIdentity:async()=>({user_uuid:'reader'})}});
 assert.equal(audience.status,401);
 l.env.NEWSROOM_SYNTHETIC_ONLY='false';assert.equal((await request(l,'chat','reader','GET',p)).status,503);
 assert.equal(l.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,0);
});

test('unknown revision, block, and unpublished draft yield identical non-disclosing 404',async()=>{
 const l=fixture(),e=await published(l);
 const targets=[path('missing-revision'),path(e.revisionId,'missing-block'),path('cross-org-revision')];
 assert.deepEqual((await request(l,'chat','reader','GET',targets[0])).body,{error:'not_found'});
 assert.deepEqual((await request(l,'chat','reader','GET',targets[1])).body,{error:'not_found'});
 const draft=await request(l,'editions','publisher','POST','/api/newsroom/drafts',{slug:'later-edition',title:'Not published',manifest});
 assert.equal(draft.status,201);
 const rev='unpublished-not-an-id'; // no revision row exists for a private draft
 assert.equal((await request(l,'chat','reader','GET',path(rev))).status,404);
 assert.equal(l.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,0);
});

test('idempotency is scoped to verified author; reused operations on another block are rejected',async()=>{
 const l=fixture(),e=await published(l),p=path(e.revisionId);
 const a=await request(l,'chat','commenter','POST',p+'/messages',postPayload('replay-operation'));
 assert.equal(a.status,201);
 const b=await request(l,'chat','commenter','POST',p+'/messages',postPayload('replay-operation'));
 assert.equal(b.status,200);assert.equal(b.body.duplicate,true);assert.equal(b.body.messageId,a.body.messageId);
 const mismatch=await request(l,'chat','commenter','POST',p+'/messages',postPayload('replay-operation','Different text'));
 assert.equal(mismatch.status,409);assert.equal(mismatch.body.error,'operation_reused');
 const differentBlock=await request(l,'chat','commenter','POST',path(e.revisionId,'block-two')+'/messages',postPayload('replay-operation'));
 assert.equal(differentBlock.status,409);
 const differentActor=await request(l,'chat','publisher','POST',p+'/messages',postPayload('replay-operation','Different member'));
 assert.equal(differentActor.status,201);
 assert.equal(l.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,2);
});

test('revocation at database layer prevents direct post and HTTP revocation instantly hides old thread',async()=>{
 const l=fixture(),e=await published(l),p=path(e.revisionId);
 await request(l,'chat','commenter','POST',p+'/messages',postPayload());
 l.sqlite.prepare("UPDATE nr_memberships SET active=0 WHERE subject='commenter'").run();
 assert.equal((await request(l,'chat','commenter','GET',p)).status,404);
 assert.throws(()=>l.sqlite.prepare(`INSERT INTO nr_thread_messages
 (org_id,message_id,revision_id,block_id,author_sub,operation_id,request_sha256,body_text,created_at)
 VALUES(?,?,?,?,?,?,?,?,?)`).run(ORG,'synthetic-id',e.revisionId,'block-one','commenter','other-op','a'.repeat(64),'Must be denied.',Date.now()),/not_authorized/);
 assert.equal(l.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,1);
});

test('published corrections preserve the original exact-text reference and separate thread',async()=>{
 const l=fixture(),e=await published(l),p=path(e.revisionId);
 assert.equal((await request(l,'chat','commenter','POST',p+'/messages',postPayload())).status,201);
 const corrected=structuredClone(manifest);corrected.articles[0].blocks[0].text='Corrected text in an immutable second edition revision.';
 const update=await request(l,'editions','publisher','PUT',`/api/newsroom/drafts/${e.id}`,{expectedGeneration:1,manifest:corrected});assert.equal(update.status,200);
 const pub=await request(l,'editions','publisher','POST',`/api/newsroom/drafts/${e.id}/publish`,{expectedGeneration:2,operationId:'synthetic-publish-0002'});assert.equal(pub.status,201);
 const original=await request(l,'chat','reader','GET',p);
 assert.equal(original.body.anchor.version,1);assert.equal(original.body.anchor.text,manifest.articles[0].blocks[0].text);
 const next=await request(l,'chat','reader','GET',path(pub.body.revisionId));
 assert.equal(next.body.anchor.version,2);assert.equal(next.body.anchor.text,corrected.articles[0].blocks[0].text);
 assert.equal(next.body.messages.length,0);assert.equal(original.body.messages.length,1);
 assert.throws(()=>l.sqlite.prepare('DELETE FROM nr_thread_messages').run(),/immutable/);
 assert.throws(()=>l.sqlite.prepare("UPDATE nr_thread_messages SET body_text='corrupt'").run(),/immutable/);
});

test('malformed, oversized, cross-origin, and extra-field requests fail without writing',async()=>{
 const l=fixture(),e=await published(l),p=path(e.revisionId);
 for(const bad of [postPayload('tiny','x'),postPayload('large-message','X'.repeat(2000)),{operationId:'synthetic-op-004',text:'Hello',role:'owner'},postPayload('synthetic-op-005','\u0000x'),postPayload('synthetic-op-006',' trailing ')]){
  const response=await request(l,'chat','commenter','POST',p+'/messages',bad);
  assert.equal(response.status,400,JSON.stringify(bad).slice(0,100));
 }
 const oversized=await request(l,'chat','commenter','POST',p+'/messages',postPayload('synthetic-op-007','X'.repeat(5000)));
 assert.equal(oversized.status,413);
 const attack=await request(l,'chat','commenter','POST',p+'/messages',postPayload('synthetic-op-008'),{Origin:'https://attacker.invalid'});
 assert.equal(attack.status,403);
 assert.equal(l.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,0);
});

test('real default JWT signature verification refuses a forged role/subject header',async()=>{
 const l=fixture(),e=await published(l),p=path(e.revisionId);
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk=publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'synthetic-key',alg:'RS256'});
 const encoder=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
 const h=encoder({alg:'RS256',kid:jwk.kid});
 const jwt=sub=>{const now=Math.floor(Date.now()/1000);const c=encoder({iss:'https://fictional.cloudflareaccess.com',aud:'fake-audience',sub,exp:now+180,iat:now});const b=h+'.'+c;return b+'.'+sign('RSA-SHA256',Buffer.from(b),privateKey).toString('base64url')};
 l.env.ACCESS_JWKS_URL=l.env.ACCESS_ISSUER+'/cdn-cgi/access/certs';
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[jwk]});
 try{
  const r=new Request(ORIGIN+p,{headers:{'Cf-Access-Jwt-Assertion':jwt('reader'),'X-Role':'publisher','X-User-Subject':'publisher'}});
  assert.equal((await l.chat.fetch(r,l.env,{})).status,200);
  const denied=new Request(ORIGIN+p+'/messages',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':jwt('reader'),Origin:ORIGIN,'Content-Type':'application/json','X-Role':'publisher'},body:JSON.stringify(postPayload())});
  assert.equal((await l.chat.fetch(denied,l.env,{})).status,404);
  const forged=new Request(ORIGIN+p,{headers:{'Cf-Access-Authenticated-User-Email':'commenter@example.invalid'}});
  assert.equal((await l.chat.fetch(forged,l.env,{})).status,401);
 }finally{globalThis.fetch=old}
});


test('identical revision IDs in a foreign organization never disclose another organization thread',async()=>{
 const l=fixture(),e=await published(l),p=path(e.revisionId);
 await request(l,'chat','commenter','POST',p+'/messages',postPayload());
 const otherOrg='fictional_other_org';
 l.sqlite.prepare('INSERT INTO nr_organizations(org_id,label) VALUES(?,?)').run(otherOrg,'Other Fictional Organization');
 l.sqlite.prepare('INSERT INTO nr_memberships(org_id,subject,role,active,created_at) VALUES(?,?,?,?,?)').run(otherOrg,'reader','reader',1,Date.now());
 l.env.NEWSROOM_ORG_ID=otherOrg;
 const foreign=await request(l,'chat','reader','GET',p);
 assert.equal(foreign.status,404);assert.deepEqual(foreign.body,{error:'not_found'});
 l.env.NEWSROOM_ORG_ID=ORG;
 assert.equal((await request(l,'chat','reader','GET',p)).body.messages.length,1);
});

// Offline-only conversation recovery: never routed through the live Worker.
async function recoveryCase(){
 const src=fixture();const edition=await published(src);
 const first=await request(src,'chat','commenter','POST',path(edition.revisionId)+'/messages',postPayload('archival-op-001','First-version question.'));
 assert.equal(first.status,201);
 const reply=await request(src,'chat','publisher','POST',path(edition.revisionId)+'/messages',postPayload('archival-op-002','First-version answer.'));
 assert.equal(reply.status,201);
 const revised=structuredClone(manifest);revised.articles[0].blocks[0].text='Edited copy in a separately published revision.';
 const draft=await request(src,'editions','publisher','PUT',`/api/newsroom/drafts/${edition.id}`,{expectedGeneration:1,manifest:revised});assert.equal(draft.status,200);
 const next=await request(src,'editions','publisher','POST',`/api/newsroom/drafts/${edition.id}/publish`,{expectedGeneration:2,operationId:'synthetic-publish-0002'});
 assert.equal(next.status,201);
 const postV2=await request(src,'chat','commenter','POST',path(next.body.revisionId)+'/messages',postPayload('archival-op-003','Second-version comment.'));
 assert.equal(postV2.status,201);
 const editions=await request(src,'editions','reader','GET',`/api/newsroom/editions/${edition.id}/export`);
 assert.equal(editions.status,200);
 const archive=await exportSyntheticConversations(src.env.NEWSROOM_DB,ORG,edition.id,{allowSyntheticExport:true});
 return {src,edition,editions:editions.body,archive,oldId:edition.revisionId,newId:next.body.revisionId};
}
async function recoveryTarget(editions){
 const target=fixture();
 const restored=await restoreSyntheticEdition(target.env.NEWSROOM_DB,ORG,editions,{allowSyntheticRestore:true});
 assert.equal(restored.restored,true);
 return target;
}
async function rehashArchive(a){const {archiveSha256,...payload}=a;return {...payload,archiveSha256:await sha256(canonicalJSON(payload))};}

test('offline export covers every message and restores exact two-revision anchors into an empty synthetic target',async()=>{
 const {edition,editions,archive,oldId,newId}=await recoveryCase();
 assert.equal(archive.kind,'newsroom-synthetic-conversation-archive');
 assert.equal(archive.edition.editionId,edition.id);assert.equal(archive.messages.length,3);
 assert.deepEqual(archive.revisions.map(r=>r.version),[1,2]);
 const exported=JSON.parse(JSON.stringify(archive)); // portable, not tied to DB object identity
 const target=await recoveryTarget(editions);
 const result=await restoreSyntheticConversations(target.env.NEWSROOM_DB,ORG,exported,{allowSyntheticRestore:true});
 assert.equal(result.restored,true);assert.equal(result.messageCount,3);
 assert.equal(target.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,3);
 const old=await request(target,'chat','reader','GET',path(oldId));
 const newer=await request(target,'chat','reader','GET',path(newId));
 assert.equal(old.body.messages.length,2);assert.equal(newer.body.messages.length,1);
 assert.equal(old.body.anchor.text,manifest.articles[0].blocks[0].text);
 assert.notEqual(newer.body.anchor.text,old.body.anchor.text);
 const twice=await exportSyntheticConversations(target.env.NEWSROOM_DB,ORG,edition.id,{allowSyntheticExport:true});
 assert.deepEqual(twice,exported,'roundtrip preserves all operation IDs, authors, anchors, order, and hashes');
 assert.equal(target.sqlite.prepare('SELECT value FROM unrelated_canary WHERE id=1').get().value,'preserved');
 await assert.rejects(()=>restoreSyntheticConversations(target.env.NEWSROOM_DB,ORG,archive,{allowSyntheticRestore:true}),/restore_denied/);
 assert.equal(target.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,3);
});

test('explicit opt-in, organization, edition provenance and empty target are mandatory',async()=>{
 const {editions,archive}=await recoveryCase();const target=await recoveryTarget(editions);
 await assert.rejects(()=>restoreSyntheticConversations(target.env.NEWSROOM_DB,ORG,archive),/restore_denied/);
 await assert.rejects(()=>exportSyntheticConversations(target.env.NEWSROOM_DB,ORG,archive.edition.editionId),/export_denied/);
 await assert.rejects(()=>restoreSyntheticConversations(target.env.NEWSROOM_DB,'fictional_other',archive,{allowSyntheticRestore:true}),/restore_denied/);
 const wrongRev=structuredClone(archive);wrongRev.revisions[0].sha256='f'.repeat(64);
 const wrongArchive=await rehashArchive(wrongRev);
 await assert.rejects(()=>restoreSyntheticConversations(target.env.NEWSROOM_DB,ORG,wrongArchive,{allowSyntheticRestore:true}),/restore_denied/);
 target.sqlite.prepare("INSERT INTO nr_thread_messages (org_id,message_id,revision_id,block_id,author_sub,operation_id,request_sha256,body_text,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
  .run(ORG,'existing-message',archive.messages[0].revisionId,archive.messages[0].blockId,'commenter','preexisting-op',
   'f'.repeat(64),'Existing record.',Date.now());
 await assert.rejects(()=>restoreSyntheticConversations(target.env.NEWSROOM_DB,ORG,archive,{allowSyntheticRestore:true}),/restore_denied/);
 assert.equal(target.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,1);
});

test('tampered text, quoted paragraph digest, operation, author, and duplicate ID fail before writing',async()=>{
 const {editions,archive}=await recoveryCase();
 for(const change of [
  a=>{a.messages[0].text='A silently edited comment.';},
  a=>{a.messages[0].anchorSha256='0'.repeat(64);},
  a=>{a.messages[0].requestSha256='0'.repeat(64);},
  a=>{a.messages[1].messageId=a.messages[0].messageId;},
  a=>{a.messages[1].operationId=a.messages[0].operationId;a.messages[1].authorSub=a.messages[0].authorSub;},
  a=>{a.messages[0].authorSub='nonmember';},
  a=>{a.messages[0].blockId='unknown-block';},
 ]){
  const bad=structuredClone(archive);change(bad);const target=await recoveryTarget(editions);
  const tampered=await rehashArchive(bad);
  await assert.rejects(()=>restoreSyntheticConversations(target.env.NEWSROOM_DB,ORG,tampered,{allowSyntheticRestore:true}),/restore_denied/);
  assert.equal(target.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,0);
 }
});

test('restoration is all-or-nothing when an insert fails after preflight',async()=>{
 const {editions,archive}=await recoveryCase();const target=await recoveryTarget(editions);
 target.sqlite.exec(`CREATE TRIGGER synthetic_forced_failure BEFORE INSERT ON nr_thread_messages
 WHEN NEW.message_id='${archive.messages[1].messageId}' BEGIN SELECT RAISE(ABORT,'synthetic_injected_failure'); END;`);
 await assert.rejects(()=>restoreSyntheticConversations(target.env.NEWSROOM_DB,ORG,archive,{allowSyntheticRestore:true}),/restore_denied/);
 assert.equal(target.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,0);
 assert.equal(target.sqlite.prepare('SELECT value FROM unrelated_canary WHERE id=1').get().value,'preserved');
});

test('archived historical author must be pre-provisioned as eligible in synthetic target',async()=>{
 const {editions,archive}=await recoveryCase();const target=await recoveryTarget(editions);
 target.sqlite.prepare("UPDATE nr_memberships SET active=0 WHERE org_id=? AND subject='commenter'").run(ORG);
 await assert.rejects(()=>restoreSyntheticConversations(target.env.NEWSROOM_DB,ORG,archive,{allowSyntheticRestore:true}),/restore_denied/);
 assert.equal(target.sqlite.prepare('SELECT COUNT(*) AS n FROM nr_thread_messages').get().n,0);
});

test('export includes more than the 100-message reader page and rejects over-limit rather than truncating',async()=>{
 const l=fixture(),edition=await published(l);
 const statement=l.sqlite.prepare('INSERT INTO nr_thread_messages(org_id,message_id,revision_id,block_id,author_sub,operation_id,request_sha256,body_text,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<101;i++){
  const text='Archive content '+i+'.';
  const hash=await sha256(canonicalJSON({action:'comment',revisionId:edition.revisionId,blockId:'block-one',text}));
  statement.run(ORG,'fake-message-'+i,edition.revisionId,'block-one','commenter','synthetic-archive-'+i,hash,text,Date.now()+i);
 }
 const read=await request(l,'chat','reader','GET',path(edition.revisionId));
 assert.equal(read.body.messages.length,100);assert.equal(read.body.truncated,true);
 const archive=await exportSyntheticConversations(l.env.NEWSROOM_DB,ORG,edition.id,{allowSyntheticExport:true});
 assert.equal(archive.messages.length,101);
 for(let i=101;i<=500;i++){
  const text='Archive content '+i+'.';
  const hash=await sha256(canonicalJSON({action:'comment',revisionId:edition.revisionId,blockId:'block-one',text}));
  statement.run(ORG,'fake-message-'+i,edition.revisionId,'block-one','commenter','synthetic-archive-'+i,hash,text,Date.now()+i);
 }
 await assert.rejects(()=>exportSyntheticConversations(l.env.NEWSROOM_DB,ORG,edition.id,{allowSyntheticExport:true}),/export_denied/);
});
