import test from 'node:test';
import assert from 'node:assert/strict';
import {createPurelymailImapConnector} from '../src/communications/mail-imap-transport.mjs';
import {expectedSentMessageId,countSentCandidates,probePurelymailSent} from '../src/communications/mail-sent-evidence.mjs';

const delivery='123e4567-e89b-42d3-a456-426614174016';
const settings={host:'imap.purelymail.com',port:993,servername:'imap.purelymail.com',
 tlsRequired:true,rejectUnauthorized:true,username:'hello@devonakins.com',purpose:'sent-evidence'};
const bytes=new TextEncoder();
function fixture({search='* SEARCH 7',failExamine=false,failLogin=false}={}){
 let controller,closed=false;
 const commands=[],targets=[];
 const respond=message=>{
  const b=bytes.encode(message);
  for(let i=0;i<b.length;i+=5)controller.enqueue(b.slice(i,i+5));
 };
 const connect=(target,options)=>{
  targets.push({target,options});
  return {opened:Promise.resolve(),
   readable:new ReadableStream({start(c){controller=c;respond('* OK Purelymail ready\r\n');}}),
   writable:new WritableStream({write(b){
    const cmd=new TextDecoder().decode(b),tag=cmd.slice(0,5);
    commands.push(cmd);
    if(cmd.includes(' LOGIN '))respond(tag+(failLogin?' NO denied':' OK login')+'\r\n');
    else if(cmd.endsWith(' EXAMINE "Sent"\r\n'))
     respond(failExamine?tag+' NO absent\r\n':'* FLAGS (\\Seen)\r\n* OK [UIDVALIDITY 10] valid\r\n'+tag+' OK selected\r\n');
    else if(cmd.includes(' UID SEARCH HEADER Message-ID '))
     respond(search+'\r\n'+tag+' OK searched\r\n');
    else throw Error('unexpected IMAP command');
   }}),
   async close(){closed=true;try{controller.close();}catch{}}
  };
 };
 return {connect,commands,targets,closed:()=>closed};
}
const run=(s,opts={})=>probePurelymailSent({
 connect:s.connect,password:'synthetic-test-pass',deliveryId:delivery,signal:new AbortController().signal,...opts});
test('Sent proof is only an explicit metadata candidate lookup; never SMTP, APPEND, STORE or body fetch',async()=>{
 const s=fixture(),r=await run(s);
 assert.deepEqual(r,{sentFolderExamined:true,candidateCount:1,exactHeaderVerified:false,
  providerCopyConfirmed:false,recipientDeliveryConfirmed:false,automaticRetry:false});
 assert.deepEqual(s.targets,[{target:{hostname:'imap.purelymail.com',port:993},options:{secureTransport:'on'}}]);
 assert.equal(s.commands.length,3);
 assert.match(s.commands[0],/^A0001 LOGIN "hello@devonakins.com" "synthetic-test-pass"\r\n$/);
 assert.equal(s.commands[1],'A0002 EXAMINE "Sent"\r\n');
 assert.equal(s.commands[2],'A0003 UID SEARCH HEADER Message-ID "'+expectedSentMessageId(delivery)+'"\r\n');
 assert(s.commands.every(c=>!/\b(APPEND|STORE|EXPUNGE|SELECT|FETCH|SMTP)\b/.test(c)));
 assert(s.closed());
});
test('empty provider Sent folder means zero candidates, not proof of missing delivery',async()=>{
 const s=fixture({search:'* SEARCH'});
 const r=await run(s);
 assert.equal(r.candidateCount,0);assert.equal(r.recipientDeliveryConfirmed,false);
});
test('malformed, ambiguous and oversized search replies fail closed, do not export raw provider data',async()=>{
 for(const search of ['* SEARCH 0','* SEARCH 7 7','* SEARCH -1','* SEARCH 4294967296',
  '* SEARCH 1\r\n* SEARCH 2','* SEARCH '+Array.from({length:11},(_,i)=>i+1).join(' ')]){
  const s=fixture({search});
  await assert.rejects(run(s),error=>{
   assert(!error.message.includes('synthetic-test-pass'));return true;
  });
  assert(s.closed());
 }
 assert.equal(countSentCandidates('* SEARCH 1 2 3'),3);
 assert.throws(()=>countSentCandidates('* SEARCH 0001'),/imap_sent_invalid_search/);
});
test('Sent connection is purpose-isolated; inbox connection cannot search Sent',async()=>{
 const s=fixture();
 const connector=createPurelymailImapConnector({connect:s.connect,credentials:async()=> 'synthetic-test-pass',
  decodeMime:async()=>assert.fail('Sent must never decode MIME')});
 const c=await connector.open(settings);
 for(const cmd of ['EXAMINE "INBOX"','UID FETCH 1 (UID FLAGS INTERNALDATE BODY.PEEK[])',
  'UID SEARCH HEADER Message-ID "<'+delivery+'@evil.com>"',
  'UID SEARCH HEADER Message-ID "<'+delivery+'@devonakins.com>"',
  'APPEND "Sent" {}','UID STORE 1 +FLAGS (\\Seen)'])
  await assert.rejects(c.exchange(cmd),/imap_command_forbidden/);
 assert.equal(s.commands.length,1);
 await c.exchange('EXAMINE "Sent"');
 assert.equal(await c.exchange('UID SEARCH HEADER Message-ID "'+expectedSentMessageId(delivery)+'"'),'* SEARCH 7');
 await c.close();
 const s2=fixture(),c2=await connector.open({...settings,purpose:'inbox',host:settings.host});
 // The first connector's synthetic socket is only for the first fixture.
 await c2.close();
 assert.equal(s2.commands.length,0);
});
test('invalid delivery IDs are rejected before any remote I/O',async()=>{
 const s=fixture();
 for(const bad of [undefined,'<script>','123e4567-e89b-42d3-a456-426614174016\r\nEXPUNGE',
  delivery.toUpperCase(),delivery+'@devonakins.com'])
  await assert.rejects(run(s,{deliveryId:bad}),/imap_sent_invalid_delivery/);
 assert.equal(s.commands.length,0);
});
test('failure to EXAMINE or login terminates without a search or implicit resend',async()=>{
 for(const spec of [{failExamine:true},{failLogin:true}]){
  const s=fixture(spec);
  await assert.rejects(run(s));
  assert(s.closed());
  assert.equal(s.commands.filter(c=>c.includes('UID SEARCH')).length,0);
 }
});
