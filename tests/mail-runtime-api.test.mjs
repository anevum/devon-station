import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createStation} from '../worker/index.mjs';
const mime=new TextEncoder().encode('From: Author <author@example.org>\r\nSubject: An actual test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nAn inert message.');
const schema=readFileSync(new URL('../worker/migrations/0004-comms-ro-mail.sql',import.meta.url),'utf8');
function d1Double(db) {
 let batches=0;
 const prepared=(sql,params=[])=>({sql,params,bind(...v){return prepared(sql,v);},
   async all(){return {success:true,results:db.prepare(sql).all(...params)};},
   async first(){return db.prepare(sql).get(...params)??null;}});
 return {prepare(sql){return prepared(sql);},get batches(){return batches;},async batch(statements){
   batches++;db.exec('BEGIN IMMEDIATE');
   try{const r=statements.map(({sql,params})=>{const x=db.prepare(sql).run(...params);return {success:true,meta:{changes:x.changes}};});db.exec('COMMIT');return r;}
   catch(e){db.exec('ROLLBACK');throw e;}
 }};
}
function socketMock(payload=mime,{trailingMetadata=false,complete=true}={}) {
 let controller,closed=false,calls=[];
 const respond = bytes => {const raw=typeof bytes==='string'?new TextEncoder().encode(bytes):bytes;
  for(let pos=0;pos<raw.length;pos+=11)controller.enqueue(raw.slice(pos,pos+11));};
 const connect=(target,options)=>{
  assert.deepEqual(target,{hostname:'imap.purelymail.com',port:993});
  assert.deepEqual(options,{secureTransport:'on'});
  return {opened:Promise.resolve(),readable:new ReadableStream({start(c){controller=c;respond('* OK ready\r\n');}}),
   writable:new WritableStream({write(chunk){const command=new TextDecoder().decode(chunk);calls.push(command);
    const tag=command.slice(0,5);
    if(command.includes(' LOGIN '))respond(tag+' OK logged in\r\n');
    else if(command.includes('EXAMINE'))respond('* OK [UIDVALIDITY 7] [UIDNEXT 2] selected\r\n'+tag+' OK done\r\n');
    else if(command.includes('UID SEARCH'))respond('* SEARCH 1\r\n'+tag+' OK done\r\n');
    else if(command.includes('UID FETCH')) {
      respond((trailingMetadata?'* 1 FETCH (BODY[] {':'* 1 FETCH (UID 1 FLAGS (\\Seen) INTERNALDATE "02-Nov-2026 12:00:00 -0500" BODY[] {')+payload.byteLength+'}\r\n');
      respond(payload);
      if(complete)respond((trailingMetadata?' UID 1 FLAGS (\\Seen) INTERNALDATE "02-Nov-2026 12:00:00 -0500"': '')+')\r\n');
      respond(tag+' OK done\r\n');
    } else throw new Error('unexpected command');
   }}),
   async close(){if(!closed){closed=true;controller.close();}}
  };
 };
 return {connect,calls:()=>calls,closed:()=>closed};
}
function env(db){return {OWNER_EMAIL:'owner@example.org',APP_ORIGIN:'https://station.example',
  MAIL_OWNER_SUB:'trusted-owner-sub',MAIL_ENABLED:'true',MAIL_IMAP_ADDRESS:'hello@devonakins.com',
  MAIL_IMAP_PASSWORD:'synthetic-password',MAIL_DB:db};}
const auth=async()=>({email:'owner@example.org',subject:'trusted-owner-sub'});
const base='https://station.example';
function req(path,method='GET',extra={}) {return new Request(base+path,{method,...(method==='POST'?{headers:{Origin:base,'Content-Type':'application/json'},body:'{}'}:{}),...extra});}
test('fail-closed when mail provider is not configured and never starts a socket',async()=>{
 const mock=socketMock(),station=createStation({},auth,fetch,mock.connect);
 const unconfigured={OWNER_EMAIL:'owner@example.org',APP_ORIGIN:base,MAIL_OWNER_SUB:'trusted-owner-sub'};
 const r=await station.fetch(req('/api/mail/status'),unconfigured);assert.equal(r.status,200);
 assert.equal((await r.json()).configured,false);
 const b=await station.fetch(req('/api/mail/inbox'),unconfigured);assert.equal(b.status,503);
 assert.equal(mock.calls().length,0);
});
test('signed owner subject, Origin and HTTP method enforced before mail access',async()=>{
 const mock=socketMock(),station=createStation({},auth,fetch,mock.connect);
 const db=new DatabaseSync(':memory:');db.exec(schema);const binding=d1Double(db);
 assert.equal((await station.fetch(req('/api/mail/inbox'),{...env(binding),MAIL_OWNER_SUB:'other'})).status,403);
 assert.equal((await station.fetch(req('/api/mail/sync','POST',{headers:{Origin:'https://evil.example','Content-Type':'application/json'}}),env(binding))).status,403);
 assert.equal((await station.fetch(req('/api/mail/sync','DELETE',{headers:{Origin:base,'Content-Type':'application/json'}}),env(binding))).status,405);
 assert.equal(mock.calls().length,0);db.close();
});
test('owner-triggered IMAP TLS read-only sync persists in isolated D1 and returns text-only inbox',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(schema);db.exec('PRAGMA foreign_keys=ON');
 const binding=d1Double(db),mock=socketMock(),station=createStation({},auth,fetch,mock.connect);
 const sync=await station.fetch(req('/api/mail/sync','POST'),env(binding));
 assert.equal(sync.status,200);const receipt=await sync.json();assert.equal(receipt.imported,1);
 assert.equal(receipt.cursor.uidValidity,7);
 assert.equal(binding.batches,1);
 const inbox=await station.fetch(req('/api/mail/inbox?limit=10'),env(binding));
 assert.equal(inbox.status,200);const response=await inbox.json();
 assert.equal(response.messages.length,1);
 assert.equal(response.messages[0].text,'An inert message.\n');
 assert.equal(response.messages[0].subject,'An actual test');
 assert.equal(response.messages[0].timestamp,'2026-11-02T17:00:00.000Z');
 assert.equal(Object.hasOwn(response.messages[0],'html'),false);
 assert(mock.calls().every(x=>!/\b(SELECT|STORE|APPEND|EXPUNGE)\b/.test(x)));
 assert.equal(mock.closed(),true);
 db.close();
});
test('HTML-only email syncs as inert plain text and cannot add remote tracking assets',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(schema);const binding=d1Double(db);
 const html=new TextEncoder().encode('From: Author <author@example.org>\r\nSubject: HTML message\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>Actual message</p><script>steal()</script><img src="https://tracking.example/pixel"></body></html>');
 const mock=socketMock(html),station=createStation({},auth,fetch,mock.connect);
 const sync=await station.fetch(req('/api/mail/sync','POST'),env(binding));
 assert.equal(sync.status,200);assert.equal((await sync.json()).imported,1);
 assert.equal(binding.batches,1);
 const inbox=await station.fetch(req('/api/mail/inbox'),env(binding));
 assert.equal(inbox.status,200);
 const rows=(await inbox.json()).messages;
 assert.equal(rows.length,1);
 assert.match(rows[0].text,/Actual message/);
 assert.doesNotMatch(rows[0].text,/steal\(\)|tracking\.example|<img/);
 assert.equal(Object.hasOwn(rows[0],'html'),false);
 db.close();
});
test('oversize indexed text fails before any D1 transaction, retaining cursor for retry',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(schema);const binding=d1Double(db);
 const large=new TextEncoder().encode('From: author@example.org\r\nSubject: Oversize\r\nContent-Type: text/plain\r\n\r\n'+'A'.repeat(4200));
 const mock=socketMock(large),station=createStation({},auth,fetch,mock.connect);
 const sync=await station.fetch(req('/api/mail/sync','POST'),env(binding));
 assert.equal(sync.status,502);assert.deepEqual(await sync.json(),{error:'mail_operation_failed'});
 assert.equal(binding.batches,0);
 const inbox=await station.fetch(req('/api/mail/inbox'),env(binding));
 assert.equal((await inbox.json()).messages.length,0);
 db.close();
});

test('reordered FETCH persists through owner API, while premature tagged OK cannot advance D1',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(schema);const binding=d1Double(db);
 try{
  const broken=socketMock(mime,{trailingMetadata:true,complete:false});
  const rejected=await createStation({},auth,fetch,broken.connect).fetch(req('/api/mail/sync','POST'),env(binding));
  assert.equal(rejected.status,502);assert.deepEqual(await rejected.json(),{error:'mail_operation_failed'});
  assert.equal(binding.batches,0);assert.equal(broken.closed(),true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM comms_ro_mailboxes').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM comms_ro_messages').get().n,0);
  const valid=socketMock(mime,{trailingMetadata:true});
  const station=createStation({},auth,fetch,valid.connect);
  const accepted=await station.fetch(req('/api/mail/sync','POST'),env(binding));
  assert.equal(accepted.status,200);assert.equal((await accepted.json()).imported,1);
  assert.equal(binding.batches,1);assert.equal(valid.closed(),true);
  const inbox=await station.fetch(req('/api/mail/inbox'),env(binding));
  assert.equal((await inbox.json()).messages[0].text,'An inert message.\n');
 }finally{db.close();}
});

test('inbox revision query is bounded and invalid tokens never reach provider sockets',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(schema);const binding=d1Double(db),mock=socketMock();
 const station=createStation({},auth,fetch,mock.connect);
 try{
  for(const query of ['-1','01','1.5','9007199254740992','nope','1&revision=2'])
   assert.equal((await station.fetch(req('/api/mail/inbox?revision='+query),env(binding))).status,400);
  const empty=await station.fetch(req('/api/mail/inbox?revision=0'),env(binding));
  assert.equal(empty.status,200);assert.equal((await empty.json()).revision,0);
  const conflict=await station.fetch(req('/api/mail/inbox?revision=1'),env(binding));
  assert.equal(conflict.status,409);assert.deepEqual(await conflict.json(),{error:'mailbox_revision_conflict'});
  assert.equal(mock.calls().length,0);assert.equal(binding.batches,0);
 }finally{db.close();}
});
