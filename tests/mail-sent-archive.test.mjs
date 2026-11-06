import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createMailPayloadCipher} from '../src/communications/mail-payload-crypto.mjs';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
import {createD1Outbox} from '../src/communications/mail-outbox.mjs';
import {handleMailOutboxApi} from '../worker/mail-outbox-api.mjs';

const owner={installationId:'personal',mailboxId:'hello',ownerSub:'synthetic-owner'};
const peer={...owner,ownerSub:'synthetic-peer'};
const draftId='a0000000-0000-4000-8000-000000000001';
const deliveryId='a0000000-0000-4000-8000-000000000002';
const claimId='a0000000-0000-4000-8000-000000000003';
const from='hello@devonakins.com';
const sample={to:['recipient@example.test'],
 subject:'<script>plain text</script>',body:'Line one\n<img src="https://tracking.example.test">'};
const key='AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const migration=name=>readFileSync(new URL('../worker/migrations/'+name,import.meta.url),'utf8');

function fixture(t,{migrate=true}={}){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const name of ['0005-comms-drafts.sql','0006-comms-outbox.sql',
  '0007-comms-draft-outbox-lineage.sql','0008-comms-one-delivery-per-draft.sql'])
  sqlite.exec(migration(name));
 if(migrate)sqlite.exec(migration('0009-comms-sent-archive.sql'));
 const db={prepare(sql){return {bind(...args){
  const statement=sqlite.prepare(sql);
  return {async first(){return statement.get(...args)??null},
   async all(){return {success:true,results:statement.all(...args)}},
   async run(){const result=statement.run(...args);return {success:true,meta:{changes:result.changes}}}};
 },async first(){return sqlite.prepare(sql).get()??null}};}};
 const cipher=createMailPayloadCipher({activeKeyId:'one',keys:{one:key}});
 let clock='2026-01-01T00:00:00.000Z';
 const drafts=createD1DraftStore(db,{cipher,now:()=>clock});
 const outbox=createD1Outbox(db,owner,{cipher,now:()=>clock});
 const other=createD1Outbox(db,peer,{cipher,now:()=>clock});
 const seed=async()=>{
  await drafts.create(owner,draftId);
  await drafts.save(owner,{id:draftId,revision:1,operationId:claimId,...sample});
  return outbox.offerLinkedDraft(deliveryId,{draftId,draftRevision:2,
   payload:{from,draft:sample,date:clock}});
 };
 const accept=async()=>{await outbox.claim(deliveryId,claimId);return outbox.finish(deliveryId,claimId,'accepted');};
 return {sqlite,db,cipher,drafts,outbox,other,seed,accept,
  setClock:value=>{clock=value;},migrate:()=>sqlite.exec(migration('0009-comms-sent-archive.sql'))};
}

test('accepted linked draft is captured atomically as AES-GCM ciphertext; draft deletion and payload retention do not erase Sent archive',async t=>{
 const f=fixture(t);await f.seed();
 assert.deepEqual(await f.outbox.listArchived(),{entries:[],hasMore:false});
 await f.outbox.claim(deliveryId,claimId);
 assert.equal((await f.outbox.listArchived()).entries.length,0,'claimed is not sent');
 await f.outbox.finish(deliveryId,claimId,'accepted');
 const rows=f.sqlite.prepare('SELECT * FROM comms_sent_archive').all();
 assert.equal(rows.length,1);
 assert(!rows[0].payload_json.includes(sample.body));
 assert.equal(JSON.parse(rows[0].payload_json).alg,'A256GCM');
 assert.equal(rows[0].payload_json,f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json);
 const archived=await f.outbox.readArchived(deliveryId);
 assert.deepEqual({to:archived.to,subject:archived.subject,body:archived.body},sample);
 assert.equal(archived.messageId,'<'+deliveryId+'@devonakins.com>');
 assert.equal(archived.recipientDeliveryConfirmed,false);
 assert.equal(archived.providerCopyConfirmed,false);
 const list=await f.outbox.listArchived();
 assert.deepEqual(list.entries.map(x=>x.deliveryId),[deliveryId]);
 assert.equal(list.hasMore,false);
 assert(!JSON.stringify(list).includes(sample.subject),'listing must not disclose subject');
 assert(!JSON.stringify(list).includes(sample.body),'listing must not disclose body');
 const locked=createD1DraftStore(f.db,{cipher:f.cipher,protectPendingOutbox:true});
 assert.deepEqual(await locked.remove(owner,{id:draftId,revision:2}),{deleted:true});
 assert.equal(await f.drafts.read(owner,draftId),null);
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
 f.setClock('2026-03-10T00:00:00.000Z');
 assert.deepEqual(await f.outbox.expireTerminalPayloads({before:'2026-02-05T00:00:00.000Z'}),{expired:1});
 assert.equal((await f.outbox.read(deliveryId)).payload,null);
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
});

test('accepted retention requires exact encrypted archived snapshot while rejected/failed still expire',async t=>{
 const f=fixture(t);await f.seed();await f.accept();
 const insert=f.sqlite.prepare('INSERT INTO comms_outbox (installation_id,mailbox_id,owner_sub,delivery_id,payload_json,state,claim_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)');
 const old='2026-01-01T00:00:00.000Z';
 const unarchivedId='a0000000-0000-4000-8000-000000000071';
 const rejectedId='a0000000-0000-4000-8000-000000000072';
 const failedId='a0000000-0000-4000-8000-000000000073';
 const archivedEnvelope=f.sqlite.prepare('SELECT payload_json FROM comms_sent_archive WHERE delivery_id=?').get(deliveryId).payload_json;
 insert.run(owner.installationId,owner.mailboxId,owner.ownerSub,unarchivedId,archivedEnvelope,'accepted',old,old);
 insert.run(owner.installationId,owner.mailboxId,owner.ownerSub,rejectedId,archivedEnvelope,'rejected',old,old);
 insert.run(owner.installationId,owner.mailboxId,owner.ownerSub,failedId,archivedEnvelope,'failed',old,old);
 f.setClock('2026-03-10T00:00:00.000Z');
 assert.deepEqual(await f.outbox.expireTerminalPayloads({before:'2026-02-05T00:00:00.000Z'}),{expired:3});
 const check=f.sqlite.prepare('SELECT payload_json FROM comms_outbox WHERE delivery_id=?');
 assert.equal(check.get(deliveryId).payload_json,'null','archived accepted ciphertext can expire');
 assert.equal(check.get(unarchivedId).payload_json,archivedEnvelope,'unarchived accepted ciphertext is preserved');
 assert.equal(check.get(rejectedId).payload_json,'null','rejected retention policy unchanged');
 assert.equal(check.get(failedId).payload_json,'null','failed retention policy unchanged');
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
 assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM comms_sent_archive').get().n,1);
});
test('accepted retention refuses ciphertext/lineage mismatch without disturbing archived copy',async t=>{
 const f=fixture(t);await f.seed();await f.accept();
 const original=f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json;
 const modified=await f.cipher.seal({from,draft:{...sample,body:'changed after SMTP'},date:'2026-01-01T00:00:00.000Z'},
  ['outbox',owner.installationId,owner.mailboxId,owner.ownerSub,deliveryId]);
 f.sqlite.prepare('UPDATE comms_outbox SET payload_json=?').run(modified);
 f.setClock('2026-03-10T00:00:00.000Z');
 assert.deepEqual(await f.outbox.expireTerminalPayloads({before:'2026-02-05T00:00:00.000Z'}),{expired:0});
 assert.equal(f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json,modified);
 assert.equal(f.sqlite.prepare('SELECT payload_json FROM comms_sent_archive').get().payload_json,original);
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
});
test('retention fails closed when migration 0009 is missing; historical accepted ciphertext remains intact',async t=>{
 const f=fixture(t,{migrate:false});await f.seed();await f.accept();
 const before=f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json;
 f.setClock('2026-03-10T00:00:00.000Z');
 await assert.rejects(
  f.outbox.expireTerminalPayloads({before:'2026-02-05T00:00:00.000Z'}),
  error=>error?.code==='outbox_retention_failed');
 assert.equal(f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json,before);
 assert.notEqual(before,'null');
});
test('Sent archive is append-only against ordinary SQL UPDATE and DELETE, with keyset index present',async t=>{
 const f=fixture(t);await f.seed();await f.accept();
 const before=f.sqlite.prepare('SELECT * FROM comms_sent_archive').get();
 const index=f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='comms_sent_archive_owner_time'").get();
 assert.equal(index.name,'comms_sent_archive_owner_time');
 const guardNames=f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'comms_sent_archive_immutable_%' ORDER BY name").all().map(x=>x.name);
 assert.deepEqual(guardNames,['comms_sent_archive_immutable_delete','comms_sent_archive_immutable_update']);
 assert.throws(()=>f.sqlite.prepare("UPDATE comms_sent_archive SET accepted_at='2099-01-01T00:00:00Z'").run(),/sent_archive_immutable/);
 assert.throws(()=>f.sqlite.prepare('DELETE FROM comms_sent_archive').run(),/sent_archive_immutable/);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM comms_sent_archive').get(),before);
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
});
test('archive content is refused if permanent accepted receipt is absent or its metadata disagrees',async t=>{
 const f=fixture(t);await f.seed();await f.accept();
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
 const recorded=f.sqlite.prepare('SELECT draft_revision,state,updated_at FROM comms_outbox').get();
 const edit=f.sqlite.prepare('UPDATE comms_outbox SET draft_revision=?');
 edit.run(recorded.draft_revision+1);
 await assert.rejects(f.outbox.readArchived(deliveryId),e=>e?.code==='outbox_archive_unavailable');
 edit.run(recorded.draft_revision);
 f.sqlite.prepare("UPDATE comms_outbox SET state='uncertain'").run();
 await assert.rejects(f.outbox.readArchived(deliveryId),e=>e?.code==='outbox_archive_unavailable');
 f.sqlite.prepare("UPDATE comms_outbox SET state='accepted',updated_at=?").run(recorded.updated_at);
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
 f.sqlite.prepare('DELETE FROM comms_outbox').run();
 await assert.rejects(f.outbox.readArchived(deliveryId),e=>e?.code==='outbox_archive_unavailable');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM comms_sent_archive').get().n,1,
  'archive remains intact even if an administrative outbox deletion corrupts receipt linkage');
});
test('source-only migration backfills previously accepted encrypted snapshots once and ignores nonaccepted rows',async t=>{
 const f=fixture(t,{migrate:false});await f.seed();await f.accept();
 f.migrate();f.migrate();
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM comms_sent_archive').get().n,1);
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM comms_outbox').get().n,1);
});


test('synthetic pre-migration D1 backup independently restores and migrates with encrypted contents and receipts preserved',async t=>{
 const source=fixture(t,{migrate:false});
 await source.seed();
 await source.accept();
 const beforeRows=source.sqlite.prepare('SELECT * FROM comms_outbox ORDER BY delivery_id').all();
 const beforeDrafts=source.sqlite.prepare('SELECT * FROM comms_mail_drafts ORDER BY draft_id').all();
 const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 const baseline={outbox:digest(beforeRows),drafts:digest(beforeDrafts)};
 const directory=mkdtempSync(join(tmpdir(),'ds011-comms39-'));
 t.after(()=>rmSync(directory,{force:true,recursive:true}));
 const snapshotPath=join(directory,'synthetic-pre-migration.sqlite');
 // SQLite VACUUM INTO writes a transactionally consistent independent copy.
 // No live Cloudflare data, secrets or customer messages are ever downloaded.
 source.sqlite.prepare('VACUUM INTO ?').run(snapshotPath);
 const restored=new DatabaseSync(snapshotPath);
 t.after(()=>restored.close());
 const integrity=restored.prepare('PRAGMA integrity_check').all();
 assert.equal(integrity.length,1);
 assert.equal(integrity[0].integrity_check,'ok');
 assert.equal(digest(restored.prepare('SELECT * FROM comms_outbox ORDER BY delivery_id').all()),baseline.outbox);
 assert.equal(digest(restored.prepare('SELECT * FROM comms_mail_drafts ORDER BY draft_id').all()),baseline.drafts);
 assert.equal(restored.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='comms_sent_archive'").get().n,0);
 restored.exec(migration('0009-comms-sent-archive.sql'));
 assert.equal(restored.prepare('SELECT count(*) AS n FROM comms_sent_archive').get().n,1);
 const record=restored.prepare('SELECT payload_json FROM comms_sent_archive').get();
 assert(!record.payload_json.includes(sample.body));
 const restoredPayload=await source.cipher.open(record.payload_json,
  ['outbox',owner.installationId,owner.mailboxId,owner.ownerSub,deliveryId]);
 assert.deepEqual(restoredPayload.draft,sample);
 assert.equal(digest(restored.prepare('SELECT * FROM comms_outbox ORDER BY delivery_id').all()),baseline.outbox);
 assert.equal(digest(restored.prepare('SELECT * FROM comms_mail_drafts ORDER BY draft_id').all()),baseline.drafts);
 assert.equal(source.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='comms_sent_archive'").get().n,0,
  'restored migration must not mutate the original synthetic database');
 assert.equal(source.sqlite.prepare('SELECT COUNT(*) AS n FROM comms_outbox').get().n,1);
});

test('Sent archive metadata keyset pages beyond 100 with identical timestamps and no duplicate entries',async t=>{
 const f=fixture(t);await f.seed();await f.accept();
 const existing=f.sqlite.prepare('SELECT * FROM comms_sent_archive').get();
 const insert=f.sqlite.prepare('INSERT INTO comms_sent_archive (installation_id,mailbox_id,owner_sub,delivery_id,draft_id,draft_revision,payload_json,accepted_at) VALUES (?,?,?,?,?,?,?,?)');
 const outbox=f.sqlite.prepare("INSERT INTO comms_outbox (installation_id,mailbox_id,owner_sub,delivery_id,payload_json,state,claim_id,created_at,updated_at,draft_id,draft_revision) VALUES (?,?,?,?,?,'accepted',NULL,?,?,?,?)");
 for(let i=0;i<105;i++){
  const next='a0000000-0000-4000-8000-'+String(i+10).padStart(12,'0');
  const linked='b0000000-0000-4000-8000-'+String(i+10).padStart(12,'0');
  const encrypted=await f.cipher.seal({from,draft:sample,date:existing.accepted_at},
   ['outbox',owner.installationId,owner.mailboxId,owner.ownerSub,next]);
  outbox.run(owner.installationId,owner.mailboxId,owner.ownerSub,next,encrypted,
   existing.accepted_at,existing.accepted_at,linked,2);
  insert.run(owner.installationId,owner.mailboxId,owner.ownerSub,next,linked,2,encrypted,existing.accepted_at);
 }
 // Insert 105 bogus rows sorting ahead of the real messages. The archive
 // listing must ignore them before computing its 100-row lookahead.
 for(let i=0;i<105;i++)insert.run(owner.installationId,owner.mailboxId,owner.ownerSub,
  'f0000000-0000-4000-8000-'+String(i+10).padStart(12,'0'),
  'b0000000-0000-4000-8000-'+String(i+300).padStart(12,'0'),
  2,existing.payload_json,existing.accepted_at);
 const first=await f.outbox.listArchived();
 assert.equal(first.entries.length,100);assert.equal(first.hasMore,true);
 const edge=first.entries.at(-1);
 const last=await f.outbox.listArchived({acceptedAt:edge.acceptedAt,deliveryId:edge.deliveryId});
 assert.equal(last.entries.length,6);assert.equal(last.hasMore,false);
 const ids=[...first.entries,...last.entries].map(x=>x.deliveryId);
 assert.equal(ids.length,106);assert.equal(new Set(ids).size,106);
 assert(ids.every(x=>!x.startsWith('f')),'orphan entries cannot masquerade as Sent');
 assert.deepEqual(ids,[...ids].sort((a,b)=>b.localeCompare(a)));
 assert.equal((await f.outbox.readArchived(ids[0])).body,sample.body);
 assert.deepEqual((await f.other.listArchived()).entries,[]);
 for(const bad of [{acceptedAt:edge.acceptedAt,deliveryId:'bad'},
  {acceptedAt:edge.acceptedAt,deliveryId:edge.deliveryId,ownerSub:'other'},
  {acceptedAt:'invalid',deliveryId:edge.deliveryId}])
  await assert.rejects(f.outbox.listArchived(bad),e=>e?.code==='outbox_invalid_archive_cursor');
});
test('Sent list excludes nonaccepted, altered and missing outbox receipts',async t=>{
 const f=fixture(t);await f.seed();await f.accept();
 const valid=async()=>{const result=await f.outbox.listArchived();assert.equal(result.entries.length,1);
  assert.equal(result.entries[0].deliveryId,deliveryId);};
 const empty=async()=>assert.deepEqual(await f.outbox.listArchived(),{entries:[],hasMore:false});
 await valid();
 const prior=f.sqlite.prepare('SELECT draft_id,draft_revision,updated_at FROM comms_outbox').get();
 f.sqlite.prepare("UPDATE comms_outbox SET state='uncertain'").run();await empty();
 f.sqlite.prepare("UPDATE comms_outbox SET state='accepted',draft_revision=?").run(prior.draft_revision+1);await empty();
 f.sqlite.prepare('UPDATE comms_outbox SET draft_revision=?,draft_id=?')
  .run(prior.draft_revision,'b0000000-0000-4000-8000-000000000900');await empty();
 f.sqlite.prepare('UPDATE comms_outbox SET draft_id=?,updated_at=?')
  .run(prior.draft_id,'2026-01-01T12:00:00.000Z');await empty();
 f.sqlite.prepare('UPDATE comms_outbox SET updated_at=?').run(prior.updated_at);await valid();
 f.sqlite.prepare('DELETE FROM comms_outbox').run();await empty();
 assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM comms_sent_archive').get().n,1);
});
test('archive pagination API requires signed owner and strict cursor without provider calls',async t=>{
 const f=fixture(t);await f.seed();await f.accept();
 const url=new URL('https://station.example/api/mail/outbox/archive/page');
 const before={acceptedAt:'2026-01-02T00:00:00.000Z',deliveryId};
 const env={MAIL_OWNER_SUB:owner.ownerSub,MAIL_OUTBOX_ENABLED:'true',MAIL_DB:f.db,
  MAIL_PAYLOAD_KEY_ID:'one',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({one:key}),
  MAIL_SEND_ENABLED:'false',MAIL_SENDER_VERIFIED:'false'};
 let remote=0;
 const args={request:new Request(url,{method:'POST'}),url,env,user:{subject:owner.ownerSub},
  readBody:async()=>({before}),connect:()=>{remote++;throw Error('provider I/O forbidden');},registry:{}};
 const result=await handleMailOutboxApi(args);
 assert.equal(result.status,200);assert.equal(result.body.providerIndependent,true);
 assert.equal(result.body.entries.length,1);assert.equal(result.body.hasMore,false);
 assert.equal(remote,0);
 assert.deepEqual(await handleMailOutboxApi({...args,user:{subject:peer.ownerSub}}),
  {status:403,body:{error:'mail_owner_not_authorized'}});
 for(const bad of [{...before,extra:'bad'},{...before,acceptedAt:'invalid'}])
  assert.deepEqual(await handleMailOutboxApi({...args,readBody:async()=>({before:bad})}),
   {status:400,body:{error:'invalid_mail_archive_request'}});
 assert.deepEqual(await handleMailOutboxApi({...args,request:new Request(url,{method:'GET'})}),
  {status:405,body:{error:'method_not_allowed'}});
 assert.equal(remote,0);
});
test('uncertain SMTP attempt remains nonarchived and nonretryable; owner scopes cannot see each other',async t=>{
 const f=fixture(t);await f.seed();
 assert.equal(await f.outbox.readArchived(deliveryId),null);
 await f.outbox.claim(deliveryId,claimId);
 await f.outbox.finish(deliveryId,claimId,'uncertain');
 assert.deepEqual(await f.outbox.listArchived(),{entries:[],hasMore:false});
 await assert.rejects(f.outbox.finish(deliveryId,claimId,'accepted'),error=>error?.code==='outbox_transition_conflict');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM comms_sent_archive').get().n,0);
 await assert.rejects(f.outbox.readArchived('not-an-id'),error=>error?.code==='outbox_invalid_id');
 const source=f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json;
 f.sqlite.prepare('INSERT INTO comms_sent_archive (installation_id,mailbox_id,owner_sub,delivery_id,draft_id,draft_revision,payload_json,accepted_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(owner.installationId,owner.mailboxId,peer.ownerSub,deliveryId,draftId,2,source,'2026-01-01T00:00:00Z');
 assert.equal((await f.outbox.listArchived()).entries.length,0);
 await assert.rejects(f.other.readArchived(deliveryId),error=>error?.code==='outbox_archive_unavailable');
});

test('historical terminal receipts beyond 100 do not lock new mail or hide a pending draft',async t=>{
 const f=fixture(t);
 const insert=f.sqlite.prepare("INSERT INTO comms_outbox (installation_id,mailbox_id,owner_sub,delivery_id,payload_json,state,claim_id,created_at,updated_at) VALUES (?,?,?,?,?,'accepted',NULL,?,?)");
 for(let i=0;i<105;i++){
  const key='a0000000-0000-4000-8000-'+String(i+200).padStart(12,'0');
  insert.run(owner.installationId,owner.mailboxId,owner.ownerSub,key,'null',
   '2025-12-01T00:00:00.000Z','2025-12-01T00:00:00.000Z');
 }
 assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM comms_outbox WHERE state='accepted'").get().n,105);
 await f.seed();
 assert.equal((await f.outbox.readReceipt(deliveryId)).state,'queued');
 const visible=await f.outbox.list();
 assert.equal(visible.length,100);
 assert.equal(visible[0].deliveryId,deliveryId,'old terminal receipts cannot hide a new draft');
 assert.equal(visible[0].state,'queued');
 await f.outbox.claim(deliveryId,claimId);
 await f.outbox.finish(deliveryId,claimId,'accepted');
 assert.equal((await f.outbox.readArchived(deliveryId)).body,sample.body);
 assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM comms_outbox WHERE state='accepted'").get().n,106);
 assert.equal((await f.outbox.listArchived()).entries.length,1);
});
test('the 100-attempt unresolved capacity limit still blocks new prepared mail',async t=>{
 const f=fixture(t);
 const insert=f.sqlite.prepare("INSERT INTO comms_outbox (installation_id,mailbox_id,owner_sub,delivery_id,payload_json,state,claim_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)");
 for(let i=0;i<100;i++){
  const key='a0000000-0000-4000-8000-'+String(i+500).padStart(12,'0');
  insert.run(owner.installationId,owner.mailboxId,owner.ownerSub,key,'null',
   i%3===0?'queued':i%3===1?'claimed':'uncertain',
   '2025-12-01T00:00:00.000Z','2025-12-01T00:00:00.000Z');
 }
 await assert.rejects(f.seed(),error=>error?.code==='outbox_limit');
 assert.equal(await f.outbox.readReceipt(deliveryId),null);
 assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM comms_outbox').get().n,100);
 const list=await f.outbox.list();
 assert.equal(list.length,100);
 assert(list.every(x=>['queued','claimed','uncertain'].includes(x.state)));
});
test('archive constraint failure rolls back accepted-state write without authorizing an SMTP retry',async t=>{
 const f=fixture(t);await f.seed();await f.outbox.claim(deliveryId,claimId);
 const source=f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json;
 f.sqlite.prepare('INSERT INTO comms_sent_archive (installation_id,mailbox_id,owner_sub,delivery_id,draft_id,draft_revision,payload_json,accepted_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(owner.installationId,owner.mailboxId,owner.ownerSub,deliveryId,draftId,2,source,'2026-01-01T00:00:00Z');
 await assert.rejects(f.outbox.finish(deliveryId,claimId,'accepted'));
 assert.equal(f.sqlite.prepare('SELECT state FROM comms_outbox').get().state,'claimed');
 assert.equal(await f.outbox.claim(deliveryId,claimId),null,'delivery cannot be re-claimed or resent');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM comms_sent_archive').get().n,1);
});

test('signed owner archive endpoints read the snapshot without provider I/O, reject invalid requests and remain closed before migration',async t=>{
 const f=fixture(t);await f.seed();await f.accept();
 const env={MAIL_OWNER_SUB:owner.ownerSub,MAIL_OUTBOX_ENABLED:'true',MAIL_DB:f.db,
  MAIL_PAYLOAD_KEY_ID:'one',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({one:key}),
  MAIL_SEND_ENABLED:'false',MAIL_SENDER_VERIFIED:'false'};
 const url=new URL('https://station.example/api/mail/outbox/archive/view');
 const request=new Request(url,{method:'POST'});
 let remoteCalls=0;
 const args={url,request,env,user:{subject:owner.ownerSub},
  readBody:async()=>({deliveryId}),connect:()=>{remoteCalls++;throw Error('provider access forbidden');},registry:{}};
 assert.deepEqual(await handleMailOutboxApi({...args,user:{subject:peer.ownerSub}}),
  {status:403,body:{error:'mail_owner_not_authorized'}});
 const result=await handleMailOutboxApi(args);
 assert.equal(result.status,200);assert.equal(result.body.archive.body,sample.body);
 assert.equal(result.body.archive.providerCopyConfirmed,false);
 assert.equal(result.body.archive.recipientDeliveryConfirmed,false);
 assert.equal(remoteCalls,0);
 assert.deepEqual(await handleMailOutboxApi({...args,readBody:async()=>({deliveryId,extra:true})}),
  {status:400,body:{error:'invalid_mail_archive_request'}});
 assert.deepEqual(await handleMailOutboxApi({...args,readBody:async()=>({deliveryId:'invalid'})}),
  {status:400,body:{error:'invalid_mail_archive_request'}});
 const listUrl=new URL('https://station.example/api/mail/outbox/archive');
 const listing=await handleMailOutboxApi({...args,url:listUrl,request:new Request(listUrl)});
 assert.equal(listing.status,200);assert.deepEqual(listing.body.entries.map(x=>x.deliveryId),[deliveryId]);
 assert.equal(listing.body.providerIndependent,true);
 assert.equal(remoteCalls,0);
 const other=fixture(t,{migrate:false});
 const missed=await handleMailOutboxApi({...args,env:{...env,MAIL_DB:other.db},url:listUrl,request:new Request(listUrl)});
 assert.deepEqual(missed,{status:503,body:{error:'mail_sent_archive_unavailable'}});
});

test('receipt-backed Sent works before 0009, survives fresh readers and draft deletion, and cannot erase its sole ciphertext',async t=>{
 const f=fixture(t,{migrate:false});await f.seed();await f.accept();
 assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='comms_sent_archive'").get().n,0);
 const fresh=createD1Outbox(f.db,owner,{cipher:f.cipher,now:()=> '2026-03-10T00:00:00.000Z'});
 const listing=await fresh.listAccepted();
 assert.equal(listing.entries.length,1);assert.equal(listing.hasMore,false);
 assert(!JSON.stringify(listing).includes(sample.subject));assert(!JSON.stringify(listing).includes('recipient@'));
 const copy=await fresh.readAccepted(deliveryId);
 assert.deepEqual({to:copy.to,subject:copy.subject,body:copy.body},sample);
 assert.equal(copy.storageSource,'outbox');assert.equal(copy.recipientDeliveryConfirmed,false);
 const locked=createD1DraftStore(f.db,{cipher:f.cipher,protectPendingOutbox:true});
 await locked.remove(owner,{id:draftId,revision:2});
 assert.equal((await fresh.readAccepted(deliveryId)).body,sample.body);
 const envelope=f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json;
 await assert.rejects(fresh.expireTerminalPayloads({before:'2026-02-05T00:00:00.000Z'}),/outbox_retention_failed/);
 assert.equal(f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json,envelope);
 assert.equal(await f.outbox.claim(deliveryId,claimId),null,'history never grants resend authority');
});
test('receipt-backed Sent excludes queued, claimed, uncertain and unlinked messages and enforces owner isolation',async t=>{
 const f=fixture(t,{migrate:false});await f.seed();
 for(const state of ['queued','claimed','uncertain']){
  f.sqlite.prepare('UPDATE comms_outbox SET state=?').run(state);
  assert.deepEqual(await f.outbox.listAccepted(),{entries:[],hasMore:false});
  assert.equal(await f.outbox.readAccepted(deliveryId),null);
 }
 f.sqlite.prepare("UPDATE comms_outbox SET state='accepted'").run();
 assert.equal((await f.outbox.listAccepted()).entries.length,1);
 assert.deepEqual(await f.other.listAccepted(),{entries:[],hasMore:false});
 assert.equal(await f.other.readAccepted(deliveryId),null);
 f.sqlite.prepare('UPDATE comms_outbox SET draft_id=NULL,draft_revision=NULL').run();
 assert.deepEqual(await f.outbox.listAccepted(),{entries:[],hasMore:false});
 assert.equal(await f.outbox.readAccepted(deliveryId),null);
});
test('receipt-backed history pages all accepted receipts even when unresolved attempts crowd the status list',async t=>{
 const f=fixture(t,{migrate:false});await f.seed();await f.accept();
 const row=f.sqlite.prepare('SELECT * FROM comms_outbox').get();
 const insert=f.sqlite.prepare('INSERT INTO comms_outbox (installation_id,mailbox_id,owner_sub,delivery_id,payload_json,state,created_at,updated_at,draft_id,draft_revision) VALUES (?,?,?,?,?,?,?,?,?,?)');
 for(let i=10;i<115;i++){
  const key='a0000000-0000-4000-8000-'+String(i).padStart(12,'0');
  const linked='b0000000-0000-4000-8000-'+String(i).padStart(12,'0');
  const encrypted=await f.cipher.seal({from,draft:sample,date:row.updated_at},['outbox',owner.installationId,owner.mailboxId,owner.ownerSub,key]);
  insert.run(owner.installationId,owner.mailboxId,owner.ownerSub,key,encrypted,'accepted',row.created_at,row.updated_at,linked,2);
 }
 for(let i=200;i<300;i++)insert.run(owner.installationId,owner.mailboxId,owner.ownerSub,
  'c0000000-0000-4000-8000-'+String(i).padStart(12,'0'),row.payload_json,'uncertain',row.created_at,row.updated_at,null,null);
 assert((await f.outbox.list()).every(x=>x.state==='uncertain'));
 const first=await f.outbox.listAccepted();assert.equal(first.entries.length,100);assert.equal(first.hasMore,true);
 const last=await f.outbox.listAccepted({acceptedAt:first.entries.at(-1).acceptedAt,deliveryId:first.entries.at(-1).deliveryId});
 assert.equal(last.entries.length,6);assert.equal(last.hasMore,false);
 assert.equal(new Set([...first.entries,...last.entries].map(x=>x.deliveryId)).size,106);
 assert.equal((await f.outbox.readAccepted(first.entries[0].deliveryId)).body,sample.body);
 await assert.rejects(f.outbox.listAccepted({acceptedAt:row.updated_at,deliveryId,ownerSub:peer.ownerSub}),/outbox_invalid_archive_cursor/);
});
test('accepted history uses the archive after deliberate retention, but never hides missing keys or corrupted ciphertext',async t=>{
 const f=fixture(t);await f.seed();await f.accept();
 const wrong=createD1Outbox(f.db,owner,{cipher:createMailPayloadCipher({activeKeyId:'other',keys:{other:key}})});
 await assert.rejects(wrong.readAccepted(deliveryId),/outbox_history_unavailable/);
 const original=f.sqlite.prepare('SELECT payload_json FROM comms_outbox').get().payload_json;
 f.sqlite.prepare('UPDATE comms_outbox SET payload_json=?').run(JSON.stringify({corrupt:true}));
 await assert.rejects(f.outbox.readAccepted(deliveryId),/outbox_history_unavailable/);
 f.sqlite.prepare('UPDATE comms_outbox SET payload_json=?').run(original);
 f.setClock('2026-03-10T00:00:00.000Z');await f.outbox.expireTerminalPayloads({before:'2026-02-05T00:00:00.000Z'});
 assert.equal((await f.outbox.readAccepted(deliveryId)).storageSource,'archive');
 assert.equal((await f.outbox.readAccepted(deliveryId)).body,sample.body);
 const noArchive=fixture(t,{migrate:false});await noArchive.seed();await noArchive.accept();
 noArchive.sqlite.prepare("UPDATE comms_outbox SET payload_json='null'").run();
 await assert.rejects(noArchive.outbox.readAccepted(deliveryId),/outbox_history_unavailable/);
});
test('accepted-history APIs require owner, strict inputs and cipher, return redacted failures and never call a provider',async t=>{
 const f=fixture(t,{migrate:false});await f.seed();await f.accept();
 const env={MAIL_OWNER_SUB:owner.ownerSub,MAIL_OUTBOX_ENABLED:'true',MAIL_DB:f.db,
  MAIL_PAYLOAD_KEY_ID:'one',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({one:key}),MAIL_SEND_ENABLED:'false'};
 let remote=0;
 const call=(path,method='GET',input,user=owner.ownerSub,settings=env)=>{
  const url=new URL('https://station.example/api/mail/outbox/accepted'+path);
  return handleMailOutboxApi({request:new Request(url,{method}),url,env:settings,user:{subject:user},
   readBody:async()=>input,connect:()=>{remote++;throw Error('no provider');},registry:{}});
 };
 assert.equal((await call('')).body.entries.length,1);
 const copy=await call('/view','POST',{deliveryId});assert.equal(copy.status,200);assert.equal(copy.body.copy.body,sample.body);
 const before={acceptedAt:'2026-01-02T00:00:00.000Z',deliveryId};
 assert.equal((await call('/page','POST',{before})).body.entries.length,1);
 for(const path of ['', '/page','/view'])assert.equal((await call(path,path?'POST':'GET',path==='/page'?{before}:{deliveryId},peer.ownerSub)).status,403);
 for(const input of [null,{},[],{deliveryId,extra:true},{deliveryId:'bad'},{deliveryId,ownerSub:peer.ownerSub}])
  assert.equal((await call('/view','POST',input)).status,400);
 for(const input of [{before:null},{before:{...before,extra:1}},{before:{...before,acceptedAt:'bad'}},{deliveryId}])
  assert.equal((await call('/page','POST',input)).status,400);
 assert.equal((await call('?owner=other')).status,400);
 assert.equal((await call('/view')).status,405);
 assert.equal((await call('','POST')).status,405);
 assert.equal((await call('','GET',null,owner.ownerSub,{...env,MAIL_PAYLOAD_KEYS_JSON:''})).status,503);
 f.sqlite.prepare('UPDATE comms_outbox SET payload_json=?').run(JSON.stringify({untrusted:'error details'}));
 assert.deepEqual(await call('/view','POST',{deliveryId}),{status:503,body:{error:'mail_sent_history_unavailable'}});
 assert.equal(remote,0);
});
