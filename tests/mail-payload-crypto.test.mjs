import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMailPayloadCipher,mailPayloadCipherFromEnv} from '../src/communications/mail-payload-crypto.mjs';
import {createD1Outbox} from '../src/communications/mail-outbox.mjs';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
import {handleMailOutboxApi,mailSendingEnabled} from '../worker/mail-outbox-api.mjs';
const key1=Buffer.alloc(32,1).toString('base64'),key2=Buffer.alloc(32,2).toString('base64');
const cipher=()=>createMailPayloadCipher({activeKeyId:'first',keys:{first:key1}});
const scope={installationId:'personal',mailboxId:'hello',ownerSub:'synthetic-owner'};
const id=n=>'a0000000-0000-4000-8000-'+String(n).padStart(12,'0');
const sample={from:'hello@devonakins.com',draft:{to:['private-recipient@example.test'],subject:'Confidential synthetic subject',body:'Confidential synthetic body'},date:'2026-01-01T12:00:00.000Z'};
const context=['outbox','personal','hello',scope.ownerSub,id(1)];
const unavailable=e=>e?.code==='mail_payload_unavailable'&&e.message==='mail_payload_unavailable';
const binding=db=>({prepare(sql){const bind=(...args)=>({async first(){return db.prepare(sql).get(...args)??null},async all(){return {success:true,results:db.prepare(sql).all(...args)}},async run(){return {success:true,meta:{changes:db.prepare(sql).run(...args).changes}}}});return {...bind(),bind}}});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const f of ['0005-comms-drafts.sql','0006-comms-outbox.sql','0007-comms-draft-outbox-lineage.sql','0008-comms-one-delivery-per-draft.sql'])db.exec(readFileSync(new URL('../worker/migrations/'+f,import.meta.url),'utf8'));
 const d1=binding(db),clock={at:'2026-01-01T12:00:00.000Z'};
 return {db,d1,clock,store:createD1Outbox(d1,scope,{cipher:cipher(),now:()=>clock.at})};
}
test('AES-GCM encrypts real payload bytes with fresh nonces and authenticates record identity',async()=>{
 const c=cipher(),a=await c.seal(sample,context),b=await c.seal(sample,context);
 assert.notEqual(a,b);assert.deepEqual(await c.open(a,context),sample);
 assert(!a.includes(sample.draft.body));assert(!a.includes(sample.draft.to[0]));
 for(const altered of [['outbox','personal','hello','different-owner',id(1)],['outbox','personal','other',scope.ownerSub,id(1)],['draft','personal','hello',scope.ownerSub,id(1)],['outbox','personal','hello',scope.ownerSub,id(2)]])await assert.rejects(c.open(a,altered),unavailable);
 const envelope=JSON.parse(a),data=Buffer.from(envelope.ct,'base64');data[0]^=1;
 await assert.rejects(c.open(JSON.stringify({...envelope,ct:data.toString('base64')}),context),unavailable);
 for(const bad of [JSON.stringify(sample),'null',JSON.stringify({...envelope,v:2}),JSON.stringify({...envelope,extra:true}),JSON.stringify({...envelope,kid:'missing'}),JSON.stringify({...envelope,iv:'AAAA'})])await assert.rejects(c.open(bad,context),unavailable);
});
test('key rotation preserves explicitly retained old keys and fails closed if recovery key is lost',async()=>{
 const old=await cipher().seal(sample,context);
 const rotated=createMailPayloadCipher({activeKeyId:'second',keys:{first:key1,second:key2}});
 assert.deepEqual(await rotated.open(old,context),sample);
 const fresh=await rotated.seal(sample,context);assert.equal(JSON.parse(fresh).kid,'second');
 const restored=mailPayloadCipherFromEnv({MAIL_PAYLOAD_KEY_ID:'second',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({first:key1,second:key2})});
 assert.deepEqual(await restored.open(fresh,context),sample);
 await assert.rejects(createMailPayloadCipher({activeKeyId:'second',keys:{second:key2}}).open(old,context),unavailable);
});
test('invalid keys, oversized payloads, malformed input and secret-bearing configuration errors are sanitized',async()=>{
 for(const keys of [{first:'secret-invalid-key'}, {first:Buffer.alloc(31).toString('base64')},{first:key1.replace(/=$/,'')},{}])assert.throws(()=>createMailPayloadCipher({activeKeyId:'first',keys}),unavailable);
 assert.throws(()=>mailPayloadCipherFromEnv({MAIL_PAYLOAD_KEYS_JSON:'not-json-secret'}),unavailable);
 await assert.rejects(cipher().seal({body:'x'.repeat(160*1024)},context),unavailable);
 await assert.rejects(cipher().seal(undefined,context),unavailable);
 const large={body:'é'.repeat(60000)};assert.deepEqual(await cipher().open(await cipher().seal(large,context),context),large);
});
test('D1 encrypted outbox survives independent backup/restore with replay and claim authority intact',async t=>{
 const f=fixture(t),dir=mkdtempSync(join(tmpdir(),'ds-mail-crypto-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 await f.store.offer(id(1),sample);await f.store.offer(id(1),sample);
 const raw=f.db.prepare('SELECT payload_json FROM comms_outbox').get().payload_json;
 assert.equal(JSON.parse(raw).alg,'A256GCM');for(const field of [sample.from,sample.draft.body,sample.draft.subject,sample.draft.to[0]])assert(!raw.includes(field));
 await assert.rejects(f.store.offer(id(1),{...sample,date:'2026-01-02T00:00:00Z'}),/outbox_conflict/);
 assert.deepEqual((await f.store.read(id(1))).payload,sample);
 const path=join(dir,'backup.sqlite');f.db.prepare('VACUUM INTO ?').run(path);
 const restored=new DatabaseSync(path);t.after(()=>restored.close());
 const recovered=createD1Outbox(binding(restored),scope,{cipher:cipher()});
 assert.deepEqual((await recovered.read(id(1))).payload,sample);
 const claims=await Promise.all([recovered.claim(id(1),id(11)),recovered.claim(id(1),id(12))]);
 assert.equal(claims.filter(Boolean).length,1);assert.equal((await recovered.read(id(1))).state,'claimed');
 assert.equal(await recovered.claim(id(1),id(13)),null);
 const peer=createD1Outbox(binding(restored),{...scope,ownerSub:'other'},{cipher:cipher()});assert.equal(await peer.read(id(1)),null);
});
test('terminal expiry clears only old final payloads, preserving receipts and unresolved delivery evidence',async t=>{
 const f=fixture(t),states=['accepted','failed','rejected','uncertain','claimed','queued'];
 for(let i=0;i<states.length;i++){
  await f.store.offer(id(i+1),sample);
  if(states[i]!=='queued'){await f.store.claim(id(i+1),id(20+i));if(states[i]!=='claimed')await f.store.finish(id(i+1),id(20+i),states[i]);}
 }
 f.clock.at='2026-03-01T12:00:00.000Z';
 await assert.rejects(f.store.expireTerminalPayloads({before:'2026-03-01T00:00:00Z'}),/invalid_retention/);
 assert.deepEqual(await f.store.expireTerminalPayloads({before:'2026-01-30T00:00:00Z'}),{expired:3});
 for(let i=0;i<3;i++){const row=await f.store.read(id(i+1));assert.equal(row.payload,null);assert.equal(row.state,states[i]);assert.equal(await f.store.claim(id(i+1),id(99)),null);}
 for(let i=3;i<6;i++)assert.deepEqual((await f.store.read(id(i+1))).payload,sample);
 assert.equal((await f.store.list()).length,6);assert.deepEqual(await f.store.expireTerminalPayloads({before:'2026-01-30T00:00:00Z'}),{expired:0});
 await assert.rejects(f.store.offer(id(1),sample),/outbox_conflict/);
});
test('encrypted store refuses legacy plaintext and ciphertext moved between delivery IDs',async t=>{
 const f=fixture(t);await f.store.offer(id(1),sample);await f.store.offer(id(2),sample);
 f.db.prepare('UPDATE comms_outbox SET payload_json=(SELECT payload_json FROM comms_outbox WHERE delivery_id=?) WHERE delivery_id=?').run(id(1),id(2));
 await assert.rejects(f.store.read(id(2)),unavailable);
 f.db.prepare('UPDATE comms_outbox SET payload_json=? WHERE delivery_id=?').run(JSON.stringify(sample),id(1));
 await assert.rejects(f.store.read(id(1)),unavailable);
});
test('encrypted saved drafts retain idempotency, scope isolation and atomic immutable delivery linkage',async t=>{
 const f=fixture(t),drafts=createD1DraftStore(f.d1,{cipher:cipher(),protectLinkedOutbox:true});
 await drafts.create(scope,id(1));
 const input={id:id(1),revision:1,operationId:id(2),...sample.draft};
 const saved=await drafts.save(scope,input);assert.deepEqual(await drafts.save(scope,input),saved);
 const row=f.db.prepare('SELECT recipients_json,subject,body_text FROM comms_mail_drafts').get();
 assert.equal(row.subject,'');assert.equal(row.body_text,'');assert.equal(JSON.parse(row.recipients_json).alg,'A256GCM');
 for(const value of [sample.draft.body,sample.draft.subject,sample.draft.to[0]])assert(!JSON.stringify(row).includes(value));
 assert.equal((await drafts.read(scope,id(1))).body,sample.draft.body);
 assert.deepEqual(await drafts.list({...scope,ownerSub:'other'}),[]);
 await f.store.offerLinkedDraft(id(3),{draftId:id(1),draftRevision:2,payload:sample});
 await f.store.offerLinkedDraft(id(3),{draftId:id(1),draftRevision:2,payload:sample});
 assert.deepEqual((await f.store.read(id(3))).payload,sample);
 await assert.rejects(f.store.offerLinkedDraft(id(4),{draftId:id(1),draftRevision:2,payload:sample}),/outbox_draft_already_prepared/);
 await assert.rejects(drafts.save(scope,{...input,revision:2,operationId:id(5),body:'rewrite'}),/mail_draft_delivery_locked/);
 await assert.rejects(f.store.offerLinkedDraft(id(5),{draftId:id(1),draftRevision:2,payload:{...sample,draft:{...sample.draft,body:'substituted'}}}),/outbox_draft_stale/);
});
test('HTTP preparation and live-send capability fail closed without encryption secrets; receipts remain readable',async t=>{
 const f=fixture(t);let reads=0;
 const env={MAIL_OUTBOX_ENABLED:'true',MAIL_DRAFTS_ENABLED:'true',MAIL_SEND_ENABLED:'true',MAIL_SENDER_VERIFIED:'true',MAIL_SMTP_ADDRESS:sample.from,MAIL_SMTP_PASSWORD:'synthetic-password',MAIL_OWNER_SUB:scope.ownerSub,MAIL_DB:f.d1};
 const connect=()=>assert.fail('no provider call');assert.equal(mailSendingEnabled(env,connect),false);
 const args={request:{method:'POST'},url:new URL('https://station.test/api/mail/outbox/prepare'),user:{subject:scope.ownerSub},env,readBody:()=>{reads++;assert.fail('must not read body')},connect};
 assert.deepEqual(await handleMailOutboxApi(args),{status:503,body:{error:'mail_payload_encryption_not_configured'}});assert.equal(reads,0);
 const listing=await handleMailOutboxApi({...args,request:{method:'GET'},url:new URL('https://station.test/api/mail/outbox')});assert.equal(listing.status,200);assert.equal(listing.body.sendingEnabled,false);
});
