const {JSDOM,VirtualConsole}=require('jsdom');
const {readFileSync,mkdtempSync,rmSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');const {tmpdir}=require('node:os');const {webcrypto}=require('node:crypto');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let i=0;i<150;i++){if(fn())return;await delay(20);}throw Error('Timed out: '+label);}
(async()=>{
 const {start,token}=await import('./runtime-harness.mjs');const dir=mkdtempSync(join(tmpdir(),'ds-dom-')),path=join(dir,'synthetic.sqlite');let server=await start(path);const errors=[];let dom;
 const make=async(subject='test-owner')=>{
  const html=readFileSync(join(__dirname,'../hosted-dist/index.html'),'utf8');
  const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!/Not implemented: (window.computedStyle|HTMLDialogElement|navigation)/.test(e.message))errors.push(e.message);});
  return new JSDOM(html,{url:server.url+'/#workspace',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
   Object.defineProperty(w,'crypto',{value:webcrypto});w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.matchMedia=()=>({matches:false,addEventListener(){}});w.HTMLElement.prototype.scrollIntoView=function(){};w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};w.URL.createObjectURL=()=>'';w.URL.revokeObjectURL=()=>{};
   w.fetch=(input,options={})=>fetch(new URL(input,server.url),{...options,headers:{...options.headers,'Cf-Access-Jwt-Assertion':token(subject),...(options.method?{Origin:server.url}:{})}});
  }});
 };
 try{
  dom=await make();let doc=dom.window.document;
  try{await until(()=>doc.querySelector('#ws-summary'),'workspace loaded');}catch(e){console.error('BOOT ERRORS',errors);console.error('VIEW',doc.querySelector('#view')?.textContent.slice(0,1500));console.error('BODY',doc.body.textContent.slice(-400));throw e;}
  const source=doc.querySelector('.ws-project-header a');if(!source.href.includes('synthetic-project-a'))throw Error('source missing');
  // Async redraw must preserve a keyboard user's place after reload/scope change.
  const reload=doc.querySelector('#ws-reload');reload.focus();reload.click();
  await until(()=>doc.querySelector('#ws-reload')!==reload&&!doc.querySelector('#ws-reload').disabled,'workspace keyboard reload');
  if(doc.activeElement?.id!=='ws-reload')throw Error('workspace reload lost keyboard focus');
  const chooser=doc.querySelector('#ws-scope');chooser.focus();chooser.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  await until(()=>doc.querySelector('#ws-scope')!==chooser&&!doc.querySelector('#ws-scope').disabled,'workspace keyboard scope selection');
  if(doc.activeElement?.id!=='ws-scope')throw Error('scope selection lost keyboard focus');
  function click(selector){const el=doc.querySelector(selector);if(!el)throw Error('missing '+selector);el.click();}
  async function propose(text){const input=doc.querySelector('#ws-summary');input.value=text;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));doc.querySelector('#ws-proposal').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await until(()=>doc.querySelector('#ws-status').textContent.includes('Proposal saved'),'proposed');}
  await propose('DOM acceptance approval');click('[data-ws-review]');if(doc.activeElement.id!=='ws-review-title')throw Error('review focus');click('[data-ws-decision=approved]');await until(()=>doc.querySelector('#ws-status').textContent.includes('Decision saved: approved'),'approved');
  await propose('DOM acceptance rejection');click('[data-ws-review]');click('[data-ws-decision=rejected]');await until(()=>doc.querySelector('#ws-status').textContent.includes('Decision saved: rejected'),'rejected');if(doc.querySelectorAll('.ws-action li').length!==4)throw Error('audit receipts');
  click('[data-ws-project=project-b]');if(doc.querySelectorAll('.ws-action').length)throw Error('project isolation');click('[data-ws-project=project-a]');if(doc.querySelectorAll('.ws-action').length!==2)throw Error('project restoration');
  // Original app route + capture without replacing its shell or scripts.
  click('#capture-open');doc.querySelector('#capture-text').value='Preserved original capture';doc.querySelector('#capture-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));if(!doc.querySelector('#view').textContent.includes('Preserved original capture'))throw Error('capture regression');click('#nav [data-go=workspace]');await until(()=>doc.querySelector('#ws-summary'),'workspace return');
  const axe=require('axe-core');dom.window.eval(axe.source);const audit=await dom.window.axe.run(doc.querySelector('#station-workspace'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']},rules:{'color-contrast':{enabled:false}}});if(audit.violations.length)throw Error('DOM accessibility '+JSON.stringify(audit.violations.map(x=>({id:x.id,nodes:x.nodes.map(n=>n.target)}))));
  dom.window.close();await server.close();server=await start(path);dom=await make();doc=dom.window.document;await until(()=>doc.querySelectorAll('.ws-action').length===2,'restart state');
  server.env.WORKSPACE_GRANTS=[];click('[data-ws-reload]');await until(()=>doc.querySelector('#station-workspace').textContent.includes('No workspace authorized'),'revocation');if(doc.querySelectorAll('.ws-action').length)throw Error('revocation leak');
  dom.window.close();dom=await make('other-subject');doc=dom.window.document;await until(()=>doc.querySelector('#station-workspace').textContent.includes('No workspace authorized'),'other subject');
  if(errors.length)throw Error('DOM errors '+JSON.stringify(errors));if(server.externalCalls())throw Error('external operation');
  const result={actualRecoveredHTML:true,sourceLinkedProjects:true,approveReject:true,auditReceipts:4,originalCapture:true,restart:true,revocation:true,nonownerIsolation:true,domAccessibilityViolations:audit.violations.length,domErrors:errors.length,externalCalls:0,limitations:'jsdom does not verify browser layout, color contrast, real device or rendered accessibility'};
  writeFileSync(join(__dirname,'dom-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{dom?.window.close();await server.close();rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
