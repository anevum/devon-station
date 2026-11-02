/* Browser acceptance for real Presence Studio layout at three responsive widths. */
const {chromium}=require('playwright');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
(async()=>{
 const {start,token}=await import('./runtime-harness.mjs');
 const path=mkdtempSync(join(tmpdir(),'ds-presence-browser-'));
 const server=await start(join(path,'synthetic.sqlite'));
 let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.DS_CHROME,args:['--no-sandbox','--disable-dev-shm-usage'],headless:true});
  const results=[];
  for(const width of [1440,390,320]){
   const context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,reducedMotion:'reduce',extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token()}});
   const page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto(server.url+'/#presence');
   await page.locator('#ps-compose').waitFor();
   const actual=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
   if(actual>1)throw Error('Presence Studio page horizontal overflow at '+width+': '+actual);
   const mobileNav=await page.locator('#nav [data-go=presence]').evaluate(el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right}});
   if(mobileNav.right>width+1&&width<500)throw Error('Presence Studio nav hidden offscreen at '+width);
   if(await page.locator('#ps-privacy').isChecked())throw Error('Privacy review prechecked at '+width);
   await page.locator('#ps-title').fill('Synthetic original drawing');
   await page.locator('#ps-facebook').fill('A new creative sketch for friends.');
   await page.locator('#ps-instagram').fill('A new illustration and what I learned.');
   await page.locator('#ps-privacy').check();
   await page.locator('#ps-compose button[type=submit]').click();
   await page.locator('[data-ps-ready]').click();
   const recordForm=page.locator('[data-ps-published]');
   await recordForm.locator('select[name=platform]').selectOption('facebook');
   await recordForm.locator('input[name=url]').fill('https://www.facebook.com/synthetic.owner/posts/12345678');
   await recordForm.locator('button[type=submit]').click();
   const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('devon-station:presence:v1')));
   if(saved.drafts.length!==1||saved.drafts[0].published.facebook.source!=='owner-entered'||saved.drafts[0].stage!=='ready')throw Error('Manual publication receipt did not persist');
   await page.locator('[data-ps-tab=insights]').click();
   await page.locator('#ps-platform').selectOption('facebook');
   await page.locator('#ps-date').fill('2026-11-02');
   await page.locator('#ps-window').selectOption('30');
   await page.locator('#ps-followers').fill('34');
   await page.locator('#ps-views').fill('0');
   await page.locator('#ps-snapshot button[type=submit]').click();
   const sample=await page.evaluate(()=>JSON.parse(localStorage.getItem('devon-station:presence:v1')));
   if(sample.snapshots.length!==1||sample.snapshots[0].followers!==34||sample.snapshots[0].views!==0||sample.snapshots[0].engagements!==null)throw Error('Local metrics did not persist correctly');
   const newOverflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
   if(newOverflow>1)throw Error('Insight panel overflow at '+width+': '+newOverflow);
   const undersized=await page.locator('#view button:visible, #view input:visible, #view select:visible').evaluateAll(els=>els.filter(el=>el.type!=='checkbox'&&el.getBoundingClientRect().height<43).map(el=>({tag:el.tagName,id:el.id,h:el.getBoundingClientRect().height})));
   if(undersized.length)throw Error('Small touch controls at '+width+': '+JSON.stringify(undersized));
   if(errors.length)throw Error('Presence Studio page errors at '+width+': '+JSON.stringify(errors));
   results.push({width,composer:true,nativeReceipt:true,metrics:true,overflow:Math.max(actual,newOverflow),smallControls:0,pageErrors:0});
   await context.close();
  }
  if(server.externalCalls())throw Error('Unexpected external dispatch');
  console.log(JSON.stringify({scope:'Presence Studio synthetic browser',results,externalCalls:0}));
 } finally {await browser?.close();await server.close();rmSync(path,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
