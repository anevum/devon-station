// Actual hosted shell + signed local auth + encrypted SQLite + synthetic sockets.
// These checks do not demonstrate real provider acceptance or recipient delivery.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join}=require('node:path');
(async()=>{
 const {start,token}=await import('./runtime-harness.mjs');
 const {syntheticMailProvider}=await import('./runtime-mail-provider.mjs');
 const temp=mkdtempSync(join(tmpdir(),'ds-mail-browser-'));let browser,server;
 const results=[];
 try{
  browser=await chromium.launch({executablePath:process.env.DS_CHROME,args:['--no-sandbox','--disable-dev-shm-usage'],headless:true});
  for(const width of [1440,390,320]){
   const provider=syntheticMailProvider();server=await start(join(temp,width+'.sqlite'),{mailFixture:true,connect:provider.connect});
   const context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token()},reducedMotion:'reduce'});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   let confirm=false;page.on('dialog',dialog=>confirm?dialog.accept():dialog.dismiss());
   await page.goto(server.url+'/#mail');
   await page.getByRole('button',{name:'Synchronize Inbox',exact:true}).click();
   await page.locator('.mail-message').waitFor();await page.locator('.mail-message').click();
   await page.getByRole('heading',{name:'Browser incoming fixture',exact:true}).waitFor();
   assert.match(await page.locator('.mail-body').textContent(),/Safe incoming browser message/);
   assert.equal(await page.locator('#station-mail img,#station-mail iframe,#station-mail script').count(),0);
   await page.getByRole('button',{name:'New Draft',exact:true}).click();
   await page.getByLabel('To (comma-separated addresses)',{exact:true}).fill('synthetic-recipient@example.test');
   await page.getByLabel('Subject',{exact:true}).fill('Browser outgoing fixture '+width);
   await page.getByLabel('Message',{exact:true}).fill('Synthetic browser outgoing body '+width);
   await page.getByRole('button',{name:'Save Draft',exact:true}).click();
   await page.getByRole('button',{name:'Review Saved Draft for Sending',exact:true}).click();
   const send=page.getByRole('button',{name:'Confirm and Submit Email',exact:true});await send.waitFor();
   await page.screenshot({path:join(__dirname,'mail-review-'+width+'.png'),fullPage:true});
   assert.equal(provider.evidence.dataWrites,0);
   await send.click();assert.equal(provider.evidence.dataWrites,0,'dismissed confirmation must not send');
   confirm=true;await send.click();await page.getByText('Outbox state: accepted',{exact:false}).waitFor();
   assert.equal(provider.evidence.smtpConnections,1);assert.equal(provider.evidence.dataWrites,1);
   await page.reload();await page.getByRole('button',{name:'Inspect Outbox History',exact:true}).click();
   await page.locator('[data-outbox-state=accepted]').first().waitFor();
   assert.equal(await page.locator('.mail-message').count(),1);assert.equal(provider.evidence.dataWrites,1);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(overflow<=1,'overflow '+width+': '+overflow);
   assert.deepEqual(errors,[]);
   await page.addScriptTag({content:require('axe-core').source});
   const violations=await page.evaluate(async()=> (await axe.run(document.getElementById('station-mail'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa']}})).violations.filter(x=>['critical','serious'].includes(x.impact)).map(x=>({id:x.id,impact:x.impact})));
   assert.deepEqual(violations,[],'mail accessibility');
   await page.screenshot({path:join(__dirname,'mail-'+width+'.png'),fullPage:true});
   // A different signed subject cannot list mail even with the same named email.
   const denied=await context.request.get(server.url+'/api/mail/inbox',{headers:{'Cf-Access-Jwt-Assertion':token('not-owner')}});assert.equal(denied.status(),403);
   assert.equal(server.externalCalls(),0);
   results.push({width,overflow,pageErrors:0,inboxRead:true,draftSaved:true,confirmationCancelled:true,syntheticSmtpAttempts:1,acceptedNotDelivered:true,reload:true,nonownerStatus:403,externalCalls:0});
   await context.close();await server.close();server=null;
  }
  writeFileSync(join(__dirname,'mail-browser-results.json'),JSON.stringify({provider:'synthetic-only',results},null,2));console.log(JSON.stringify({provider:'synthetic-only',results}));
 }finally{await browser?.close();await server?.close();rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
