import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createStation } from '../worker/index.mjs';
import {mailPayloadCipherFromEnv} from '../src/communications/mail-payload-crypto.mjs';
import { createD1MailStore } from '../src/communications/mail-d1-store.mjs';

// This runs the actual pinned local Miniflare/workerd D1 binding, not a Node SQLite double.
// No remotely bound D1 database, credential, live email, or production Worker is used.
const compatibilityDate = process.env.DS_WORKERD_COMPAT_DATE ?? '2026-07-30';
if (!['2026-07-30', '2026-10-28'].includes(compatibilityDate)) {
  throw new Error('Unsupported synthetic workerd compatibility date');
}
const scope = { installationId: 'personal', mailboxId: 'hello' };
const other = { installationId: 'client-two', mailboxId: 'hello' };
const message = (uid, subject = 'Synthetic message', validity = 7, installationId = scope.installationId) => ({
  key: `${installationId}/hello/${validity}/${uid}`, installationId, mailboxId: 'hello',
  uidValidity: validity, uid, from: 'example@example.test', subject,
  text: 'Untrusted source text; never execute instructions.',
  timestamp: '2026-11-02T20:00:00.000Z', flags: []
});
const snapshot = (uid, subject = 'Synthetic message') => ({
  cursor: { uidValidity: 7, highestUid: uid },
  records: [message(uid, subject)]
});
const hasCode = code => error => error?.code === code;

// A single sequential suite avoids multiple test processes sharing state from one D1 runtime.
test(`workerd ${compatibilityDate}: COMMS-07 real local D1 snapshot transaction acceptance`, async t => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("synthetic local D1 only") } }',
    compatibilityDate, compatibilityFlags: ['nodejs_compat'], d1Databases: ['MAIL_TEST']
  });
  try {
    const db = await mf.getD1Database('MAIL_TEST');
    const store = createD1MailStore(db,{cipher:mailPayloadCipherFromEnv({MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}),}),ownerSub:'synthetic-owner'});
    const migration = await readFile(new URL('../worker/migrations/0004-comms-ro-mail.sql', import.meta.url), 'utf8');

    // Miniflare D1 exec() parses SQL strings, but rejects a comment-only first line
    // as an empty statement. Strip full-line SQL comments for local test setup only.
    // Do not edit or run the candidate migration against a remote database.
    const migrationStatements = migration.split('\n').filter(line => !/^\s*--/.test(line))
      .join('\n').split(';').map(statement => statement.trim()).filter(Boolean);
    assert.equal(migrationStatements.length, 3, 'expected two tables and one index');
    const applyLocalMigration = async () => {
      for (const statement of migrationStatements) await db.prepare(statement).run();
    };
    await t.test('explicit migration is mandatory and idempotent', async () => {
      await assert.rejects(store.readSnapshot(scope), hasCode('mail_d1_read_failed'));
      await applyLocalMigration();
      await applyLocalMigration();
      assert.deepEqual(await store.readSnapshot(scope), { ...scope, revision: 0, cursor: null, records: [] });
    });

    await t.test('first transactional commit writes cursor and message together', async () => {
      assert.deepEqual(await store.commitSnapshot({ scope, expectedRevision: 0, next: snapshot(1) }),
        { ok: true, revision: 1 });
      const value = await store.readSnapshot(scope);
      assert.equal(value.revision, 1);
      assert.deepEqual(value.cursor, { uidValidity: 7, highestUid: 1 });
      assert.deepEqual(value.records, [message(1)]);
    });

    await t.test('stale revision cannot change either messages or cursor', async () => {
      const before = await store.readSnapshot(scope);
      assert.deepEqual(await store.commitSnapshot({ scope, expectedRevision: 0, next: snapshot(2) }),
        { ok: false });
      assert.deepEqual(await store.readSnapshot(scope), before);
    });

    await t.test('simultaneous stale peers cannot both commit', async () => {
      const before = await store.readSnapshot(scope);
      const results = await Promise.all([
        store.commitSnapshot({ scope, expectedRevision: before.revision, next: snapshot(2, 'First proposal') }),
        store.commitSnapshot({ scope, expectedRevision: before.revision, next: snapshot(3, 'Second proposal') })
      ]);
      assert.deepEqual(results.map(x => x.ok).sort(), [false, true]);
      const after = await store.readSnapshot(scope);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.records.length, 1);
      assert(['First proposal', 'Second proposal'].includes(after.records[0].subject));
    });

    await t.test('failed mid-batch INSERT rolls back DELETE and CAS', async () => {
      const before = await store.readSnapshot(scope);
      await db.prepare(`CREATE TRIGGER reject_test_uid BEFORE INSERT ON comms_ro_messages
        WHEN NEW.uid = 999 BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END`).run();
      try {
        const blocked = { cursor: { uidValidity: 7, highestUid: 999 },
          records: [...before.records, message(999, 'Blocked')] };
        await assert.rejects(
          store.commitSnapshot({ scope, expectedRevision: before.revision, next: blocked }),
          hasCode('mail_d1_batch_failed')
        );
        assert.deepEqual(await store.readSnapshot(scope), before);
      } finally {
        await db.prepare('DROP TRIGGER reject_test_uid').run();
      }
    });

    await t.test('identical mailbox ID in another installation cannot read or change private rows', async () => {
      const personalBefore = await store.readSnapshot(scope);
      assert.deepEqual(await store.readSnapshot(other), { ...other, revision: 0, cursor: null, records: [] });
      assert.deepEqual(await store.commitSnapshot({ scope: other, expectedRevision: 0,
        next: { cursor: { uidValidity: 7, highestUid: 1 },
          records: [message(1, 'Other client', 7, other.installationId)] } }),
      { ok: true, revision: 1 });
      assert.deepEqual(await store.readSnapshot(scope), personalBefore);
      assert.equal((await store.readSnapshot(other)).records[0].subject, 'Other client');
    });

    await t.test('UIDVALIDITY change keeps original message cohort and database integrity', async () => {
      const before = await store.readSnapshot(scope);
      const updated = { cursor: { uidValidity: 8, highestUid: 1 },
        records: [...before.records, message(1, 'New UID cohort', 8)] };
      assert.deepEqual(await store.commitSnapshot({ scope, expectedRevision: before.revision, next: updated }),
        { ok: true, revision: before.revision + 1 });
      assert.deepEqual((await store.readSnapshot(scope)).records.map(x => x.uidValidity), [7, 8]);
      // D1 disallows administrative PRAGMA queries in its Workers binding.
      // Verify FK relationships through a portable read-only join instead.
      const orphaned = await db.prepare(`SELECT count(*) AS n FROM comms_ro_messages AS msg
        LEFT JOIN comms_ro_mailboxes AS box
        ON msg.installation_id = box.installation_id AND msg.mailbox_id = box.mailbox_id
        WHERE box.mailbox_id IS NULL`).first();
      assert.equal(orphaned.n, 0);
      assert.equal((await db.prepare('SELECT count(*) AS n FROM comms_ro_messages WHERE installation_id = ? AND mailbox_id = ?')
        .bind(scope.installationId, scope.mailboxId).first()).n, 2);
    });
  } finally {
    await mf.dispose();
  }
});

// Complete HTTP -> socket framing -> MIME -> real disposable D1 acceptance.
test(`workerd ${compatibilityDate}: reordered FETCH commits only a complete frame through owner API`,async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated pipeline")}}',
  compatibilityDate,compatibilityFlags:['nodejs_compat'],d1Databases:['MAIL_PIPELINE']});
 try{
  const db=await mf.getD1Database('MAIL_PIPELINE');
  const migration=await readFile(new URL('../worker/migrations/0004-comms-ro-mail.sql',import.meta.url),'utf8');
  for(const sql of migration.split('\n').filter(line=>!/^\s*--/.test(line)).join('\n').split(';').map(x=>x.trim()).filter(Boolean))
   await db.prepare(sql).run();
  const store=createD1MailStore(db,{cipher:mailPayloadCipherFromEnv({MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}),}),ownerSub:'synthetic-owner'}),before=await store.readSnapshot(scope);
  const base='https://station.example';
  const env={OWNER_EMAIL:'owner@example.org',APP_ORIGIN:base,MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}),MAIL_ENABLED:'true',MAIL_OWNER_SUB:'synthetic-owner',
   MAIL_IMAP_ADDRESS:'hello@devonakins.com',MAIL_IMAP_PASSWORD:'synthetic-only',MAIL_DB:db};
  const payload=new TextEncoder().encode('From: author@example.org\r\nSubject: Synthetic pipeline\r\nContent-Type: text/plain\r\n\r\nInert body');
  for(const complete of [false,true]){
   let controller,closed=false;const commands=[];
   const respond=value=>{
    const data=typeof value==='string'?new TextEncoder().encode(value):value;
    for(let i=0;i<data.length;i+=3)controller.enqueue(data.slice(i,i+3));
   };
   const connect=(target,options)=>{
    assert.deepEqual(target,{hostname:'imap.purelymail.com',port:993});
    assert.deepEqual(options,{secureTransport:'on'});
    return {opened:Promise.resolve(),readable:new ReadableStream({start(c){controller=c;respond('* OK ready\r\n');}}),
     writable:new WritableStream({write(chunk){
      const command=new TextDecoder().decode(chunk),tag=command.slice(0,5);commands.push(command);
      if(command.includes(' LOGIN '))respond(tag+' OK authenticated\r\n');
      else if(command.includes('EXAMINE'))respond('* OK [UIDVALIDITY 7] [UIDNEXT 2] valid\r\n'+tag+' OK selected\r\n');
      else if(command.includes('UID SEARCH'))respond('* SEARCH 1\r\n'+tag+' OK found\r\n');
      else if(command.includes('UID FETCH')){
       respond('* 1 FETCH (BODY[] {'+payload.length+'}\r\n');respond(payload);
       if(complete)respond(' UID 1 FLAGS (\\Seen) INTERNALDATE "02-Nov-2026 12:00:00 -0500")\r\n');
       respond(tag+' OK fetched\r\n');
      }else assert.fail('unexpected command');
     }}),async close(){if(!closed){closed=true;controller.close();}}};
   };
   const station=createStation({},async()=>({email:'owner@example.org',subject:'synthetic-owner'}),fetch,connect);
   const result=await station.fetch(new Request(base+'/api/mail/sync',{method:'POST',
    headers:{Origin:base,'Content-Type':'application/json'},body:'{}'}),env);
   assert.equal(closed,true);
   assert(commands.every(x=>!/\b(SELECT|STORE|APPEND|EXPUNGE)\b/.test(x)));
   if(!complete){
    assert.equal(result.status,502);assert.deepEqual(await result.json(),{error:'mail_operation_failed'});
    assert.deepEqual(await store.readSnapshot(scope),before);
   }else{
    assert.equal(result.status,200);assert.equal((await result.json()).imported,1);
    const saved=await store.readSnapshot(scope);
    assert.deepEqual(saved.cursor,{uidValidity:7,highestUid:1});assert.equal(saved.revision,1);
    assert.equal(saved.records[0].text,'Inert body\n');assert.deepEqual(saved.records[0].flags,['seen']);
   }
  }
 }finally{await mf.dispose();}
});

// Handler and wire fixture run in Node; every snapshot transaction uses real local D1.
test(`workerd ${compatibilityDate}: incremental polling preserves indexed mail and cursor across idle/error/reset cases`,async t=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated incremental poll")}}',
  compatibilityDate,compatibilityFlags:['nodejs_compat'],d1Databases:['MAIL_POLL']});
 try{
  const db=await mf.getD1Database('MAIL_POLL');
  const migration=await readFile(new URL('../worker/migrations/0004-comms-ro-mail.sql',import.meta.url),'utf8');
  for(const sql of migration.split('\n').filter(line=>!/^\s*--/.test(line)).join('\n').split(';').map(x=>x.trim()).filter(Boolean))
   await db.prepare(sql).run();
  const store=createD1MailStore(db,{cipher:mailPayloadCipherFromEnv({MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}),}),ownerSub:'synthetic-owner'}),base='https://station.example';
  const env={OWNER_EMAIL:'owner@example.org',APP_ORIGIN:base,MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}),MAIL_ENABLED:'true',MAIL_OWNER_SUB:'synthetic-owner',
   MAIL_IMAP_ADDRESS:'hello@devonakins.com',MAIL_IMAP_PASSWORD:'synthetic-only',MAIL_DB:db};
  const cases=[
   {name:'empty first mailbox',validity:7,start:1,uids:[],highest:0,imported:0},
   {name:'first sparse arrival',validity:7,start:1,uids:[5],highest:5,imported:1},
   {name:'idle mailbox with indexed messages',validity:7,start:6,uids:[],highest:5,imported:0},
   {name:'stale search result rejected',validity:7,start:6,uids:[5],error:true},
   {name:'duplicate search result rejected',validity:7,start:6,uids:[9,9],error:true},
   {name:'sparse arrivals sorted before fetch',validity:7,start:6,uids:[11,9],highest:11,imported:2},
   {name:'empty new UIDVALIDITY cohort retains old mail',validity:8,start:1,uids:[],highest:0,imported:0,reset:true},
   {name:'new cohort arrival retains earlier cohorts',validity:8,start:1,uids:[2],highest:2,imported:1},
   {name:'exhausted UID ceiling performs only EXAMINE',validity:8,start:null,uids:[],highest:4294967295,imported:0,ceiling:true},
   {name:'UIDVALIDITY reset after exhausted ceiling',validity:9,start:1,uids:[],highest:0,imported:0,reset:true},
   {name:'empty scan budget persists first watermark',validity:10,start:1,uids:[],highest:4096,uidNext:10000,imported:0,reset:true},
   {name:'next poll resumes after persisted empty range',validity:10,start:4097,uids:[],highest:8192,uidNext:10000,imported:0},
   {name:'last gap stops before future UID space',validity:10,start:8193,uids:[],highest:9999,uidNext:10000,imported:0},
   {name:'later arrival is not skipped by prior empty scans',validity:10,start:10000,uids:[10000],highest:10000,uidNext:10001,imported:1}
  ];
  for(const scenario of cases)await t.test(scenario.name,async()=>{
   if(scenario.ceiling){
    const previous=await store.readSnapshot(scope);
    await store.commitSnapshot({scope,expectedRevision:previous.revision,
     next:{records:previous.records,cursor:{uidValidity:8,highestUid:4294967295}}});
   }
   const before=await store.readSnapshot(scope);let controller,closed=false;const commands=[];
   const respond=value=>{
    const data=typeof value==='string'?new TextEncoder().encode(value):value;
    for(let i=0;i<data.length;i+=5)controller.enqueue(data.slice(i,i+5));
   };
   const connect=(target,options)=>{
    assert.deepEqual(target,{hostname:'imap.purelymail.com',port:993});
    assert.deepEqual(options,{secureTransport:'on'});
    return {opened:Promise.resolve(),readable:new ReadableStream({start(c){controller=c;respond('* OK ready\r\n');}}),
     writable:new WritableStream({write(chunk){
      const command=new TextDecoder().decode(chunk),tag=command.slice(0,5);commands.push(command);
      if(command.includes(' LOGIN '))respond(tag+' OK authenticated\r\n');
      else if(command.includes('EXAMINE'))respond('* OK [UIDVALIDITY '+scenario.validity+'] [UIDNEXT '+(scenario.uidNext??(scenario.error?12:Math.min(scenario.highest+1,4294967295)))+'] valid\r\n'+tag+' OK selected\r\n');
      else if(command.includes('UID SEARCH')){
       assert.notEqual(scenario.start,null);
       const [,lower,upper]=/UID SEARCH UID ([0-9]+):([0-9]+)/.exec(command);
       const lo=Number(lower),hi=Number(upper);
       assert(lo>=scenario.start);assert(hi-lo<256);
       assert(hi<(scenario.uidNext??(scenario.error?12:Math.min(scenario.highest+1,4294967295))));
       const hits=scenario.error?scenario.uids:scenario.uids.filter(uid=>uid>=lo&&uid<=hi);
       respond('* SEARCH'+hits.map(uid=>' '+uid).join('')+'\r\n'+tag+' OK found\r\n');
      }else if(command.includes('UID FETCH')){
       assert(!scenario.error,'invalid SEARCH must never reach FETCH');
       const uids=scenario.uids.slice().sort((a,b)=>a-b);
       assert.equal(command,tag+' UID FETCH '+uids.join(',')+' (UID FLAGS INTERNALDATE BODY.PEEK[])\r\n');
       for(const [i,uid] of uids.entries()){
        const payload=new TextEncoder().encode('From: author@example.org\r\nSubject: Synthetic '+uid+'\r\nContent-Type: text/plain\r\n\r\nInert message '+uid);
        respond('* '+(i+1)+' FETCH (BODY[] {'+payload.length+'}\r\n');respond(payload);
        respond(' UID '+uid+' FLAGS () INTERNALDATE "02-Nov-2026 12:00:00 -0500")\r\n');
       }
       respond(tag+' OK fetched\r\n');
      }else assert.fail('unexpected command');
     }}),async close(){if(!closed){closed=true;controller.close();}}};
   };
   const station=createStation({},async()=>({email:'owner@example.org',subject:'synthetic-owner'}),fetch,connect);
   const result=await station.fetch(new Request(base+'/api/mail/sync',{method:'POST',
    headers:{Origin:base,'Content-Type':'application/json'},body:'{}'}),env);
   assert.equal(closed,true);
   const after=await store.readSnapshot(scope);
   if(scenario.error){
    assert.equal(result.status,502);assert.deepEqual(await result.json(),{error:'mail_operation_failed'});
    assert.deepEqual(after,before);
   }else{
    assert.equal(result.status,200);const receipt=await result.json();
    assert.equal(receipt.imported,scenario.imported);assert.equal(receipt.updated,0);
    assert.equal(receipt.uidValidityReset,scenario.reset??false);
    assert.equal(receipt.hasMore,scenario.highest < (scenario.uidNext??Math.min(scenario.highest+1,4294967295))-1);
    assert.deepEqual(receipt.cursor,{uidValidity:scenario.validity,highestUid:scenario.highest});
    assert.deepEqual(after.cursor,receipt.cursor);assert.equal(after.revision,before.revision+1);
    assert.equal(after.records.length,before.records.length+scenario.imported);
    for(const record of before.records)assert.deepEqual(after.records.find(x=>x.key===record.key),record);
   }
   assert.equal(commands.some(x=>x.includes('UID FETCH')),!scenario.error&&scenario.uids.length>0);
   if(scenario.start===null)assert.equal(commands.length,2); // LOGIN and EXAMINE only.
  });
 }finally{await mf.dispose();}
});

test(`workerd ${compatibilityDate}: owner HTTP inbox pages are bound to one real D1 revision`,async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated inbox pages")}}',
  compatibilityDate,compatibilityFlags:['nodejs_compat'],d1Databases:['MAIL_PAGES']});
 try{
  const db=await mf.getD1Database('MAIL_PAGES');
  const migration=await readFile(new URL('../worker/migrations/0004-comms-ro-mail.sql',import.meta.url),'utf8');
  for(const sql of migration.split('\n').filter(line=>!/^\s*--/.test(line)).join('\n').split(';').map(x=>x.trim()).filter(Boolean))
   await db.prepare(sql).run();
  const store=createD1MailStore(db,{cipher:mailPayloadCipherFromEnv({MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}),}),ownerSub:'synthetic-owner'}),base='https://station.example';
  const records=Array.from({length:123},(_,i)=>message(i+1));
  assert.deepEqual(await store.commitSnapshot({scope,expectedRevision:0,
   next:{cursor:{uidValidity:7,highestUid:123},records}}),{ok:true,revision:1});
  const env={OWNER_EMAIL:'owner@example.org',APP_ORIGIN:base,MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='}),MAIL_ENABLED:'true',MAIL_OWNER_SUB:'synthetic-owner',
   MAIL_IMAP_ADDRESS:'hello@devonakins.com',MAIL_IMAP_PASSWORD:'synthetic-only',MAIL_DB:db};
  const noSocket=()=>assert.fail('cached pagination must not open IMAP');
  const station=createStation({},async()=>({email:'owner@example.org',subject:'synthetic-owner'}),fetch,noSocket);
  const seen=[];
  for(const offset of [0,50,100]){
   const response=await station.fetch(new Request(base+'/api/mail/inbox?limit=50&offset='+offset+'&revision=1'),env);
   assert.equal(response.status,200);const page=await response.json();
   assert.equal(page.offset,offset);assert.equal(page.revision,1);assert.equal(page.total,123);
   assert.equal(page.messages.length,Math.min(50,123-offset));seen.push(...page.messages.map(x=>x.key));
  }
  assert.deepEqual(seen,records.slice().reverse().map(x=>x.key));assert.equal(new Set(seen).size,123);
  await store.commitSnapshot({scope,expectedRevision:1,next:{cursor:{uidValidity:7,highestUid:124},records:[...records,message(124)]}});
  const stale=await station.fetch(new Request(base+'/api/mail/inbox?limit=50&offset=50&revision=1'),env);
  assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'mailbox_revision_conflict'});
  const refreshed=await station.fetch(new Request(base+'/api/mail/inbox?limit=50&offset=0'),env);
  assert.equal((await refreshed.json()).revision,2);
  const denied=await station.fetch(new Request(base+'/api/mail/inbox?revision=2'),{...env,MAIL_OWNER_SUB:'other'});
  assert.equal(denied.status,403);
  assert.equal((await store.readSnapshot(scope)).revision,2);
 }finally{await mf.dispose();}
});
