import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const compatibilityDate=process.env.DS_WORKERD_COMPAT_DATE??'2026-07-30';
test('workerd '+compatibilityDate+': native WebCrypto encrypts inbox/draft/outbox and recovers on independent restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ds-native-encrypted-'));
 const config={modules:true,modulesRoot:fileURLToPath(new URL('../',import.meta.url)),scriptPath:fileURLToPath(new URL('./mail-encrypted-fixture.mjs',import.meta.url)),
  compatibilityDate,d1Databases:['MAIL'],d1Persist:dir,bindings:{MAIL_PAYLOAD_KEY_ID:'test-key',MAIL_PAYLOAD_KEYS_JSON:JSON.stringify({'test-key':'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='})}};
 let mf=new Miniflare(config);
 try{
  const db=await mf.getD1Database('MAIL');
  for(const f of ['0004-comms-ro-mail.sql','0005-comms-drafts.sql','0006-comms-outbox.sql','0007-comms-draft-outbox-lineage.sql','0008-comms-one-delivery-per-draft.sql']){
   const text=await readFile(new URL('../worker/migrations/'+f,import.meta.url),'utf8');
   for(const sql of text.split('\n').filter(x=>!/^\s*--/.test(x)).join('\n').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
  }
  const seeded=await mf.dispatchFetch('http://localhost/seed');assert.equal(seeded.status,200);
  const expected={recovered:true,revision:2,inbox:1,state:'queued'};assert.deepEqual(await seeded.json(),expected);
  for(const [table,column] of [['comms_mail_drafts','recipients_json'],['comms_ro_messages','body_text'],['comms_outbox','payload_json']]){
   const row=await db.prepare('SELECT '+column+' AS payload FROM '+table).first();
   assert.equal(JSON.parse(row.payload).alg,'A256GCM');assert.doesNotMatch(row.payload,/confidential|synthetic-recipient|synthetic-author|private-reply-target/);
  }
  await mf.dispose();mf=new Miniflare(config);
  assert.deepEqual(await (await mf.dispatchFetch('http://localhost/read')).json(),expected);
  const recovered=await mf.getD1Database('MAIL');
  await recovered.prepare("UPDATE comms_mail_drafts SET recipients_json='[]'").run();
  const denied=await mf.dispatchFetch('http://localhost/read');assert.equal(denied.status,503);
  assert.deepEqual(await denied.json(),{error:'encrypted_mail_unavailable'});
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
