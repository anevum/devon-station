/* Original RB01 project/decision component, mounted inside the recovered app. */
(()=>{
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let scopes=[],scope=null,state=null,projectId=null,reviewId=null,busy=false,started=false,error='',notice='',draft='',epoch=0;
 const host=()=>document.getElementById('station-workspace');
 const scopeKey=s=>s.scopeKind+':'+s.scopeId;
 const query=()=>new URLSearchParams(scope).toString();
 const title=s=>s.scopeKind[0].toUpperCase()+s.scopeKind.slice(1)+' / '+s.scopeId;
 const date=value=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
 async function api(path,body){
  const response=await fetch(path,{cache:'no-store',credentials:'same-origin',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error(response.status===401||response.status===403?'Your session or scope is no longer authorized. Sign in again or choose an approved workspace.':response.status===409?'The workspace changed. Reload and review its current state before continuing.':'The workspace could not confirm this request. Reload to check saved records before trying again.');
  return response.json();
 }
 function draw(focus){
  const root=host();if(!root)return;
  const projects=state?.projects??[],project=projects.find(x=>x.projectId===projectId),actions=(state?.actions??[]).filter(x=>x.projectId===projectId),review=actions.find(x=>x.recordId===reviewId);
  root.setAttribute('aria-busy',String(busy));
  root.innerHTML=`<div class="ws-toolbar"><div><label for="ws-scope">Workspace boundary</label><select id="ws-scope" ${busy?'disabled':''}>${scopes.map(s=>`<option value="${escape(scopeKey(s))}" ${scope&&scopeKey(scope)===scopeKey(s)?'selected':''}>${escape(title(s))}</option>`).join('')}</select></div><button data-ws-reload ${busy?'disabled':''}>${busy?'Loading…':'Reload workspace'}</button></div>
   <p class="ws-notice">Approvals record your decision. External operations require their own authorized workflow.</p>
   <p id="ws-status" tabindex="-1" role="status" aria-live="polite">${escape(notice)}</p><p id="ws-error" role="alert" class="error">${escape(error)}</p>
   ${state?`<div class="ws-layout"><nav class="ws-projects" aria-label="Approved projects"><h2>Projects <span class="count-label">${projects.length}</span></h2>${projects.length?projects.map(p=>`<button data-ws-project="${escape(p.projectId)}" ${p.projectId===projectId?'aria-current="true"':''}><strong>${escape(p.title)}</strong><span>Source-linked · ${escape(p.freshness)}</span></button>`).join(''):'<p class="muted">No approved project metadata is available in this scope.</p>'}</nav>
   <div class="ws-content">${project?`<section class="panel ws-project-header"><span class="eyebrow">PROJECT WORKSPACE</span><h2 id="ws-project-title" tabindex="-1">${escape(project.title)}</h2><p class="muted">Source observed ${escape(date(project.source.observedAt))}</p><a class="source-link" href="${escape(project.source.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open project source ↗</a></section>
   <section class="panel"><h2>Propose the next action</h2><form id="ws-proposal"><label for="ws-summary">Action to review</label><textarea id="ws-summary" rows="3" required maxlength="180" ${busy?'disabled':''} placeholder="One clear, non-sensitive next step">${escape(draft)}</textarea><p class="tiny muted">Keep personal records, clinical information and credentials out of proposals.</p><button type="submit" class="primary" ${busy?'disabled':''}>Create proposal</button></form></section>
   ${review?`<section class="panel ws-review" aria-labelledby="ws-review-title"><span class="eyebrow">REVIEW BEFORE DECIDING</span><h2 id="ws-review-title" tabindex="-1">${escape(review.summary)}</h2><p>Project: ${escape(project.title)}</p><p>Approval records this decision only. It does not run the action.</p><div class="button-row"><button class="primary" data-ws-decision="approved" ${busy?'disabled':''}>Approve record</button><button data-ws-decision="rejected" ${busy?'disabled':''}>Reject record</button><button data-ws-cancel ${busy?'disabled':''}>Back to proposals</button></div></section>`:''}
   <section class="panel"><h2>Action journal</h2>${actions.length?actions.slice().reverse().map(a=>`<article class="ws-action"><div class="ws-action-head"><h3>${escape(a.summary)}</h3><span class="tag">${escape(a.status)}</span></div><p class="tiny muted">Updated ${escape(date(a.updatedAt))}</p>${a.status==='proposed'?`<button data-ws-review="${escape(a.recordId)}" ${busy?'disabled':''}>Review proposal</button>`:''}<details><summary>Decision history · ${a.revision} ${a.revision===1?'record':'records'}</summary><ol>${state.receipts.filter(r=>r.recordId===a.recordId).map(r=>`<li><strong>${escape(r.result)}</strong> · ${escape(date(r.timestamp))}<br><span class="tiny muted ws-reference">Receipt ${escape(r.receiptId)}</span></li>`).join('')}</ol></details></article>`).join(''):'<p class="muted">No actions yet. Start with one useful proposal.</p>'}</section>`:'<section class="panel"><h2>Choose a project</h2><p class="muted">Only explicitly approved, source-linked projects appear here.</p></section>'}</div></div>`:!busy&&!error?'<section class="panel"><h2>No workspace authorized</h2><p class="muted">An owner must configure explicit scope and project grants before this workflow is available.</p></section>':''}`;
  if(focus)document.getElementById(focus)?.focus({preventScroll:true});
 }
 async function load(changeScope){
  const mine=++epoch;busy=true;error='';notice='';state=null;reviewId=null;if(changeScope){draft='';projectId=null;}draw();
  try{
   const response=await api('/api/workspaces');if(mine!==epoch)return;scopes=response.scopes;
   scope=scopes.find(s=>scope&&scopeKey(s)===scopeKey(scope))??scopes[0]??null;
   if(scope){const next=await api('/api/workspace?'+query());if(mine!==epoch)return;state=next;projectId=next.projects.some(p=>p.projectId===projectId)?projectId:next.projects[0]?.projectId;notice='Workspace loaded. Saved decisions are up to date.';}
  }catch(e){if(mine===epoch){state=null;error=e.message;}}
  finally{if(mine===epoch){busy=false;draw();}}
 }
 async function mutate(kind,input){
  if(busy||!state)return;busy=true;error='';notice='';draw();
  try{state=await api('/api/workspace/'+kind+'?'+query(),{expectedGeneration:state.generation,input});notice=kind==='propose'?'Proposal saved. Review it before deciding.':`Decision saved: ${input.decision}. No external operation was run.`;if(kind==='propose')draft='';reviewId=null;}
  catch(e){state=null;reviewId=null;error=e.message;}
  finally{busy=false;draw('ws-status');}
 }
 document.addEventListener('input',e=>{if(e.target.id==='ws-summary')draft=e.target.value;});
 document.addEventListener('change',e=>{if(e.target.id==='ws-scope'&&!busy){scope=scopes.find(s=>scopeKey(s)===e.target.value);load(true);}});
 document.addEventListener('submit',e=>{if(e.target.id!=='ws-proposal')return;e.preventDefault();if(busy||!projectId)return;const summary=draft.trim();if(!summary)return;mutate('propose',{operationId:crypto.randomUUID(),recordId:crypto.randomUUID(),projectId,summary,expectedRevision:0});});
 document.addEventListener('click',e=>{
  const button=e.target.closest('button');if(!button||busy)return;const d=button.dataset;
  if('wsReload'in d)load(false);
  else if(d.wsProject){projectId=d.wsProject;reviewId=null;draft='';notice='';draw('ws-project-title');}
  else if(d.wsReview){reviewId=d.wsReview;draw('ws-review-title');}
  else if('wsCancel'in d){reviewId=null;draw('ws-project-title');}
  else if(d.wsDecision){const a=state?.actions.find(x=>x.recordId===reviewId);if(a)mutate('decide',{operationId:crypto.randomUUID(),recordId:a.recordId,decision:d.wsDecision,expectedRevision:a.revision});}
 });
 globalThis.StationWorkspace={mounted(){if(!host())return;if(!started){started=true;load(false);}else draw();}};
 globalThis.StationWorkspace.mounted();
})();
