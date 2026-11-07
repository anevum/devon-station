const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,writeFileSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join}=require('node:path');
(async()=>{
 const {start,token}=await import('./runtime-harness.mjs');
 const {createMailPayloadCipher}=await import('../src/communications/mail-payload-crypto.mjs');
 const {createExecutionLedger}=await import('../worker/ai-work-execution.mjs');
 const {createExecutionController,executionPlanDigest}=await import('./ai-work/execution-controller.mjs');
 const temp=mkdtempSync(join(tmpdir(),'ds-work-browser-'));let browser,server;const results=[];
 try{
  browser=await chromium.launch({executablePath:process.env.DS_CHROME,args:['--no-sandbox','--disable-dev-shm-usage'],headless:true});
  for(const width of [1440,390,320]){
   server=await start(join(temp,width+'.sqlite'),{aiFixture:true,executionFixture:true});
   const context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500,extraHTTPHeaders:{'Cf-Access-Jwt-Assertion':token()},reducedMotion:'reduce'});
   const page=await context.newPage(),errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
   page.on('request',r=>{if(!r.url().startsWith(server.url))external.push(r.url());});
   await page.clock.install();
   await page.goto(server.url+'/#aiwork');
   await page.getByLabel('Task',{exact:true}).waitFor();
   await page.getByLabel('Task',{exact:true}).fill('BROWSER_PRIVATE_TASK <img src=x onerror="alert(1)">');
   await page.getByLabel('Proposed API cap (USD cents)').fill('75');
   await page.getByRole('button',{name:'Save for review',exact:true}).click();
   await page.getByRole('button',{name:'Approve plan only',exact:true}).waitFor();
   assert.equal(await page.locator('#station-ai-work img').count(),0);
   assert.match(await page.locator('.aw-text').textContent(),/BROWSER_PRIVATE_TASK/);
   assert.match(await page.locator('body').textContent(),/Billing is not authorized/);
   await page.getByRole('button',{name:'Approve plan only',exact:true}).click();
   await page.getByRole('region',{name:'Private job detail'}).getByText('Plan approved · execution locked',{exact:true}).waitFor();
   await page.reload();await page.locator('.aw-job').first().waitFor();await page.locator('.aw-job').first().click();
   await page.getByRole('button',{name:'Cancel pending job',exact:true}).click();
   await page.getByRole('button',{name:'Prepare follow-up plan',exact:true}).waitFor();
   await page.getByRole('button',{name:'Prepare follow-up plan',exact:true}).click();
   await page.getByLabel('Task',{exact:true}).fill('Private follow-up test');
   await page.getByRole('button',{name:'Save for review',exact:true}).click();
   await page.getByRole('button',{name:'Approve plan only',exact:true}).waitFor();
   assert.equal(await page.locator('.aw-job').count(),2);
   // A strictly synthetic private service exercises the execution record path;
   // no provider key, network call, or billable inference exists in this fixture.
   await page.getByRole('button',{name:'Approve plan only',exact:true}).click();
   await page.getByRole('region',{name:'Private job detail'}).getByText('Plan approved · execution locked',{exact:true}).waitFor();
   const list=await(await context.request.get(server.url+'/api/ai-work/jobs')).json();
   const job=list.jobs.find(j=>j.state==='ready');assert(job);
   const cipher=createMailPayloadCipher({activeKeyId:server.env.AI_WORK_KEY_ID,keys:JSON.parse(server.env.AI_WORK_KEYS_JSON)});
   const ledger=createExecutionLedger({db:server.env.DB,cipher,ownerSubject:'test-owner',dispatchEnabled:true});
   const plan=await ledger.readPlan(job.jobId),digest=await executionPlanDigest(plan);
   let providerStatus='in_progress',cancels=0;
   const provider={
    run:async(options,checkpoint)=>{
     await checkpoint({type:'agent.session.created',session:{id:'sess_browser'}},{sessionId:'sess_browser'});
     await checkpoint({type:'agent.session.turn.in_progress',turn:{id:'turn_browser',subagent_id:null}},{sessionId:'sess_browser'});
     await checkpoint({type:'agent.session.turn.output_text.delta',delta:'PRIVATE_EXECUTION_OUTPUT <img src=x onerror=alert(1)>'},{sessionId:'sess_browser'});
     return {status:'unverified'};
    },
    readback:async()=>({sessionId:'sess_browser',turnId:'turn_browser',turnStatus:providerStatus,sessionStatus:providerStatus==='in_progress'?'in_progress':'idle',limitCents:35,consumedCents:2}),
    cancel:async()=>{cancels++;return {accepted:true};},
   };
   // Use a fixed receipt expiry so revalidation detects genuine changes only.
   const expiry=Date.now()+60000;
   const service=createExecutionController({ledger,provider,scopeAllowed:async()=>true,readApproval:async()=>({id:'synthetic-owner-approval',ownerSubject:'test-owner',jobId:job.jobId,planDigest:digest,authorized:true,limitCents:35,expiresAt:expiry})});
   await service.prepare(job.jobId,2);await service.dispatch(job.jobId);
   await page.getByRole('button',{name:'Reload jobs',exact:true}).click();
   const execution=page.getByRole('region',{name:'Private execution record'});await execution.waitFor();
   assert.match(await execution.textContent(),/PRIVATE_EXECUTION_OUTPUT/);assert.equal(await execution.locator('img').count(),0);
   await page.getByRole('button',{name:'Request cancellation',exact:true}).click();
   await page.getByRole('region',{name:'Private job detail'}).getByText('Cancellation requested',{exact:true}).waitFor();
   assert.equal(cancels,0);await service.cancel(job.jobId);assert.equal(cancels,1);
   await page.getByLabel('Task',{exact:true}).fill('Keep this unsaved private task');
   providerStatus='cancelled';await service.reconcile(job.jobId);
   await page.clock.fastForward(10001);
   await execution.getByText('Root turn outcome confirmed by provider readback. Task results still need independent review.',{exact:true}).waitFor();
   assert.equal(await page.getByLabel('Task',{exact:true}).inputValue(),'Keep this unsaved private task');
   assert.equal(await page.getByLabel('Task',{exact:true}).evaluate(el=>el===document.activeElement),true);
   await page.locator('details summary').filter({hasText:'Private session identity'}).click();
   assert.match(await execution.textContent(),/sess_browser/);
   const stored=await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]));assert.doesNotMatch(stored,/BROWSER_PRIVATE_TASK|Private follow-up|PRIVATE_EXECUTION_OUTPUT|sess_browser/);
   const denied=await context.request.get(server.url+'/api/ai-work/jobs',{headers:{'Cf-Access-Jwt-Assertion':token('not-owner')}});assert.equal(denied.status(),403);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(overflow<=1,'overflow '+width+': '+overflow);
   await page.addScriptTag({content:require('axe-core').source});
   const violations=await page.evaluate(async()=> (await axe.run(document.getElementById('station-ai-work'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa']}})).violations.map(x=>({id:x.id,impact:x.impact,nodes:x.nodes.map(n=>n.target)})));
   assert.deepEqual(violations,[],'work console accessibility');
   await page.locator('.aw-hero').scrollIntoViewIfNeeded();
   await page.screenshot({path:join(__dirname,'ai-work-'+width+'.png'),fullPage:true});
   // Revocation clears cached private detail on the next explicit refresh.
   server.env.AI_WORK_PROJECTS_JSON='["rhen"]';await page.getByRole('button',{name:'Reload jobs',exact:true}).click();
   await page.getByRole('heading',{name:'Owner connection required'}).waitFor();
   assert.doesNotMatch(await page.locator('#station-ai-work').textContent(),/Private follow-up test|BROWSER_PRIVATE_TASK|PRIVATE_EXECUTION_OUTPUT|sess_browser/);
   assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.equal(server.externalCalls(),0);
   results.push({width,overflow,pageErrors:0,accessibilityViolations:0,privateStorage:true,createApproveCancelFollowup:true,executionOutputAndConfirmedCancellation:true,liveRefreshPreservesCompose:true,reload:true,nonowner:403,revocation:true,externalCalls:0});
   await context.close();await server.close();server=null;
  }
  writeFileSync(join(__dirname,'ai-work-browser-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }finally{await browser?.close();await server?.close();rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
