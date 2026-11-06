import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const mail=readFileSync(new URL('../src/mail-ui.js',import.meta.url),'utf8');
const drafts=readFileSync(new URL('../src/mail-drafts-ui.js',import.meta.url),'utf8');
const id='d43f536a-e5c6-4683-b241-eb9ad1dbf680';
const op='2faf4ca1-324c-4c40-a0aa-b0cbe51b7fc4';
const wait=()=>new Promise(resolve=>setTimeout(resolve,20));
function setup({conflict=false,saveErrors=[],messages=[],createFailure=false}={}){
 const dom=new JSDOM('<main><section id="station-mail"></section></main>',{url:'https://station.example/#mail',runScripts:'outside-only'});
 Object.defineProperty(dom.window.crypto,'randomUUID',{value:(()=>{let n=0;return ()=>++n===1?id:n===2?op:'2faf4ca1-324c-4c40-a0aa-'+String(n).padStart(12,'0')})(),configurable:true});
 const calls=[],records=[];
 dom.window.fetch=async(path,options)=>{
  calls.push({path,method:options.method,credentials:options.credentials,
   body:options.body?JSON.parse(options.body):undefined});
  const reply=(value,status=200)=>({ok:status>=200&&status<300,status,
   headers:new Headers({'Content-Type':'application/json'}),json:async()=>value});
  if(path==='/api/mail/status')
   return reply({configured:messages.length>0,draftsEnabled:true,address:'hello@devonakins.com',outgoingEnabled:false});
  if(path.startsWith('/api/mail/inbox?'))return reply({messages,total:messages.length,offset:0,limit:50,revision:1});
  if(path==='/api/mail/drafts'&&options.method==='GET')return reply({drafts:records});
  if(path==='/api/mail/drafts/create'){
   if(createFailure)return reply({error:'owner_sign_in_required'},401);
   const row={id:options.body?JSON.parse(options.body).id:id,revision:1,from:'hello@devonakins.com',
    to:[],subject:'',body:'',updatedAt:'2026-11-03T12:00:00.000Z'};
   records.push(row);return reply({draft:row});
  }
  if(path==='/api/mail/drafts/save'){
   if(conflict)return reply({error:'mail_draft_conflict'},409);
   const failure=saveErrors.shift();
   if(failure==='network')throw Error('simulated disconnection');
   if(failure)return reply({error:failure.code},failure.status);
   const body=JSON.parse(options.body);const row={...records[0],to:body.to,subject:body.subject,
    body:body.body,revision:2};records[0]=row;return reply({draft:row});
  }
  if(path==='/api/mail/drafts/delete'){
   records.splice(0);return reply({deleted:true});
  }
  throw Error('Unexpected external URL '+path);
 };
 dom.window.eval(mail);dom.window.eval(drafts);
 return {dom,calls,records,doc:dom.window.document};
}
test('draft editor activates independently of incoming IMAP, saves only on user action and never sends',async()=>{
 const x=setup();await wait();
 assert.deepEqual(x.calls.map(c=>c.path),['/api/mail/status','/api/mail/drafts']);
 const create=x.doc.querySelector('[data-mail-draft-action="create"]');assert(create);create.click();await wait();
 assert.equal(x.calls.filter(c=>c.method==='POST').length,1);
 assert.equal(x.calls.at(-1).path,'/api/mail/drafts/create');
 const to=x.doc.querySelector('[data-mail-draft-field="to"]');
 const subj=x.doc.querySelector('[data-mail-draft-field="subject"]');
 const body=x.doc.querySelector('[data-mail-draft-field="body"]');
 for(const [node,value] of [[to,'friend@example.org'],[subj,'<script>unsafe()</script>'],[body,'<img src="https://tracker.test/"> inert text']]){
  node.value=value;node.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
 }
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 const saves=x.calls.filter(c=>c.path==='/api/mail/drafts/save');
 assert.equal(saves.length,1);
 assert.equal(saves[0].body.subject,'<script>unsafe()</script>');
 assert.equal(saves[0].body.to[0],'friend@example.org');
 assert.equal(x.calls.filter(c=>/send|smtp/i.test(c.path)).length,0);
 const root=x.doc.getElementById('mail-drafts');
 assert(root.textContent.includes('No message was sent'));
 assert.equal(root.querySelectorAll('script,img,iframe').length,0);
 assert(x.calls.every(c=>c.credentials==='same-origin'));
 x.dom.window.close();
});
test('server revision conflict keeps unsaved text available instead of claiming delivery',async()=>{
 const x=setup({conflict:true});await wait();
 x.doc.querySelector('[data-mail-draft-action="create"]').click();await wait();
 const subject=x.doc.querySelector('[data-mail-draft-field="subject"]');
 subject.value='Local unsaved changes';subject.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 assert(x.doc.getElementById('mail-drafts').textContent.includes('Another version was saved'));
 assert.equal(x.doc.querySelector('[data-mail-draft-field="subject"]').value,'Local unsaved changes');
 assert.equal(x.calls.filter(c=>/send|smtp/.test(c.path)).length,0);
 x.dom.window.close();
});
test('draft support missing from status never calls draft endpoint or shows a composer',async()=>{
 const dom=new JSDOM('<section id="station-mail"></section>',{url:'https://station.example/#mail',runScripts:'outside-only'});
 const calls=[];
 dom.window.fetch=async(path)=>{
  calls.push(path);return {ok:true,status:200,headers:new Headers({'Content-Type':'application/json'}),
   json:async()=>({address:'hello@devonakins.com',configured:false,draftsEnabled:false})};
 };
 dom.window.eval(mail);dom.window.eval(drafts);await wait();
 assert.deepEqual(calls,['/api/mail/status']);
 assert.equal(dom.window.document.querySelector('#mail-drafts'),null);
 dom.window.close();
});

test('definitive recipient validation preserves edits, explains the refusal and accepts a corrected save',async()=>{
 const x=setup({saveErrors:[{status:400,code:'invalid_mail_draft_recipient'}]});await wait();
 x.doc.querySelector('[data-mail-draft-action="create"]').click();await wait();
 const input=(name,value)=>{
  const node=x.doc.querySelector('[data-mail-draft-field="'+name+'"]');
  node.value=value;node.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
 };
 input('to','not-an-address');input('subject','Preserve my work');input('body','Keep this unsaved body');
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 assert.match(x.doc.getElementById('mail-drafts').textContent,/Recipient address is invalid/);
 assert.doesNotMatch(x.doc.getElementById('mail-drafts').textContent,/Save confirmation unavailable/);
 assert.equal(x.records[0].revision,1);
 assert.equal(x.doc.querySelector('[data-mail-draft-field="body"]').value,'Keep this unsaved body');
 input('to','corrected@example.invalid');
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 assert.equal(x.records[0].revision,2);
 assert.deepEqual(x.records[0].to,['corrected@example.invalid']);
 const saves=x.calls.filter(c=>c.path==='/api/mail/drafts/save');
 assert.notEqual(saves[0].body.operationId,saves[1].body.operationId);
 assert.match(x.doc.getElementById('mail-drafts').textContent,/Draft saved at revision 2/);
 assert.equal(x.calls.filter(c=>/outbox|send|smtp/.test(c.path)).length,0);
 x.dom.window.close();
});
test('recognized content/size refusals retain unsaved text and never echo arbitrary server strings',async()=>{
 for(const failure of [{status:400,code:'invalid_mail_draft_payload'},{status:413,code:'mail_draft_payload_too_large'}]){
  const x=setup({saveErrors:[failure]});await wait();
  x.doc.querySelector('[data-mail-draft-action="create"]').click();await wait();
  const node=x.doc.querySelector('[data-mail-draft-field="body"]');node.value='Retain unsaved work';
  node.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
  x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
  assert.match(x.doc.getElementById('mail-drafts').textContent,/Draft content was refused/);
  assert.equal(x.doc.querySelector('[data-mail-draft-field="body"]').value,'Retain unsaved work');
  assert.equal(x.records[0].revision,1);
  x.dom.window.close();
 }
});
test('unknown errors and disconnections preserve the exact pending save for explicit retry',async()=>{
 for(const failure of ['network',{status:400,code:'<img src="https://tracker.test/">'},{status:502,code:'mail_draft_storage_failed'}]){
  const x=setup({saveErrors:[failure]});await wait();
  x.doc.querySelector('[data-mail-draft-action="create"]').click();await wait();
  x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
  assert.match(x.doc.getElementById('mail-drafts').textContent,/Save confirmation unavailable/);
  assert.doesNotMatch(x.doc.getElementById('mail-drafts').textContent,/tracker.test/);
  assert.equal(x.doc.getElementById('mail-drafts').querySelectorAll('img,script,iframe').length,0);
  assert.equal(x.calls.filter(c=>c.path==='/api/mail/drafts/save').length,1,'no automatic retry');
  x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
  const saves=x.calls.filter(c=>c.path==='/api/mail/drafts/save');
  assert.deepEqual(saves[0].body,saves[1].body);
  x.dom.window.close();
 }
});

const incoming={key:'personal/hello/7/1',from:'sender@example.org',subject:'A question',
 text:'<img src="https://tracker.invalid/pixel"> untrusted preview',timestamp:'2026-11-06T12:00:00.000Z',flags:[]};
test('reply opens a focused unsent draft and requires an explicit save; no SMTP or automatic quote',async()=>{
 const x=setup({messages:[incoming]});await wait();
 const reply=x.doc.querySelector('[data-mail-action="reply"]');assert(reply);reply.click();reply.click();await wait();
 assert.equal(x.calls.filter(c=>c.path.endsWith('/create')).length,1);
 assert.equal(x.calls.filter(c=>c.path.endsWith('/save')).length,0);
 const field=name=>x.doc.querySelector('[data-mail-draft-field="'+name+'"]');
 assert.equal(field('to').value,incoming.from);assert.equal(field('subject').value,'Re: A question');
 assert.equal(field('body').value,'');assert.equal(x.doc.activeElement,field('body'));
 assert.equal(x.records[0].subject,'','prefill must not mutate the confirmed server snapshot');
 field('body').value='My answer';field('body').dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 const saved=x.calls.find(c=>c.path.endsWith('/save')).body;
 assert.deepEqual(saved.to,[incoming.from]);assert.equal(saved.subject,'Re: A question');assert.equal(saved.body,'My answer');
 assert.equal(x.calls.filter(c=>/outbox|smtp|sync/.test(c.path)).length,0);
 assert.equal(x.doc.querySelectorAll('#station-mail img,#station-mail script').length,0);x.dom.window.close();
});
test('reply preserves dirty edits and refuses a second creation until they are saved',async()=>{
 const x=setup({messages:[incoming]});await wait();
 x.doc.querySelector('[data-mail-draft-action="create"]').click();await wait();
 const body=x.doc.querySelector('[data-mail-draft-field="body"]');body.value='Keep my work';
 body.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
 x.doc.querySelector('[data-mail-action="reply"]').click();await wait();
 assert.equal(x.calls.filter(c=>c.path.endsWith('/create')).length,1);
 assert.equal(x.doc.querySelector('[data-mail-draft-field="body"]').value,'Keep my work');
 assert.match(x.doc.querySelector('#mail-drafts').textContent,/Your edits are preserved/);x.dom.window.close();
});
test('reply treats subjects as inert text and avoids repeated Re prefixes',async()=>{
 const x=setup({messages:[{...incoming,subject:'RE: <script>unsafe()</script>'}]});await wait();
 x.doc.querySelector('[data-mail-action="reply"]').click();await wait();
 assert.equal(x.doc.querySelector('[data-mail-draft-field="subject"]').value,'RE: <script>unsafe()</script>');
 assert.equal(x.doc.querySelectorAll('#station-mail script').length,0);x.dom.window.close();
});
test('malformed sender, header injection and overlong reply subject cause no draft mutation',async()=>{
 for(const message of [{...incoming,from:'sender@example.org,other@example.org'},
  {...incoming,from:'sender@example.org\r\nBcc:other@example.org'},
  {...incoming,subject:'Bad\r\nSubject'}, {...incoming,subject:'x'.repeat(512)}]){
  const x=setup({messages:[message]});await wait();
  x.doc.querySelector('[data-mail-action="reply"]').click();await wait();
  assert.equal(x.calls.filter(c=>c.method==='POST').length,0);
  assert.match(x.doc.querySelector('#mail-drafts').textContent,/cannot prefill a reply safely/);x.dom.window.close();
 }
});
test('expired-session reply creation never claims a saved reply or submits mail',async()=>{
 const x=setup({messages:[incoming],createFailure:true});await wait();
 x.doc.querySelector('[data-mail-action="reply"]').click();await wait();
 assert.match(x.doc.querySelector('#mail-drafts').textContent,/Owner session expired/);
 assert.equal(x.doc.querySelector('[data-mail-draft-field="body"]'),null);
 x.doc.querySelector('[data-mail-action="reply"]').click();await wait();
 assert.equal(x.calls.filter(c=>c.method==='POST').length,1,'unconfirmed create needs explicit resolution');x.dom.window.close();
});

test('forward opens a recipient-free draft with a labeled inert text preview and requires explicit save',async()=>{
 const x=setup({messages:[incoming]});await wait();
 x.doc.querySelector('[data-mail-action="forward"]').click();
 x.doc.querySelector('[data-mail-action="forward"]').click();await wait();
 assert.equal(x.calls.filter(c=>c.path.endsWith('/create')).length,1);
 const field=name=>x.doc.querySelector('[data-mail-draft-field="'+name+'"]');
 assert.equal(field('to').value,'');assert.equal(x.doc.activeElement,field('to'));
 assert.equal(field('subject').value,'Fwd: A question');
 assert.match(field('body').value,/Forwarded text preview/);
 assert(field('body').value.includes(incoming.text));
 assert.match(field('body').value,/Attachments are not forwarded/);
 assert.equal(x.calls.filter(c=>c.path.endsWith('/save')).length,0);
 assert.equal(x.doc.querySelectorAll('#station-mail img,#station-mail script').length,0);
 field('to').value='chosen@example.org';field('to').dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 const saved=x.calls.find(c=>c.path.endsWith('/save')).body;
 assert.deepEqual(saved.to,['chosen@example.org']);assert.equal(saved.subject,'Fwd: A question');
 assert(saved.body.includes(incoming.text));assert.equal(x.calls.filter(c=>/outbox|smtp|sync/.test(c.path)).length,0);
 x.dom.window.close();
});
test('forward preserves unsaved reply edits instead of replacing the recipient or body',async()=>{
 const x=setup({messages:[incoming]});await wait();
 x.doc.querySelector('[data-mail-action="reply"]').click();await wait();
 const body=x.doc.querySelector('[data-mail-draft-field="body"]');body.value='Answer in progress';
 body.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
 x.doc.querySelector('[data-mail-action="forward"]').click();await wait();
 assert.equal(x.calls.filter(c=>c.path.endsWith('/create')).length,1);
 assert.equal(x.doc.querySelector('[data-mail-draft-field="body"]').value,'Answer in progress');
 assert.equal(x.doc.querySelector('[data-mail-draft-field="to"]').value,incoming.from);
 x.dom.window.close();
});
test('existing Fw/Fwd subjects and shortened preview notices survive without implying full content',async()=>{
 for(const subject of ['FW: Test','Fwd: Test']){
  const message={...incoming,subject,text:'Partial message\n[Message shortened. The full message remains with your email provider.]'};
  const x=setup({messages:[message]});await wait();
  x.doc.querySelector('[data-mail-action="forward"]').click();await wait();
  assert.equal(x.doc.querySelector('[data-mail-draft-field="subject"]').value,subject);
  assert(x.doc.querySelector('[data-mail-draft-field="body"]').value.includes(message.text));x.dom.window.close();
 }
});
test('invalid forwarding content or metadata is refused before allocating a draft',async()=>{
 const x=setup({messages:[incoming]});await wait();
 for(const patch of [{text:'x'.repeat(4097)},{text:'bad\u0000body'},{text:'bad\u202ebody'},
  {timestamp:'invalid'},{timestamp:null},{from:'sender@example.org\nOther: value'},
  {subject:'x'.repeat(512)}]){
  await x.dom.window.StationDrafts.forward({...incoming,...patch});
 }
 assert.equal(x.calls.filter(c=>c.method==='POST').length,0);x.dom.window.close();
});

test('expired-session forwarding creates no editable preview and never sends',async()=>{
 const x=setup({messages:[incoming],createFailure:true});await wait();
 x.doc.querySelector('[data-mail-action="forward"]').click();await wait();
 assert.match(x.doc.querySelector('#mail-drafts').textContent,/Owner session expired/);
 assert.equal(x.doc.querySelector('[data-mail-draft-field="body"]'),null);
 assert.equal(x.calls.filter(c=>c.path.endsWith('/save')||/outbox|smtp/.test(c.path)).length,0);
 x.dom.window.close();
});

test('a saved forward stays separate when the owner subsequently opens a reply',async()=>{
 const x=setup({messages:[incoming]});await wait();
 x.doc.querySelector('[data-mail-action="forward"]').click();await wait();
 const to=x.doc.querySelector('[data-mail-draft-field="to"]');to.value='chosen@example.org';
 to.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));
 x.doc.querySelector('[data-mail-draft-action="save"]').click();await wait();
 const saved=JSON.stringify(x.records[0]);
 x.doc.querySelector('[data-mail-action="reply"]').click();await wait();
 assert.equal(x.records.length,2);assert.equal(JSON.stringify(x.records[0]),saved);
 assert.equal(x.doc.querySelector('[data-mail-draft-field="to"]').value,incoming.from);
 assert.equal(x.doc.querySelector('[data-mail-draft-field="subject"]').value,'Re: A question');
 assert.equal(x.doc.querySelector('[data-mail-draft-field="body"]').value,'');
 assert.equal(x.calls.filter(c=>c.path.endsWith('/save')).length,1,'new reply must require its own explicit save');
 x.dom.window.close();
});

test('Reply-To is visible and prefills the distinct reply recipient without altering the sender',async()=>{
 const x=setup({messages:[{...incoming,replyTo:'support@example.org'}]});await wait();
 const reader=x.doc.querySelector('.mail-reader');assert(reader.textContent.includes(incoming.from));
 assert(reader.textContent.includes('support@example.org'));
 x.doc.querySelector('[data-mail-action="reply"]').click();await wait();
 assert.equal(x.doc.querySelector('[data-mail-draft-field="to"]').value,'support@example.org');
 assert.match(x.doc.querySelector('#mail-drafts').textContent,/message Reply-To address/);
 assert.equal(x.calls.filter(c=>c.path.endsWith('/save')||/outbox|smtp/.test(c.path)).length,0);x.dom.window.close();
});
test('ambiguous Reply-To never falls back to From, while reading and forwarding stay available',async()=>{
 const message={...incoming,replyTo:null};const x=setup({messages:[message]});await wait();
 assert.equal(x.doc.querySelector('[data-mail-action="reply"]').disabled,true);
 assert.match(x.doc.querySelector('.mail-reader').textContent,/Reply-To is invalid or ambiguous/);
 await x.dom.window.StationDrafts.reply(message);
 assert.equal(x.calls.filter(c=>c.method==='POST').length,0);
 x.doc.querySelector('[data-mail-action="forward"]').click();await wait();
 assert.equal(x.doc.querySelector('[data-mail-draft-field="to"]').value,'');
 assert(x.doc.querySelector('[data-mail-draft-field="body"]').value.includes(incoming.text));x.dom.window.close();
});
test('malformed routing from a client call cannot create a reply draft',async()=>{
 const x=setup({messages:[incoming]});await wait();
 for(const replyTo of ['a@example.org,b@example.org','a@example.org\nBcc:b@example.org',42,{}])
  await x.dom.window.StationDrafts.reply({...incoming,replyTo});
 assert.equal(x.calls.filter(c=>c.method==='POST').length,0);x.dom.window.close();
});
