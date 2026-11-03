import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createD1MailStore} from '../src/communications/mail-d1-store.mjs';
import {createMailRegistry} from '../src/communications/mail-core.mjs';
import {pollReadOnlyMailbox,listReadOnlyInbox} from '../src/communications/mail-readonly-service.mjs';

const migration = readFileSync(fileURLToPath(new URL('../worker/migrations/0004-comms-ro-mail.sql',import.meta.url)), 'utf8');
const a={installationId:'personal',mailboxId:'hello'};
const b={installationId:'client-two',mailboxId:'hello'};
const record=(uid=1,extra={})=>({key:`personal/hello/7/${uid}`,installationId:'personal',mailboxId:'hello',uidValidity:7,uid,
  from:'sender@example.test',subject:'An inert subject',text:'Content is not an instruction',
  timestamp:'2026-11-02T20:00:00.000Z',flags:[],...extra});
const next=(uid=1)=>({cursor:{uidValidity:7,highestUid:uid},records:Array.from({length:uid},(_,i)=>record(i+1))});

// A D1 Worker Binding-shaped test double running real SQLite in-process.
// This proves actual SQL transaction semantics, not Cloudflare network/D1 parity.
function d1Double(database, options={}){
  let lastBatch=0;
  function prepared(sql,params=[]){return {
    sql, params,
    bind(...values){return prepared(sql,values);},
    async all(){return {success:true,results:database.prepare(sql).all(...params)};},
    async first(){return database.prepare(sql).get(...params)??null;},
  };}
  return {
    prepare(sql){return prepared(sql);},
    get batches(){return lastBatch;},
    async batch(statements){
      lastBatch++;
      database.exec('BEGIN IMMEDIATE');
      let done=false;
      try {
        const results=statements.map(({sql,params})=>{
          const meta=database.prepare(sql).run(...params);
          return {success:true,meta:{changes:meta.changes}};
        });
        database.exec('COMMIT');done=true;
        if(options.dropReplyOnce){options.dropReplyOnce=false;throw Error('synthetic network acknowledgement lost');}
        return results;
      } catch(error){if(!done)database.exec('ROLLBACK');if(process.env.MAIL_DEBUG)console.error('SQL_ERROR',error.message);throw error;}
    }
  };
}
function fixture({schema=true,path=':memory:', options}={}) {
 const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');
 if(schema)db.exec(migration);
 const binding=d1Double(db,options);
 return {db,binding,store:createD1MailStore(binding)};
}
const code=(key)=>(e)=>e.code===key;

test('migration is separate, explicit, additive and idempotent in disposable SQLite',async()=>{
 const f=fixture({schema:false});
 await assert.rejects(f.store.readSnapshot(a),code('mail_d1_read_failed'));
 f.db.exec(migration);f.db.exec(migration);
 assert.deepEqual(await f.store.readSnapshot(a),{...a,revision:0,cursor:null,records:[]});f.db.close();
});
test('transaction commits first snapshot with one D1 batch; reads are scoped and consistent',async()=>{
 const f=fixture();
 assert.deepEqual(await f.store.commitSnapshot({scope:a,expectedRevision:0,next:next(2)}),{ok:true,revision:1});
 assert.equal(f.binding.batches,1);
 const snapshot=await f.store.readSnapshot(a);
 assert.equal(snapshot.revision,1);assert.equal(snapshot.records.length,2);
 assert.deepEqual(snapshot.cursor,{uidValidity:7,highestUid:2});
 assert.equal((await f.store.readSnapshot(b)).records.length,0);f.db.close();
});
test('stale revision is rejected without changing any row or cursor',async()=>{
 const f=fixture();await f.store.commitSnapshot({scope:a,expectedRevision:0,next:next()});
 const prior=await f.store.readSnapshot(a);
 assert.deepEqual(await f.store.commitSnapshot({scope:a,expectedRevision:0,next:next(2)}),{ok:false});
 assert.deepEqual(await f.store.readSnapshot(a),prior);f.db.close();
});
test('rollback on failed insert preserves original content and revision',async()=>{
 const f=fixture();await f.store.commitSnapshot({scope:a,expectedRevision:0,next:next()});
 const prior=await f.store.readSnapshot(a);
 f.db.exec("CREATE TRIGGER deny_insert BEFORE INSERT ON comms_ro_messages BEGIN SELECT RAISE(ABORT,'blocked'); END;");
 await assert.rejects(f.store.commitSnapshot({scope:a,expectedRevision:1,next:next(2)}),code('mail_d1_batch_failed'));
 assert.deepEqual(await f.store.readSnapshot(a),prior);f.db.close();
});
test('lost batch acknowledgement is recovered using stored operation identity',async()=>{
 const opt={dropReplyOnce:true},f=fixture({options:opt});
 assert.deepEqual(await f.store.commitSnapshot({scope:a,expectedRevision:0,next:next()}),{ok:true,revision:1});
 assert.deepEqual((await f.store.readSnapshot(a)).cursor,{uidValidity:7,highestUid:1});
 assert.equal(f.binding.batches,1);f.db.close();
});
test('competing installations with same mailbox ID cannot affect one another',async()=>{
 const f=fixture();await f.store.commitSnapshot({scope:a,expectedRevision:0,next:next()});
 const otherRow={...record(),installationId:b.installationId,key:'client-two/hello/7/1'};
 await f.store.commitSnapshot({scope:b,expectedRevision:0,next:{cursor:{uidValidity:7,highestUid:1},records:[otherRow]}});
 assert.equal((await f.store.readSnapshot(a)).records[0].installationId,'personal');
 assert.equal((await f.store.readSnapshot(b)).records[0].installationId,'client-two');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM comms_ro_messages').get().n,2);f.db.close();
});
test('a UIDVALIDITY reset adds a distinct cohort without mixing row identities',async()=>{
 const f=fixture();await f.store.commitSnapshot({scope:a,expectedRevision:0,next:next()});
 const prev=await f.store.readSnapshot(a),newer={...record(),uidValidity:8,key:'personal/hello/8/1'};
 await f.store.commitSnapshot({scope:a,expectedRevision:prev.revision,
  next:{cursor:{uidValidity:8,highestUid:1},records:[...prev.records,newer]}});
 assert.deepEqual((await f.store.readSnapshot(a)).records.map(x=>x.uidValidity),[7,8]);f.db.close();
});
test('SQL injection stays bound; raw, HTML, and foreign-scope records fail closed',async()=>{
 const f=fixture();const toxic={...record(),subject:"'); DROP TABLE comms_ro_messages; --",text:'<script>inert</script>'};
 await f.store.commitSnapshot({scope:a,expectedRevision:0,next:{cursor:next().cursor,records:[toxic]}});
 assert.equal((await f.store.readSnapshot(a)).records[0].subject,toxic.subject);
 for(const bad of [{...record(),html:'unsafe'},{...record(),installationId:'other'},{...record(),attachments:[]},
   {...record(),flags:['unknown']}]) {
  await assert.rejects(f.store.commitSnapshot({scope:a,expectedRevision:1,
   next:{cursor:next().cursor,records:[bad]}}),code('invalid_mail_snapshot'));
 }
 assert.equal((await f.store.readSnapshot(a)).revision,1);f.db.close();
});
test('bounded snapshot count and serialized bytes fail closed before database access',async()=>{
 const f=fixture();
 const many=Array.from({length:501},(_,i)=>record(i+1));
 await assert.rejects(f.store.commitSnapshot({scope:a,expectedRevision:0,
  next:{cursor:{uidValidity:7,highestUid:501},records:many}}),code('mail_d1_snapshot_limit'));
 const large=Array.from({length:90},(_,i)=>record(i+1,{text:'X'.repeat(4000)}));
 await assert.rejects(f.store.commitSnapshot({scope:a,expectedRevision:0,
  next:{cursor:{uidValidity:7,highestUid:90},records:large}}),code('mail_d1_snapshot_limit'));
 assert.equal(f.binding.batches,0);f.db.close();
});
test('corrupted stored JSON representation is rejected, not shown to another user',async()=>{
 const f=fixture();await f.store.commitSnapshot({scope:a,expectedRevision:0,next:next()});
 f.db.prepare('UPDATE comms_ro_messages SET flags_json=? WHERE installation_id=?').run('{}','personal');
 await assert.rejects(f.store.readSnapshot(a),code('mail_d1_invalid_snapshot'));f.db.close();
});
test('database file reopens with exact scope, message and cursor retained',async()=>{
 const root=mkdtempSync(join(tmpdir(),'comms06-d1-'));
 try {
  const path=join(root,'synthetic.sqlite');const one=fixture({path});
  await one.store.commitSnapshot({scope:a,expectedRevision:0,next:next()});one.db.close();
  const two=fixture({path,schema:false});
  assert.equal((await two.store.readSnapshot(a)).records[0].subject,'An inert subject');
  assert.equal((await two.store.readSnapshot(a)).revision,1);two.db.close();
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('read-only provider orchestration composes with D1-shaped real SQL store',async()=>{
 const f=fixture();
 const registry=createMailRegistry({installations:[{id:'personal',domain:'devonakins.com'}],
  mailboxes:[{id:'hello',installationId:'personal',address:'hello@devonakins.com',provider:'mock-imap',mode:'imap'}],
  identities:[{mailboxId:'hello',address:'hello@devonakins.com',kind:'primary'}],
  grants:[{installationId:'personal',principalId:'syncer',mailboxId:'hello',capabilities:['sync']},
   {installationId:'personal',principalId:'reader',mailboxId:'hello',capabilities:['read']}]});
 const providers={'mock-imap':{openReadOnly:async()=>({fetchBatch:async()=>({uidValidity:7,messages:[
  {uid:1,from:'sender@example.test',subject:'Synthetic',text:'Untrusted and inert',timestamp:'2026-11-02T20:00:00Z',flags:[]}
 ]}),close:async()=>{}})}};
 const summary=await pollReadOnlyMailbox({registry,context:{installationId:'personal',principalId:'syncer'},
  mailboxId:'hello',store:f.store,providers});
 assert.equal(summary.imported,1);assert.equal(summary.revision,1);
 const inbox=await listReadOnlyInbox({registry,context:{installationId:'personal',principalId:'reader'},mailboxId:'hello',store:f.store});
 assert.equal(inbox.messages[0].subject,'Synthetic');
 await assert.rejects(listReadOnlyInbox({registry,context:{installationId:'personal',principalId:'syncer'},mailboxId:'hello',store:f.store}),code('mailbox_not_authorized'));
 f.db.close();
});
test('nonzero expected revision cannot bootstrap an absent mailbox',async()=>{
 const f=fixture();
 assert.deepEqual(await f.store.commitSnapshot({scope:a,expectedRevision:4,next:next()}),{ok:false});
 assert.deepEqual(await f.store.readSnapshot(a),{...a,revision:0,cursor:null,records:[]});
 f.db.close();
});
test('simulated external writer wins and leaves stale proposal without partial changes',async()=>{
 const f=fixture();
 const old=await f.store.readSnapshot(a);
 await f.store.commitSnapshot({scope:a,expectedRevision:old.revision,next:next()});
 assert.deepEqual(await f.store.commitSnapshot({scope:a,expectedRevision:old.revision,next:next(2)}),{ok:false});
 assert.equal((await f.store.readSnapshot(a)).records.length,1);
 f.db.close();
});
