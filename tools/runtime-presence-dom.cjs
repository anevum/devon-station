/* Synthetic DOM acceptance for Presence Studio in the actual bundled HTML. */
const {JSDOM,VirtualConsole} = require('jsdom');
const {readFileSync} = require('node:fs');
const {webcrypto} = require('node:crypto');
const assert = require('node:assert/strict');
const {setTimeout:delay} = require('node:timers/promises');

(async () => {
 const html = readFileSync(new URL('../hosted-dist/index.html', 'file://' + __filename), 'utf8');
 const errors = [];
 const vc = new VirtualConsole();
 vc.on('jsdomError', err => {
  if (!/Not implemented: (HTMLDialogElement|navigation|window.computedStyle)/.test(err.message)) errors.push(err.message);
 });
 const dom = new JSDOM(html, {
  url:'https://synthetic-owner.example.test/#presence',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
  beforeParse(w) {
   Object.defineProperty(w,'crypto',{value:webcrypto});
   w.structuredClone=structuredClone;
   w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
   w.matchMedia=()=>({matches:false,addEventListener(){}});
   w.HTMLElement.prototype.scrollIntoView=function(){};
   w.HTMLDialogElement.prototype.showModal=function(){this.open=true};
   w.HTMLDialogElement.prototype.close=function(){this.open=false};
   w.fetch=async()=>new Response(JSON.stringify({error:'authentication_required'}),{status:401,headers:{'Content-Type':'application/json'}});
  }
 });
 try {
  const {document:doc,Event}=dom.window;
  const $=s=>doc.querySelector(s);
  assert.equal($('#view').className,'page-presence');
  assert($('#ps-compose'),'composer should be present');
  assert.match($('#view').textContent,/Not connected/);
  assert.equal($('[data-go=presence]').getAttribute('aria-current'),'page');
  assert.equal($('#ps-privacy').checked,false,'review cannot be prechecked');
  $('#ps-title').value='A synthetic original sketch';
  $('#ps-facebook').value='A brief update from my day.';
  $('#ps-instagram').value='A photo from the afternoon.';
  $('#ps-privacy').checked=true;
  $('#ps-compose').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  assert($('#view').textContent.includes('A synthetic original sketch'),'draft saved in rendered queue');
  let data=JSON.parse(dom.window.localStorage.getItem('devon-station:presence:v1'));
  assert.equal(data.drafts.length,1);assert.equal(data.drafts[0].stage,'draft');
  assert(!JSON.stringify(dom.window.localStorage.getItem('devon-station:local:v1')||'').includes('A synthetic original sketch'),'separate local storage');
  $('[data-ps-ready]').click();data=JSON.parse(dom.window.localStorage.getItem('devon-station:presence:v1'));
  assert.equal(data.drafts[0].stage,'ready');
  const form=$('[data-ps-published]');assert(form);
  form.querySelector('[name=platform]').value='facebook';
  form.querySelector('[name=url]').value='https://www.facebook.com/synthetic.person/posts/12345';
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  data=JSON.parse(dom.window.localStorage.getItem('devon-station:presence:v1'));
  assert.equal(data.drafts[0].published.facebook.source,'owner-entered');
  assert.equal(data.drafts[0].stage,'ready','Instagram still awaits publication');
  assert(!$('[data-ps-edit]'),'partial publishing must prohibit altering content');
  $('[data-ps-tab=insights]').click();
  assert($('#ps-snapshot'));
  $('#ps-platform').value='facebook';
  $('#ps-date').value='2026-11-02';
  $('#ps-window').value='30';
  $('#ps-followers').value='34';
  $('#ps-views').value='0';
  $('#ps-engagements').value='';
  $('#ps-snapshot').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  data=JSON.parse(dom.window.localStorage.getItem('devon-station:presence:v1'));
  assert.equal(data.snapshots[0].followers,34);
  assert.equal(data.snapshots[0].views,0);
  assert.equal(data.snapshots[0].engagements,null);
  assert($('#view').textContent.includes('34'),'manual metric visible');
  const axe=require('axe-core');
  dom.window.eval(axe.source);
  const report=await dom.window.axe.run($('#view'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']},rules:{'color-contrast':{enabled:false}}});
  if(report.violations.length)throw Error('Accessibility violations: '+JSON.stringify(report.violations.map(x=>({id:x.id,nodes:x.nodes.map(n=>n.target)}))));
  await delay(70);
  if(errors.length)throw Error('DOM script errors: '+JSON.stringify(errors));
  console.log(JSON.stringify({scope:'Presence Studio synthetic DOM',queue:true,manualReceipt:true,manualInsights:true,sourceProvenance:true,htmlErrors:0,axeViolations:0}));
 } finally {dom.window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
