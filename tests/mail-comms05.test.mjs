import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSqliteMailStore, MAIL_SQLITE_SCHEMA} from '../src/communications/mail-sqlite-store.mjs';
import {createReadOnlyImapProvider, parseUidValidity, parseSearchUids} from '../src/communications/mail-imap-readonly.mjs';
import {createMailRegistry} from '../src/communications/mail-core.mjs';
import {pollReadOnlyMailbox, listReadOnlyInbox} from '../src/communications/mail-readonly-service.mjs';
const scope={installationId:'personal',mailboxId:'hello'};
const row={key:'personal/hello/7/1',installationId:'personal',mailboxId:'hello',uidValidity:7,uid:1,from:'author@example.test',subject:'Test',text:'Synthetic only',timestamp:'2026-11-02T20:00:00Z',flags:[]};
const next={cursor:{uidValidity:7,highestUid:1},records:[row]};
function openDB(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');db.exec(MAIL_SQLITE_SCHEMA);return {db,store:createSqliteMailStore(db)};}
test('SQLite CAS commits rows and cursor atomically, rejects stale writes',async()=>{
 const {db,store}=openDB();
 assert.equal((await store.readSnapshot(scope)).revision,0);
 assert.deepEqual(await store.commitSnapshot({scope,expectedRevision:0,next}),{ok:true,revision:1});
 assert.deepEqual((await store.readSnapshot(scope)).records,[row]);
 assert.deepEqual(await store.commitSnapshot({scope,expectedRevision:0,next}),{ok:false});
 assert.deepEqual((await store.readSnapshot(scope)).cursor,next.cursor);
 db.close();
});
test('SQL failure rolls back cursor and message replacement',async()=>{
 const {db,store}=openDB();await store.commitSnapshot({scope,expectedRevision:0,next});
 db.exec("CREATE TRIGGER deny BEFORE INSERT ON comms_ro_messages BEGIN SELECT RAISE(ABORT, 'stop'); END;");
 await assert.rejects(store.commitSnapshot({scope,expectedRevision:1,next}),/mail_store_transaction_failed/);
 assert.equal((await store.readSnapshot(scope)).revision,1);
 assert.deepEqual((await store.readSnapshot(scope)).records,[row]);db.close();
});
test('same mailbox name in another installation cannot read private mail',async()=>{
 const {db,store}=openDB();await store.commitSnapshot({scope,expectedRevision:0,next});
 const other=await store.readSnapshot({installationId:'client-two',mailboxId:'hello'});
 assert.deepEqual(other.records,[]);assert.equal(other.revision,0);db.close();
});
test('IMAP parser rejects invalid UID response and duplicate search hits',()=>{
 assert.equal(parseUidValidity('* OK [UIDVALIDITY 7]'),7);
 assert.deepEqual(parseSearchUids('* SEARCH 1 2',1),[1,2]);
 assert.throws(()=>parseSearchUids('* SEARCH 1 1',1),/invalid_imap_search/);
 assert.throws(()=>parseUidValidity('* OK [UIDVALIDITY 0]'),/invalid_imap_examine/);
});
test('synthetic IMAP and real SQLite compose with existing authorization service',async()=>{
 const {db,store}=openDB(),commands=[];
 const registry=createMailRegistry({installations:[{id:'personal',domain:'devonakins.com'}],mailboxes:[{id:'hello',installationId:'personal',address:'hello@devonakins.com',provider:'purelymail',mode:'imap'}],identities:[{mailboxId:'hello',address:'hello@devonakins.com',kind:'primary'}],grants:[{installationId:'personal',principalId:'worker',mailboxId:'hello',capabilities:['sync']},{installationId:'personal',principalId:'reader',mailboxId:'hello',capabilities:['read']}]});
 const connector={async open(settings){assert.equal(settings.rejectUnauthorized,true);assert.equal(settings.port,993);return {async exchange(cmd){commands.push(cmd);if(cmd.startsWith('EXAMINE'))return '* OK [UIDVALIDITY 7]';if(cmd.startsWith('UID SEARCH'))return '* SEARCH 1';if(cmd.startsWith('UID FETCH'))return {messages:[{uid:1,from:row.from,subject:row.subject,text:row.text,timestamp:row.timestamp,flags:[]}]};throw Error('unexpected command');},async close(){}};}};
 const context={installationId:'personal',principalId:'worker'};
 await pollReadOnlyMailbox({registry,context,mailboxId:'hello',store,providers:{purelymail:createReadOnlyImapProvider({connector})}});
 const data=await listReadOnlyInbox({registry,context:{installationId:'personal',principalId:'reader'},mailboxId:'hello',store});
 assert.equal(data.messages[0].subject,'Test');
 assert(commands.every(cmd=>!/(SELECT|STORE|EXPUNGE|APPEND)/.test(cmd)));
 await assert.rejects(listReadOnlyInbox({registry,context,mailboxId:'hello',store}),/mailbox_not_authorized/);db.close();
});
