import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const client=readFileSync(new URL('../src/mail-ui.js',import.meta.url),'utf8');
const wait=()=>new Promise(resolve=>setTimeout(resolve,15));
function load(handler){
 const dom=new JSDOM('<main id="view"><section id="station-mail"></section></main>',{
  url:'https://station.example/#mail',runScripts:'outside-only',pretendToBeVisual:true
 });
 const calls=[];
 dom.window.fetch=async(path,options)=>{
   calls.push({path,method:options.method,credentials:options.credentials,redirect:options.redirect});
   return handler(path,options);
 };
 dom.window.eval(client);
 return {dom,doc:dom.window.document,calls};
}
const reply=(body,status=200,type='application/json')=>({
 ok:status>=200&&status<300,status,headers:new Headers({'Content-Type':type}),json:async()=>body
});
const sample={key:'personal/hello/7/1',from:'author@example.org',subject:'<script>alert(1)</script>',
  text:'<img src="https://tracker.invalid/pixel"> is inert plaintext',
  timestamp:'2026-11-02T15:20:00.000Z',flags:['seen']};
test('normal real read-only API response presents plain text with no remote tracking element',async()=>{
 const fixture=load(path=>path==='/api/mail/status'?
  reply({address:'hello@devonakins.com',configured:true,incomingVerified:false,outgoingEnabled:false}):
  reply({total:1,messages:[sample]}));
 await wait();
 assert.equal(fixture.calls.length,2);
 assert.deepEqual(fixture.calls.map(x=>x.path),['/api/mail/status','/api/mail/inbox?limit=50&offset=0']);
 assert(fixture.calls.every(x=>x.credentials==='same-origin'&&x.redirect==='manual'));
 const root=fixture.doc.getElementById('station-mail');
 assert(root.textContent.includes(sample.text));
 assert(root.textContent.includes(sample.subject));
 assert.equal(root.querySelectorAll('img,iframe,script,link,a[href]').length,0);
 assert.equal(root.querySelector('.mail-body').textContent,sample.text);
 assert(root.textContent.includes('Sending, drafts, HTML and attachments are not enabled'));
 fixture.dom.window.close();
});
test('without configured provider, no IMAP request or invented message is implied',async()=>{
 const fixture=load(path=>reply({address:'hello@devonakins.com',configured:false}));
 await wait();
 assert.equal(fixture.calls.length,1);
 assert(fixture.doc.getElementById('station-mail').textContent.includes('Setup incomplete'));
 assert.equal(fixture.doc.querySelector('[data-mail-action="sync"]').disabled,true);
 assert.equal(fixture.doc.querySelectorAll('.mail-message').length,0);
 fixture.dom.window.close();
});
test('sync starts only on explicit click and refreshes the authenticated mailbox list',async()=>{
 let syncs=0,items=[];
 const fixture=load((path,opts)=>{
  if(path==='/api/mail/status')return reply({address:'hello@devonakins.com',configured:true});
  if(path==='/api/mail/sync'){syncs++;assert.equal(opts.method,'POST');assert.equal(opts.body,'{}');return reply({imported:1,updated:0,hasMore:false});}
  return reply({total:items.length,messages:items});
 });
 await wait();
 assert.equal(syncs,0);
 items=[sample];
 fixture.doc.querySelector('[data-mail-action="sync"]').click();
 await wait();
 assert.equal(syncs,1);
 assert.equal(fixture.doc.querySelectorAll('.mail-message').length,1);
 assert(fixture.doc.querySelector('[role="status"]').textContent.includes('1 new, 0 updated'));
 fixture.dom.window.close();
});
test('unexpected response and expired owner session fail visibly without rendering mail',async()=>{
 const fixture=load(()=>reply({error:'owner_sign_in_required'},401));
 await wait();
 const root=fixture.doc.getElementById('station-mail');
 assert(root.textContent.includes('Your owner session has expired'));
 assert.equal(root.querySelectorAll('.mail-message').length,0);
 fixture.dom.window.close();
});
test('malformed payload is refused without injecting sender-provided element properties',async()=>{
 const fixture=load(path=>path==='/api/mail/status'?
  reply({address:'hello@devonakins.com',configured:true}):
  reply({total:1,messages:[{...sample,text:123}]}));
 await wait();
 assert(fixture.doc.querySelector('[role="status"]').textContent.includes('Unable to read'));
 assert.equal(fixture.doc.querySelectorAll('.mail-message').length,0);
 fixture.dom.window.close();
});

async function ready(handler){
 const x=load((path,options)=>path==='/api/mail/status'?
  reply({address:'hello@devonakins.com',configured:true}):handler(path,options));
 await wait();return x;
}
const click=(x,action)=>x.doc.querySelector('[data-mail-action="'+action+'"]').click();
test('explicit catch-up stops at provider snapshot, counts only confirmed batches and never auto-starts',async()=>{
 let posts=0;
 const x=await ready(path=>path==='/api/mail/sync'?
  reply({imported:++posts===1?10:2,updated:0,hasMore:posts<2}):reply({total:0,messages:[]}));
 try{
  assert.equal(posts,0);click(x,'catchup');await wait();
  assert.equal(posts,2);const text=x.doc.querySelector('[role="status"]').textContent;
  assert(text.includes('2 batch(es) confirmed: 12 new, 0 updated'));
  assert(text.includes('Caught up to the provider snapshot'));
  await wait();assert.equal(posts,2);
 }finally{x.dom.window.close();}
});
test('catch-up pauses after ten batches with explicit remaining-work messaging',async()=>{
 let posts=0;
 const x=await ready(path=>{
  if(path==='/api/mail/sync'){posts++;return reply({imported:0,updated:0,hasMore:true});}
  return reply({total:0,messages:[]});
 });
 try{
  click(x,'catchup');await wait();
  assert.equal(posts,10);assert(x.doc.querySelector('[role="status"]').textContent.includes('More catch-up remains'));
  assert.equal(x.doc.querySelector('[data-mail-action="sync"]').textContent,'Sync Next Batch');
  await wait();assert.equal(posts,10);
 }finally{x.dom.window.close();}
});
test('stop during an in-flight batch waits for confirmation and prevents another POST',async()=>{
 let finish,posts=0;
 const pending=new Promise(resolve=>{finish=resolve;});
 const x=await ready(path=>{
  if(path==='/api/mail/sync'){posts++;return pending;}
  return reply({total:1,messages:[sample]});
 });
 try{
  click(x,'catchup');assert.equal(posts,1);click(x,'stop');
  assert(x.doc.querySelector('[role="status"]').textContent.includes('Will stop after this batch'));
  assert.equal(x.doc.querySelector('[data-mail-action="sync"]').disabled,true);
  finish(reply({imported:1,updated:0,hasMore:true}));await wait();
  assert.equal(posts,1);assert(x.doc.querySelector('[role="status"]').textContent.includes('Stopped after the current batch'));
  assert.equal(x.doc.querySelectorAll('.mail-message').length,1);
 }finally{x.dom.window.close();}
});
test('navigation stops catch-up after current commit and returning does not restart it',async()=>{
 let finish,posts=0;const pending=new Promise(resolve=>{finish=resolve;});
 const x=await ready(path=>{
  if(path==='/api/mail/sync'){posts++;return pending;}
  return reply({total:0,messages:[]});
 });
 try{
  click(x,'catchup');x.dom.window.StationMail.mounted('settings');
  x.doc.getElementById('station-mail').remove();
  finish(reply({imported:0,updated:0,hasMore:true}));await wait();assert.equal(posts,1);
  const root=x.doc.createElement('section');root.id='station-mail';x.doc.getElementById('view').append(root);
  x.dom.window.StationMail.mounted('mail');await wait();assert.equal(posts,1);
  assert(root.textContent.includes('Stopped after the current batch'));
 }finally{x.dom.window.close();}
});
test('partial failure retains confirmed counts and refuses an unverified continuation flag',async()=>{
 for(const failure of ['network','invalid-progress']){
  let posts=0;
  const x=await ready(path=>{
   if(path==='/api/mail/sync'){
    if(++posts===1)return reply({imported:3,updated:0,hasMore:true});
    if(failure==='network')throw Error('lost response');
    return reply({imported:4,updated:0,hasMore:'false'});
   }
   return reply({total:1,messages:[sample]});
  });
  try{
   click(x,'catchup');await wait();assert.equal(posts,2);
   const text=x.doc.querySelector('[role="status"]').textContent;
   assert(text.includes('1 batch(es) confirmed, 3 new messages saved'));
   assert(text.includes('unconfirmed request may still have committed'));
   assert(!text.includes('Caught up'));assert.equal(x.doc.querySelectorAll('.mail-message').length,1);
  }finally{x.dom.window.close();}
 }
});

test('owner-session expiry during catch-up stops requests and clears cached private mail',async()=>{
 let posts=0;
 const x=await ready(path=>{
  if(path==='/api/mail/sync'){posts++;return reply({error:'owner_sign_in_required'},401);}
  return reply({total:1,messages:[sample]});
 });
 try{
  assert.equal(x.doc.querySelectorAll('.mail-message').length,1);click(x,'catchup');await wait();
  assert.equal(posts,1);assert.equal(x.doc.querySelectorAll('.mail-message').length,0);
  assert(x.doc.querySelector('[role="status"]').textContent.includes('Owner session expired'));
 }finally{x.dom.window.close();}
});

test('reloading cached inbox after an uncertain batch never issues another provider POST',async()=>{
 let posts=0,reads=0;
 const x=await ready(path=>{
  if(path==='/api/mail/sync'){posts++;throw Error('lost confirmation');}
  reads++;return reply({total:1,messages:[sample]});
 });
 try{
  click(x,'sync');await wait();assert.equal(posts,1);
  click(x,'reload');await wait();assert.equal(posts,1);assert.equal(reads,2);
  assert.equal(x.doc.querySelectorAll('.mail-message').length,1);
 }finally{x.dom.window.close();}
});
