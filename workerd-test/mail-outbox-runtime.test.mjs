import test from 'node:test';
import assert from 'node:assert/strict';
import {createStation} from '../worker/index.mjs';
import {Miniflare} from 'miniflare';
import {readFile} from 'node:fs/promises';
import {createD1Outbox,createOutboxDispatcher} from '../src/communications/mail-outbox.mjs';
const compatibilityDate=process.env.DS_WORKERD_COMPAT_DATE??'2026-07-30';
const scope={installationId:'personal',mailboxId:'hello',ownerSub:'synthetic-owner'};
const id='123e4567-e89b-42d3-a456-426614174000',claim='123e4567-e89b-42d3-a456-426614174001';
const context={installationId:'personal',principalId:'owner'},from='hello@devonakins.com';
const registry={mailboxes:[{id:'hello',installationId:'personal',mode:'imap',sendVerified:true}],identities:[{address:from,mailboxId:'hello',installationId:'personal',sendVerified:true}],grants:[{installationId:'personal',principalId:'owner',mailboxId:'hello',capabilities:['send']}]};
const draft={to:['recipient@example.test'],subject:'Synthetic',body:'Untrusted inert message'};
test('workerd '+compatibilityDate+': durable outbox claim, isolation and crash-safe non-retry semantics',async t=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic outbox")}}',compatibilityDate,d1Databases:['MAIL']});
 try{
  const db=await mf.getD1Database('MAIL');
  const sql=await readFile(new URL('../worker/migrations/0006-comms-outbox.sql',import.meta.url),'utf8');
  await db.prepare(sql.split('\n').filter(x=>!x.startsWith('--')).join('\n').replace(/;\s*$/,'')).run();
  const store=createD1Outbox(db,scope),peer=createD1Outbox(db,{...scope,ownerSub:'other'});
  const dispatcher=createOutboxDispatcher({store,registry,context,mailboxId:'hello',from,
   connect:()=>assert.fail('unapproved network'),credentials:async()=>undefined});
  await t.test('explicit approval, deterministic enqueue replay and immutable payload',async()=>{
   await assert.rejects(dispatcher.enqueue({deliveryId:id,draft}),/approval_required/);
   await dispatcher.enqueue({deliveryId:id,draft,approvedByOwner:true});
   await dispatcher.enqueue({deliveryId:id,draft,approvedByOwner:true});assert.equal((await store.list()).length,1);
   await assert.rejects(dispatcher.enqueue({deliveryId:id,draft:{...draft,body:'changed'},approvedByOwner:true}),/outbox_conflict/);
   assert.equal(await peer.read(id),null);assert.deepEqual(await peer.list(),[]);
  });
  await t.test('concurrent D1 claims have one winner; crashed claims cannot be reclaimed',async()=>{
   const results=await Promise.all([store.claim(id,claim),store.claim(id,'123e4567-e89b-42d3-a456-426614174002')]);
   assert.equal(results.filter(Boolean).length,1);assert.equal(await store.claim(id,claim),null);
   await assert.rejects(dispatcher.submit({deliveryId:id,signal:new AbortController().signal}),/not_queued/);
   await assert.rejects(peer.finish(id,claim,'accepted'),/transition_conflict/);
  });
  await t.test('only claim owner can finalize; no terminal state can be retried',async()=>{
   // The first invocation executes its atomic UPDATE before the second in this fixture.
   const row=await db.prepare('SELECT claim_id FROM comms_outbox WHERE delivery_id=?').bind(id).first();
   await assert.rejects(store.finish(id,'123e4567-e89b-42d3-a456-426614174099','failed'),/transition_conflict/);
   await store.finish(id,row.claim_id,'uncertain');
   assert.equal((await store.read(id)).state,'uncertain');assert.equal(await store.claim(id,claim),null);
   await assert.rejects(dispatcher.submit({deliveryId:id,signal:new AbortController().signal}),/not_queued/);
   const listing=JSON.stringify(await store.list());assert(!listing.includes(draft.body));assert(!listing.includes('recipient@'));
  });
  await t.test('real D1 dispatcher and existing SMTP wire report accepted versus uncertain',async()=>{
   for(const [suffix,mode,expected] of [['010','accepted','accepted'],['011','lost','uncertain'],['012','write-failed','claimed']]){
    const deliveryId='123e4567-e89b-42d3-a456-426614174'+suffix;let controller,connections=0,data=0;
    const respond=text=>controller.enqueue(new TextEncoder().encode(text));
    const connect=(address,options)=>{
     connections++;assert.equal(address.hostname,'smtp.purelymail.com');assert.equal(options.secureTransport,'on');
     return {opened:Promise.resolve(),readable:new ReadableStream({start(c){controller=c;respond('220 ready\r\n');}}),
      writable:new WritableStream({write(bytes){const text=new TextDecoder().decode(bytes);
       if(text.startsWith('From:')){data++;if(mode==='lost')controller.close();else respond('250 accepted\r\n');}
       else if(text.startsWith('EHLO'))respond('250-AUTH PLAIN\r\n250 ready\r\n');
       else if(text.startsWith('AUTH'))respond('235 authenticated\r\n');
       else if(text.startsWith('DATA'))respond('354 continue\r\n');
       else if(!text.startsWith('QUIT'))respond('250 ok\r\n');
      }}),async close(){try{controller.close();}catch{}}};
    };
    const selected=mode==='write-failed'?{...store,finish:async()=>{throw Error('synthetic database failure');}}:store;
    const send=createOutboxDispatcher({store:selected,registry,context,mailboxId:'hello',from,connect,credentials:async()=> 'synthetic-app-password'});
    await send.enqueue({deliveryId,draft,approvedByOwner:true});
    if(mode==='write-failed')await assert.rejects(send.submit({deliveryId,signal:new AbortController().signal}),/confirmation_unavailable/);
    else {const receipt=await send.submit({deliveryId,signal:new AbortController().signal});assert.equal(receipt.state,expected);if(mode==='accepted')assert.equal(receipt.delivered,false);}
    assert.equal((await store.read(deliveryId)).state,expected);assert.equal(data,1);
    await assert.rejects(send.submit({deliveryId,signal:new AbortController().signal}),/not_queued/);assert.equal(connections,1);
   }
  });
  await t.test('owner Worker API prepares and lists durable outbox without exposing SMTP',async()=>{
   const base='https://station.example',station=createStation({},async()=>({email:'owner@example.test',subject:scope.ownerSub}),fetch,()=>assert.fail('HTTP must not open SMTP'));
   const env={APP_ORIGIN:base,OWNER_EMAIL:'owner@example.test',MAIL_OWNER_SUB:scope.ownerSub,MAIL_OUTBOX_ENABLED:'true',MAIL_SENDER_VERIFIED:'true',MAIL_DB:db};
   const request=(path,method='GET',body)=>new Request(base+path,{method,...(body?{headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
   const deliveryId='123e4567-e89b-42d3-a456-426614174013';
   const saved=await station.fetch(request('/api/mail/outbox/prepare','POST',{deliveryId,draft,approvedByOwner:true}),env);
   assert.equal(saved.status,200);assert.equal((await saved.json()).sendingEnabled,false);
   const listed=await station.fetch(request('/api/mail/outbox'),env);assert.equal(listed.status,200);
   assert(!JSON.stringify(await listed.json()).includes(draft.body));
   assert.equal((await station.fetch(request('/api/mail/outbox/submit','POST',{deliveryId}),env)).status,404);
   assert.equal((await station.fetch(request('/api/mail/outbox'),{...env,MAIL_OWNER_SUB:'other'})).status,403);
   assert.equal((await station.fetch(request('/api/mail/outbox/prepare','POST',{deliveryId:'123e4567-e89b-42d3-a456-426614174014',draft,approvedByOwner:true}),{...env,MAIL_SENDER_VERIFIED:'false'})).status,400);
  });
 }finally{await mf.dispose();}
});
