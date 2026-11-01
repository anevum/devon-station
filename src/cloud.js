/* Owner-only hosted synchronization. The private local snapshot build never loads this module. */
(()=>{
 if(!/^https:\/\//.test(location.origin))return;
 let revision=0,mode='connecting',remoteState=null,opQueue=Promise.resolve(),pending=false;
 let portfolioConfigured=false,lastConflictCount=0;
 // The confirmation baseline belongs to this tab, not shared localStorage.
 // A cross-tab baseline can misclassify another tab's new draft as a deletion.
 const SYNC_CONFIRMED_KEY='devon-station:confirmed:tab:v2';
 const LEGACY_SYNC_CONFIRMED_KEY='devon-station:confirmed:v1';
 let externalEpoch=0;
 const label=()=>document.getElementById('local-state');
 const state=()=>({version:1,prefs:{...local.prefs},drafts:local.drafts,feedback:local.feedback,outcomes:local.outcomes,history:local.history});
 function confirmed(){
  try{
   const current=readConfirmedSnapshot(JSON.parse(sessionStorage.getItem(SYNC_CONFIRMED_KEY)));
   if(current)return current;
   // One-time backwards-compatible migration is safe only for an identical
   // device snapshot; never assume a shared baseline from a different tab.
   const legacy=trustedLegacyTabBaseline(state(),JSON.parse(localStorage.getItem(LEGACY_SYNC_CONFIRMED_KEY)));
   if(legacy){
    sessionStorage.setItem(SYNC_CONFIRMED_KEY,JSON.stringify(legacy));
    return legacy;
   }
  }catch{}
  return null;
 }
 function acknowledge(rev,value){
  // Record only server-acknowledged data. Never mark an unconfirmed local edit synced.
  try{sessionStorage.setItem(SYNC_CONFIRMED_KEY,JSON.stringify({version:1,revision:rev,state:value}))}catch{}
  // Clearing this tab's journal is safe only when all edits were confirmed.
  if(syncEqual(state(),value))try{sessionStorage.removeItem(TAB_RECOVERY_KEY)}catch{}
  try{localStorage.removeItem(LEGACY_SYNC_CONFIRMED_KEY)}catch{}
 }
 const setStatus=(message)=>{
  const e=label();if(e)e.textContent=message;
  const mobile=document.getElementById('cloud-status-mobile');if(mobile)mobile.textContent=message;
  const importButton=document.getElementById('cloud-import');
  refreshRecoveryHealth?.();
  if(importButton){
   importButton.hidden=!['import-required','blocked'].includes(mode);
   importButton.textContent=mode==='blocked'?'Retry private sync':'Review device changes';
  }
 };
 async function api(method,body){
  const response=await fetch('/api/state',{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store'});
  if(!response.headers.get('Content-Type')?.includes('application/json'))throw Error('Sign-in or private API unavailable');
  const data=await response.json();if(!response.ok){const err=Error(data.error||'Private API unavailable');err.status=response.status;throw err;}
  return data;
 }
 function hydrate(data){
  local=restoreLocal(data,SNAPSHOT.projects);applyPrefs();
  try{localStorage.setItem(KEY,JSON.stringify({version:1,...local}))}catch{}
  render();
 }
 function hasDeviceChanges(s){
  return s.drafts.length>0||s.feedback.length>0||s.history.length>0||s.outcomes.length>0||!syncEqual(s.prefs,DEFAULTS);
 }
 function enqueue(value){
  opQueue=opQueue.then(async()=>{
   if(mode!=='live')return;
   const saveEpoch=externalEpoch;
   setStatus('Saving to private storage…');
   try{
    const response=await api('POST',{expectedRevision:revision,operationId:crypto.randomUUID(),action:'Owner workspace changed',state:value});
    if(response.superseded){const conflict=Error('Older save was superseded');conflict.status=409;throw conflict;}
    if(externalEpoch!==saveEpoch||mode!=='live')return; // Other tab changed shared storage during flight.
    revision=response.currentRevision??response.revision;
    acknowledge(revision,value);
    if(syncEqual(state(),value))pending=false;
    setStatus('Private storage synced · revision '+revision);
   }catch(error){
    pending=true;
    if(externalEpoch!==saveEpoch)return;
    mode=error.status===409?'import-required':'blocked';
    setStatus(error.status===409?'Sync conflict · local changes preserved. Review device changes.':'Sync unavailable · device changes preserved. Export before switching devices.');
   }
  });
 }
 async function readPortfolio(method='GET'){
  const response=await fetch(method==='POST'?'/api/portfolio/refresh':'/api/portfolio',{method,headers:method==='POST'?{'Content-Type':'application/json'}:{},body:method==='POST'?'{}':undefined,credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw Error('Notion project cache unavailable');
  const data=await response.json();portfolioConfigured=!!data.configured;
  const button=document.getElementById('portfolio-refresh');if(button)button.hidden=!portfolioConfigured;
  // An authoritative empty result must clear a previously loaded cache.
  if(Array.isArray(data.projects)){
   SNAPSHOT.projects=data.projects.slice(0,150);SNAPSHOT.mode='Notion read-only metadata cache';
   render();
  }
  return data;
 }
 async function start(){
  const startEpoch=externalEpoch;
  setStatus('Connecting to private storage…');
  try{
   const current=await api('GET');
   if(externalEpoch!==startEpoch){mode='import-required';setStatus('Other tab changed device data · review before syncing');return;}
   revision=current.revision;remoteState=current.state;
   const device=state(),base=confirmed();
   // Previously synced data that has not been edited on this device is not an
   // unsaved draft; adopt the most recent revision automatically.
   if(syncEqual(device,remoteState)||(!pending&&(shouldAdoptRemote(device,base)||!hasDeviceChanges(device)))){
    mode='live';pending=false;hydrate(remoteState);acknowledge(revision,state());setStatus('Private storage connected · revision '+revision);
   }else{
    mode='import-required';setStatus('Device changes require review · private storage untouched');
   }
   await readPortfolio().catch(()=>{});
  }catch(error){mode='blocked';setStatus('Private sync offline · device-only changes. Export to protect data.');}
 }
 let activeReview=null,reviewDialog=null;
 function labelForConflict(key){
  if(key.startsWith('drafts:'))return 'Draft edited on two devices';
  if(key.startsWith('feedback:'))return 'Feedback edited on two devices';
  if(key.startsWith('prefs:'))return 'Setting changed on two devices · '+key.slice(6);
  if(key==='outcomes')return 'Focus marks changed on two devices';
  return 'Concurrent changes';
 }
 function previewConflict(key,s){
  if(key.startsWith('drafts:')){
   const value=s.drafts.find(x=>x.id===key.slice(7));
   return value?value.title+'\n'+value.state:'Deleted on this device';
  }
  if(key.startsWith('feedback:')){
   const value=s.feedback.find(x=>x.id===key.slice(9));
   return value?value.note+'\n'+value.state:'Deleted on this device';
  }
  if(key.startsWith('prefs:'))return String(s.prefs[key.slice(6)]??'Unspecified');
  if(key==='outcomes')return s.outcomes.length?s.outcomes.join(', '):'No focus marks';
  return 'Unable to preview';
 }
 function element(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
 function setupReviewDialog(){
  if(reviewDialog)return reviewDialog;
  const dialog=document.createElement('dialog');dialog.id='sync-review-dialog';dialog.setAttribute('aria-labelledby','sync-review-title');
  const form=document.createElement('form');form.id='sync-review-form';form.noValidate=true;
  const head=element('div','dialog-head');const h=element('h2','', 'Review simultaneous changes');h.id='sync-review-title';head.append(h);
  const close=element('button','icon-button','×');close.type='button';close.setAttribute('aria-label','Cancel conflict review');close.addEventListener('click',()=>dialog.close());head.append(close);
  form.append(head,element('p','review-intro','Choose one version for each conflicting item. Other independent changes are kept. No cloud data changes until you confirm.'));
  const items=element('div','');items.id='sync-review-items';form.append(items);
  const error=element('p','error');error.id='sync-review-error';error.setAttribute('role','alert');form.append(error);
  const buttons=element('div','dialog-actions');const cancel=element('button','','Cancel');cancel.type='button';cancel.addEventListener('click',()=>dialog.close());
  const apply=element('button','primary','Apply reviewed choices');apply.type='submit';apply.id='sync-review-apply';buttons.append(cancel,apply);form.append(buttons);
  dialog.append(form);document.body.append(dialog);
  form.addEventListener('submit',submitReviewedChoices);
  dialog.addEventListener('close',()=>{
   activeReview=null;
   if(mode==='reviewing'){mode='import-required';setStatus('Review cancelled · device and cloud changes preserved');}
  });
  reviewDialog=dialog;return dialog;
 }
 function openConflictReview(device,base,latest,conflicts){
  if(conflicts.some(x=>x.endsWith(':limit'))||conflicts.length>30){mode='import-required';setStatus('Too many concurrent changes · export notes and reduce the list before syncing');return;}
  const dialog=setupReviewDialog(),container=dialog.querySelector('#sync-review-items');container.replaceChildren();
  activeReview={device:JSON.parse(JSON.stringify(device)),base:base?JSON.parse(JSON.stringify(base)):null,remote:JSON.parse(JSON.stringify(latest.state)),revision:latest.revision,conflicts:[...conflicts]};
  for(const [i,key] of conflicts.entries()){
   const group=element('fieldset','sync-review-item');const legend=element('legend','',labelForConflict(key));group.append(legend);
   const grid=element('div','sync-review-grid');
   for(const [choice,name,snapshot] of [['device','This device',device],['cloud','Private cloud',latest.state]]){
    const option=element('label','sync-review-choice');const radio=document.createElement('input');radio.type='radio';radio.name='sync-choice-'+i;radio.value=choice;radio.required=true;
    const content=element('div','');content.append(element('strong','',name),element('span','',previewConflict(key,snapshot)));
    option.append(radio,content);grid.append(option);
   }
   group.append(grid);container.append(group);
  }
  dialog.querySelector('#sync-review-error').textContent='';dialog.querySelector('#sync-review-apply').disabled=false;
  mode='reviewing';setStatus(conflicts.length+' conflicting '+(conflicts.length===1?'edit':'edits')+' · choose a version for each to continue');
  dialog.showModal();dialog.querySelector('input[type=radio]')?.focus();
 }
 async function submitReviewedChoices(event){
  event.preventDefault();if(!activeReview||mode!=='reviewing')return;
  const form=event.currentTarget,button=form.querySelector('#sync-review-apply'),error=form.querySelector('#sync-review-error');
  const choices=Object.create(null);
  for(let i=0;i<activeReview.conflicts.length;i++){
   const selected=form.querySelector(`input[name="sync-choice-${i}"]:checked`);
   if(!selected){error.textContent='Choose a version for every conflicting item before continuing.';return;}
   choices[activeReview.conflicts[i]]=selected.value;
  }
  button.disabled=true;error.textContent='';const data=activeReview;
  try{
   if(!syncEqual(state(),data.device))throw Object.assign(Error('Device notes changed during review. Reopen the review.'),{status:409});
   const latest=await api('GET');
   if(latest.revision!==data.revision||!syncEqual(latest.state,data.remote))throw Object.assign(Error('Cloud changed during review. Review the latest version before saving.'),{status:409});
   const merged=resolveOwnerConflicts(data.base?.state??null,data.device,data.remote,choices);
   if(syncEqual(merged,latest.state)){
    revision=latest.revision;mode='live';pending=false;remoteState=latest.state;
    hydrate(latest.state);acknowledge(revision,state());setStatus('Cloud version retained · private revision '+revision);reviewDialog.close();return;
   }
   const result=await api('POST',{expectedRevision:latest.revision,operationId:crypto.randomUUID(),action:'Owner-reviewed concurrent edits',state:merged});
   if(result.superseded)throw Object.assign(Error('Cloud changed while saving. Review again.'),{status:409});
   revision=result.currentRevision??result.revision;mode='live';pending=false;remoteState=merged;
   hydrate(merged);acknowledge(revision,state());setStatus('Reviewed choices saved · private revision '+revision);reviewDialog.close();
  }catch(e){
   if(e.status===409){mode='import-required';setStatus('Review must restart · local notes preserved');reviewDialog.close();}
   else error.textContent='Could not save the review. Your local and cloud notes are unchanged. '+(e.message||'');
  }finally{button.disabled=false;}
 }

 async function importDevice(){
  if(mode==='blocked'){mode='connecting';setStatus('Reconnecting…');await start();return;}
  if(mode!=='import-required')return;
  mode='importing';setStatus('Checking latest private revision…');
  try{
   const latest=await api('GET'),device=state(),base=confirmed();
   if(base&&latest.revision<base.revision){mode='import-required';setStatus('Cloud revision older than this device · export notes and inspect recovery.');return;}
   if(device.drafts.some(d=>d.project!=null||d.destination!=null)){
    mode='import-required';setStatus('Project-linked drafts need manual review. Export before changing data.');return;
   }
   const reconciled=reconcileOwnerStates(base?.state??null,device,latest.state);
   if(!reconciled.safe){
    lastConflictCount=reconciled.conflicts.length;
    openConflictReview(device,base,latest,reconciled.conflicts);
    return;
   }
   // Even a clean merge uses a fresh revision to avoid races after the GET.
   // Do not generate an unnecessary write when there is nothing to import.
   if(syncEqual(reconciled.state,latest.state)){
    revision=latest.revision;mode='live';pending=false;hydrate(latest.state);acknowledge(revision,state());setStatus('Private storage current · revision '+revision);return;
   }
   const response=await api('POST',{expectedRevision:latest.revision,operationId:crypto.randomUUID(),action:'Explicit three-way device reconciliation',state:reconciled.state});
   if(response.superseded)throw Object.assign(Error('Superseded reconciliation'),{status:409});
   revision=response.revision;mode='live';pending=false;remoteState=reconciled.state;
   hydrate(reconciled.state);acknowledge(revision,state());setStatus('Device changes safely merged · private revision '+revision);
  }catch(error){mode='import-required';setStatus(error.status===409?'Revision changed during merge · retry after exporting notes':'Review not completed · '+error.message);}
 }
 globalThis.StationCloud={get ready(){return mode==='live'},get diagnostics(){return {mode,revision,pending,externalChange:externalEpoch>0}},async stageBackupRestore(){
  if(mode==='connecting'||mode==='importing'||mode==='reviewing')return false;
  await opQueue.catch(()=>{});
  // The imported file has no trusted relationship to this device's previous
  // acknowledged snapshot. Never auto-post a restored backup to cloud.
  mode='import-required';pending=true;
  try{sessionStorage.removeItem(SYNC_CONFIRMED_KEY);localStorage.removeItem(LEGACY_SYNC_CONFIRMED_KEY)}catch{}
  setStatus('Encrypted backup staged · review device changes before cloud sync');
  return true;
 },onExternalChange(){
  externalEpoch++;pending=true;
  // Closing an open review invalidates its stale snapshot and choices.
  if(reviewDialog?.open)reviewDialog.close();
  mode='import-required';
  setStatus('Another tab changed device storage · your notes are preserved. Review before syncing.');
 },onLocalChange(){pending=true;if(mode==='live')enqueue(JSON.parse(JSON.stringify(state())));else if(mode==='connecting')setStatus('Waiting for private storage…');else setStatus('Device-only changes · export or review required');}};
 document.getElementById('cloud-import')?.addEventListener('click',importDevice);
 document.getElementById('portfolio-refresh')?.addEventListener('click',async()=>{
  if(!portfolioConfigured)return;const b=document.getElementById('portfolio-refresh');b.disabled=true;
  try{const result=await readPortfolio('POST');setStatus('Notion read-only project cache refreshed · '+result.projects.length+' projects');}
  catch{setStatus('Notion refresh failed · existing project cache preserved');}
  finally{b.disabled=false;}
 });
 start();
})();
