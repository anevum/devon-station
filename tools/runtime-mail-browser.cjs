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
   // Read-only, in-app acceptance must function in a real mobile-width browser,
   // without DevTools, provider requests, messages or authorization bypasses.
   assert.equal(provider.evidence.imapConnections,0);
   const diagnosticsRequests=[];
   page.on('request',request=>{
    const path=new URL(request.url()).pathname;
    if(path==='/api/session'||path.startsWith('/api/mail/'))diagnosticsRequests.push({path,method:request.method()});
   });
   await page.getByRole('button',{name:'Check connection',exact:true}).click();
   await page.locator('.mail-diagnostic-status[data-check="checked"]').waitFor();
   assert.match(await page.locator('.mail-diagnostic-results').textContent(),/Isolated D1 cache metadata: reachable/);
   assert.match(await page.locator('.mail-diagnostic-status[data-check="checked"]').textContent(),/Decryption, real IMAP, SMTP and recipient delivery remain unverified/);
   const ownerChecks=diagnosticsRequests.filter(x=>['/api/session','/api/mail/status','/api/mail/diagnostics'].includes(x.path));
   assert.deepEqual(ownerChecks.slice(-3).map(x=>x.path),['/api/session','/api/mail/status','/api/mail/diagnostics']);
   assert(diagnosticsRequests.every(x=>x.method==='GET'));
   assert.equal(provider.evidence.imapConnections,0);
   assert.equal(provider.evidence.smtpConnections,0);
   assert.equal(provider.evidence.dataWrites,0);
   // Distinct explicit owner POST opens TLS IMAP only for LOGIN + read-only EXAMINE;
   // no fetched messages, cache writes or outgoing SMTP.
   const probe=page.getByRole('button',{name:'Test IMAP login (read-only)',exact:true});
   assert.equal(await probe.isDisabled(),false);
   await probe.click();
   await page.locator('.mail-diagnostic-status[data-provider-check="checked"]').waitFor();
   assert.match(await page.locator('[data-provider-check]').textContent(),/IMAP TLS login and read-only INBOX selection succeeded/);
   assert.equal(provider.evidence.imapConnections,1);
   assert.equal(provider.evidence.smtpConnections,0);
   assert.equal(provider.evidence.dataWrites,0);
   const providerPosts=diagnosticsRequests.filter(x=>x.method==='POST');
   assert.deepEqual(providerPosts.map(x=>x.path),['/api/mail/diagnostics/imap-check']);
   await page.getByRole('button',{name:'Synchronize Inbox',exact:true}).click();
   await page.locator('.mail-message').waitFor();await page.locator('.mail-message').click();
   // Search is intentionally page-local. A nonmatching query must hide both
   // message content and reply controls without contacting the backend.
   const requestsBeforeSearch=diagnosticsRequests.length;
   const search=page.getByRole('searchbox',{name:'Find on this page'});
   await search.fill('does-not-exist-in-this-mailbox-index');
   assert.equal(await page.locator('.mail-message:visible').count(),0);
   assert.equal(await page.locator('[data-mail-filter-empty]').isVisible(),true);
   assert.equal(await page.locator('[data-mail-reader-content]').isVisible(),false);
   assert.equal(await page.locator('[data-mail-reader-filtered]').isVisible(),true);
   await search.fill('Browser incoming fixture');
   assert.equal(await page.locator('.mail-message:visible').count(),1);
   assert.equal(await page.locator('[data-mail-reader-content]').isVisible(),true);
   assert.equal(await page.locator('[data-mail-reader-filtered]').isVisible(),false);
   await search.fill('');
   assert.equal(diagnosticsRequests.length,requestsBeforeSearch);
   await page.getByRole('heading',{name:'Browser incoming fixture',exact:true}).waitFor();
   assert.match(await page.locator('.mail-body').textContent(),/Safe incoming browser message/);
   assert.equal(await page.locator('#station-mail img,#station-mail iframe,#station-mail script').count(),0);
   await page.getByRole('button',{name:'Forward text',exact:true}).click();
   await page.getByLabel('Subject',{exact:true}).waitFor();
   assert.equal(await page.getByLabel('Subject',{exact:true}).inputValue(),'Fwd: Browser incoming fixture');
   assert.equal(await page.getByLabel('To (comma-separated addresses)',{exact:true}).inputValue(),'');
   assert.match(await page.getByLabel('Message',{exact:true}).inputValue(),/Safe incoming browser message/);
   assert.match(await page.getByLabel('Message',{exact:true}).inputValue(),/Attachments are not forwarded/);
   assert.equal(provider.evidence.smtpConnections,0);
   await page.getByLabel('To (comma-separated addresses)',{exact:true}).fill('forward-recipient@example.test');
   await page.getByRole('button',{name:'Save Draft',exact:true}).click();
   await page.getByText(/^Draft saved at revision [0-9]+\. No message was sent\.$/,{exact:true}).waitFor();
   await page.getByRole('button',{name:'Reply to reply address',exact:true}).click();
   // The prior forward editor is still visible while the new draft is created.
   // Wait for the new working copy rather than merely an existing textbox.
   await page.waitForFunction(()=>document.querySelector('[data-mail-draft-field="subject"]')?.value==='Re: Browser incoming fixture');
   assert.equal(await page.getByLabel('Subject',{exact:true}).inputValue(),'Re: Browser incoming fixture');
   assert.equal(await page.getByLabel('Message',{exact:true}).inputValue(),'');
   assert.equal(await page.getByLabel('To (comma-separated addresses)',{exact:true}).inputValue(),'private-reply-target@example.test');
   assert.equal(provider.evidence.smtpConnections,0);
   assert.equal(provider.evidence.dataWrites,0);
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
   assert.match(provider.evidence.lastWire,/In-Reply-To: <browser-parent@example.test>\r\n/);
   assert.match(provider.evidence.lastWire,/References: <browser-root@example.test> <browser-parent@example.test>\r\n/);
   await page.reload();await page.getByRole('button',{name:'Inspect Outbox History',exact:true}).click();
   await page.locator('[data-outbox-state=accepted]').first().waitFor();
   assert.equal(await page.locator('.mail-message').count(),1);assert.equal(provider.evidence.dataWrites,1);
   await page.getByRole('button',{name:'Inspect encrypted Sent history',exact:true}).click();
   const sentHistory=page.getByRole('region',{name:'Encrypted Sent history',exact:true});
   await sentHistory.locator('[data-outbox-state=accepted]').waitFor();
   await sentHistory.getByRole('button',{name:'View encrypted Sent copy',exact:true}).click();
   await page.getByRole('region',{name:'Decrypted Sent copy — owner only',exact:true}).waitFor();
   assert.match(await page.locator('.mail-outbox-text').textContent(),/Synthetic browser outgoing body/);
   assert.equal(provider.evidence.smtpConnections,1);assert.equal(provider.evidence.dataWrites,1);
   const deniedHistory=await context.request.get(server.url+'/api/mail/outbox/accepted',{headers:{'Cf-Access-Jwt-Assertion':token('not-owner')}});
   assert.equal(deniedHistory.status(),403);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(overflow<=1,'overflow '+width+': '+overflow);
   assert.deepEqual(errors,[]);
   await page.addScriptTag({content:require('axe-core').source});
   const violations=await page.evaluate(async()=> (await axe.run(document.getElementById('station-mail'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa']}})).violations.filter(x=>['critical','serious'].includes(x.impact)).map(x=>({id:x.id,impact:x.impact})));
   assert.deepEqual(violations,[],'mail accessibility');
   await page.screenshot({path:join(__dirname,'mail-'+width+'.png'),fullPage:true});
   // A different signed subject cannot list mail even with the same named email.
   const denied=await context.request.get(server.url+'/api/mail/inbox',{headers:{'Cf-Access-Jwt-Assertion':token('not-owner')}});assert.equal(denied.status(),403);
   assert.equal(server.externalCalls(),0);
   results.push({width,overflow,pageErrors:0,ownerDiagnostics:true,ownerReadOnlyImapProbe:true,inboxRead:true,replyDraft:true,replyToRouting:true,replyHeaders:true,forwardDraft:true,draftSaved:true,confirmationCancelled:true,syntheticSmtpAttempts:1,acceptedNotDelivered:true,receiptBackedSent:true,reload:true,nonownerStatus:403,externalCalls:0});
   await context.close();await server.close();server=null;
  }
  writeFileSync(join(__dirname,'mail-browser-results.json'),JSON.stringify({provider:'synthetic-only',results},null,2));console.log(JSON.stringify({provider:'synthetic-only',results}));
 }finally{await browser?.close();await server?.close();rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
