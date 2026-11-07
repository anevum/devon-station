/* Owner-private job control mounted in the recovered DevonStation shell. */
(()=>{
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const host=()=>document.getElementById('station-ai-work');
 let config=null,jobs=[],detail=null,error='',notice='',busy=false,epoch=0,timer=null,cursor=null;
 let draft={task:'',projectSlug:'',profile:'sandbox-review',spendLimitCents:50},submissionId=null,parentJobId=null;
 const executionLabels={authorized:'API authorized · not submitted',submitting:'Submission awaiting confirmation',running:'Provider turn active',waiting:'Provider needs attention',unverified:'Outcome unverified',cancel_requested:'Cancellation requested',cancelled:'Provider work stopped',completed:'Provider turn completed',failed:'Provider turn failed',blocked:'Submission blocked'};
 const terminal=phase=>['completed','failed','cancelled','blocked'].includes(phase);
 const statusOf=job=>job.execution?executionLabels[job.execution.phase]:labels[job.state];
 const labels={review:'Needs review',ready:'Plan approved · execution locked',rejected:'Rejected',cancelled:'Cancelled before execution'};
 async function api(path,body){
  const res=await fetch('/api/ai-work/'+path,{cache:'no-store',credentials:'same-origin',redirect:'manual',headers:body?{'Content-Type':'application/json'}:{},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  if(res.status===401||res.status===403||res.type==='opaqueredirect'||res.status>=300&&res.status<400)throw Error('Your owner session or project grant is unavailable. Sign in again.');
  if(!res.ok){
   if(res.status===409)throw Error('This job changed. Reload and review the saved record before trying again.');
   throw Error('The work console could not confirm this request. Reload to check saved records.');
  }
  if(!res.headers.get('Content-Type')?.includes('application/json'))throw Error('Owner session could not be confirmed.');
  return res.json();
 }
 function form(){return `<section class="panel aw-compose"><span class="eyebrow">NEW PRIVATE JOB</span><h2>What needs doing?</h2><form id="aw-create"><label for="aw-project">Project</label><select id="aw-project" required>${config.projects.map(p=>`<option value="${esc(p.slug)}" ${p.slug===draft.projectSlug?'selected':''}>${esc(p.name)}</option>`).join('')}</select><label for="aw-profile">Permission profile</label><select id="aw-profile">${Object.entries(config.profiles).map(([id,label])=>`<option value="${esc(id)}" ${id===draft.profile?'selected':''}>${id==='sandbox-review'?'Review only':'Build and test'}</option>`).join('')}</select><p class="tiny muted">Isolated sandbox only. Repository writes, publication, deployments and account connections require separate authorization.</p><label for="aw-task">Task</label><textarea id="aw-task" required maxlength="8192" rows="5" placeholder="A clear task and the evidence you expect">${esc(draft.task)}</textarea><p class="tiny muted">Keep credentials, clinical details and client information out of tasks.</p><label for="aw-cap">Proposed API cap (USD cents)</label><input id="aw-cap" type="number" min="1" max="10000" step="1" value="${esc(draft.spendLimitCents)}" required><p class="tiny muted">This records a proposed limit. ChatGPT Work credits are separate from API billing.</p>${parentJobId?'<p>New follow-up plan. Previous history is preserved; no provider session is resumed.</p>':''}<button class="primary" type="submit" ${busy?'disabled':''}>Save for review</button></form></section>`;}
 function lane(state,title){const subset=jobs.filter(j=>state.includes(j.execution?.phase??j.state));return `<section class="aw-lane" aria-label="${title}"><div class="panel-head"><h3>${title}</h3><span class="tag">${subset.length}</span></div>${subset.map(j=>`<button class="aw-job" data-aw-job="${esc(j.jobId)}" ${detail?.jobId===j.jobId?'aria-current="true"':''}><strong>${esc(config.projects.find(p=>p.slug===j.projectSlug)?.name??'Project')}</strong><span>${esc(statusOf(j))}</span><span class="tiny muted">${esc(new Date(j.createdAt).toLocaleString())}</span></button>`).join('')||'<p class="tiny muted">No jobs here.</p>'}</section>`;}
 function reader(){
  if(!detail)return '<section class="panel aw-reader"><h2>Review a job</h2><p class="muted">Choose a saved job to inspect its task, limits and decision history.</p></section>';
  const d=detail,run=d.execution;
  const controls=run?(!terminal(run.phase)&&run.phase!=='cancel_requested'?`<button data-aw-action="cancel" ${busy?'disabled':''}>Request cancellation</button>`:''):
   (d.state==='review'?`<button data-aw-action="approve-plan" class="primary" ${busy?'disabled':''}>Approve plan only</button><button data-aw-action="reject" ${busy?'disabled':''}>Reject plan</button>`:'')+
   (['review','ready'].includes(d.state)?`<button data-aw-action="cancel" ${busy?'disabled':''}>Cancel pending job</button>`:`<button data-aw-followup ${busy?'disabled':''}>Prepare follow-up plan</button>`);
  const output=run?`<section aria-label="Private execution record"><h3>Execution record</h3><p>Authorized session cap: <strong>$${(run.approvedLimitCents/100).toFixed(2)}</strong>.</p><p>Provider-reported consumption: ${run.usage?.consumedCents!==null&&run.usage?.consumedCents!==undefined?'$'+(run.usage.consumedCents/100).toFixed(2):'unknown'} (best effort; may change).</p><p>${run.providerOutcomeConfirmed?'Root turn outcome confirmed by provider readback.':'Provider outcome is not confirmed.'} Task results still need independent review.</p>${run.lastError?'<p class="aw-lock">Recovery or owner review is required. This job will not restart automatically.</p>':''}<h3>Private output</h3>${run.outputText?`<pre class="aw-text">${esc(run.outputText)}</pre>`:'<p class="muted">No private output has been recovered.</p>'}<p class="tiny muted">${run.outputTruncated?'Output reached its storage limit.':run.outputComplete?'Streamed output was saved.':'Saved output may be incomplete after interruption.'}</p><h3>Execution evidence</h3>${run.evidence.length?`<ul>${run.evidence.map(e=>`<li>Provider root-turn readback: ${esc(e.status)} · ${esc(new Date(e.at).toLocaleString())}</li>`).join('')}</ul>`:'<p class="muted">No provider readback evidence yet.</p>'}<details><summary>Private session identity</summary><p class="aw-text">Session: ${esc(run.sessionId??'Not yet recovered')}<br>Turn: ${esc(run.turnId??'Not yet recovered')}</p></details></section>`:'<h3>Output and evidence</h3><p class="muted">No agent has run for this job. No output, test results or code changes are claimed.</p>';
  return `<section class="panel aw-reader" aria-label="Private job detail"><div class="panel-head"><h2>Job review</h2><span class="tag">${esc(statusOf(d))}</span></div><p>${esc(config.projects.find(p=>p.slug===d.projectSlug)?.name)} · ${esc(config.profiles[d.profile])}</p><pre class="aw-text">${esc(d.task)}</pre><p>Proposed cap: <strong>$${(d.spendLimitCents/100).toFixed(2)}</strong>. ${run?'Execution authority is recorded separately from the plan.':'Billing is not authorized.'}</p><p class="aw-lock">${run?'Cancellation requests need provider confirmation. This console cannot start new API execution.':'Execution is not connected. Approving this plan saves your decision and makes no API request.'}</p><div class="button-row">${controls}</div>${output}<h3>Decision history</h3><ol>${d.history.map(h=>`<li>${esc(labels[h.state])} · ${esc(new Date(h.at).toLocaleString())}</li>`).join('')}</ol>${d.parentJobId?'<p class="tiny muted">This is a follow-up plan linked to a previous closed plan.</p>':''}</section>`;
 }

 function draw(focus){
  const root=host();if(!root)return;
  root.setAttribute('aria-busy',String(busy));
  root.innerHTML=`<div class="aw-hero"><div><span class="eyebrow">PRIVATE WORK / OWNER CONTROL</span><h2>Intent. Evidence. Your call.</h2><p>Keep parallel work organized, review its boundaries, and retain every decision.</p></div><div class="aw-privacy"><strong>Private by default</strong><span>Public sharing off</span><span>API execution locked</span></div></div><p id="aw-status" role="status" tabindex="-1">${esc(notice)}</p><p id="aw-error" class="error" role="alert" tabindex="-1">${esc(error)}</p><div class="button-row"><button data-aw-reload ${busy?'disabled':''}>Reload jobs</button><span class="tiny muted">Encrypted private storage · not saved in browser storage</span></div>${config?`<div class="aw-layout">${form()}<div class="aw-supervision"><div class="aw-lanes">${lane(['review'],'Review')}${lane(['ready','authorized','submitting','running','waiting','unverified','cancel_requested'],'Work')}${lane(['rejected','cancelled','completed','failed','blocked'],'Closed')}</div>${cursor?'<button data-aw-more>Load older jobs</button>':''}${reader()}</div></div>`:'<section class="panel"><h2>Owner connection required</h2><p>Private job storage, project grants and encryption must be configured before the console can open.</p></section>'}`;
  if(focus)document.getElementById(focus)?.focus({preventScroll:true});
 }
 async function load({quiet=false,more=false}={}){
  if(busy)return;
  const mine=epoch;
  if(!quiet){busy=true;error='';draw();}
  try{
   const nextConfig=await api('config');if(mine!==epoch)return;
   const result=await api('jobs'+(more&&cursor?'?cursor='+encodeURIComponent(cursor):''));if(mine!==epoch)return;
   config=nextConfig;
   draft.projectSlug=config.projects.some(p=>p.slug===draft.projectSlug)?draft.projectSlug:config.projects[0]?.slug;
   if(quiet){
    // Revoke a selected project immediately, without retaining its private content.
    if(detail&&!config.projects.some(p=>p.slug===detail.projectSlug)){detail=null;error='Project access was revoked.';draw();}
    const previous=JSON.stringify(jobs);
    const fresh=result.jobs.find(j=>j.jobId===detail?.jobId),active=document.activeElement;
    const detailChanged=detail&&fresh&&(fresh.revision!==detail.revision||fresh.execution?.revision!==detail.execution?.revision);
    if(previous===JSON.stringify(result.jobs)&&!detailChanged)return;
    if(active?.closest('.aw-lanes')){const status=document.getElementById('aw-status');if(status)status.textContent='Saved jobs changed. Reload or leave the job list to refresh it.';return;}
    const readerHost=host()?.querySelector('.aw-reader');
    const readerFocused=readerHost?.contains(active);
    jobs=[...result.jobs,...jobs.filter(j=>!result.jobs.some(n=>n.jobId===j.jobId)&&config.projects.some(p=>p.slug===j.projectSlug))];
    const lanes=host()?.querySelector('.aw-lanes');
    if(lanes)lanes.innerHTML=lane(['review'],'Review')+lane(['ready','authorized','submitting','running','waiting','unverified','cancel_requested'],'Work')+lane(['rejected','cancelled','completed','failed','blocked'],'Closed');
    if(detailChanged&&!readerFocused){
     const response=await api('jobs/'+detail.jobId);if(mine!==epoch)return;detail=response.job;
     if(readerHost)readerHost.outerHTML=reader();
     notice='Saved execution updated. Task results still need independent review.';
    }else notice='Saved jobs updated. Reload to refresh a review you are using.';
    // The compose form and a focused review are never replaced by a poll.
    const status=document.getElementById('aw-status');if(status)status.textContent=notice;return;
   }
   jobs=more?[...jobs,...result.jobs.filter(j=>!jobs.some(x=>x.jobId===j.jobId))]:result.jobs;cursor=result.nextCursor;
   if(detail){const response=await api('jobs/'+detail.jobId);if(mine!==epoch)return;detail=response.job;}
   notice='Saved jobs loaded. API execution and public sharing remain off.';
  }catch(e){if(mine===epoch){error=e.message;detail=null;if(!quiet){config=null;jobs=[];}else{config=null;jobs=[];draft.task='';draw();}}}
  finally{if(mine===epoch&&!quiet){busy=false;draw('aw-status');}}
 }
 async function change(action){
  if(busy||!detail)return;const mine=epoch,id=detail.jobId,revision=detail.revision,executionRevision=detail.execution?.revision;busy=true;error='';draw();
  try{
   await api('jobs/'+id+'/'+(action==='cancel'?'cancel':'decision'),{expectedRevision:revision,...(action==='cancel'?(executionRevision?{expectedExecutionRevision:executionRevision}:{}):{decision:action})});
   if(mine!==epoch)return;detail=(await api('jobs/'+id)).job;if(mine!==epoch)return;
   const response=await api('jobs');if(mine!==epoch)return;jobs=response.jobs;cursor=response.nextCursor;notice='Decision saved. No provider call or public activity was sent.';
  }catch(e){if(mine===epoch){error=e.message;detail=null;}}
  finally{if(mine===epoch){busy=false;draw('aw-status');}}
 }
 document.addEventListener('input',e=>{
  if(!e.target.closest('#station-ai-work'))return;
  const fields={'aw-task':'task','aw-project':'projectSlug','aw-profile':'profile','aw-cap':'spendLimitCents'};
  if(fields[e.target.id]){draft[fields[e.target.id]]=e.target.id==='aw-cap'?Number(e.target.value):e.target.value;submissionId=null;}
 });
 document.addEventListener('submit',async e=>{
  if(e.target.id!=='aw-create')return;e.preventDefault();if(busy)return;
  const mine=epoch;busy=true;error='';submissionId??=crypto.randomUUID();draw();
  try{
   const result=await api('jobs',{...draft,jobId:submissionId,...(parentJobId?{parentJobId}:{})});if(mine!==epoch)return;
   detail=(await api('jobs/'+result.job.jobId)).job;if(mine!==epoch)return;
   const response=await api('jobs');if(mine!==epoch)return;jobs=response.jobs;cursor=response.nextCursor;draft.task='';submissionId=null;parentJobId=null;notice='Private job saved for review. Nothing has executed.';
  }catch(e){if(mine===epoch)error=e.message;}
  finally{if(mine===epoch){busy=false;draw('aw-status');}}
 });
 document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b?.closest('#station-ai-work')||busy)return;
  if(b.hasAttribute('data-aw-reload'))return load();
  if(b.hasAttribute('data-aw-more'))return load({more:true});
  if(b.dataset.awAction)return change(b.dataset.awAction);
  if(b.hasAttribute('data-aw-followup')&&detail){draft={task:'',projectSlug:detail.projectSlug,profile:detail.profile,spendLimitCents:detail.spendLimitCents};parentJobId=detail.jobId;submissionId=null;draw('aw-task');return;}
  if(b.dataset.awJob){
   const mine=epoch;busy=true;error='';
   try{const response=await api('jobs/'+b.dataset.awJob);if(mine===epoch)detail=response.job;}
   catch(e){if(mine===epoch){error=e.message;detail=null;}}
   finally{if(mine===epoch){busy=false;draw('aw-status');}}
  }
 });
 globalThis.StationAiWork=Object.freeze({mounted(section){
  clearInterval(timer);timer=null;epoch++;busy=false;
  if(section!=='aiwork'){config=null;jobs=[];detail=null;draft.task='';submissionId=null;parentJobId=null;return;}
  draw();void load();timer=setInterval(()=>{if(!document.hidden&&host())void load({quiet:true});},10000);
 }});
 if(host())globalThis.StationAiWork.mounted('aiwork');
})();
