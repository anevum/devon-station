import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const mail=readFileSync(new URL('../src/mail-ui.js',import.meta.url),'utf8');
const drafts=readFileSync(new URL('../src/mail-drafts-ui.js',import.meta.url),'utf8');
const savedId='d43f536a-e5c6-4683-b241-eb9ad1dbf680';
const operationId='2faf4ca1-324c-4c40-a0aa-b0cbe51b7fc4';
const deliveryId='123e4567-e89b-42d3-a456-426614174016';
const wait=()=>new Promise(resolve=>setTimeout(resolve,30));
const copy=d=>({...d,to:d.to.slice()});
function setup({outgoing=true,submitFails=false}={}){
 const dom=new JSDOM('<main><section id="station-mail"></section></main>',{
  url:'https://station.example/#mail',runScripts:'outside-only'
 });
 const ids=[savedId,operationId,deliveryId];let cursor=0;
 Object.defineProperty(dom.window.crypto,'randomUUID',{value:()=>ids[cursor++],configurable:true});
 const calls=[],records=[],outbox=[],prompts=[];
 let confirmation=false;
 dom.window.confirm=message=>{prompts.push(message);return confirmation;};
 const reply=(value,status=200)=>({
  ok:status>=200&&status<300,status,
  headers:new Headers({'Content-Type':'application/json'}),json:async()=>value
 });
 dom.window.fetch=async(path,options)=>{
  const body=options.body?JSON.parse(options.body):undefined;
  calls.push({path,body,method:options.method,credentials:options.credentials,redirect:options.redirect});
  if(path==='/api/mail/status')
   return reply({configured:false,draftsEnabled:true,outgoingEnabled:outgoing,address:'hello@devonakins.com'});
  if(path==='/api/mail/drafts')return reply({drafts:records.map(copy)});
  if(path==='/api/mail/drafts/create'){
   const row={id:body.id,revision:1,from:'hello@devonakins.com',
    to:[],subject:'',body:'',updatedAt:'2026-11-03T16:00:00Z'};
   records.push(row);return reply({draft:copy(row)});
  }
  if(path==='/api/mail/drafts/save'){
   const updated={...records[0],revision:2,to:body.to,subject:body.subject,body:body.body};
   records[0]=updated;return reply({draft:copy(updated)});
  }
  if(path==='/api/mail/outbox/prepare'){
   assert(outgoing,'UI may never prepare when outgoing is disabled');
   assert.equal(body.approvedByOwner,true);
   assert.deepEqual(Object.keys(body).sort(),['approvedByOwner','deliveryId','draft']);
   assert.equal(body.deliveryId,deliveryId);
   assert.equal(body.draft.from,undefined);
   outbox.push({deliveryId:body.deliveryId,state:'queued'});
   return reply({receipt:{deliveryId:body.deliveryId,state:'queued'},sendingEnabled:true});
  }
  if(path==='/api/mail/outbox/submit'){
   assert.equal(body.confirmedByOwner,true);
   assert.deepEqual(Object.keys(body).sort(),['confirmedByOwner','deliveryId']);
   assert.equal(body.deliveryId,deliveryId);
   outbox[0].state=submitFails?'uncertain':'accepted';
   if(submitFails)return reply({error:'mail_send_operation_failed',deliveryUncertain:true},502);
   return reply({receipt:{deliveryId:body.deliveryId,state:'accepted'},
    deliveryConfirmed:false,automaticRetry:false});
  }
  if(path==='/api/mail/outbox')return reply({outbox:outbox.map(row=>({...row})),sendingEnabled:outgoing});
  throw Error('Unexpected external URL '+path);
 };
 dom.window.eval(mail);dom.window.eval(drafts);
 return {dom,calls,records,outbox,prompts,doc:dom.window.document,setConfirm:x=>{confirmation=x;}};
}
const count=(x,path)=>x.calls.filter(call=>call.path===path).length;
function update(x,name,text){
 const input=x.doc.querySelector('[data-mail-draft-field="'+name+'"]');
 assert(input,name);
 input.value=text;input.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
}
async function savedDraft(x){
 await wait();
 const create=x.doc.querySelector('[data-mail-draft-action="create"]');assert(create);
 create.click();await wait();
 update(x,'to','friend@example.test');
 update(x,'subject','<script>alert(1)</script>');
 update(x,'body','<img src="https://pixel.test/track"> visible as inert text');
 return x;
}
test('disabled outgoing flag never renders a send or preparation control',async()=>{
 const x=await savedDraft(setup({outgoing:false}));
 assert.equal(x.doc.querySelector('[data-mail-draft-action="send-prepare"]'),null);
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 assert.equal(x.doc.querySelector('[data-mail-draft-action="send-prepare"]'),null);
 assert.equal(count(x,'/api/mail/outbox/prepare'),0);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 x.dom.window.close();
});
test('saved revision, inert preview, two explicit actions and one SMTP attempt',async()=>{
 const x=await savedDraft(setup());
 const disabled=x.doc.querySelector('[data-mail-draft-action="send-prepare"]');
 assert(disabled);assert.equal(disabled.disabled,true,'unsaved edits cannot enter send review');
 assert.equal(count(x,'/api/mail/outbox/prepare'),0);
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 const prepare=x.doc.querySelector('[data-mail-draft-action="send-prepare"]');
 assert.equal(prepare.disabled,false);assert.equal(count(x,'/api/mail/outbox/submit'),0);
 prepare.click();await wait();
 assert.equal(count(x,'/api/mail/outbox/prepare'),1);
 assert.equal(count(x,'/api/mail/outbox/submit'),0,'preparation must not send');
 const review=x.doc.querySelector('[aria-label="Review outgoing email before submission"]');
 assert(review);assert(review.textContent.includes('<script>alert(1)</script>'));
 assert(review.textContent.includes('<img src="https://pixel.test/track">'));
 assert.equal(review.querySelectorAll('script,img,iframe,a[href]').length,0);
 assert.equal(x.doc.querySelector('[data-mail-draft-field="body"]').disabled,true);
 assert.equal(x.doc.querySelector('[data-mail-draft-action="save"]').disabled,true);
 x.doc.querySelector('[data-mail-draft-action="send-submit"]').click();await wait();
 assert.equal(x.prompts.length,1,'second confirmation must be presented');
 assert.equal(count(x,'/api/mail/outbox/submit'),0,'denied second confirmation cannot send');
 x.setConfirm(true);
 x.doc.querySelector('[data-mail-draft-action="send-submit"]').click();await wait();
 assert.equal(count(x,'/api/mail/outbox/submit'),1);
 assert.equal(x.outbox[0].state,'accepted');
 assert(x.doc.querySelector('#mail-drafts').textContent.includes('recipient delivery is not verified'));
 assert.equal(x.doc.querySelector('[data-mail-draft-action="send-submit"]'),null);
 x.doc.querySelector('[data-mail-draft-action="send-status"]').click();await wait();
 assert.equal(count(x,'/api/mail/outbox/submit'),1,'checking status must not retransmit');
 assert(x.calls.every(call=>call.credentials==='same-origin'&&call.redirect==='manual'));
 assert.equal(x.records[0].revision,2,'original saved draft must be retained for explicit Sent reconciliation');
 x.dom.window.close();
});
test('uncertain server outcome forbids retries and reports durable outbox state',async()=>{
 const x=await savedDraft(setup({submitFails:true}));
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 x.doc.querySelector('[data-mail-draft-action="send-prepare"]').click();await wait();
 x.setConfirm(true);
 x.doc.querySelector('[data-mail-draft-action="send-submit"]').click();await wait();
 assert.equal(count(x,'/api/mail/outbox/submit'),1);
 assert.equal(x.doc.querySelector('[data-mail-draft-action="send-submit"]'),null);
 assert(x.doc.querySelector('#mail-drafts').textContent.includes('Never retry'));
 x.doc.querySelector('[data-mail-draft-action="send-status"]').click();await wait();
 assert.equal(x.outbox[0].state,'uncertain');
 assert(x.doc.querySelector('#mail-drafts').textContent.includes('uncertain'));
 assert.equal(count(x,'/api/mail/outbox/submit'),1);
 assert.equal(count(x,'/api/mail/outbox/prepare'),1);
 x.dom.window.close();
});
