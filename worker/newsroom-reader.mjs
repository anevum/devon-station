/**
 * DS011-RB02 — optional, UNMOUNTED nonclinical newspaper reader + passage discussions.
 * Private synthetic-only composition of the existing editions and conversations.
 * Does not modify the RB01 owner-only Worker or issue permissions.
 */
import {authorizedIdentity} from './access.mjs';
import {createNewsroomHandler} from './newsroom.mjs';
import {canonicalJSON,idValid,sha256,validateManifest} from './newsroom-contract.mjs';

const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const header={
 'Cache-Control':'private, no-store',
 'X-Content-Type-Options':'nosniff',
 'X-Frame-Options':'DENY',
 'Referrer-Policy':'no-referrer',
 'Cross-Origin-Resource-Policy':'same-origin',
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 'Strict-Transport-Security':'max-age=31536000'
};
const errorResponse=(status,error)=>new Response(JSON.stringify({error}),{
 status,headers:{...header,'Content-Type':'application/json;charset=utf-8'}
});

const css=String.raw`
:root{color-scheme:light;--forest:#18392e;--forest-deep:#10281f;--cream:#f4f0e6;--paper:#fffdf6;--ink:#223b30;--muted:#56665b;--line:#d1d9ce;--copper:#a34d34;--sage:#eef0e9;--shadow:0 18px 55px #152f2915}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:var(--cream);font:17px/1.65 Georgia,'Times New Roman',serif}button,textarea{font:inherit}button{cursor:pointer}a{color:inherit;text-underline-offset:.2em}button:focus-visible,a:focus-visible,textarea:focus-visible{outline:3px solid var(--copper);outline-offset:3px}button:disabled{cursor:not-allowed;opacity:.65}.skip{position:absolute;left:1rem;top:-7rem;z-index:100;padding:.75rem 1rem;background:white}.skip:focus{top:1rem}
.topline{height:5px;background:var(--forest)}.top{display:flex;align-items:center;justify-content:space-between;gap:1.25rem;padding:1.05rem clamp(1rem,3vw,2.7rem);border-bottom:1px solid var(--line);background:#f9f7f0}.brand{font-size:clamp(1.65rem,3.1vw,2.4rem);font-weight:bold;letter-spacing:-.05em;line-height:1}.brand small{display:block;margin-bottom:.45rem;font:700 .56rem/1.3 system-ui,sans-serif;letter-spacing:.21em;color:var(--copper)}.topright{font:700 .67rem/1.6 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;text-align:right;color:var(--forest)}.topright span{display:block;font-weight:500;color:var(--muted);letter-spacing:.02em;text-transform:none}.layout{max-width:1680px;margin:auto;display:grid;grid-template-columns:220px minmax(0,1fr) 350px;min-height:calc(100dvh - 96px)}.contents{padding:2rem 1.35rem;background:#eeede4;border-right:1px solid var(--line)}.eyebrow{font:800 .62rem/1.45 system-ui,sans-serif;letter-spacing:.15em;text-transform:uppercase;color:var(--copper)}.contents nav{position:sticky;top:1.4rem}.contents ol{list-style:none;margin:1.5rem 0 0;padding:0}.contents li{margin:.7rem 0;border-bottom:1px solid #c8d1c6;padding-bottom:.8rem}.contents a{display:block;text-decoration:none;font:600 .88rem/1.45 system-ui,sans-serif}.contents a:hover{text-decoration:underline}.contents .hint{margin-top:2rem;font:.78rem/1.6 system-ui,sans-serif;color:var(--muted)}.sheet{min-width:0;padding:clamp(1.4rem,4vw,4rem) clamp(1.1rem,4.2vw,5.3rem) 5rem;background:var(--paper)}.issue-meta{display:flex;justify-content:space-between;gap:1rem;border-bottom:2px solid var(--forest);padding-bottom:.6rem;font:700 .66rem/1.4 system-ui,sans-serif;letter-spacing:.13em;text-transform:uppercase;color:var(--copper)}.headline{font-size:clamp(2.6rem,5.1vw,5rem);line-height:1.04;letter-spacing:-.045em;margin:2.1rem 0 .8rem;font-weight:600}.standfirst{max-width:51ch;font-size:1.08rem;color:var(--muted);margin-bottom:3.2rem}.article{padding-top:1rem;border-top:1px solid var(--line);margin-top:3.1rem;scroll-margin-top:1.5rem}.article h2{font-size:clamp(1.8rem,3vw,2.8rem);line-height:1.15;margin:.8rem 0 1.5rem}.article-number{font:700 .65rem system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--copper)}.passage{margin:1.9rem 0;padding:1.15rem 1.15rem 1.15rem 1.3rem;border-left:3px solid transparent;transition:background .13s,border-color .13s;scroll-margin-top:1rem}.passage[data-selected="true"]{background:#edf0e9;border-left-color:var(--copper)}.passage h3{font-size:1.4rem;line-height:1.25;margin:0 0 .7rem}.passage p{margin:0 0 .75rem;max-width:67ch;overflow-wrap:anywhere}.passage .figure{font-style:italic;color:var(--muted)}.passage-tools{display:flex;align-items:center;flex-wrap:wrap;gap:.6rem;margin-top:.9rem}.reference{font:600 .64rem system-ui,sans-serif;letter-spacing:.08em;color:var(--muted)}.discuss{border:1px solid #bac9bf;border-radius:100px;background:transparent;color:var(--forest);padding:.46rem .9rem;font:700 .75rem/1.3 system-ui,sans-serif;min-height:40px}.discuss:hover,.discuss[aria-pressed="true"]{background:var(--forest);color:#fff}.source{font:.76rem/1.4 system-ui,sans-serif;color:var(--muted)}.foot{border-top:1px solid var(--line);margin-top:3.4rem;padding-top:1.2rem;font:.76rem/1.7 system-ui,sans-serif;color:var(--muted)}
.desk{background:var(--forest-deep);color:#faf7eb;padding:1.65rem 1.5rem;min-width:0;position:sticky;top:0;align-self:start;height:100dvh;overflow:auto;overscroll-behavior:contain}.desk h2{font-size:1.95rem;letter-spacing:-.03em;line-height:1.1;margin:.3rem 0 1rem}.desk .eyebrow{color:#d8a78a}.desk-sub{font:.8rem/1.6 system-ui,sans-serif;color:#c1d1c5}.quote{border-left:3px solid #cb846a;margin:1.5rem 0;padding:.4rem 0 .4rem 1rem;color:#f7f5eb;font-style:italic;overflow-wrap:anywhere}.quote small{display:block;font:700 .64rem system-ui,sans-serif;letter-spacing:.1em;color:#b8d0c0;text-transform:uppercase;margin-bottom:.65rem}.thread-title{font:700 .68rem system-ui,sans-serif;letter-spacing:.13em;text-transform:uppercase;color:#bccebe;padding-top:1.2rem;border-top:1px solid #537065}.messages{list-style:none;margin:1rem 0 1.5rem;padding:0;display:grid;gap:1rem}.message{background:#244638;border:1px solid #3e6354;border-radius:8px;padding:1rem 1rem .85rem;overflow-wrap:anywhere}.message-header{display:flex;justify-content:space-between;gap:.7rem;align-items:baseline;font:700 .7rem/1.4 system-ui,sans-serif;color:#deede0}.message time{font-weight:400;color:#b9cfc0}.message p{margin:.55rem 0 0;white-space:pre-wrap;font:.89rem/1.55 system-ui,sans-serif}.empty{font:.83rem/1.6 system-ui,sans-serif;color:#cadaaa;background:#244638;border-radius:8px;padding:1rem}.notice{font:700 .75rem/1.55 system-ui,sans-serif;color:#f0cdbb}.composer{border-top:1px solid #537065;padding-top:1rem}.composer label{display:block;font:700 .74rem/1.5 system-ui,sans-serif;margin-bottom:.6rem}.composer textarea{width:100%;background:#fffdf6;border:1px solid #9caf9f;border-radius:7px;min-height:118px;resize:vertical;padding:.85rem;color:#12291e;font:1rem/1.55 system-ui,sans-serif}.compose-actions{display:flex;align-items:center;justify-content:space-between;gap:.7rem;margin-top:.7rem;flex-wrap:wrap}.send{border:0;border-radius:6px;padding:.78rem 1.15rem;background:#eac39d;color:#143225;font:700 .79rem/1.2 system-ui,sans-serif;min-height:43px}.send:hover{background:#f8d8ae}.state{min-height:2.6rem;margin-top:.8rem;font:.78rem/1.55 system-ui,sans-serif;color:#d5e5d7}.mobile-toggle,.close{display:none}.no-script{margin:1rem 0;padding:1rem;background:#f3e0c6;color:#392617;font:.9rem system-ui,sans-serif}
@media(max-width:1300px){.layout{grid-template-columns:178px minmax(0,1fr) 320px}.contents{padding:1.45rem .9rem}.desk{padding:1.4rem 1.1rem}.sheet{padding:2rem 2.1rem 4rem}}
@media(max-width:980px){.layout{grid-template-columns:170px minmax(0,1fr)}.desk{display:none;position:fixed;inset:0;z-index:50;height:100dvh;height:100svh;max-height:100dvh;overflow:auto;padding:clamp(1.2rem,4vw,2rem);padding-top:max(1.2rem,env(safe-area-inset-top));padding-bottom:max(1.2rem,env(safe-area-inset-bottom));background:var(--forest-deep)}.desk[data-open="true"]{display:block}.mobile-toggle{display:block;position:fixed;z-index:35;bottom:max(1rem,env(safe-area-inset-bottom));right:1rem;border:0;border-radius:100px;padding:.9rem 1.15rem;background:var(--forest);color:#fff;font:700 .79rem system-ui,sans-serif;box-shadow:var(--shadow)}.close{display:inline-flex;align-items:center;justify-content:center;float:right;border:1px solid #648071;color:white;background:transparent;border-radius:100px;min-height:44px;padding:.45rem 1rem;font:.75rem system-ui,sans-serif}body[data-drawer="open"]{overflow:hidden}}
@media(max-width:600px){.top{padding:1rem}.topright{font-size:.6rem}.layout{display:block}.contents{border-right:0;border-bottom:1px solid var(--line);padding:.8rem 1rem}.contents nav{position:static}.contents ol{display:flex;gap:.6rem;overflow-x:auto;margin:.6rem 0 0;padding:0 0 .2rem}.contents li{flex:0 0 auto;border:1px solid var(--line);padding:0;border-radius:6px;margin:0;max-width:13rem}.contents a{padding:.65rem .8rem;font-size:.75rem}.contents .hint{display:none}.sheet{padding:1.35rem 1.1rem 6rem}.headline{margin:1.25rem 0}.article{margin-top:2.2rem}.passage{padding:1rem .75rem 1rem 1rem;margin:1.1rem 0}.issue-meta{font-size:.58rem}}
@media print{.topline{display:none}.top{background:white;padding:0 0 .7rem}.layout{display:block}.contents,.desk,.mobile-toggle,.discuss,.passage-tools{display:none!important}.sheet{padding:0;background:white}.headline{font-size:36pt}.article{break-before:page}.passage{border:0;padding:0;break-inside:avoid}body{background:white;color:#000}.foot{color:#555}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.passage{transition:none}}
`;

/** All reader DOM changes use textContent; no server comment may inject HTML. */
const client=String.raw`(()=>{
 'use strict';
 const root=document.getElementById('reader');
 const revision=root.dataset.revision, digest=root.dataset.digest;
 const writable=root.dataset.canReply==='true';
 const quote=document.getElementById('quote-text');
 const messages=document.getElementById('thread-messages');
 const selectedMeta=document.getElementById('selection-meta');
 const truncation=document.getElementById('truncation');
 const status=document.getElementById('thread-status');
 const form=document.getElementById('reply-form');
 const text=document.getElementById('reply-text');
 const submit=document.getElementById('submit-reply');
 const desk=document.getElementById('discussion');
 const mobile=document.getElementById('mobile-discussion');
 const closer=document.getElementById('close-discussion');
 const buttons=Array.from(document.querySelectorAll('[data-discuss]'));
 const drafts=new Map();
 const pending=new Map();
 let block=null, sequence=0, busy=false;
 const setStatus=(message)=>{status.textContent=message;};
 function openDrawer(){
  if(!matchMedia('(max-width:980px)').matches)return;
  desk.dataset.open='true';document.body.dataset.drawer='open';
  mobile.setAttribute('aria-expanded','true');closer.focus();
 }
 function closeDrawer(){
  desk.dataset.open='false';document.body.dataset.drawer='closed';
  mobile.setAttribute('aria-expanded','false');
  const active=buttons.find(b=>b.dataset.block===block);
  (active||mobile).focus();
 }
 function markSelected(id){
  for(const b of buttons){const current=b.dataset.block===id;
   b.setAttribute('aria-pressed',String(current));
   b.closest('.passage').dataset.selected=String(current);
  }
 }
 async function jsonRequest(url,options={}){
  const res=await fetch(url,{credentials:'same-origin',redirect:'manual',cache:'no-store',
   ...options,headers:{Accept:'application/json','X-Requested-With':'XMLHttpRequest',...(options.headers||{})}});
  if(res.type==='opaqueredirect'||res.redirected||res.status>=300&&res.status<400||
   res.status===401||res.status===403){throw new Error('Your session needs a fresh sign-in. Your unsent text is still here.');}
  if(!res.headers.get('Content-Type')?.toLowerCase().includes('application/json')){
   throw new Error('The server returned an unexpected response. Your text has not been cleared.');
  }
  let value;try{value=await res.json()}catch{throw new Error('The response could not be read. Try again.');}
  if(!res.ok){
   if(res.status===404)throw new Error('This discussion is unavailable or your access has changed.');
   if(res.status===409)throw new Error('A conflict occurred. Review your draft before trying again.');
   throw new Error('The request was not completed ('+res.status+'). You can retry.');
  }
  return value;
 }
 const path=id=>'/api/newsroom/conversations/'+encodeURIComponent(revision)+'/'+encodeURIComponent(id);
 function renderMessages(list){
  messages.replaceChildren();
  if(!list.length){const li=document.createElement('li');li.className='empty';
   li.textContent='No comments on this passage yet. Reading never implies approval.';messages.append(li);return;}
  for(const item of list){const li=document.createElement('li');li.className='message';
   const row=document.createElement('div');row.className='message-header';
   const who=document.createElement('span');who.textContent='Member '+item.authorSub;
   const when=document.createElement('time');
   const stamp=new Date(item.createdAt);
   when.dateTime=Number.isFinite(stamp.getTime())?stamp.toISOString():'';
   when.textContent=when.dateTime?stamp.toLocaleString():'Date unavailable';
   row.append(who,when);
   const body=document.createElement('p');body.textContent=item.text;
   li.append(row,body);messages.append(li);
  }
 }
 async function select(id,restoreFocus=false){
  if(block)drafts.set(block,text.value);
  block=id;const token=++sequence;markSelected(id);text.value=drafts.get(id)||'';
  quote.textContent='Loading the published quotation…';
  selectedMeta.textContent='Checking revision and paragraph';
  messages.replaceChildren();truncation.hidden=true;
  form.hidden=!writable;submit.disabled=true;
  setStatus('Loading the discussion…');
  try{
   const response=await jsonRequest(path(id));
   if(token!==sequence)return;
   if(response.anchor?.revisionId!==revision||response.anchor.blockId!==id||
      response.anchor.revisionSha256!==digest||!Array.isArray(response.messages)){
    throw new Error('The source revision did not match this page. Nothing was submitted.');
   }
   quote.textContent=response.anchor.text;
   selectedMeta.textContent='Edition revision '+response.anchor.version+' · passage '+id;
   renderMessages(response.messages);
   truncation.hidden=!response.truncated;
   submit.disabled=!writable||!text.value.trim();
   setStatus(writable?'Discussion loaded. Messages are not approvals.':'Read-only access: you cannot post comments.');
  }catch(err){if(token!==sequence)return;
   form.hidden=true;quote.textContent='Discussion unavailable';
   messages.replaceChildren();setStatus(err.message||'This discussion could not be loaded.');
  }
  if(restoreFocus)openDrawer();
 }
 for(const b of buttons)b.addEventListener('click',()=>select(b.dataset.block,true));
 mobile.addEventListener('click',()=>{if(desk.dataset.open==='true')closeDrawer();else openDrawer();});
 closer.addEventListener('click',closeDrawer);
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&desk.dataset.open==='true')closeDrawer();});
 text.addEventListener('input',()=>{
  if(!block)return;drafts.set(block,text.value);
  const p=pending.get(block);if(p&&p.text!==text.value.trim())pending.delete(block);
  if(form.hidden||busy)return;
  submit.disabled=!text.value.trim()||text.value.trim().length>1600;
 });
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!block||!writable)return;
  const id=block,trimmed=text.value.trim();
  if(!trimmed||trimmed.length>1600){setStatus('Write 1–1600 characters before sending.');return;}
  let operation=pending.get(id);
  if(!operation||operation.text!==trimmed){operation={text:trimmed,id:crypto.randomUUID()};pending.set(id,operation);}
  busy=true;submit.disabled=true;setStatus('Sending a comment…');
  try{
   const sent=await jsonRequest(path(id)+'/messages',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({operationId:operation.id,text:operation.text})});
   if(!sent.messageId||sent.revisionId!==revision||sent.blockId!==id){
    throw new Error('The reply receipt was not valid. You can retry with the same operation.');
   }
   pending.delete(id);drafts.delete(id);
   if(block===id){text.value='';await select(id);setStatus('Comment saved. This is not a decision or approval.');}
  }catch(err){
   if(block===id)setStatus((err.message||'Could not confirm delivery.')+' Retry uses the same operation ID.');
  }finally{busy=false;if(!form.hidden)submit.disabled=!text.value.trim()||text.value.trim().length>1600;}
 });
 window.addEventListener('resize',()=>{if(!matchMedia('(max-width:980px)').matches&&desk.dataset.open==='true'){
  desk.dataset.open='false';document.body.dataset.drawer='closed';mobile.setAttribute('aria-expanded','false');
 }});
})()`;

/** Pure server-rendered UI, with fixed per-request nonce. */
export function renderNewsroomReader(edition,revision,{canReply=false,nonce='TEST_ONLY_NONCE'}={}){
 const normalized=validateManifest(revision.manifest);
 const safe=x=>escapeHTML(x);
 const articles=normalized.articles.map((article,index)=>`<article class="article" id="article-${safe(article.id)}" aria-labelledby="heading-${safe(article.id)}"><span class="article-number">Article ${index+1} / ${normalized.articles.length}</span><h2 id="heading-${safe(article.id)}">${safe(article.title)}</h2>${article.blocks.map(block=>`<section class="passage" id="passage-${safe(block.id)}" data-selected="false" aria-label="Passage ${safe(block.id)}">${block.type==='heading'?`<h3>${safe(block.text)}</h3>`:block.type==='figure'?`<p class="figure" role="img" aria-label="Figure description">${safe(block.text)}</p>`:`<p>${safe(block.text)}</p>`}${block.sourceUri?`<p class="source">Source: <a href="${safe(block.sourceUri)}" target="_blank" rel="noopener noreferrer">${safe(new URL(block.sourceUri).hostname)}</a></p>`:''}<div class="passage-tools"><button type="button" class="discuss" data-discuss data-block="${safe(block.id)}" aria-controls="discussion" aria-pressed="false">Discuss passage</button><span class="reference">§ ${safe(block.id)}</span></div></section>`).join('')}</article>`).join('');
 const date=new Date(revision.publishedAt);const published=Number.isFinite(date.getTime())?date.toISOString().slice(0,10):'Date unavailable';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light"><title>${safe(edition.title)} · CONTINUANCE Newsroom</title><style>${css}</style></head><body><a class="skip" href="#reading">Skip to the publication</a><div class="topline"></div><header class="top"><div class="brand"><small>THE WORKING EDITION / PRIVATE NEWSROOM</small>CONTINUANCE</div><div class="topright">Editorial / issue ${safe(revision.version)}<span>Private nonclinical demonstration</span></div></header><div id="reader" class="layout" data-revision="${safe(revision.revisionId)}" data-digest="${safe(revision.sha256)}" data-can-reply="${canReply?'true':'false'}"><aside class="contents" aria-label="Article index"><nav aria-label="Contents"><p class="eyebrow">In this edition</p><ol>${normalized.articles.map((a,i)=>`<li><a href="#article-${safe(a.id)}">${i+1}. ${safe(a.title)}</a></li>`).join('')}</ol><p class="hint">Select “Discuss passage” beside a paragraph for its exact revision-linked conversation. The edition is immutable; replies do not approve work.</p></nav></aside><main class="sheet" id="reading"><div class="issue-meta"><span>Issue / revision ${safe(revision.version)}</span><span>Published ${safe(published)}</span></div><h1 class="headline">${safe(edition.title)}</h1><p class="standfirst">Original articles, linked conversations, and a durable published record. Read when it suits you; respond only where the text calls for dialogue.</p>${articles}<footer class="foot">Edition ${safe(edition.editionId)} · source digest ${safe(revision.sha256.slice(0,12))}… · Reading and discussion do not constitute authorization.</footer></main><aside class="desk" id="discussion" data-open="false" aria-labelledby="discussion-title" tabindex="-1"><button type="button" class="close" id="close-discussion">Close discussion</button><p class="eyebrow">Conversation desk</p><h2 id="discussion-title">Beside the story.</h2><p class="desk-sub">Conversations remain attached to the exact edition version and paragraph. Separate comments are not decisions.</p><blockquote class="quote"><small id="selection-meta">Choose a passage</small><span id="quote-text">Select “Discuss passage” beside the article text to open a thread.</span></blockquote><h3 class="thread-title">Paragraph discussion</h3><p class="notice" id="truncation" hidden>Only the first 100 comments are shown here. This is not a complete archive.</p><ol class="messages" id="thread-messages" aria-label="Messages"><li class="empty">Choose a passage to view its conversation.</li></ol><form class="composer" id="reply-form" hidden><label for="reply-text">Your response</label><textarea id="reply-text" maxlength="1600" placeholder="Write a response to this exact paragraph."></textarea><div class="compose-actions"><span class="desk-sub">1,600 characters max</span><button class="send" id="submit-reply" type="submit" disabled>Post comment</button></div></form><p id="thread-status" class="state" role="status" aria-live="polite"></p></aside></div><button type="button" id="mobile-discussion" class="mobile-toggle" aria-controls="discussion" aria-expanded="false">Open discussion</button><noscript><p class="no-script">The publication is readable without JavaScript. Interactive discussion requires it. No comments are sent from a disabled browser.</p></noscript><script nonce="${safe(nonce)}">${client}</script></body></html>`;
}

/** Routes are intentionally NOT mounted in station/index.mjs or newsroom.mjs. */
export function createNewsroomReaderHandler({authenticate=authorizedIdentity}={}){
 return {async fetch(request,env,ctx){
  try{
   if(env?.NEWSROOM_SYNTHETIC_ONLY!=='true'||!env.NEWSROOM_DB||!idValid(env.NEWSROOM_ORG_ID))return errorResponse(503,'not_configured');
   const url=new URL(request.url);
   if(url.origin!==env.APP_ORIGIN)return errorResponse(403,'wrong_origin');
   const parts=url.pathname.split('/').filter(Boolean);
   if(parts.length!==5||parts[0]!=='newsroom'||parts[1]!=='reader'||parts[3]!=='revisions'||
      !idValid(parts[2])||!/^[1-9][0-9]{0,5}$/.test(parts[4]))return errorResponse(404,'not_found');
   if(request.method!=='GET')return errorResponse(405,'method_not_allowed');
   let user;try{user=await authenticate(request,env,ctx)}catch{return errorResponse(401,'sign_in_required')}
   if(!user?.subject)return errorResponse(401,'sign_in_required');
   const inner=new Request(url.origin+'/api/newsroom/editions/'+parts[2]+'/revisions/'+parts[4],
     {method:'GET',headers:request.headers});
   const res=await createNewsroomHandler({authenticate:async()=>user}).fetch(inner,env,ctx);
   if(!res.ok)return errorResponse(res.status,[401,403].includes(res.status)?'sign_in_required':res.status===404?'not_found':'request_failed');
   const entry=await res.json();
   const normalized=validateManifest(entry.revision?.manifest);
   if(await sha256(canonicalJSON(normalized))!==entry.revision.sha256)return errorResponse(503,'source_integrity_error');
   const m=await env.NEWSROOM_DB.prepare(`SELECT m.role FROM nr_memberships m JOIN nr_organizations o
    ON o.org_id=m.org_id WHERE o.org_id=? AND o.classification='nonclinical'
    AND m.subject=? AND m.active=1`).bind(env.NEWSROOM_ORG_ID,user.subject).first();
   if(!m)return errorResponse(404,'not_found');
   const nonce=crypto.randomUUID().replaceAll('-','');
   const html=renderNewsroomReader(entry.edition,{...entry.revision,manifest:normalized},
     {nonce,canReply:['owner','publisher','commenter'].includes(m.role)});
   return new Response(html,{headers:{...header,'Content-Type':'text/html;charset=utf-8',
    'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`}});
  }catch{return errorResponse(503,'request_failed')}
 }};
}
