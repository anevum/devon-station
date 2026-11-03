import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSqliteMailStore, MAIL_SQLITE_SCHEMA} from '../src/communications/mail-sqlite-store.mjs';
import {createReadOnlyImapProvider, parseUidValidity, parseUidNext, parseSearchUids} from '../src/communications/mail-imap-readonly.mjs';
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
 assert.equal(parseUidValidity('* OK [UIDVALIDITY 7] [UIDNEXT 2]'),7);
 assert.deepEqual(parseSearchUids('* SEARCH 1 2',1),[1,2]);
 assert.throws(()=>parseSearchUids('* SEARCH 1 1',1),/invalid_imap_search/);
 assert.throws(()=>parseUidValidity('* OK [UIDVALIDITY 0]'),/invalid_imap_examine/);
});
test('synthetic IMAP and real SQLite compose with existing authorization service',async()=>{
 const {db,store}=openDB(),commands=[];
 const registry=createMailRegistry({installations:[{id:'personal',domain:'devonakins.com'}],mailboxes:[{id:'hello',installationId:'personal',address:'hello@devonakins.com',provider:'purelymail',mode:'imap'}],identities:[{mailboxId:'hello',address:'hello@devonakins.com',kind:'primary'}],grants:[{installationId:'personal',principalId:'worker',mailboxId:'hello',capabilities:['sync']},{installationId:'personal',principalId:'reader',mailboxId:'hello',capabilities:['read']}]});
 const connector={async open(settings){assert.equal(settings.rejectUnauthorized,true);assert.equal(settings.port,993);return {async exchange(cmd){commands.push(cmd);if(cmd.startsWith('EXAMINE'))return '* OK [UIDVALIDITY 7] [UIDNEXT 2]';if(cmd.startsWith('UID SEARCH'))return '* SEARCH 1';if(cmd.startsWith('UID FETCH'))return {messages:[{uid:1,from:row.from,subject:row.subject,text:row.text,timestamp:row.timestamp,flags:[]}]};throw Error('unexpected command');},async close(){}};}};
 const context={installationId:'personal',principalId:'worker'};
 await pollReadOnlyMailbox({registry,context,mailboxId:'hello',store,providers:{purelymail:createReadOnlyImapProvider({connector})}});
 const data=await listReadOnlyInbox({registry,context:{installationId:'personal',principalId:'reader'},mailboxId:'hello',store});
 assert.equal(data.messages[0].subject,'Test');
 assert(commands.every(cmd=>!/(SELECT|STORE|EXPUNGE|APPEND)/.test(cmd)));
 await assert.rejects(listReadOnlyInbox({registry,context,mailboxId:'hello',store}),/mailbox_not_authorized/);db.close();
});

async function imapSession({validity=7,uidNext=2,search='* SEARCH',messages=[]}={}){
 const commands=[];
 const connector={async open(){return {async exchange(command){
  commands.push(command);
  if(command.startsWith('EXAMINE'))return '* OK [UIDVALIDITY '+validity+'] [UIDNEXT '+uidNext+'] valid';
  if(command.startsWith('UID SEARCH'))return search;
  if(command.startsWith('UID FETCH'))return {messages};
  assert.fail('unexpected command');
 },async close(){}};}};
 const session=await createReadOnlyImapProvider({connector}).openReadOnly({
  mailbox:{provider:'purelymail',mode:'imap',address:'hello@devonakins.com'},readOnly:true,peek:true});
 return {session,commands};
}
const batchOptions={peek:true,readOnly:true,limit:10};
test('UIDNEXT avoids SEARCH and FETCH when the mailbox is already caught up',async()=>{
 const {session,commands}=await imapSession();
 try{
  assert.deepEqual(await session.fetchBatch({...batchOptions,cursor:{uidValidity:7,highestUid:1}}),
   {uidValidity:7,messages:[]});
  assert.deepEqual(commands,['EXAMINE "INBOX"']);
 }finally{await session.close();}
});
test('UID ceiling and an empty new UIDVALIDITY cohort perform only EXAMINE',async()=>{
 for(const validity of [7,8]){
  const {session,commands}=await imapSession({validity,uidNext:1});
  try{
   assert.deepEqual(await session.fetchBatch({...batchOptions,cursor:{uidValidity:7,highestUid:4294967295}}),
    {uidValidity:validity,messages:[]});
   assert.deepEqual(commands,['EXAMINE "INBOX"']);
  }finally{await session.close();}
 }
});
test('protocol UID bounds and stale, duplicate, oversized or malformed SEARCH results fail closed',async()=>{
 assert.deepEqual(parseSearchUids('* SEARCH',2),[]);
 assert.deepEqual(parseSearchUids('* SEARCH 4294967295',4294967295),[4294967295]);
 for(const response of ['* SEARCH 1','* SEARCH 2 2','* SEARCH 0','* SEARCH 4294967296','* SEARCH 9007199254740992','* SEARCH 2\r\n* SEARCH 3'])
  assert.throws(()=>parseSearchUids(response,2),/invalid_imap_search/);
 assert.throws(()=>parseSearchUids('* SEARCH',4294967296),/invalid_imap_search/);
 assert.throws(()=>parseSearchUids('* SEARCH '+Array.from({length:501},(_,i)=>i+2).join(' '),2),/imap_search_limit/);
 assert.throws(()=>parseUidValidity('* OK [UIDVALIDITY 4294967296]'),/invalid_imap_examine/);
 const {session,commands}=await imapSession();
 try{
  await assert.rejects(session.fetchBatch({...batchOptions,cursor:{uidValidity:7,highestUid:4294967296}}),/invalid_imap_options/);
  assert.deepEqual(commands,['EXAMINE "INBOX"']);
 }finally{await session.close();}
});
test('finite SEARCH sorts sparse new UIDs, enforces fetch limit and still rejects stale hits',async()=>{
 const fresh={uid:3,from:row.from,subject:row.subject,text:row.text,timestamp:row.timestamp,flags:[]};
 const {session,commands}=await imapSession({uidNext:12,search:'* SEARCH 11 3 7',messages:[fresh]});
 try{
  assert.deepEqual((await session.fetchBatch({...batchOptions,limit:1,cursor:{uidValidity:7,highestUid:1}})).messages,[fresh]);
  assert.deepEqual(commands,['EXAMINE "INBOX"','UID SEARCH UID 2:11','UID FETCH 3 (UID FLAGS INTERNALDATE BODY.PEEK[])']);
 }finally{await session.close();}
 const bad=await imapSession({uidNext:3,search:'* SEARCH 1'});
 try{
  await assert.rejects(bad.session.fetchBatch({...batchOptions,cursor:{uidValidity:7,highestUid:1}}),/invalid_imap_search/);
  assert.equal(bad.commands.length,2);
 }finally{await bad.session.close();}
});

test('601-message mailbox drains across bounded pages without omissions or duplicate imports',async()=>{
 const {db,store}=openDB();
 const registry=createMailRegistry({installations:[{id:'personal',domain:'devonakins.com'}],
  mailboxes:[{id:'hello',installationId:'personal',address:'hello@devonakins.com',provider:'purelymail',mode:'imap'}],
  identities:[{mailboxId:'hello',address:'hello@devonakins.com',kind:'primary'}],
  grants:[{installationId:'personal',principalId:'worker',mailboxId:'hello',capabilities:['sync']}]});
 const commands=[];
 const connector={async open(){return {async exchange(command){
  commands.push(command);
  if(command.startsWith('EXAMINE'))return '* OK [UIDVALIDITY 7] [UIDNEXT 602]';
  if(command.startsWith('UID SEARCH')){
   const [,start,end]=/^UID SEARCH UID (\d+):(\d+)$/.exec(command);
   assert(Number(end)-Number(start)<256);assert(Number(end)<602);
   return '* SEARCH'+Array.from({length:Number(end)-Number(start)+1},(_,i)=>' '+(Number(start)+i)).reverse().join('');
  }
  const [,ids]=/^UID FETCH ([0-9,]+) /.exec(command);
  return {messages:ids.split(',').map(Number).map(uid=>({uid,from:row.from,subject:'Message '+uid,text:row.text,timestamp:row.timestamp,flags:[]}))};
 },async close(){}};}};
 try{
  let imported=0;
  for(let i=0;i<61;i++){
   const result=await pollReadOnlyMailbox({registry,context:{installationId:'personal',principalId:'worker'},
    mailboxId:'hello',store,providers:{purelymail:createReadOnlyImapProvider({connector})},limit:10});
   imported+=result.imported;assert.equal(result.updated,0);
  }
  const snapshot=await store.readSnapshot(scope);
  assert.equal(imported,601);assert.equal(snapshot.records.length,601);
  assert.deepEqual(snapshot.records.map(x=>x.uid),Array.from({length:601},(_,i)=>i+1));
  assert.deepEqual(snapshot.cursor,{uidValidity:7,highestUid:601});
  const before=commands.length;
  const idle=await pollReadOnlyMailbox({registry,context:{installationId:'personal',principalId:'worker'},
   mailboxId:'hello',store,providers:{purelymail:createReadOnlyImapProvider({connector})},limit:10});
  assert.equal(idle.imported,0);assert.deepEqual(commands.slice(before),['EXAMINE "INBOX"']);
 }finally{db.close();}
});
test('bounded empty scans progress only below UIDNEXT and missing FETCH results fail closed',async()=>{
 const commands=[];
 const connector={async open(){return {async exchange(command){
  commands.push(command);
  if(command.startsWith('EXAMINE'))return '* OK [UIDVALIDITY 7] [UIDNEXT 10000]';
  if(command.startsWith('UID SEARCH'))return '* SEARCH';
  assert.fail('must not fetch empty windows');
 },async close(){}};}};
 const session=await createReadOnlyImapProvider({connector}).openReadOnly({
  mailbox:{provider:'purelymail',mode:'imap',address:'hello@devonakins.com'},peek:true,readOnly:true});
 try{
  const result=await session.fetchBatch({...batchOptions,cursor:null});
  assert.deepEqual(result,{uidValidity:7,messages:[],scannedThrough:4096});
  assert.equal(commands.length,17);assert.equal(commands.at(-1),'UID SEARCH UID 3841:4096');
 }finally{await session.close();}
 const missing=await imapSession({uidNext:4,search:'* SEARCH 2 3',messages:[{...row,uid:3}]});
 try{await assert.rejects(missing.session.fetchBatch({...batchOptions,cursor:null}),/invalid_imap_fetch/);}
 finally{await missing.session.close();}
});
test('missing, duplicate or invalid UIDNEXT and out-of-window SEARCH results are rejected',async()=>{
 assert.equal(parseUidNext('* OK [UIDNEXT 602]'),602);
 for(const reply of ['* OK [UIDVALIDITY 7]','* OK [UIDNEXT 2] [UIDNEXT 3]',
  '* OK [UIDNEXT 0]','* OK [UIDNEXT 4294967296]'])assert.throws(()=>parseUidNext(reply),/invalid_imap_examine/);
 for(const uidNext of [0,4294967296]){
  const x=await imapSession({uidNext});
  try{await assert.rejects(x.session.fetchBatch({...batchOptions,cursor:null}),/invalid_imap_examine/);}
  finally{await x.session.close();}
 }
 const x=await imapSession({uidNext:3,search:'* SEARCH 3'});
 try{await assert.rejects(x.session.fetchBatch({...batchOptions,cursor:null}),/invalid_imap_search/);}
 finally{await x.session.close();}
});
