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
function setup({outgoing=true,submitFails=false,duplicateDraft=false,outboxReadFails=false,pendingDelete=false,saveLocked=false,sentProbeMalformed=false,archiveDeferred=false}={}){
 const dom=new JSDOM('<main><section id="station-mail"></section></main>',{
  url:'https://station.example/#mail',runScripts:'outside-only'
 });
 const ids=[savedId,operationId,deliveryId];let cursor=0;
 Object.defineProperty(dom.window.crypto,'randomUUID',{value:()=>ids[cursor++],configurable:true});
 const calls=[],records=[],outbox=[],prompts=[];let resolveArchive=()=>{};
 let confirmation=false;
 dom.window.confirm=message=>{prompts.push(message);return confirmation;};
 const archiveRows=()=>outbox.filter(x=>x.state==='accepted'&&x.draftId).map(x=>({
  deliveryId:x.deliveryId,draftId:x.draftId,draftRevision:x.draftRevision,
  acceptedAt:x.updatedAt,state:'accepted'})).sort((a,b)=>
   b.acceptedAt.localeCompare(a.acceptedAt)||b.deliveryId.localeCompare(a.deliveryId));
 const reply=(value,status=200)=>({
  ok:status>=200&&status<300,status,
  headers:new Headers({'Content-Type':'application/json'}),json:async()=>value
 });
 dom.window.fetch=async(path,options)=>{
  const body=options.body?JSON.parse(options.body):undefined;
  calls.push({path,body,method:options.method,credentials:options.credentials,redirect:options.redirect});
  if(path==='/api/mail/status')
   return reply({configured:false,draftsEnabled:true,outgoingEnabled:outgoing,outboxEnabled:true,address:'hello@devonakins.com'});
  if(path==='/api/mail/drafts')return reply({drafts:records.map(copy)});
  if(path==='/api/mail/drafts/create'){
   const row={id:body.id,revision:1,from:'hello@devonakins.com',
    to:[],subject:'',body:'',updatedAt:'2026-11-03T16:00:00Z'};
   records.push(row);return reply({draft:copy(row)});
  }
  if(path==='/api/mail/drafts/save'){
   if(saveLocked&&outbox.some(row=>row.draftId===savedId))
    return reply({error:'mail_draft_delivery_locked'},409);
   const updated={...records[0],revision:2,to:body.to,subject:body.subject,body:body.body};
   records[0]=updated;return reply({draft:copy(updated)});
  }
  if(path==='/api/mail/drafts/delete'){
   assert.equal(body.id,savedId);assert.equal(body.revision,2);
   if(pendingDelete)return reply({error:'mail_draft_pending_delivery'},409);
   records.splice(0,1);return reply({deleted:true});
  }
  if(path==='/api/mail/outbox/prepare'){
   assert(outgoing,'UI may never prepare when outgoing is disabled');
   assert.equal(body.approvedByOwner,true);
   assert.deepEqual(Object.keys(body).sort(),['approvedByOwner','deliveryId','draftId','draftRevision']);
   assert.equal(body.deliveryId,deliveryId);
   assert.equal(body.draftId,savedId);
   assert.equal(body.draftRevision,2);
   assert.equal(body.draft,undefined,'browser may never submit message text to prepare');
   if(duplicateDraft)return reply({error:'outbox_draft_already_prepared'},409);
   outbox.push({deliveryId:body.deliveryId,draftId:body.draftId,draftRevision:body.draftRevision,state:'queued',createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:00:00.000Z'});
   return reply({receipt:{deliveryId:body.deliveryId,draftId:body.draftId,draftRevision:2,state:'queued'},sendingEnabled:true});
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
  if(path==='/api/mail/outbox/archive'){
   assert.equal(options.method,'GET');
   const rows=archiveRows();
   return reply({entries:rows.slice(0,100),hasMore:rows.length>100,providerIndependent:true});
  }
  if(path==='/api/mail/outbox/archive/page'){
   assert.equal(options.method,'POST');
   assert.deepEqual(Object.keys(body),['before']);
   assert.deepEqual(Object.keys(body.before).sort(),['acceptedAt','deliveryId']);
   const rows=archiveRows().filter(x=>x.acceptedAt<body.before.acceptedAt||
    (x.acceptedAt===body.before.acceptedAt&&x.deliveryId<body.before.deliveryId));
   return reply({entries:rows.slice(0,100),hasMore:rows.length>100,providerIndependent:true});
  }
  if(path==='/api/mail/outbox/archive/view'){
   if(archiveDeferred)await new Promise(resolve=>{resolveArchive=resolve;});
   assert.equal(options.method,'POST');assert.deepEqual(Object.keys(body),['deliveryId']);
   const row=outbox.find(x=>x.deliveryId===body.deliveryId&&x.state==='accepted'&&x.draftId);
   if(!row)return reply({error:'mail_sent_archive_not_found'},404);
   return reply({archive:{deliveryId:row.deliveryId,draftId:row.draftId,
    draftRevision:row.draftRevision,state:'accepted',from:'hello@devonakins.com',
    to:['friend@example.test'],subject:'<script>alert(1)</script>',
    body:'<img src="https://pixel.example.test"> inert text',messageId:'<'+row.deliveryId+'@devonakins.com>',
    acceptedAt:row.updatedAt,providerCopyConfirmed:false,
    recipientDeliveryConfirmed:false},providerIndependent:true});
  }
  if(path==='/api/mail/outbox/sent-check'){
   assert.equal(options.method,'POST');assert.deepEqual(Object.keys(body),['deliveryId']);
   assert(outbox.some(row=>row.deliveryId===body.deliveryId&&row.draftId));
   return reply({deliveryId:body.deliveryId,sentFolderExamined:true,
    candidateCount:sentProbeMalformed?'invalid':0,exactHeaderVerified:false,
    providerCopyConfirmed:false,recipientDeliveryConfirmed:false,automaticRetry:false});
  }
  if(path==='/api/mail/outbox')return outboxReadFails?reply({error:'unavailable'},503):reply({outbox:outbox.map(row=>({...row})),sendingEnabled:outgoing});
  throw Error('Unexpected external URL '+path);
 };
 dom.window.eval(mail);dom.window.eval(drafts);
 return {dom,calls,records,outbox,prompts,doc:dom.window.document,
  resolveArchive:()=>resolveArchive(),setConfirm:x=>{confirmation=x;}};
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

test('fresh browser instance inspects durable receipts with sending disabled, without retransmitting',async()=>{
 const x=setup({outgoing:false});
 x.outbox.push({deliveryId,state:'uncertain',createdAt:'2026-11-03T16:00:00.000Z',
  updatedAt:'2026-11-03T16:01:00.000Z'});
 await wait();
 assert.equal(count(x,'/api/mail/outbox'),0,'status reads must be explicitly requested');
 assert.equal(x.doc.querySelector('[data-mail-draft-action="send-prepare"]'),null);
 const inspect=x.doc.querySelector('[data-mail-draft-action="outbox-refresh"]');assert(inspect);
 inspect.click();await wait();
 const history=x.doc.querySelector('[aria-label="Durable outbox status history"]');
 assert(history);assert(history.textContent.includes('Delivery uncertain'));
 assert(history.textContent.includes(deliveryId));
 assert(history.textContent.includes('Do not retry'));
 assert.equal(history.querySelectorAll('a[href],button,script,img,iframe').length,0);
 assert.equal(count(x,'/api/mail/outbox'),1);
 assert.equal(count(x,'/api/mail/outbox/prepare'),0);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 x.dom.window.close();
});

test('linked delivery receipt shows expected Message-ID without asserting delivery or sending',async()=>{
 const x=setup({outgoing:false});
 const row={deliveryId,draftId:savedId,draftRevision:2,state:'accepted',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'};
 x.outbox.push(row);
 await wait();
 const refresh=async()=>{
  const inspect=x.doc.querySelector('[data-mail-draft-action="outbox-refresh"]');assert(inspect);
  inspect.click();await wait();
  return x.doc.querySelector('[aria-label="Durable outbox status history"]');
 };
 for(const state of ['accepted','claimed','uncertain']){
  x.outbox[0].state=state;
  const history=await refresh();
  assert(history.textContent.includes('Expected Message-ID <'+deliveryId+'@devonakins.com>'));
  assert(history.textContent.includes('not proof of delivery'));
  assert.equal(history.querySelectorAll('a[href],script,img,iframe').length,0);
  const checks=history.querySelectorAll('button');
  assert.deepEqual([...checks].map(x=>x.dataset.mailDraftAction).sort(),
   state==='accepted'?['archive-open','sent-check']:['sent-check']);
  assert.equal(count(x,'/api/mail/outbox/archive/view'),0,'archive is never fetched automatically');
  assert.equal(count(x,'/api/mail/outbox/sent-check'),0,'must not call provider without owner click');
 }
 x.outbox[0]={...row,state:'queued'};
 assert(!(await refresh()).textContent.includes('Expected Message-ID'));
 x.outbox[0]={deliveryId,state:'accepted',createdAt:row.createdAt,updatedAt:row.updatedAt};
 assert(!(await refresh()).textContent.includes('Expected Message-ID'));
 assert.equal(count(x,'/api/mail/outbox/prepare'),0);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 x.dom.window.close();
});

test('owner-triggered Sent-copy inspection with SMTP disabled is informational and never transmits',async()=>{
 const x=setup({outgoing:false});
 x.outbox.push({deliveryId,draftId:savedId,draftRevision:2,state:'accepted',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 await wait();
 x.doc.querySelector('[data-mail-draft-action="outbox-refresh"]').click();await wait();
 const inspect=x.doc.querySelector('[data-mail-draft-action="sent-check"]');assert(inspect);
 inspect.click();await wait();
 const history=x.doc.querySelector('[aria-label="Durable outbox status history"]');
 assert(history.textContent.includes('Read-only Sent search found 0 candidates'));
 assert(history.textContent.includes('zero candidates does not mean sending failed'));
 assert.equal(count(x,'/api/mail/outbox/sent-check'),1);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 assert.equal(count(x,'/api/mail/outbox/prepare'),0);
 assert.equal(history.querySelectorAll('script,img,iframe,a[href]').length,0);
 x.dom.window.close();
});
test('accepted receipt renders encrypted archive only on click, not as executable HTML or a resend',async()=>{
 const x=setup({outgoing:false});
 x.outbox.push({deliveryId,draftId:savedId,draftRevision:2,state:'accepted',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 await wait();x.doc.querySelector('[data-mail-draft-action="outbox-refresh"]').click();await wait();
 assert.equal(count(x,'/api/mail/outbox/archive/view'),0);
 x.doc.querySelector('[data-mail-draft-action="archive-open"]').click();await wait();
 const panel=x.doc.querySelector('[aria-label="Decrypted Sent copy — owner only"]');
 assert(panel);assert(panel.textContent.includes('<img src="https://pixel.example.test">'));
 assert(panel.textContent.includes('<script>alert(1)</script>'));
 assert.equal(panel.querySelectorAll('img,iframe,script,a[href]').length,0);
 assert(panel.textContent.includes('not confirmed'));
 assert.equal(count(x,'/api/mail/outbox/archive/view'),1);
 for(const path of ['/api/mail/outbox/sent-check','/api/mail/outbox/prepare','/api/mail/outbox/submit'])
  assert.equal(count(x,path),0);
 x.doc.querySelector('[data-mail-draft-action="archive-close"]').click();await wait();
 assert.equal(x.doc.querySelector('[aria-label="Decrypted Sent copy — owner only"]'),null);
 x.dom.window.close();
});
test('owner can browse encrypted Sent metadata independently from outbox history',async()=>{
 const x=setup({outgoing:false});
 x.outbox.push({deliveryId,draftId:savedId,draftRevision:2,state:'accepted',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 await wait();
 assert.equal(count(x,'/api/mail/outbox/archive'),0);
 x.doc.querySelector('[data-mail-draft-action="archive-refresh"]').click();await wait();
 const section=x.doc.querySelector('[aria-label="Encrypted Sent history"]');
 assert(section);assert(section.textContent.includes(deliveryId));
 assert(!section.textContent.includes('pixel.example.test'),'listing must exclude private message body');
 assert.equal(count(x,'/api/mail/outbox/archive'),1);
 assert.equal(count(x,'/api/mail/outbox/archive/view'),0,'archive body must remain on-demand');
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 x.doc.querySelector('[data-mail-draft-action="archive-open"]').click();await wait();
 const opened=x.doc.querySelector('[aria-label="Encrypted Sent history"] [aria-label="Decrypted Sent copy — owner only"]');
 assert(opened);assert(opened.textContent.includes('pixel.example.test'));
 assert.equal(opened.querySelectorAll('img,script,iframe,a[href]').length,0);
 assert.equal(count(x,'/api/mail/outbox/prepare'),0);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 x.dom.window.close();
});
test('leaving Mail clears an already decrypted Sent copy without contacting a provider',async()=>{
 const x=setup({outgoing:false});
 x.outbox.push({deliveryId,draftId:savedId,draftRevision:2,state:'accepted',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 await wait();x.doc.querySelector('[data-mail-draft-action="outbox-refresh"]').click();await wait();
 x.doc.querySelector('[data-mail-draft-action="archive-open"]').click();await wait();
 assert(x.doc.querySelector('[aria-label="Decrypted Sent copy — owner only"]'));
 x.dom.window.location.hash='#settings';
 await wait();
 assert.equal(x.doc.querySelector('[aria-label="Decrypted Sent copy — owner only"]'),null);
 assert.equal(count(x,'/api/mail/outbox/archive/view'),1);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 x.dom.window.close();
});
test('Sent history loads older 100-row pages by stable cursor without duplicates or SMTP',async()=>{
 const x=setup({outgoing:false});
 for(let i=0;i<105;i++)x.outbox.push({
  deliveryId:'a0000000-0000-4000-8000-'+String(i+10).padStart(12,'0'),
  draftId:savedId,draftRevision:2,state:'accepted',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 await wait();x.doc.querySelector('[data-mail-draft-action="archive-refresh"]').click();await wait();
 let history=x.doc.querySelector('[aria-label="Encrypted Sent history"]');
 assert.equal(history.querySelectorAll('li').length,100);
 assert(history.querySelector('[data-mail-draft-action="archive-more"]'));
 assert.equal(count(x,'/api/mail/outbox/archive/page'),0);
 history.querySelector('[data-mail-draft-action="archive-more"]').click();await wait();
 history=x.doc.querySelector('[aria-label="Encrypted Sent history"]');
 assert.equal(history.querySelectorAll('li').length,105);
 assert.equal(history.querySelector('[data-mail-draft-action="archive-more"]'),null);
 const ids=[...history.querySelectorAll('li')].map(li=>li.querySelector('span.mail-draft-notice')?.textContent)
  .filter(x=>x?.startsWith('Delivery '));
 assert.equal(ids.length,105);assert.equal(new Set(ids).size,105);
 assert.equal(count(x,'/api/mail/outbox/archive/page'),1);
 assert.equal(count(x,'/api/mail/outbox/archive/view'),0);
 assert.equal(count(x,'/api/mail/outbox/prepare'),0);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 x.dom.window.close();
});
test('hidden mobile tab discards archive body even when in-flight response arrives later',async()=>{
 const x=setup({outgoing:false,archiveDeferred:true});
 x.outbox.push({deliveryId,draftId:savedId,draftRevision:2,state:'accepted',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 await wait();x.doc.querySelector('[data-mail-draft-action="outbox-refresh"]').click();await wait();
 x.doc.querySelector('[data-mail-draft-action="archive-open"]').click();await wait();
 Object.defineProperty(x.doc,'visibilityState',{configurable:true,value:'hidden'});
 x.doc.dispatchEvent(new x.dom.window.Event('visibilitychange'));
 x.resolveArchive();await wait();
 assert.equal(x.doc.querySelector('[aria-label="Decrypted Sent copy — owner only"]'),null);
 assert.equal(count(x,'/api/mail/outbox/archive/view'),1);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 x.dom.window.close();
});
test('malformed Sent probe results fail closed without implying delivery state',async()=>{
 const x=setup({outgoing:false,sentProbeMalformed:true});
 x.outbox.push({deliveryId,draftId:savedId,draftRevision:2,state:'uncertain',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 await wait();x.doc.querySelector('[data-mail-draft-action="outbox-refresh"]').click();await wait();
 x.doc.querySelector('[data-mail-draft-action="sent-check"]').click();await wait();
 const history=x.doc.querySelector('[aria-label="Durable outbox status history"]');
 assert(history.textContent.includes('Sent copy could not be inspected'));
 assert(!history.textContent.includes('Read-only Sent search found'));
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 x.dom.window.close();
});
test('malformed stored receipt fails closed and never becomes executable DOM',async()=>{
 const x=setup({outgoing:false});
 x.outbox.push({deliveryId,state:'accepted',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 await wait();
 x.doc.querySelector('[data-mail-draft-action="outbox-refresh"]').click();await wait();
 assert(x.doc.querySelector('[aria-label="Durable outbox status history"]').textContent.includes(deliveryId));
 x.outbox.splice(0,1,{deliveryId:'<script>injected()</script>',state:'accepted',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 x.doc.querySelector('[data-mail-draft-action="outbox-refresh"]').click();await wait();
 const history=x.doc.querySelector('[aria-label="Durable outbox status history"]');
 assert(history.textContent.includes('could not be verified'));
 assert(!history.textContent.includes('injected()'));
 assert(!history.textContent.includes(deliveryId),'unverified read must clear stale status');
 assert.equal(history.querySelectorAll('script,img,iframe,a[href]').length,0);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 x.dom.window.close();
});

test('preparing an already-linked saved revision never opens SMTP or creates another delivery',async()=>{
 const x=await savedDraft(setup({duplicateDraft:true}));
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 x.doc.querySelector('[data-mail-draft-action="send-prepare"]').click();await wait();
 assert.equal(count(x,'/api/mail/outbox/prepare'),1);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 assert.equal(x.outbox.length,0);
 assert(x.doc.querySelector('#mail-drafts').textContent.includes('already has a durable delivery'));
 assert.equal(x.doc.querySelector('[data-mail-draft-action="send-submit"]'),null);
 x.dom.window.close();
});

test('saved draft with a prior delivery revision is blocked even after another save',async()=>{
 const x=await savedDraft(setup());
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 x.outbox.push({deliveryId,draftId:savedId,draftRevision:1,state:'accepted',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 const prepare=x.doc.querySelector('[data-mail-draft-action="send-prepare"]');assert(prepare);
 prepare.click();await wait();
 assert.equal(count(x,'/api/mail/outbox'),1);
 assert.equal(count(x,'/api/mail/outbox/prepare'),0,'cannot prepare a different revision of a previously attempted draft');
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 assert(x.doc.querySelector('#mail-drafts').textContent.includes('delivery already exists'));
 const inspect=x.doc.querySelector('[data-mail-draft-action="outbox-refresh"]');assert(inspect);
 inspect.click();await wait();
 assert(x.doc.querySelector('#mail-drafts').textContent.includes('Recorded delivery'));
 const entry=x.doc.querySelector('[data-mail-draft-id="'+savedId+'"]');assert(entry);
 assert(entry.textContent.includes('Accepted by SMTP'));
 assert.equal(x.doc.querySelector('[data-mail-draft-action="send-prepare"]').disabled,true);
 assert.equal(x.doc.querySelectorAll('script,img,iframe').length,0);
 x.dom.window.close();
});

test('prior delivery lookup failures prevent prepare and do not allocate a delivery ID',async()=>{
 const x=await savedDraft(setup({outboxReadFails:true}));
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 const prepare=x.doc.querySelector('[data-mail-draft-action="send-prepare"]');assert(prepare);
 prepare.click();await wait();
 assert.equal(count(x,'/api/mail/outbox'),1);
 assert.equal(count(x,'/api/mail/outbox/prepare'),0);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 assert.equal(x.outbox.length,0);
 assert(x.doc.querySelector('#mail-drafts').textContent.includes('Could not verify prior delivery'));
 x.dom.window.close();
});

test('outbox history rejects half-linked receipts and never enables resend',async()=>{
 const x=await savedDraft(setup());
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 x.outbox.push({deliveryId,draftId:savedId,state:'queued',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 x.doc.querySelector('[data-mail-draft-action="send-prepare"]').click();await wait();
 assert.equal(count(x,'/api/mail/outbox/prepare'),0);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 assert(x.doc.querySelector('#mail-drafts').textContent.includes('Could not verify prior delivery'));
 x.dom.window.close();
});


test('unresolved outgoing delivery blocks draft deletion without losing saved content',async()=>{
 const x=await savedDraft(setup({pendingDelete:true}));
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 const previous=x.records[0];
 x.setConfirm(true);
 x.doc.querySelector('[data-mail-draft-action="delete"]').click();await wait();
 assert.equal(count(x,'/api/mail/drafts/delete'),1);
 assert.equal(x.records.length,1);
 assert.equal(x.records[0],previous);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 assert(x.doc.querySelector('#mail-drafts').textContent.includes('Deletion is blocked'));
 assert(x.prompts[0].includes('does not cancel queued mail'));
 x.dom.window.close();
});

test('saved draft cannot be overwritten after a linked SMTP attempt on another session',async()=>{
 const x=await savedDraft(setup({saveLocked:true}));
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 const original=x.records[0].body;
 x.outbox.push({deliveryId,draftId:savedId,draftRevision:2,state:'uncertain',
  createdAt:'2026-11-03T16:00:00.000Z',updatedAt:'2026-11-03T16:01:00.000Z'});
 update(x,'body','My new changes remain local and are not transmitted');
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 assert.equal(count(x,'/api/mail/drafts/save'),2,'server must explicitly reject the new operation');
 assert.equal(x.records[0].body,original,'server copy is immutable');
 assert.equal(count(x,'/api/mail/outbox/prepare'),0);
 assert.equal(count(x,'/api/mail/outbox/submit'),0);
 assert(x.doc.querySelector('#mail-drafts').textContent.includes('Edits are blocked'));
 assert(x.doc.querySelector('[data-mail-draft-field="body"]').value.includes('My new changes remain local'));
 x.dom.window.close();
});
