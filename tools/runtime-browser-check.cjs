const {chromium}=require('playwright');
const {mkdtempSync,rmSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
(async()=>{
 const {start,token}=await import('./runtime-harness.mjs');const temp=mkdtempSync(join(tmpdir(),'ds-browser-')),path=join(temp,'synthetic.sqlite');let server=await start(path);
 let browser;
 try{browser=await chromium.launch({executablePath:process.env.DS_CHROME,args:['--no-sandbox','--disable-dev-shm-usage'],headless:true});const results=[];

  for(const width of [1440,390,320]){
   const context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token()},reducedMotion:'reduce'});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(server.url+'/#workspace');await page.getByText('Workspace loaded. Saved decisions are up to date.').waitFor();
   await page.getByLabel('Action to review').fill('Synthetic browser action '+width);await page.getByRole('button',{name:'Create proposal',exact:true}).click();await page.getByText('Proposal saved. Review it before deciding.').waitFor();
   const article=page.locator('.ws-action').filter({hasText:'Synthetic browser action '+width});await article.getByRole('button',{name:'Review proposal'}).click();
   if(await page.locator('#ws-review-title').evaluate(e=>e!==document.activeElement))throw Error('review focus missing');
   await page.getByRole('button',{name:width===320?'Reject record':'Approve record',exact:true}).click();await page.getByText('Decision saved:',{exact:false}).waitFor();
   await article.locator('summary').click();if(await article.locator('li').count()!==2)throw Error('receipt count');
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);if(overflow>1)throw Error('horizontal overflow '+width+': '+overflow);
   const targets=await page.locator('#station-workspace button:visible, #station-workspace select:visible').evaluateAll(els=>els.map(e=>({text:e.textContent.trim(),height:e.getBoundingClientRect().height})).filter(x=>x.height<43));if(targets.length)throw Error('touch targets '+JSON.stringify(targets));
   await page.screenshot({path:join(__dirname,'workspace-'+width+'.png'),fullPage:true});
   await page.getByRole('button',{name:'Portable workspace',exact:false}).click();if(await page.locator('.ws-action').count()!==0)throw Error('project filtering failed');
   await page.getByRole('button',{name:'Recovery acceptance',exact:false}).click();
   // The app's original navigation and capture workflow still coexist.
   await page.getByRole('button',{name:'Quick capture',exact:true}).click();await page.getByLabel('Thought or next action').fill('Retain original capture '+width);await page.locator('#capture-form button[type=submit]').click();await page.getByText('Retain original capture '+width,{exact:true}).waitFor();
   await page.locator('#nav [data-go=workspace]').click();await page.locator('#ws-summary').waitFor();
   if(errors.length)throw Error('page errors '+JSON.stringify(errors));results.push({width,overflow,touchTargets:true,decision:width===320?'rejected':'approved',pageErrors:errors.length});await context.close();
  }
  const oldURL=server.url;await server.close();server=await start(path);const ctx=await browser.newContext({extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token()}});const page=await ctx.newPage();await page.goto(server.url+'/#workspace');await page.getByText('Workspace loaded. Saved decisions are up to date.').waitFor();if(await page.locator('.ws-action').count()!==3)throw Error('restart recovery failed');
  server.env.WORKSPACE_GRANTS=[];await page.getByRole('button',{name:'Reload workspace'}).click();await page.getByText('No workspace authorized',{exact:true}).waitFor();if(await page.locator('.ws-action').count()!==0)throw Error('revoked scope retained');await ctx.close();
  const denied=await browser.newContext({extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token('not-granted')}});const deniedPage=await denied.newPage();await deniedPage.goto(server.url+'/#workspace');await deniedPage.getByText('No workspace authorized',{exact:true}).waitFor();if(await deniedPage.locator('.ws-action').count())throw Error('other subject leak');await denied.close();
  if(server.externalCalls()!==0)throw Error('external call');writeFileSync(join(__dirname,'browser-results.json'),JSON.stringify({results,restart:true,revocation:true,nonownerIsolation:true,externalCalls:0},null,2));console.log(JSON.stringify({results,restart:true,revocation:true,nonownerIsolation:true,externalCalls:0}));
 }finally{await browser?.close();await server.close();rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
