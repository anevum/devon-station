import test from 'node:test';
import assert from 'node:assert/strict';
import {createPurelymailImapConnector} from '../src/communications/mail-imap-transport.mjs';
const address = 'hello@devonakins.com';
const settings = {host:'imap.purelymail.com',port:993,servername:'imap.purelymail.com',tlsRequired:true,rejectUnauthorized:true,username:address};
const bytes = new TextEncoder();
const message = bytes.encode('From: author@example.org\r\nSubject: Test\r\n\r\nMessage content');
const decodeMime = value => {assert.deepEqual(value,message);return {from:'author@example.org',subject:'Test',text:'Message content'};};
function server({badUid=false, oversized=false, malformed=false, noLogin=false, onCommand} = {}) {
  let controller, closed=false, calls=[], opts;
  const respond = source => {const data=typeof source==='string'?bytes.encode(source):source;
    for(let i=0;i<data.length;i+=7)controller.enqueue(data.slice(i,i+7));};
  const connect=(target,options) => {
    opts={target,options};
    const readable=new ReadableStream({start(c){controller=c;respond('* OK Purelymail IMAP ready\r\n');}});
    const writable=new WritableStream({write(chunk){
      const cmd=new TextDecoder().decode(chunk);calls.push(cmd);onCommand?.(cmd);
      const tag=cmd.slice(0,5);
      if(cmd.includes(' LOGIN ')) {respond(tag+(noLogin?' NO rejected':' OK authenticated')+'\r\n');return;}
      if(cmd.includes('EXAMINE')){respond('* FLAGS (\\Seen \\Answered)\r\n* OK [UIDVALIDITY 7] valid\r\n'+tag+' OK selected\r\n');return;}
      if(cmd.includes('UID SEARCH')){respond('* SEARCH 1\r\n'+tag+' OK done\r\n');return;}
      if(cmd.includes('UID FETCH')) {
        const size=oversized?65537:message.length;
        respond('* 1 FETCH (UID '+(badUid?'garbage':'1')+' FLAGS (\\Seen) INTERNALDATE "02-Nov-2026 10:20:00 -0500" BODY[] {'+size+'}\r\n');
        if(!oversized)respond(message);
        respond((malformed?'oops':')')+'\r\n'+tag+' OK fetched\r\n');return;
      }
      throw new Error('unauthorized command '+cmd);
    }});
    return {opened:Promise.resolve({}),readable,writable,async close(){if(closed)return;closed=true;controller.close();}};
  };
  return {connect,received:()=>calls,parameters:()=>opts,closed:()=>closed};
}
async function open(s, opts={}) {return createPurelymailImapConnector({connect:s.connect,credentials:async user=>user===address?'secret word':undefined,decodeMime}).open({...settings,...opts});}
test('native TLS socket is pinned, framed FETCH is parsed and flags/timestamps preserved',async()=>{
  const s=server();const conn=await open(s);
  assert.deepEqual(s.parameters(),{target:{hostname:'imap.purelymail.com',port:993},options:{secureTransport:'on'}});
  assert.match(await conn.exchange('EXAMINE "INBOX"'),/UIDVALIDITY 7/);
  assert.equal(await conn.exchange('UID SEARCH UID 1:*'),'* SEARCH 1');
  const fetched=await conn.exchange('UID FETCH 1 (UID FLAGS INTERNALDATE BODY.PEEK[])');
  assert.deepEqual(fetched,{messages:[{uid:1,from:'author@example.org',subject:'Test',text:'Message content',timestamp:'2026-11-02T15:20:00.000Z',flags:['seen']}]});
  assert(s.received().every(line=>!/(EXPUNGE|APPEND|\bSTORE\b|\bSELECT\b)/.test(line)));
  assert.match(s.received()[0],/^A0001 LOGIN "hello@devonakins.com" "secret word"\r\n$/);
  await conn.close();assert.equal(s.closed(),true);
});
test('refuses plaintext, hostname override and disabled verification',async()=>{
 const s=server(), connector=createPurelymailImapConnector({connect:s.connect,credentials:async()=> 'ok',decodeMime});
 for(const bad of [{tlsRequired:false},{host:'attacker.example'},{port:143},{rejectUnauthorized:false},{servername:'attacker.example'}])
   await assert.rejects(connector.open({...settings,...bad}),/imap_tls_policy_required/);
 assert.equal(s.parameters(),undefined);
});
test('secrets absent means no outbound connection',async()=>{
 const s=server();await assert.rejects(createPurelymailImapConnector({connect:s.connect,credentials:async()=>undefined,decodeMime}).open(settings),/imap_credentials_unavailable/);
 assert.equal(s.parameters(),undefined);
});
test('never executes write or caller supplied non-audited commands',async()=>{
 const s=server(),conn=await open(s);
 for (const cmd of ['SELECT "INBOX"','UID STORE 1 +FLAGS (\\Seen)','UID FETCH 1 (BODY[])','UID FETCH 1 (UID FLAGS INTERNALDATE BODY.PEEK[])\r\nA1234 EXPUNGE'])
   await assert.rejects(conn.exchange(cmd),/imap_command_forbidden/);
 assert.equal(s.received().length,1);await conn.close();
});
test('oversized MIME literal is rejected before reading and persisting',async()=>{
 const s=server({oversized:true}),conn=await open(s);await assert.rejects(conn.exchange('UID FETCH 1 (UID FLAGS INTERNALDATE BODY.PEEK[])'),/imap_literal_limit/);await conn.close();
});
test('malformed FETCH frame and missing UID are rejected',async()=>{
 for(const spec of [{badUid:true},{malformed:true}]){
 const s=server(spec),conn=await open(s);
 await assert.rejects(conn.exchange('UID FETCH 1 (UID FLAGS INTERNALDATE BODY.PEEK[])'),/imap_invalid_fetch/);await conn.close();
 }
});
test('login denial closes the socket without exposing credentials',async()=>{
 const s=server({noLogin:true});await assert.rejects(open(s),/imap_transport_failed/);assert.equal(s.closed(),true);
});
test('abort prevents subsequent commands and closes socket',async()=>{
 const s=server(),controller=new AbortController(), conn=await open(s,{signal:controller.signal});controller.abort();
 await assert.rejects(conn.exchange('EXAMINE "INBOX"'),/imap_session_cancelled/);assert.equal(s.closed(),true);
});
