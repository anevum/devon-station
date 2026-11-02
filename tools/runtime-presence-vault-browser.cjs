/* Real Chromium, signed synthetic Cloudflare Access JWTs and isolated 0004 schema.
 * The browser never connects to Meta or actual Cloudflare services.
 */
const {chromium}=require('playwright');
const {mkdtempSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const assert=require('node:assert/strict');

(async()=>{
 const {start,token}=await import('./runtime-harness.mjs');
 const dir=mkdtempSync(join(tmpdir(),'ds-presence-vault-'));
 const server=await start(join(dir,'isolated-vault.sqlite'),{migratePresence:true});
 let browser;
 const contexts=[];
 try{
  browser=await chromium.launch({executablePath:process.env.DS_CHROME,args:['--no-sandbox','--disable-dev-shm-usage'],headless:true});
  const ownerHeaders={'Cf-Access-Jwt-Assertion':token()};
  const first=await browser.newContext({viewport:{width:1440,height:900},extraHTTPHeaders:ownerHeaders,reducedMotion:'reduce'});
  const second=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,extraHTTPHeaders:ownerHeaders,reducedMotion:'reduce'});
  contexts.push(first,second);
  const firstPage=await first.newPage(),secondPage=await second.newPage(),errors=[];
  for(const p of [firstPage,secondPage])p.on('pageerror',e=>errors.push(e.message));

  // Both independent browsers share a signed owner identity, not localStorage.
  await Promise.all([firstPage.goto(server.url+'/#presence'),secondPage.goto(server.url+'/#presence')]);
  await Promise.all([firstPage.locator('#ps-vault-form').waitFor(),secondPage.locator('#ps-vault-form').waitFor()]);
  assert.equal(await secondPage.evaluate(()=>localStorage.getItem('devon-station:presence:v1')),null);
  const blank=await firstPage.evaluate(async()=>{const r=await fetch('/api/presence/vault');return {status:r.status,body:await r.json()};});
  assert.equal(blank.status,200);assert.equal(blank.body.revision,0);assert.equal(blank.body.envelope,null);

  await firstPage.locator('#ps-title').fill('Synthetic original family-free creative work');
  await firstPage.locator('#ps-facebook').fill('Original code and a new illustration.');
  await firstPage.locator('#ps-instagram').fill('A fresh creative project and a story.');
  await firstPage.locator('#ps-privacy').check();
  await firstPage.locator('#ps-compose button[type=submit]').click();
  await firstPage.locator('[data-ps-tab=insights]').click();
  await firstPage.locator('#ps-platform').selectOption('instagram');
  await firstPage.locator('#ps-date').fill('2026-11-02');
  await firstPage.locator('#ps-window').selectOption('30');
  await firstPage.locator('#ps-followers').fill('21');
  await firstPage.locator('#ps-snapshot button[type=submit]').click();
  const original=await firstPage.evaluate(()=>JSON.parse(localStorage.getItem('devon-station:presence:v1')));
  assert.equal(original.drafts.length,1);
  assert.equal(original.snapshots[0].followers,21);

  const pass='Synthetic complex passphrase for vault recovery in isolated Chromium.';
  await firstPage.locator('#ps-vault-pass').fill(pass);
  await firstPage.locator('#ps-vault-repeat').fill(pass);
  await firstPage.locator('#ps-vault-form button[value=save]').click();
  await firstPage.waitForFunction(()=>document.querySelector('#ps-vault-status')?.textContent.includes('revision 1'),{timeout:15000});
  assert.equal(await firstPage.locator('#ps-vault-pass').inputValue(),'');
  assert.equal(await firstPage.locator('#ps-vault-repeat').inputValue(),'');
  const remote=await firstPage.evaluate(async()=>{const r=await fetch('/api/presence/vault');return {status:r.status,body:await r.json()};});
  assert.equal(remote.status,200);assert.equal(remote.body.revision,1);
  const serialized=JSON.stringify(remote.body);
  for(const prohibited of [pass,original.drafts[0].title,original.drafts[0].captions.facebook])assert(!serialized.includes(prohibited),'remote vault leaked plaintext');
  assert.equal(remote.body.envelope.format,'devon-station-presence-vault');
  assert.equal(await secondPage.evaluate(()=>localStorage.getItem('devon-station:presence:v1')),null);

  // A wrong passphrase must never modify device records.
  await secondPage.locator('#ps-vault-pass').fill('Deliberately wrong synthetic passphrase.');
  await secondPage.locator('#ps-vault-form button[value=preview]').click();
  await secondPage.waitForFunction(()=>document.querySelector('#ps-vault-status')?.textContent.includes('Passphrase incorrect'),{timeout:15000});
  assert.equal(await secondPage.evaluate(()=>localStorage.getItem('devon-station:presence:v1')),null);
  assert(await secondPage.locator('#ps-vault-preview').isHidden());

  // Preview alone is not restoration.
  await secondPage.locator('#ps-vault-pass').fill(pass);
  await secondPage.locator('#ps-vault-form button[value=preview]').click();
  await secondPage.waitForFunction(()=>document.querySelector('#ps-vault-preview-summary')?.textContent.includes('1 drafts'),{timeout:15000});
  assert.equal(await secondPage.evaluate(()=>localStorage.getItem('devon-station:presence:v1')),null);

  // A second device changes remote revision after this preview. The old preview
  // must refuse restoration even if the ciphertext is valid.
  const updated=await firstPage.evaluate(async(envelope)=>{
   const r=await fetch('/api/presence/vault',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({envelope,expectedRevision:1,operationId:crypto.randomUUID()})});
   return {status:r.status,body:await r.json()};
  },remote.body.envelope);
  assert.equal(updated.status,200);assert.equal(updated.body.revision,2);

  secondPage.on('dialog',d=>d.accept());
  await secondPage.locator('[data-ps-vault-restore]').click();
  await secondPage.waitForFunction(()=>document.querySelector('#ps-vault-status')?.textContent.includes('changed after preview'),{timeout:12000});
  assert.equal(await secondPage.evaluate(()=>localStorage.getItem('devon-station:presence:v1')),null,'stale preview must not restore');
  const stale=await secondPage.evaluate(async(envelope)=>{
   const r=await fetch('/api/presence/vault',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({envelope,expectedRevision:1,operationId:crypto.randomUUID()})});
   return r.status;
  },remote.body.envelope);
  assert.equal(stale,409);

  // Explicitly unlock the newest revision and confirm restoration.
  await secondPage.locator('#ps-vault-pass').fill(pass);
  await secondPage.locator('#ps-vault-form button[value=preview]').click();
  await secondPage.waitForFunction(()=>document.querySelector('#ps-vault-preview-summary')?.textContent.includes('revision 2'),{timeout:15000});
  await secondPage.locator('[data-ps-vault-restore]').click();
  await secondPage.waitForFunction(()=>JSON.parse(localStorage.getItem('devon-station:presence:v1')||'{"drafts":[]}').drafts.length===1,{timeout:12000});
  const restored=await secondPage.evaluate(()=>JSON.parse(localStorage.getItem('devon-station:presence:v1')));
  assert.deepEqual(restored,original,'same owner restored synthetic content and metrics');
  assert.equal(await secondPage.locator('#ps-vault-pass').inputValue(),'');
  assert(!errors.length,'No uncaught browser errors: '+errors.join('; '));

  // Signed Access denial: no token, wrong account email, wrong JWT audience;
  // same email but a different subject sees an isolated, empty vault.
  const noAuth=await browser.newContext();
  const wrongEmail=await browser.newContext({extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token('test-owner',{email:'different@example.test'})}});
  const wrongAud=await browser.newContext({extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token('test-owner',{aud:['wrong-audience']})}});
  const otherSub=await browser.newContext({extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token('different-subject')}});
  contexts.push(noAuth,wrongEmail,wrongAud,otherSub);
  assert.equal((await noAuth.request.get(server.url+'/api/presence/vault')).status(),401);
  assert.equal((await wrongEmail.request.get(server.url+'/api/presence/vault')).status(),403);
  assert.equal((await wrongAud.request.get(server.url+'/api/presence/vault')).status(),401);
  const isolated=await otherSub.request.get(server.url+'/api/presence/vault');
  assert.equal(isolated.status(),200);
  assert.deepEqual(await isolated.json(),{revision:0,exists:false,updatedAt:null,envelope:null});
  const crossOrigin=await first.request.post(server.url+'/api/presence/vault',{headers:{Origin:'https://cross-origin.invalid','Content-Type':'application/json'},data:JSON.stringify({expectedRevision:2,operationId:'11111111-1111-4111-8111-111111111111',envelope:remote.body.envelope})});
  assert.equal(crossOrigin.status(),403);
  assert.equal(server.externalCalls(),0);
  console.log(JSON.stringify({scope:'signed isolated Presence vault Chromium',devices:2,encryptedRevision:2,wrongPasswordBlocked:true,staleRevisionBlocked:true,ownerDeniedStatuses:[401,403,401],crossSubjectEmpty:true,restoredDrafts:restored.drafts.length,restoredSnapshots:restored.snapshots.length,untrustedExternalCalls:0,productionModified:false}));
 } finally{
  for(const c of contexts)await c.close().catch(()=>{});
  await browser?.close();await server.close();rmSync(dir,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
