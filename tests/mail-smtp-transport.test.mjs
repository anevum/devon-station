import test from 'node:test';
import assert from 'node:assert/strict';
import {createPurelymailSmtpTransport} from '../src/communications/mail-smtp-transport.mjs';
const id='123e4567-e89b-42d3-a456-426614174000';
const owner={installationId:'personal',principalId:'owner'};
const from='hello@devonakins.com';
const registry={mailboxes:[{id:'hello',installationId:'personal',mode:'imap',sendVerified:true}],identities:[{address:from,mailboxId:'hello',installationId:'personal',sendVerified:true}],grants:[{installationId:'personal',principalId:'owner',mailboxId:'hello',capabilities:['send']}]};
const claim={deliveryId:id,status:'claimed',approvedByOwner:true,registry,context:owner,mailboxId:'hello',from,draft:{from,to:['one@example.org','two@example.net'],subject:'Test',body:'Test'},date:new Date('2026-11-03T12:00:00Z')};
function fakeSocket(options={}){
  const commands=[],data=[];
  let closed=0,controller;
  const respond=value=>{
    const bytes=new TextEncoder().encode(value);
    for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));
  };
  const connect=(address,transport)=>{
    assert.deepEqual(address,{hostname:'smtp.purelymail.com',port:465});
    assert.deepEqual(transport,{secureTransport:'on'});
    return {opened:Promise.resolve(),
      readable:new ReadableStream({start(c){controller=c;respond(options.greeting??'220-mta.example\r\n220 Ready\r\n');}}),
      writable:new WritableStream({write(bytes){
        const value=new TextDecoder().decode(bytes);
        if(value.startsWith('From:')){
          data.push(value);
          if(options.noDataAck){controller.close();return;}
          respond(options.dataAck??'250 2.0.0 queued\r\n');return;
        }
        commands.push(value);
        if(value.startsWith('EHLO '))respond(options.ehlo??'250-mail.example\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 200000\r\n');
        else if(value.startsWith('AUTH PLAIN '))respond(options.auth??'235 authenticated\r\n');
        else if(value.startsWith('MAIL FROM:'))respond('250 sender accepted\r\n');
        else if(value.startsWith('RCPT TO:'))respond(options.rcpt??'250 recipient accepted\r\n');
        else if(value==='DATA\r\n')respond('354 enter data\r\n');
        else if(value==='QUIT\r\n')respond('221 bye\r\n');
        else throw Error('unrecognized synthetic SMTP command');
      }}),
      async close(){if(!closed){closed++;try{controller.close();}catch{}}}
    };
  };
  return {connect,commands,data,closed:()=>closed};
}
function harness(options={}){
  const s=fakeSocket(options.socket);
  let claims=0,passwordRequests=0;
  const transport=createPurelymailSmtpTransport({connect:s.connect,
    claimDelivery:async deliveryId=>{claims++;assert.equal(deliveryId,id);return options.claim===undefined?claim:options.claim;},
    credentials:async address=>{passwordRequests++;assert.equal(address,from);return 'synthetic-app-password';}});
  return {s,transport,claims:()=>claims,passwordRequests:()=>passwordRequests};
}
async function submit(h){return h.transport.submit({deliveryId:id,signal:AbortSignal.timeout(3000)});}
const hasCode=code=>error=>error?.code===code;

test('one claimed delivery submits via implicit TLS, validates SMTP sequence and closes cleanly',async()=>{
  const h=harness();const result=await submit(h);
  assert.deepEqual({accepted:result.accepted,deliveryId:result.deliveryId},{accepted:true,deliveryId:id});
  assert.equal(result.messageId,'<'+id+'@devonakins.com>');
  assert.equal(result.envelopeFrom,undefined);
  assert(h.s.commands[0]==='EHLO devonakins.com\r\n');
  assert(h.s.commands[1].startsWith('AUTH PLAIN '));
  assert.deepEqual(h.s.commands.slice(2,6),[
    'MAIL FROM:<hello@devonakins.com>\r\n','RCPT TO:<one@example.org>\r\n',
    'RCPT TO:<two@example.net>\r\n','DATA\r\n']);
  assert.equal(h.s.commands.at(-1),'QUIT\r\n');
  const wire=h.s.data[0];assert(wire.startsWith('From: '+from+'\r\n'));
  assert(wire.endsWith('\r\n.\r\n'));
  assert(!wire.includes('synthetic-app-password'));
  const login=atob(h.s.commands[1].split(' ')[2].trim());
  assert.equal(login,'\0hello@devonakins.com\0synthetic-app-password');
  assert.equal(h.s.closed(),1);
  assert.equal(h.claims(),1);assert.equal(h.passwordRequests(),1);
});

test('missing owner approval refuses before password lookup or network connection',async()=>{
  const h=harness({claim:{...claim,approvedByOwner:false}});
  await assert.rejects(submit(h),hasCode('smtp_delivery_not_approved'));
  assert.equal(h.s.closed(),0);assert.equal(h.passwordRequests(),0);
});

test('unclaimed outbox state and mismatched identifier refuse early',async()=>{
  for(const bad of [{...claim,status:'approved'},{...claim,deliveryId:'00000000-0000-0000-0000-000000000000'},null]){
    const h=harness({claim:bad});await assert.rejects(submit(h),hasCode('smtp_delivery_not_approved'));
    assert.equal(h.passwordRequests(),0);
  }
});

test('sender mismatch fails before acquiring SMTP credentials',async()=>{
  const h=harness({claim:{...claim,from:'intruder@example.org'}});
  await assert.rejects(submit(h));
  assert.equal(h.passwordRequests(),0);assert.equal(h.s.closed(),0);
});

test('server without AUTH PLAIN refuses before any authentication or mail transaction',async()=>{
  const h=harness({socket:{ehlo:'250-mail.example\r\n250-AUTH LOGIN\r\n250 SIZE 200000\r\n'}});
  await assert.rejects(submit(h),hasCode('smtp_auth_not_supported'));
  assert.deepEqual(h.s.commands,['EHLO devonakins.com\r\n']);
  assert.equal(h.s.closed(),1);
});

test('recipient rejection never sends DATA or a message body',async()=>{
  const h=harness({socket:{rcpt:'550 no such recipient\r\n'}});
  await assert.rejects(submit(h),hasCode('smtp_rejected'));
  assert(!h.s.commands.includes('DATA\r\n'));assert.equal(h.s.data.length,0);assert.equal(h.s.closed(),1);
});

test('server rejects completed DATA as a definite failure instead of an uncertain outcome',async()=>{
  const h=harness({socket:{dataAck:'550 delivery blocked\r\n'}});
  await assert.rejects(submit(h),hasCode('smtp_rejected'));
  assert.equal(h.s.data.length,1);assert.equal(h.s.closed(),1);
});

test('broken connection after message DATA is explicitly uncertain, never silently retried',async()=>{
  const h=harness({socket:{noDataAck:true}});
  await assert.rejects(submit(h),hasCode('smtp_delivery_uncertain'));
  assert.equal(h.s.data.length,1);assert.equal(h.claims(),1);assert.equal(h.s.closed(),1);
});

test('malformed multiline greeting fails closed with no AUTH or DATA',async()=>{
  const h=harness({socket:{greeting:'220-hello\r\n250 ready\r\n'}});
  await assert.rejects(submit(h),hasCode('smtp_transport_failed'));
  assert.equal(h.s.commands.length,0);assert.equal(h.s.closed(),1);
});

test('caller cannot submit without an abort signal and valid delivery UUID',async()=>{
  const h=harness();
  await assert.rejects(h.transport.submit({deliveryId:id}),hasCode('smtp_submission_invalid'));
  await assert.rejects(h.transport.submit({deliveryId:'bad',signal:AbortSignal.timeout(1000)}),hasCode('smtp_submission_invalid'));
  assert.equal(h.claims(),0);
});
