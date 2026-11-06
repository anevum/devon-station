import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {decodeSafeMime} from '../src/communications/mail-mime-safe.mjs';
import {validateReplyContext,validMessageId} from '../src/communications/mail-core.mjs';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
import {createD1Outbox,createOutboxDispatcher} from '../src/communications/mail-outbox.mjs';
import {createMailPayloadCipher} from '../src/communications/mail-payload-crypto.mjs';
import {prepareOutgoingPlainText} from '../src/communications/mail-outbound-wire.mjs';
const parentId='<parent@example.test>',root='<root@example.test>';
const replyContext={parentId,references:[root,parentId]};
const decode=extra=>decodeSafeMime(new TextEncoder().encode('From: author@example.test\r\nSubject: Message\r\n'+extra+'\r\nContent-Type: text/plain\r\n\r\nBody'));
const owner={installationId:'personal',mailboxId:'hello',ownerSub:'synthetic-owner'};
const context={installationId:'personal',principalId:'owner'};
const from='hello@devonakins.com';
const registry={mailboxes:[{id:'hello',installationId:'personal',mode:'imap',sendVerified:true}],
 identities:[{address:from,mailboxId:'hello',installationId:'personal',sendVerified:true}],
 grants:[{installationId:'personal',principalId:'owner',mailboxId:'hello',capabilities:['send']}]};
const id=n=>'a0000000-0000-4000-8000-'+String(n).padStart(12,'0');
const draft={to:['recipient@example.test'],subject:'Re: Message',body:'Answer',replyContext};
const wire=d=>prepareOutgoingPlainText({registry,context,mailboxId:'hello',from,draft:d,deliveryId:id(3),date:new Date('2026-11-06T12:00:00Z')});
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const f of ['0005-comms-drafts.sql','0006-comms-outbox.sql','0007-comms-draft-outbox-lineage.sql','0008-comms-one-delivery-per-draft.sql'])db.exec(readFileSync(new URL('../worker/migrations/'+f,import.meta.url),'utf8'));
 const binding={prepare(sql){const bind=(...args)=>({async first(){return db.prepare(sql).get(...args)??null;},async all(){return {success:true,results:db.prepare(sql).all(...args)};},async run(){return {success:true,meta:{changes:db.prepare(sql).run(...args).changes}};}});return {...bind(),bind};}};
 const cipher=createMailPayloadCipher({activeKeyId:'test',keys:{test:Buffer.alloc(32,8).toString('base64')}});
 const store=createD1DraftStore(binding,{cipher,protectLinkedOutbox:true});
 const outbox=createD1Outbox(binding,owner,{cipher});
 return {db,binding,cipher,store,outbox,dispatcher:createOutboxDispatcher({store:outbox,draftStore:store,ownerSub:owner.ownerSub,registry,context,mailboxId:'hello',from,now:()=>new Date('2026-11-06T12:00:00Z')})};
}
test('MIME derives reply headers from the parent ID and References or a single In-Reply-To fallback',async()=>{
 assert.deepEqual((await decode('Message-ID: '+parentId+'\r\nReferences: '+root)).replyContext,replyContext);
 assert.deepEqual((await decode('Message-ID: '+parentId+'\r\nIn-Reply-To: '+root)).replyContext,replyContext);
 assert.deepEqual((await decode('Message-ID: '+parentId)).replyContext,{parentId,references:[parentId]});
 const old=await decode('');assert.equal(Object.hasOwn(old,'replyContext'),false);
});
test('bad parent IDs omit linking metadata without losing readable content; bad ancestry is not echoed',async()=>{
 for(const fields of ['Message-ID: bad','Message-ID: '+parentId+'\r\nMessage-ID: <other@example.test>',
  'Message-ID: <.bad@example.test>','Message-ID: <a@bad..host>']){
  const m=await decode(fields);assert.equal(Object.hasOwn(m,'replyContext'),false);assert.match(m.text,/Body/);
 }
 const m=await decode('Message-ID: '+parentId+'\r\nReferences: '+root+' Bcc: unwanted@example.test');
 assert.deepEqual(m.replyContext,{parentId,references:[parentId]});
});
test('ancestry keeps the root and newest bounded IDs, deduplicates and includes the parent once',async()=>{
 const ids=Array.from({length:30},(_,i)=>'<id'+i+'@example.test>');
 const m=await decode('Message-ID: '+parentId+'\r\nReferences: '+ids.join(' ')+' '+parentId);
 assert.equal(m.replyContext.references.length,20);assert.equal(m.replyContext.references[0],ids[0]);
 assert.equal(m.replyContext.references.at(-2),ids.at(-1));assert.equal(m.replyContext.references.at(-1),parentId);
 assert.equal(new Set(m.replyContext.references).size,20);
});
test('wire uses validated reply headers and preserves a separate unique outgoing Message-ID',()=>{
 const m=wire(draft);assert.match(m.wire,/In-Reply-To: <parent@example.test>\r\n/);
 assert.match(m.wire,/References: <root@example.test> <parent@example.test>\r\n/);
 assert.equal(m.messageId,'<'+id(3)+'@devonakins.com>');assert.notEqual(m.messageId,parentId);
 const plain={...draft};delete plain.replyContext;assert.doesNotMatch(wire(plain).wire,/In-Reply-To:|References:/);
 const refs=Array.from({length:19},(_,i)=>'<prior-message-'+i+'@example.test>');
 const long=wire({...draft,replyContext:{parentId,references:[...refs,parentId]}}).wire;
 assert(long.includes('\r\n <prior-message-'));assert(long.split('\r\n').every(line=>line.length<=998));
});
test('header injection and noncanonical contexts are refused before MIME creation',()=>{
 for(const bad of [null,{}, {parentId,references:[]},{parentId,references:[parentId,parentId]},
  {parentId,references:[root]},{parentId:'<x@local>\r\nBcc: evil@example.test',references:[parentId]},
  {parentId,references:[...Array(21).fill(root),parentId]}, {parentId,references:[parentId],extra:true}]){
  assert.throws(()=>validateReplyContext(bad));assert.throws(()=>wire({...draft,replyContext:bad}),e=>e.code==='mail_outbound_invalid_draft');
 }
 assert(validMessageId('<case@local>'));assert(!validMessageId('<x@local>\n'));
});
test('encrypted saved-draft and outbox lineage preserve headers through fresh readers and refuse changed idempotent replay',async t=>{
 const f=fixture(t);await f.store.create(owner,id(1));
 await f.store.save(owner,{id:id(1),revision:1,operationId:id(2),...draft});
 const stored=f.db.prepare('SELECT recipients_json FROM comms_mail_drafts').get().recipients_json;
 assert(!stored.includes(parentId));
 const reread=createD1DraftStore(f.binding,{cipher:f.cipher,protectLinkedOutbox:true});
 assert.deepEqual((await reread.read(owner,id(1))).replyContext,replyContext);
 const changed={parentId:'<different@example.test>',references:['<different@example.test>']};
 await assert.rejects(f.store.save(owner,{id:id(1),revision:1,operationId:id(2),...draft,replyContext:changed}),e=>e.code==='mail_draft_conflict');
 await f.dispatcher.enqueueSavedDraft({deliveryId:id(3),draftId:id(1),draftRevision:2,approvedByOwner:true});
 const delivery=await f.outbox.read(id(3));assert.deepEqual(delivery.payload.draft.replyContext,replyContext);
 assert.match(wire(delivery.payload.draft).wire,/In-Reply-To: <parent@example.test>/);
 await assert.rejects(f.store.save(owner,{id:id(1),revision:2,operationId:id(4),...draft,replyContext:changed}),e=>e.code==='mail_draft_delivery_locked');
 assert.equal((await f.outbox.read(id(3))).state,'queued','preparation must not submit SMTP');
});
