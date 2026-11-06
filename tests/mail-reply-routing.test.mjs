import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {decodeSafeMime} from '../src/communications/mail-mime-safe.mjs';
import {createMailRegistry} from '../src/communications/mail-core.mjs';
import {createD1MailStore} from '../src/communications/mail-d1-store.mjs';
import {createSqliteMailStore} from '../src/communications/mail-sqlite-store.mjs';
import {createMailPayloadCipher} from '../src/communications/mail-payload-crypto.mjs';
import {pollReadOnlyMailbox,listReadOnlyInbox} from '../src/communications/mail-readonly-service.mjs';
const decode=header=>decodeSafeMime(new TextEncoder().encode('From: author@example.org\r\nSubject: A note\r\n'+header+'Content-Type: text/plain\r\n\r\nStill readable.'));
const scope={installationId:'personal',mailboxId:'hello'};
const ownerSub='synthetic-owner';
const registry=createMailRegistry({installations:[{id:'personal',domain:'devonakins.com'}],
 mailboxes:[{id:'hello',installationId:'personal',address:'hello@devonakins.com',provider:'mock-imap',mode:'imap'}],
 identities:[{mailboxId:'hello',address:'hello@devonakins.com',kind:'primary'}],
 grants:[{...scope,principalId:'owner',capabilities:['sync','read']}]});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(readFileSync(new URL('../worker/migrations/0004-comms-ro-mail.sql',import.meta.url),'utf8'));
 const binding={prepare(sql){const bind=(...args)=>({sql,args,
  async first(){return db.prepare(sql).get(...args)??null;},
  async all(){return {success:true,results:db.prepare(sql).all(...args)};}});return {...bind(),bind};},
 async batch(statements){db.exec('BEGIN');try{const result=statements.map(s=>({success:true,meta:{changes:db.prepare(s.sql).run(...s.args).changes}}));db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const cipher=createMailPayloadCipher({activeKeyId:'test-key',keys:{'test-key':Buffer.alloc(32,9).toString('base64')}});
 return {db,binding,cipher,store:createD1MailStore(binding,{cipher,ownerSub})};
}
async function seed(f,decoded){
 const message={uid:1,timestamp:'2026-11-06T12:00:00Z',flags:[],...decoded};
 await pollReadOnlyMailbox({registry,context:{installationId:'personal',principalId:'owner'},mailboxId:'hello',store:f.store,
 providers:{'mock-imap':{openReadOnly:async()=>({fetchBatch:async()=>({uidValidity:7,messages:[message]}),close:async()=>{}})}}});
}
test('MIME keeps one canonical Reply-To address, preserves case and leaves no-header messages compatible',async()=>{
 const plain=await decode('');assert.equal(Object.hasOwn(plain,'replyTo'),false);
 const valid=await decode('Reply-To: Support <Support+Case@example.org>\r\n');
 assert.equal(valid.replyTo,'Support+Case@example.org');assert.equal(valid.from,'author@example.org');
 assert.equal((await decode('Reply-To:\r\n Support <support@example.org>\r\n')).replyTo,'support@example.org');
});
test('ambiguous or malformed Reply-To blocks reply routing without blocking incoming content',async()=>{
 for(const header of ['Reply-To: a@example.org,b@example.org\r\n','Reply-To: invalid\r\n',
  'Reply-To: \r\n','Reply-To: a@example.org\r\nReply-To: b@example.org\r\n',
  'Reply-To: Team: a@example.org;\r\n','Reply-To: .bad@example.org\r\n']){
  const message=await decode(header);assert.equal(message.replyTo,null,header);assert.match(message.text,/Still readable/);
 }
});
test('routing survives reconciliation, encrypted D1, fresh readers and owner-only inbox projection',async t=>{
 const f=fixture(t);await seed(f,await decode('Reply-To: private-replies@example.org\r\nMessage-ID: <parent@example.test>\r\nReferences: <root@example.test>\r\n'));
 const raw=f.db.prepare('SELECT * FROM comms_ro_messages').get();
 assert.equal(JSON.parse(raw.body_text).alg,'A256GCM');
 assert(!JSON.stringify(raw).includes('private-replies@example.org'));assert.equal(raw.flags_json,'[]');
 const fresh=createD1MailStore(f.binding,{cipher:f.cipher,ownerSub});
 assert.equal((await fresh.readSnapshot(scope)).records[0].replyTo,'private-replies@example.org');
 const inbox=await listReadOnlyInbox({registry,context:{installationId:'personal',principalId:'owner'},mailboxId:'hello',store:fresh});
 assert.equal(inbox.messages[0].replyTo,'private-replies@example.org');
 assert.deepEqual(inbox.messages[0].replyContext,{parentId:'<parent@example.test>',references:['<root@example.test>','<parent@example.test>']});
 assert(!JSON.stringify(raw).includes('<parent@example.test>'));
 await assert.rejects(listReadOnlyInbox({registry,context:{installationId:'personal',principalId:'other'},mailboxId:'hello',store:fresh}),e=>e.code==='mailbox_not_authorized');
 await assert.rejects(createD1MailStore(f.binding,{cipher:f.cipher,ownerSub:'other'}).readSnapshot(scope),e=>e.code==='mail_d1_invalid_snapshot');
});
test('invalid-header sentinel is encrypted and retained; old ciphertext without routing remains readable',async t=>{
 const f=fixture(t);await seed(f,await decode('Reply-To: invalid\r\n'));
 assert.equal((await f.store.readSnapshot(scope)).records[0].replyTo,null);
 const snapshot=await f.store.readSnapshot(scope);const row={...snapshot.records[0]};delete row.replyTo;
 await f.store.commitSnapshot({scope,expectedRevision:1,next:{cursor:snapshot.cursor,records:[row]}});
 assert.equal(Object.hasOwn((await f.store.readSnapshot(scope)).records[0],'replyTo'),false);
});
test('unencrypted adapters refuse routing metadata before writes rather than discarding or leaking it',async t=>{
 const f=fixture(t);await seed(f,await decode('Reply-To: replies@example.org\r\n'));
 const snapshot=await f.store.readSnapshot(scope),next={cursor:snapshot.cursor,records:snapshot.records};
 for(const store of [createD1MailStore(f.binding),createSqliteMailStore(f.db)]){
  await assert.rejects(store.commitSnapshot({scope,expectedRevision:1,next}),e=>e.code==='mail_reply_metadata_requires_encryption');
 }
 assert.equal(f.db.prepare('SELECT revision FROM comms_ro_mailboxes').get().revision,1);
});
test('invalid authenticated routing payload fails closed instead of returning an arbitrary destination',async t=>{
 const f=fixture(t);await seed(f,await decode(''));
 const envelope=await f.cipher.seal({from:'author@example.org',subject:'A note',text:'Body',replyTo:'a@example.org\nBcc:b@example.org'},['inbox','personal','hello',ownerSub,'7/1']);
 f.db.prepare('UPDATE comms_ro_messages SET body_text=?').run(envelope);
 await assert.rejects(f.store.readSnapshot(scope),e=>e.code==='mail_d1_invalid_snapshot');
});
