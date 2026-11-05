import test from 'node:test';
import assert from 'node:assert/strict';
import {createPurelymailImapConnector} from '../src/communications/mail-imap-transport.mjs';
const address = 'hello@devonakins.com';
const settings = {host:'imap.purelymail.com',port:993,servername:'imap.purelymail.com',tlsRequired:true,rejectUnauthorized:true,username:address};
const bytes = new TextEncoder();
const message = bytes.encode('From: author@example.org\r\nSubject: Test\r\n\r\nMessage content');
const decodeMime = value => {assert.deepEqual(value,message);return {from:'author@example.org',subject:'Test',text:'Message content'};};
function server({badUid=false, oversized=false, malformed=false, noLogin=false, fetchPrefix, fetchSuffix, onCommand} = {}) {
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
      if(cmd.includes('EXAMINE')){respond('* FLAGS (\\Seen \\Answered)\r\n* OK [UIDVALIDITY 7] [UIDNEXT 2] valid\r\n'+tag+' OK selected\r\n');return;}
      if(cmd.includes('UID SEARCH')){respond('* SEARCH 1\r\n'+tag+' OK done\r\n');return;}
      if(cmd.includes('UID FETCH')) {
        const size=oversized?262145:message.length;
        respond((fetchPrefix??('* 1 FETCH (UID '+(badUid?'garbage':'1')+' FLAGS (\\Seen) INTERNALDATE "02-Nov-2026 10:20:00 -0500" BODY[] {'+size+'}'))+'\r\n');
        if(!oversized)respond(message);
        if(fetchSuffix!==false)respond((fetchSuffix??(malformed?'oops':')'))+'\r\n');
        respond(tag+' OK fetched\r\n');return;
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
  assert.equal(await conn.exchange('UID SEARCH UID 1:256'),'* SEARCH 1');
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
 for (const cmd of ['UID SEARCH UID 1:*','UID SEARCH UID 1:257','UID SEARCH UID 2:1','UID SEARCH UID 0:4294967295','UID SEARCH UID 4294967296:4294967295','UID SEARCH UID 1:4294967296','UID FETCH 4294967296 (UID FLAGS INTERNALDATE BODY.PEEK[])','SELECT "INBOX"','UID STORE 1 +FLAGS (\\Seen)','UID FETCH 1 (BODY[])','UID FETCH 1 (UID FLAGS INTERNALDATE BODY.PEEK[])\r\nA1234 EXPUNGE'])
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
 const s=server({noLogin:true});await assert.rejects(open(s),/imap_login_rejected/);assert.equal(s.closed(),true);
});
test('abort prevents subsequent commands and closes socket',async()=>{
 const s=server(),controller=new AbortController(), conn=await open(s,{signal:controller.signal});controller.abort();
 await assert.rejects(conn.exchange('EXAMINE "INBOX"'),/imap_session_cancelled/);assert.equal(s.closed(),true);
});

test('FETCH accepts metadata following a fragmented literal in arbitrary requested-field order',async()=>{
 for(const fields of [
  {fetchPrefix:'* 1 FETCH (BODY[] {'+message.length+'}',fetchSuffix:' UID 1 INTERNALDATE "02-Nov-2026 10:20:00 -0500" FLAGS (\\Seen))'},
  {fetchPrefix:'* 1 FETCH (FLAGS (\\Seen) BODY[] {'+message.length+'}',fetchSuffix:' INTERNALDATE "02-Nov-2026 10:20:00 -0500" UID 1)'}
 ]){
  const s=server(fields),conn=await open(s);
  try{
   const result=await conn.exchange('UID FETCH 1 (UID FLAGS INTERNALDATE BODY.PEEK[])');
   assert.equal(result.messages[0].uid,1);
   assert.deepEqual(result.messages[0].flags,['seen']);
   assert.equal(result.messages[0].timestamp,'2026-11-02T15:20:00.000Z');
  }finally{await conn.close();}
 }
});
test('FETCH rejects missing, duplicate, unknown or injected attributes and incomplete closures',async()=>{
 const prefix='* 1 FETCH (UID 1 FLAGS (\\Seen) INTERNALDATE "02-Nov-2026 10:20:00 -0500" BODY[] {'+message.length+'}';
 for(const fetchSuffix of [false, '', ' UID 2)', ' FLAGS ())', ' RFC822.SIZE 42)', ') extra', '))',
  ' BODY[] {1}', ' UID 1)']){
  const s=server({fetchPrefix:prefix,fetchSuffix}),conn=await open(s);
  try{
   await assert.rejects(conn.exchange('UID FETCH 1 (UID FLAGS INTERNALDATE BODY.PEEK[])'),/imap_invalid_fetch/);
   assert.equal(s.closed(),true);
   await assert.rejects(conn.exchange('EXAMINE "INBOX"'),/imap_session_cancelled/);
  }
  finally{await conn.close();}
 }
});

test('all 24 requested FETCH attribute orders preserve message identity and empty flags',async()=>{
 const attributes=['UID 1','FLAGS ()','INTERNALDATE "02-Nov-2026 10:20:00 -0500"','BODY[] {'+message.length+'}'];
 const permutations=values=>values.length?values.flatMap((value,i)=>permutations(values.filter((_,j)=>i!==j)).map(tail=>[value,...tail])):[[]];
 for(const order of permutations(attributes)){
  const bodyIndex=order.indexOf(attributes[3]);
  const fetchPrefix='* 1 FETCH ('+order.slice(0,bodyIndex+1).join(' ');
  const tail=order.slice(bodyIndex+1);
  const fetchSuffix=(tail.length?' '+tail.join(' '):'')+')';
  const s=server({fetchPrefix,fetchSuffix}),conn=await open(s);
  try{
   const result=await conn.exchange('UID FETCH 1 (UID FLAGS INTERNALDATE BODY.PEEK[])');
   assert.equal(result.messages[0].uid,1);assert.deepEqual(result.messages[0].flags,[]);
   assert.equal(result.messages[0].text,'Message content');
  }finally{await conn.close();}
 }
});


test('TLS, greeting and login interruptions expose only trusted open stages and close the socket',async()=>{
 for(const [phase,expected] of [['connect','imap_tls_connect_failed'],['greeting','imap_greeting_failed'],['login','imap_login_failed']]){
  let closed=0,controller;
  const connect=()=>({opened:phase==='connect'?Promise.reject(Error('PRIVATE_TLS')):Promise.resolve(),
   readable:new ReadableStream({start(c){controller=c;if(phase==='greeting')c.error(Error('PRIVATE_GREETING'));else c.enqueue(bytes.encode('* OK ready\r\n'));}}),
   writable:new WritableStream({write(){controller.error(Error('PRIVATE_LOGIN'));}}),
   async close(){closed++;}
  });
  const connector=createPurelymailImapConnector({connect,credentials:async()=> 'PRIVATE_CREDENTIAL',decodeMime});
  await assert.rejects(connector.open(settings),error=>{
   assert.equal(error.code,expected);assert.equal(error.message,expected);
   assert.doesNotMatch(error.stack,/PRIVATE_/);return true;
  });
  assert.equal(closed,1);
 }
});
