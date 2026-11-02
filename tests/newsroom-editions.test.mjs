import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createNewsroomHandler} from '../worker/newsroom.mjs';
import {canonicalJSON,sha256,validateManifest} from '../worker/newsroom-contract.mjs';
import {renderNewsroomEdition} from '../worker/newsroom-render.mjs';
import {restoreSyntheticEdition} from '../worker/newsroom-recovery.mjs';
import {verifyAccessJWT} from '../worker/access.mjs';
import {generateKeyPairSync,sign} from 'node:crypto';

const ORIGIN='https://synthetic-newsroom.invalid',ORG='fictional_editorial_team';
const fixture={schemaVersion:1,articles:[{id:'article-01',title:'A readable update',blocks:[
 {id:'block-opening',type:'paragraph',text:'A small team can review a proposed workflow without a live meeting.'},
 {id:'block-next',type:'paragraph',text:'Reading and silence never count as approval.'}]}]};
const cloned=()=>structuredClone(fixture);
function sqliteD1(){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys = ON');
 const migration=readFileSync(new URL('../worker/migrations/0004-newsroom-p1a.sql',import.meta.url),'utf8');
 db.exec(migration);db.exec(migration);
 db.prepare("INSERT INTO nr_organizations(org_id,label) VALUES(?,?)").run(ORG,'Fictional Editorial Team');
 for(const [id,role,active] of [['publisher','publisher',1],['reader','reader',1],['outsider','reader',0],['commenter','commenter',1]]){
  db.prepare('INSERT INTO nr_memberships(org_id,subject,role,active,created_at) VALUES(?,?,?,?,?)').run(ORG,id,role,active,Date.now());
 }
 const wrap={prepare(statement){const bound=[];return {bind(...args){bound.push(...args);return this},first(){return db.prepare(statement).get(...bound)??null},all(){return {results:db.prepare(statement).all(...bound)}},run(){const result=db.prepare(statement).run(...bound);return {meta:{changes:Number(result.changes)}}}}},async batch(stmts){
  db.exec('BEGIN IMMEDIATE');try{const result=stmts.map(s=>s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}
 }};
 return {db,wrap};
}
function lab(){const {db,wrap}=sqliteD1();const env={APP_ORIGIN:ORIGIN,NEWSROOM_SYNTHETIC_ONLY:'true',NEWSROOM_DB:wrap,NEWSROOM_ORG_ID:ORG,ACCESS_AUD:'aud-synthetic',ACCESS_ISSUER:'https://test.cloudflareaccess.com'};return {db,env,handler:createNewsroomHandler()};}
async function call(lab,subject,method,path,data,extra={}){
 const req=new Request(ORIGIN+path,{method,headers:{...(data?{'Origin':ORIGIN,'Content-Type':'application/json'}:{}),...extra},...(data?{body:JSON.stringify(data)}:{})});
 const context=subject?{access:{aud:'aud-synthetic',getIdentity:async()=>({user_uuid:subject,email:subject+'@example.invalid'})}}:{};
 const response=await lab.handler.fetch(req,lab.env,context);let output;const text=await response.text();try{output=JSON.parse(text)}catch{output=text}
 return {status:response.status,body:output,headers:response.headers};
}
async function make(l){const res=await call(l,'publisher','POST','/api/newsroom/drafts',{slug:'synthetic-issue',title:'The Working Edition',manifest:cloned()});assert.equal(res.status,201,JSON.stringify(res.body));return res.body.editionId;}
async function publish(l,id,gen=1,op='synthetic-op-0001'){const res=await call(l,'publisher','POST',`/api/newsroom/drafts/${id}/publish`,{expectedGeneration:gen,operationId:op});assert.equal(res.status,201,JSON.stringify(res.body));return res.body;}

test('RB02 01A synthetic route denies absent identity, wrong Access audience and disabled module',async()=>{
 const l=lab();assert.equal((await call(l,null,'GET','/api/newsroom/editions')).status,401);
 const wrong=await l.handler.fetch(new Request(ORIGIN+'/api/newsroom/editions'),l.env,{access:{aud:'wrong',getIdentity:async()=>({user_uuid:'publisher'})}});assert.equal(wrong.status,401);
 l.env.NEWSROOM_SYNTHETIC_ONLY='false';assert.equal((await call(l,'publisher','GET','/api/newsroom/editions')).status,503);
});

test('role is server-selected and revocation hides resource without a title leak',async()=>{
 const l=lab(),id=await make(l);const denied=await call(l,'reader','GET',`/api/newsroom/drafts/${id}`);
 assert.equal(denied.status,404);assert.deepEqual(denied.body,{error:'not_found'});
 assert.deepEqual((await call(l,'reader','POST','/api/newsroom/drafts',{slug:'xxx',title:'A',manifest:cloned(),role:'publisher'})).body,{error:'not_found'});
 assert.deepEqual((await call(l,'outsider','GET',`/api/newsroom/drafts/${id}`)).body,denied.body);
 const origin=await call(l,'publisher','POST','/api/newsroom/drafts',{slug:'x1',title:'T',manifest:cloned()},{Origin:'https://attacker.invalid'});assert.equal(origin.status,403);
 l.db.prepare("UPDATE nr_memberships SET active=0 WHERE subject='reader'").run();
 const after=await call(l,'reader','GET','/api/newsroom/editions');assert.equal(after.status,404);
});

test('published revision is immutable, readable and printable without a client script',async()=>{
 const l=lab(),id=await make(l),result=await publish(l,id);
 assert.equal(result.version,1);assert.match(result.sha256,/^[0-9a-f]{64}$/);
 const reader=await call(l,'reader','GET',`/api/newsroom/editions/${id}/revisions/1`);
 assert.equal(reader.status,200);assert.equal(reader.body.revision.sha256,result.sha256);
 assert.equal(reader.body.revision.manifest.articles[0].blocks[0].id,'block-opening');
 const printed=await call(l,'reader','GET',`/api/newsroom/editions/${id}/revisions/1?format=html`);
 assert.equal(printed.status,200);assert.match(printed.body,/<main id="main"/);assert.match(printed.body,/@media print/);assert.match(printed.headers.get('content-security-policy'),/script-src 'none'/);
 assert.equal((await call(l,'reader','GET','/api/newsroom/editions')).body.editions.length,1);
 assert.throws(()=>l.db.prepare("UPDATE nr_revisions SET manifest_json='{}' WHERE revision_id=?").run(result.revisionId),/immutable/);
 assert.throws(()=>l.db.prepare('DELETE FROM nr_revision_blocks WHERE revision_id=?').run(result.revisionId),/immutable/);
});

test('idempotent publish replay returns one revision; mismatched operation and generation fail',async()=>{
 const l=lab(),id=await make(l),first=await publish(l,id);
 const second=await publish(l,id);assert.deepEqual(first,second);
 assert.equal(l.db.prepare('SELECT COUNT(*) AS n FROM nr_revisions').get().n,1);
 const changed=await call(l,'publisher','POST',`/api/newsroom/drafts/${id}/publish`,{expectedGeneration:2,operationId:'synthetic-op-0001'});
 assert.equal(changed.status,409);assert.equal(changed.body.error,'operation_reused');
 const stale=await call(l,'publisher','POST',`/api/newsroom/drafts/${id}/publish`,{expectedGeneration:1,operationId:'synthetic-op-0002'});
 assert.equal(stale.status,409);
 assert.equal(l.db.prepare('SELECT COUNT(*) AS n FROM nr_operations').get().n,1);
});

test('a correction creates v2 and preserves original manifest+digest+anchors',async()=>{
 const l=lab(),id=await make(l),v1=await publish(l,id);
 const manifest=cloned();manifest.articles[0].blocks[0].text='Corrected text keeps the original citation intact.';
 const update=await call(l,'publisher','PUT',`/api/newsroom/drafts/${id}`,{expectedGeneration:1,manifest});assert.equal(update.status,200);
 const denied=await call(l,'publisher','PUT',`/api/newsroom/drafts/${id}`,{expectedGeneration:1,manifest});assert.equal(denied.status,409);
 const v2=await publish(l,id,2,'synthetic-op-0002');assert.equal(v2.version,2);assert.notEqual(v2.sha256,v1.sha256);
 const original=await call(l,'reader','GET',`/api/newsroom/editions/${id}/revisions/1`);assert.equal(original.body.revision.sha256,v1.sha256);
 assert.equal(original.body.revision.manifest.articles[0].blocks[0].text,cloned().articles[0].blocks[0].text);
 assert.equal((await call(l,'reader','GET',`/api/newsroom/editions/${id}/revisions/2`)).body.revision.manifest.articles[0].blocks[0].id,'block-opening');
 const archive=await call(l,'reader','GET',`/api/newsroom/editions/${id}/export`);assert.equal(archive.body.revisions.length,2);
 assert.equal(archive.body.revisions[0].sha256,await sha256(canonicalJSON(archive.body.revisions[0].manifest)));
 assert.ok(!JSON.stringify(archive.body).includes('nr_memberships'));
});

test('concurrent independent publish operations cannot publish the same generation twice',async()=>{
 const l=lab(),id=await make(l);
 const [a,b]=await Promise.all([call(l,'publisher','POST',`/api/newsroom/drafts/${id}/publish`,{expectedGeneration:1,operationId:'independent-op-a'}),call(l,'publisher','POST',`/api/newsroom/drafts/${id}/publish`,{expectedGeneration:1,operationId:'independent-op-b'})]);
 assert.deepEqual([a.status,b.status].sort(),[201,409]);assert.equal(l.db.prepare('SELECT COUNT(*) AS n FROM nr_revisions').get().n,1);
 assert.equal(l.db.prepare('SELECT COUNT(*) AS n FROM nr_operations').get().n,1);
});

test('unpublished drafts, invalid content and forged source URLs never reach reader or markup',async()=>{
 const l=lab(),id=await make(l);
 assert.equal((await call(l,'reader','GET',`/api/newsroom/editions/${id}/revisions/1`)).status,404);
 const invalid=cloned();invalid.articles[0].blocks[0].sourceUri='javascript:alert(1)';
 assert.equal((await call(l,'publisher','PUT',`/api/newsroom/drafts/${id}`,{expectedGeneration:1,manifest:invalid})).status,400);
 const m=cloned();m.articles[0].blocks[0].text='<script>alert(1)</script>';
 const edited=await call(l,'publisher','PUT',`/api/newsroom/drafts/${id}`,{expectedGeneration:1,manifest:m});assert.equal(edited.status,200);
 await publish(l,id,2,'safe-html-op');
 const page=await call(l,'reader','GET',`/api/newsroom/editions/${id}/revisions/1?format=html`);
 assert.ok(page.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert.ok(!page.body.includes('<script>alert(1)</script>'));
 assert.ok(!page.body.includes('<script src='));
});

test('a guessed edition ID and foreign organization fail identically',async()=>{
 const l=lab(),id=await make(l);await publish(l,id);
 const wrongId=await call(l,'reader','GET','/api/newsroom/editions/guess123/revisions/1');
 assert.equal(wrongId.status,404);
 l.db.prepare("INSERT INTO nr_organizations(org_id,label) VALUES('second_org','Second Fictional Org')").run();
 l.env.NEWSROOM_ORG_ID='second_org';
 const wrongOrg=await call(l,'reader','GET',`/api/newsroom/editions/${id}/revisions/1`);
 assert.equal(wrongOrg.status,404);assert.deepEqual(wrongOrg.body,wrongId.body);
});

test('D1 schema replay is additive and composite foreign keys deny a foreign block',async()=>{
 const l=lab();l.db.exec("CREATE TABLE IF NOT EXISTS station_workspace_state(owner_sub TEXT)");
 const id=await make(l),rev=await publish(l,id);
 assert.throws(()=>l.db.prepare("INSERT INTO nr_revision_blocks(org_id,revision_id,block_id,article_id,ordinal,block_kind,body_text) VALUES('other_org',?,?,?,?,?,?)").run(rev.revisionId,'illegal','wrong',0,'paragraph','bad'),/FOREIGN KEY/);
 assert.equal(l.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='station_workspace_state'").get().n,1);
});

test('canonicalization is stable across object key insertion order and exact Access JWT claims are signed',async()=>{
 const a=validateManifest(cloned());const b={articles:a.articles,schemaVersion:1};assert.equal(canonicalJSON(a),canonicalJSON(b));
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk=publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'test-key',alg:'RS256',use:'sig'});
 const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const header=b64({alg:'RS256',kid:'test-key'});
 const now=Math.floor(Date.now()/1000);const issuer='https://test.cloudflareaccess.com';
 const token=(aud)=>{const payload=b64({iss:issuer,aud,sub:'publisher',iat:now,exp:now+300});const source=header+'.'+payload;return source+'.'+sign('RSA-SHA256',Buffer.from(source),privateKey).toString('base64url')};
 const config={issuer,audience:'aud-synthetic',jwksUrl:issuer+'/cdn-cgi/access/certs'};
 assert.equal((await verifyAccessJWT(token('aud-synthetic'),config,async()=>({keys:[jwk]}))).subject,'publisher');
 await assert.rejects(()=>verifyAccessJWT(token('not-this-app'),config,async()=>({keys:[jwk]})),/Invalid JWT claims/);
});


test('portable published archive restores exact v1/v2 hashes and retry receipts into an empty synthetic scope',async()=>{
 const source=lab(),id=await make(source),v1=await publish(source,id);
 const edited=cloned();edited.articles[0].blocks[1].text='A correction is a new published revision.';
 assert.equal((await call(source,'publisher','PUT',`/api/newsroom/drafts/${id}`,{expectedGeneration:1,manifest:edited})).status,200);
 const v2=await publish(source,id,2,'restore-op-v2');
 const archive=(await call(source,'reader','GET',`/api/newsroom/editions/${id}/export`)).body;
 const dest=lab();
 const result=await restoreSyntheticEdition(dest.env.NEWSROOM_DB,ORG,archive,{allowSyntheticRestore:true});
 assert.deepEqual(result,{restored:true,editionId:id,currentVersion:2,revisions:2});
 for(const [ver,ref] of [[1,v1],[2,v2]]){
  const target=await call(dest,'reader','GET',`/api/newsroom/editions/${id}/revisions/${ver}`);
  assert.equal(target.status,200);assert.equal(target.body.revision.sha256,ref.sha256);
  assert.equal(target.body.revision.revisionId,ref.revisionId);
  assert.equal(target.body.revision.manifest.articles[0].blocks[0].id,'block-opening');
 }
 const receipt=await call(dest,'publisher','POST',`/api/newsroom/drafts/${id}/publish`,{expectedGeneration:2,operationId:'restore-op-v2'});
 assert.equal(receipt.status,201);assert.equal(receipt.body.revisionId,v2.revisionId);
 assert.equal(dest.db.prepare('SELECT COUNT(*) AS n FROM nr_revisions').get().n,2);
 await assert.rejects(()=>restoreSyntheticEdition(dest.env.NEWSROOM_DB,ORG,archive,{allowSyntheticRestore:true}),/restore_denied/);
 await assert.rejects(()=>restoreSyntheticEdition(lab().env.NEWSROOM_DB,'wrong_org',archive,{allowSyntheticRestore:true}),/restore_denied/);
 await assert.rejects(()=>restoreSyntheticEdition(lab().env.NEWSROOM_DB,ORG,archive,{allowSyntheticRestore:false}),/restore_denied/);
});

test('tampered restore, unpublished draft archive and mismatched operation digest leave synthetic DB unchanged',async()=>{
 const source=lab(),id=await make(source);await publish(source,id);
 const archive=(await call(source,'reader','GET',`/api/newsroom/editions/${id}/export`)).body;
 const broken=structuredClone(archive);broken.revisions[0].manifest.articles[0].blocks[0].text='tampered!';
 const dest=lab();
 await assert.rejects(()=>restoreSyntheticEdition(dest.env.NEWSROOM_DB,ORG,broken,{allowSyntheticRestore:true}),/restore_denied/);
 const wrongReceipt=structuredClone(archive);wrongReceipt.operations[0].requestSha256='a'.repeat(64);
 await assert.rejects(()=>restoreSyntheticEdition(dest.env.NEWSROOM_DB,ORG,wrongReceipt,{allowSyntheticRestore:true}),/restore_denied/);
 assert.equal(dest.db.prepare('SELECT COUNT(*) AS n FROM nr_editions').get().n,0);
 assert.equal(dest.db.prepare('SELECT COUNT(*) AS n FROM nr_audit_events').get().n,0);
});

test('the default Newsroom handler accepts a correctly signed Access JWT but never trusts an asserted user role',async()=>{
 const l=lab();
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk=publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'end-to-end-kid',use:'sig',alg:'RS256'});
 l.env.ACCESS_JWKS_URL=l.env.ACCESS_ISSUER+'/cdn-cgi/access/certs';
 const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const header=b64({alg:'RS256',kid:jwk.kid});
 const token=(subject,audience=l.env.ACCESS_AUD)=>{const now=Math.floor(Date.now()/1000);const payload=b64({iss:l.env.ACCESS_ISSUER,aud:audience,sub:subject,exp:now+240,iat:now});const src=header+'.'+payload;return src+'.'+sign('RSA-SHA256',Buffer.from(src),privateKey).toString('base64url')};
 const original=globalThis.fetch;
 globalThis.fetch=async(url)=>url===l.env.ACCESS_JWKS_URL?new Response(JSON.stringify({keys:[jwk]}),{status:200}):new Response('not-found',{status:404});
 try{
  const request=(value)=>new Request(ORIGIN+'/api/newsroom/editions',{headers:{'Cf-Access-Jwt-Assertion':value,'X-Role':'publisher'}});
  const real=await l.handler.fetch(request(token('reader')),l.env,{});assert.equal(real.status,200);
  const outside=await l.handler.fetch(request(token('outsider')),l.env,{});assert.equal(outside.status,404);
  const wrong=await l.handler.fetch(request(token('reader','wrong-audience')),l.env,{});assert.equal(wrong.status,401);
 }finally{globalThis.fetch=original;}
});

test('oversized malicious request returns a bounded error and creates no draft',async()=>{
 const l=lab();const huge=cloned();huge.articles[0].blocks[0].text='A'.repeat(40000);
 const r=await call(l,'publisher','POST','/api/newsroom/drafts',{slug:'long-issue',title:'Too large',manifest:huge});
 assert.equal(r.status,413);assert.equal(l.db.prepare('SELECT COUNT(*) AS n FROM nr_editions').get().n,0);
});
