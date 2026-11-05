// COMMS-19: owner-only saved drafts, persisted delivery lineage and twice-confirmed SMTP.
// No automatic sending, retries, HTML execution, browser credentials or agent actions.
// DOM is composed exclusively with createElement/textContent/value, not innerHTML.
(function(){
'use strict';
const path='/api/mail/drafts';
const state={enabled:false,loaded:false,busy:false,items:[],selected:null,working:null,
 dirty:false,error:null,notice:null,pendingCreate:null,pendingSave:null,
 outgoingEnabled:false,outboxEnabled:false,pendingSend:null,outboxItems:[],outboxLoaded:false,outboxError:null,sentEvidence:null,sentEvidenceErrorId:null,archiveCopy:null,archiveErrorId:null,archiveEpoch:0,
 archiveEntries:[],archiveLoaded:false,archiveHasMore:false,archiveError:null};
const element=(tag,kind,text)=>{
 const el=document.createElement(tag);
 if(kind)el.className=kind;
 if(text!==undefined)el.textContent=String(text);
 return el;
};
const action=(text,name)=>{
 const el=element('button','mail-draft-action',text);
 el.type='button';el.dataset.mailDraftAction=name;return el;
};
const uuid=()=>globalThis.crypto?.randomUUID?.();
const deliveryIdValid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function isDraft(item){
 return item&&typeof item.id==='string'&&/^[0-9a-f-]{36}$/i.test(item.id)&&
 Number.isSafeInteger(item.revision)&&item.revision>=1&&Array.isArray(item.to)&&
 item.to.length<=20&&item.to.every(a=>typeof a==='string'&&a.length<=254)&&
 typeof item.subject==='string'&&item.subject.length<=512&&
 typeof item.body==='string'&&item.body.length<=32768&&
 typeof item.updatedAt==='string'&&Number.isFinite(Date.parse(item.updatedAt))&&
 item.from==='hello@devonakins.com';
}
async function api(url,body){
 const options={method:body===undefined?'GET':'POST',credentials:'same-origin',
  cache:'no-store',redirect:'manual',headers:{Accept:'application/json'}};
 if(body!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
 const res=await fetch(url,options);
 if(!res.ok){
   // A recognized validation refusal is definitive: nothing was saved. Keep
   // edits available for correction instead of presenting it as network doubt.
   if(url===path+'/save'&&[400,413].includes(res.status)&&
      res.headers.get('content-type')?.toLowerCase().includes('application/json')){
    const errorBody=await res.json();
    if(res.status===400&&['invalid_mail_draft_recipient','invalid_mail_draft_payload'].includes(errorBody?.error))
     throw Error(errorBody.error);
    if(res.status===413&&errorBody?.error==='mail_draft_payload_too_large')
     throw Error('mail_draft_payload_too_large');
   }
   // Only read a bounded, explicitly recognized error code from our own API.
   // A 409 for this saved-draft revision means another durable delivery exists.
   if(res.status===409&&
      res.headers.get('content-type')?.toLowerCase().includes('application/json')&&
      (url==='/api/mail/outbox/prepare'||url==='/api/mail/drafts/delete'||url==='/api/mail/drafts/save')){
    const errorBody=await res.json();
    if(url==='/api/mail/outbox/prepare'&&errorBody?.error==='outbox_draft_already_prepared')
     throw Error('outbox_draft_already_prepared');
    if(url==='/api/mail/outbox/prepare'&&errorBody?.error==='outbox_draft_stale')
     throw Error('outbox_draft_stale');
    if(url==='/api/mail/drafts/delete'&&errorBody?.error==='mail_draft_pending_delivery')
     throw Error('mail_draft_pending_delivery');
    if(url==='/api/mail/drafts/save'&&errorBody?.error==='mail_draft_delivery_locked')
     throw Error('mail_draft_delivery_locked');
   }
   const code=res.status===409?'mail_draft_conflict':res.status===401||res.status===403?
    'mail_sign_in_required':'mail_draft_request_failed';
   throw Error(code);
 }
 if(!res.headers.get('content-type')?.toLowerCase().includes('application/json'))throw Error('mail_draft_invalid_response');
 return res.json();
}
const host=()=>document.getElementById('mail-drafts');
function capture(){
 const root=host();if(!root||!state.working)return;
 const to=root.querySelector('[data-mail-draft-field="to"]');
 const subject=root.querySelector('[data-mail-draft-field="subject"]');
 const body=root.querySelector('[data-mail-draft-field="body"]');
 if(!to||!subject||!body)return;
 state.working={...state.working,to:to.value.split(',').map(x=>x.trim()).filter(Boolean),
  subject:subject.value,body:body.value};
}
function render(){
 const root=host();
 if(!root||!state.enabled)return;
 root.replaceChildren();
 const bar=element('div','mail-draft-toolbar');
 bar.append(element('strong','mail-draft-heading','Drafts · '+state.items.length));
 const controls=element('div','mail-draft-buttons');
 const refresh=action('Reload','reload');
 const create=action('New Draft','create');
 refresh.disabled=create.disabled=state.busy||!!state.pendingSend;
 controls.append(refresh,create);
 if(state.outboxEnabled){
  const inspect=action(state.outboxLoaded?'Refresh Outbox History':'Inspect Outbox History','outbox-refresh');
  const sent=action(state.archiveLoaded?'Refresh encrypted Sent history':'Inspect encrypted Sent history','archive-refresh');
  inspect.disabled=sent.disabled=state.busy;controls.append(inspect,sent);
 }
 bar.append(controls);root.append(bar);
 const info=element('p','mail-draft-live',state.busy?'Saving drafts…':
  state.error||state.notice||(state.outgoingEnabled?'Outgoing mail requires a saved draft, separate preparation, and a second explicit confirmation.':'Drafts are private and never sent until sending is separately enabled.'));
 info.setAttribute('role','status');info.setAttribute('aria-live','polite');
 root.append(info);
 if(state.outboxEnabled){
  const history=element('section','mail-outbox-history');
  history.setAttribute('aria-label','Durable outbox status history');
  history.append(element('h3','mail-draft-heading','Delivery history · Status only'));
  history.append(element('p','mail-draft-notice','Read-only receipts. No message contents or retry actions. Reloading does not cancel prepared mail.'));
  if(state.outboxError)history.append(element('p','mail-draft-live',state.outboxError));
  if(!state.outboxLoaded)history.append(element('p','mail-draft-empty','Select Inspect Outbox History to retrieve prior attempts.'));
  else if(!state.outboxItems.length)history.append(element('p','mail-draft-empty','No saved delivery receipts.'));
  else{
   const list=element('ol','mail-outbox-list');
   for(const entry of state.outboxItems){
    const item=element('li','mail-outbox-item');item.dataset.outboxState=entry.state;
    item.append(element('strong','',outboxStateLabel(entry.state)));
    item.append(element('span','mail-draft-notice','Delivery '+entry.deliveryId));
    if(entry.draftId)item.append(element('span','mail-draft-notice','Saved draft revision '+entry.draftRevision));
    // The wire Message-ID is deterministic for a linked saved draft. This is
    // only a search handle; it never asserts that a provider delivered.
    if(entry.draftId&&['claimed','accepted','uncertain'].includes(entry.state))
     item.append(element('span','mail-draft-notice',
      'Expected Message-ID <'+entry.deliveryId+'@devonakins.com> · Correlation only; not proof of delivery.'));
    item.append(element('time','mail-draft-notice','Updated '+new Date(entry.updatedAt).toLocaleString()));
    item.append(element('p','mail-draft-notice',outboxStateAdvice(entry.state)));
    if(entry.draftId&&entry.state==='accepted'){
     const view=action('View encrypted Sent copy','archive-open');
     view.dataset.deliveryId=entry.deliveryId;view.disabled=state.busy;item.append(view);
     const copy=state.archiveCopy;
     if(copy?.deliveryId===entry.deliveryId){
      const panel=element('section','mail-outbox-review');
      panel.setAttribute('aria-label','Decrypted Sent copy — owner only');
      panel.append(element('h4','mail-draft-heading','Encrypted archive · SMTP accepted'));
      panel.append(element('p','mail-draft-notice','Recipient delivery and provider Sent copy are not confirmed.'));
      const details=element('dl','mail-details');
      for(const [label,value] of [['From',copy.from],['To',copy.to.join(', ')],['Subject',copy.subject],
       ['Accepted',new Date(copy.acceptedAt).toLocaleString()]])
       details.append(element('dt','',label),element('dd','',value));
      panel.append(details);
      const body=element('pre','mail-outbox-text',copy.body);
      body.style.whiteSpace='pre-wrap';body.style.overflowWrap='anywhere';
      panel.append(body,action('Close Sent copy','archive-close'));item.append(panel);
     }
     if(state.archiveErrorId===entry.deliveryId)
      item.append(element('p','mail-draft-notice',
       'Encrypted copy unavailable. SMTP receipt unchanged; do not resend.'));
    }
    if(entry.draftId&&['claimed','accepted','uncertain'].includes(entry.state)){
     const check=action('Check provider Sent copy','sent-check');
     check.dataset.deliveryId=entry.deliveryId;check.disabled=state.busy;item.append(check);
     if(state.sentEvidence?.deliveryId===entry.deliveryId){
      const count=state.sentEvidence.candidateCount;
      item.append(element('p','mail-draft-notice',
       'Read-only Sent search found '+count+' candidate'+(count===1?'':'s')+
       '. This is not proof of an exact provider copy or recipient delivery; zero candidates does not mean sending failed.'));
     }
     if(state.sentEvidenceErrorId===entry.deliveryId)
      item.append(element('p','mail-draft-notice',
       'Sent copy could not be inspected. Do not resend based on this result.'));
    }
    list.append(item);
   }
   history.append(list);
  }
  root.append(history);
 }
 const sentHistory=element('section','mail-outbox-history');
 sentHistory.setAttribute('aria-label','Encrypted Sent history');
 sentHistory.append(element('h3','mail-draft-heading','Sent history · Encrypted private copies'));
 sentHistory.append(element('p','mail-draft-notice',
  'Saved on SMTP acceptance, independent of the provider Sent folder. Content stays encrypted until you open a copy.'));
 if(state.archiveError)sentHistory.append(element('p','mail-draft-live',state.archiveError));
 if(!state.archiveLoaded)sentHistory.append(element('p','mail-draft-empty','Select Inspect encrypted Sent history to load archived messages.'));
 else if(!state.archiveEntries.length)sentHistory.append(element('p','mail-draft-empty','No encrypted Sent records available.'));
 else{
  const list=element('ol','mail-outbox-list');
  for(const entry of state.archiveEntries){
   const item=element('li','mail-outbox-item');item.dataset.outboxState='accepted';
   item.append(element('strong','','SMTP accepted · Encrypted copy'));
   item.append(element('time','mail-draft-notice','Accepted '+new Date(entry.acceptedAt).toLocaleString()));
   item.append(element('span','mail-draft-notice','Delivery '+entry.deliveryId));
   const view=action('View encrypted Sent copy','archive-open');
   view.dataset.deliveryId=entry.deliveryId;view.disabled=state.busy;item.append(view);
   // Outbox and Sent archive may show the same entry; render the plaintext
   // only once when the original outbox receipt is already visible above.
   const outboxShows=state.outboxLoaded&&
    state.outboxItems.some(row=>row.deliveryId===entry.deliveryId&&row.state==='accepted');
   if(state.archiveCopy?.deliveryId===entry.deliveryId&&!outboxShows){
    const copy=state.archiveCopy;
    const panel=element('section','mail-outbox-review');
    panel.setAttribute('aria-label','Decrypted Sent copy — owner only');
    panel.append(element('h4','mail-draft-heading','Encrypted archive · SMTP accepted'));
    panel.append(element('p','mail-draft-notice','Recipient delivery and provider Sent copy are not confirmed.'));
    const details=element('dl','mail-details');
    for(const [label,value] of [['From',copy.from],['To',copy.to.join(', ')],['Subject',copy.subject],
      ['Accepted',new Date(copy.acceptedAt).toLocaleString()]])
      details.append(element('dt','',label),element('dd','',value));
    panel.append(details);
    const body=element('pre','mail-outbox-text',copy.body);
    body.style.whiteSpace='pre-wrap';body.style.overflowWrap='anywhere';
    panel.append(body,action('Close Sent copy','archive-close'));
    item.append(panel);
   }
   if(state.archiveErrorId===entry.deliveryId&&!outboxShows)
    item.append(element('p','mail-draft-notice','Encrypted copy unavailable. No message was sent.'));
   list.append(item);
  }
  sentHistory.append(list);
  if(state.archiveHasMore){
   const older=action('Load earlier Sent copies','archive-more');
   older.disabled=state.busy;sentHistory.append(older);
  }
 }
 root.append(sentHistory);
 if(!state.loaded){root.append(element('p','mail-draft-empty','Loading protected drafts…'));return;}
 if(state.items.length){
  const listing=element('div','mail-draft-list');
  for(const entry of state.items){
   const button=action((entry.subject||'(Untitled draft)')+' · '+new Date(entry.updatedAt).toLocaleString(),'select');
   button.className='mail-draft-entry';button.dataset.mailDraftId=entry.id;
   button.setAttribute('aria-pressed',String(entry.id===state.selected));
   const receipt=latestDeliveryForDraft(entry.id);
   if(receipt){
    const label=element('span','mail-draft-delivery-status',
     'Recorded delivery · revision '+receipt.draftRevision+' · '+outboxStateLabel(receipt.state));
    label.dataset.outboxState=receipt.state;button.append(label);
   }
   button.disabled=state.busy||!!state.pendingSend;listing.append(button);
  }
  root.append(listing);
 }else if(!state.working)root.append(element('p','mail-draft-empty','No saved drafts. Create one to compose without sending.'));
 if(!state.working)return;
 const form=element('section','mail-draft-editor');form.setAttribute('aria-label','Unsent draft editor');
 form.append(element('p','mail-draft-notice',state.outgoingEnabled?'UNSENT DRAFT · From hello@devonakins.com · Save before preparing to send':'UNSENT DRAFT · From hello@devonakins.com · No send function'));
 const fields=[
  {name:'to',label:'To (comma-separated addresses)',value:state.working.to.join(', '),tag:'input',max:5000},
  {name:'subject',label:'Subject',value:state.working.subject,tag:'input',max:512},
  {name:'body',label:'Message',value:state.working.body,tag:'textarea',max:32768}
 ];
 for(const field of fields){
  const label=element('label','mail-draft-label',field.label);
  const input=element(field.tag,'mail-draft-field');
  input.dataset.mailDraftField=field.name;
  input.value=field.value;input.maxLength=field.max;
  if(field.tag==='input')input.type='text';else input.rows=12;
  input.disabled=state.busy||!!state.pendingSend;
  label.append(input);form.append(label);
 }
 const actions=element('div','mail-draft-buttons');
 const save=action(state.busy?'Saving…':'Save Draft','save');save.disabled=state.busy||!!state.pendingSend;
 const remove=action('Delete Draft','delete');remove.disabled=state.busy||!!state.pendingSend;
 actions.append(save,remove);
 if(state.outgoingEnabled&&!state.pendingSend){
  const review=action('Review Saved Draft for Sending','send-prepare');
  review.disabled=state.busy||state.dirty||!state.working.to.length||
   !state.items.some(d=>sameSavedDraft(d,state.working))||
   (state.outboxLoaded&&state.outboxItems.some(row=>row.draftId===state.working.id));
  actions.append(review);
 }
 form.append(actions);root.append(form);
 if(state.pendingSend){
  const outgoing=state.pendingSend;
  const review=element('section','mail-outbox-review');review.setAttribute('aria-label','Review outgoing email before submission');review.dataset.outboxState=outgoing.phase;
  review.append(element('h3','mail-draft-heading','Outgoing email review'));
  review.append(element('p','mail-draft-notice','Preparation never sends email. SMTP acceptance is not recipient delivery. Uncertain results must never be resent automatically.'));
  const metadata=element('dl','mail-details');
  for(const [title,value] of [['From','hello@devonakins.com'],['To',outgoing.draft.to.join(', ')],['Subject',outgoing.draft.subject||'(No subject)']]){
   metadata.append(element('dt','',title),element('dd','',value));
  }
  review.append(metadata);
  const body=element('pre','mail-outbox-text',outgoing.draft.body);body.style.whiteSpace='pre-wrap';body.style.overflowWrap='anywhere';
  body.setAttribute('aria-label','Outgoing message plain text');review.append(body);
  const phase=element('p','mail-draft-notice','Outbox state: '+outgoing.phase+(outgoing.attempted?' · A submission was attempted; do not retry.':''));
  review.append(phase);
  const controls=element('div','mail-draft-buttons');
  if(state.outgoingEnabled&&outgoing.phase==='queued'&&!outgoing.attempted){
   const send=action('Confirm and Submit Email','send-submit');send.disabled=state.busy;controls.append(send);
  }
  const status=action('Check Outbox Status','send-status');status.disabled=state.busy;controls.append(status);
  const close=action('Return to Draft','send-close');close.disabled=state.busy;controls.append(close);
  review.append(controls);root.append(review);
 }
}
async function reload(){
 if(state.busy||state.pendingSend)return;
 state.busy=true;state.error=null;state.notice=null;render();
 try{
  const response=await api(path);
  if(!response||!Array.isArray(response.drafts)||response.drafts.length>20||
      !response.drafts.every(isDraft))throw Error('mail_draft_invalid_response');
  state.items=response.drafts.map(d=>({...d,to:d.to.slice()}));state.loaded=true;
  if(state.selected&&!state.dirty){
   const latest=state.items.find(d=>d.id===state.selected);
   state.selected=latest?.id??null;state.working=latest?{...latest,to:latest.to.slice()}:null;
  }
 }catch(e){state.error=e.message==='mail_sign_in_required'?'Owner session expired. Sign in again.':
  'Unable to retrieve private drafts. Existing drafts were not modified.';}
 finally{state.busy=false;render();}
}
async function create(){
 if(state.busy||state.pendingSend)return;
 state.busy=true;state.error=null;state.notice=null;render();
 try{
  if(!state.pendingCreate)state.pendingCreate=uuid();
  if(!state.pendingCreate)throw Error('crypto_unavailable');
  const result=await api(path+'/create',{id:state.pendingCreate});
  if(!isDraft(result?.draft))throw Error('mail_draft_invalid_response');
  state.pendingCreate=null;
  state.selected=result.draft.id;state.working={...result.draft,to:result.draft.to.slice()};
  state.dirty=false;state.pendingSave=null;state.items=[state.working,...state.items.filter(x=>x.id!==state.selected)];
  state.notice='Unsent draft created and stored securely.';
 }catch(e){state.error=e.message==='mail_sign_in_required'?'Owner session expired.':
  'Draft creation did not receive confirmation. Select New Draft to retry the same request.';}
 finally{state.busy=false;render();}
}
async function save(){
 if(state.busy||state.pendingSend||!state.working)return;
 capture();
 state.busy=true;state.error=null;state.notice=null;
 const d=state.working;
 if(!state.pendingSave)state.pendingSave={
  id:d.id,revision:d.revision,operationId:uuid(),to:d.to,subject:d.subject,body:d.body
 };
 const pending=state.pendingSave;
 render();
 try{
  if(!pending.operationId)throw Error('crypto_unavailable');
  const result=await api(path+'/save',pending);
  if(!isDraft(result?.draft))throw Error('mail_draft_invalid_response');
  state.working={...result.draft,to:result.draft.to.slice()};
  state.items=[state.working,...state.items.filter(x=>x.id!==state.selected)];
  state.dirty=false;state.pendingSave=null;
  state.notice='Draft saved at revision '+state.working.revision+'. No message was sent.';
 }catch(e){
  const invalidRecipient=e.message==='invalid_mail_draft_recipient';
  const invalidPayload=['invalid_mail_draft_payload','mail_draft_payload_too_large'].includes(e.message);
  if(invalidRecipient||invalidPayload)state.pendingSave=null;
  state.error=invalidRecipient?
   'Recipient address is invalid. Correct the To field and save again. Your edits remain unsaved; no message was sent.':
   invalidPayload?
   'Draft content was refused. Check recipients, subject and message limits, then save again. Your edits remain unsaved; no message was sent.':
   e.message==='mail_draft_delivery_locked'?
   'This draft is linked to a previous delivery. Edits are blocked to preserve the message that may have been sent. Copy your changes into a new draft.':
   e.message==='mail_draft_conflict'?
   'Another version was saved. Copy your unsaved edits before reloading; no overwrite occurred.':
   e.message==='mail_sign_in_required'?'Owner session expired; your unsaved edits remain in this page.':
   'Save confirmation unavailable. Select Save Draft to retry this exact operation.';
 }finally{state.busy=false;render();}
}
async function remove(){
 if(state.busy||state.pendingSend||!state.working)return;
 if(!globalThis.confirm?.('Permanently delete this saved draft? This does not cancel queued mail; the server blocks deletion while delivery is unresolved.'))return;
 const d=state.working;
 state.busy=true;state.error=null;state.notice=null;render();
 try{
  const response=await api(path+'/delete',{id:d.id,revision:d.revision});
  if(response?.deleted!==true)throw Error('mail_draft_invalid_response');
  state.items=state.items.filter(x=>x.id!==d.id);state.selected=null;state.working=null;
  state.dirty=false;state.pendingSave=null;state.notice='Draft deleted by explicit user action.';
 }catch(e){state.error=e.message==='mail_draft_pending_delivery'?
  'This draft has an unresolved outgoing delivery. Deletion is blocked; inspect its outbox status.':
  e.message==='mail_draft_conflict'?
  'Draft changed before deletion; reload it first.':'Could not confirm deletion. Draft may still exist.';}
 finally{state.busy=false;render();}
}
// The preview must exactly match a confirmed, saved D1 draft revision.
function sameSavedDraft(stored,working){
 return stored.id===working.id&&stored.revision===working.revision&&
  stored.subject===working.subject&&stored.body===working.body&&
  JSON.stringify(stored.to)===JSON.stringify(working.to);
}
function showSendStatus(s){
 if(s.phase==='accepted')return 'SMTP accepted this message; recipient delivery is not verified. Original draft remains saved.';
 if(s.phase==='claimed'||s.phase==='uncertain')return 'Delivery status is uncertain. Do not submit or prepare another copy without reconciliation.';
 if(s.phase==='rejected'||s.phase==='failed')return 'SMTP attempt did not complete successfully. The original delivery cannot be retried.';
 if(s.phase==='queued'&&s.attempted)return 'A previous submission received no reliable confirmation. No further submission is allowed from this review.';
 if(s.phase==='queued')return 'Prepared for sending. No SMTP submission has occurred.';
 return 'Outbox receipt unavailable. Do not retry. Check the outbox and resolve manually.';
}
async function prepareSend(){
 if(state.busy||!state.outgoingEnabled||state.pendingSend||state.dirty||!state.working)return;
 const draft=state.items.find(d=>sameSavedDraft(d,state.working));
 if(!draft||!draft.to.length)return;
 const snapshot={to:draft.to.slice(),subject:draft.subject,body:draft.body};
 state.busy=true;state.error=null;state.notice=null;render();
 // Re-read the signed owner's durable outbox before allocating a new delivery ID.
 // Avoid a second preparation after a reload, even if the draft revision changed.
 let deliveryId;
 try{
  if(!state.outboxEnabled)throw Error('outbox_unavailable');
  const entries=await fetchValidatedOutbox();
  state.outboxItems=entries;state.outboxLoaded=true;state.outboxError=null;
  if(entries.some(row=>row.draftId===draft.id)){
   state.error='A delivery already exists for this saved draft, possibly from a different revision. Inspect its outbox status. Compose a separate new draft for a new message.';
   return;
  }
  deliveryId=uuid();
  if(!deliveryIdValid(deliveryId)){
   state.error='Secure delivery ID unavailable. Nothing was prepared.';return;
  }
 }catch(e){
  state.outboxItems=[];state.outboxLoaded=false;
  state.error=e.message==='mail_sign_in_required'?'Owner session expired. No email was prepared.':
   'Could not verify prior delivery attempts. No email was prepared; inspect outbox history before trying again.';
  return;
 }finally{state.busy=false;render();}
 state.busy=true;render();
 try{
  const result=await api('/api/mail/outbox/prepare',{deliveryId,draftId:draft.id,draftRevision:draft.revision,approvedByOwner:true});
  if(result?.receipt?.deliveryId!==deliveryId||result.receipt.state!=='queued')
   throw Error('mail_outbox_invalid_receipt');
  state.pendingSend={deliveryId,draft:snapshot,draftId:draft.id,revision:draft.revision,phase:'queued',attempted:false};
  state.notice='Email prepared for review. Nothing has been submitted to SMTP.';
 }catch(e){
  if(e.message==='outbox_draft_already_prepared'||e.message==='outbox_draft_stale'){
   state.pendingSend=null;state.outboxLoaded=false;state.outboxItems=[];
   state.error=e.message==='outbox_draft_already_prepared'?
    'This saved draft revision already has a durable delivery. Inspect Outbox History; do not create another copy.':
    'The saved draft changed or was deleted before preparation. Reload drafts and review the latest revision.';
  }else{
   // Lost responses may follow a successful D1 commit; preserve the delivery ID.
   state.pendingSend={deliveryId,draft:snapshot,draftId:draft.id,revision:draft.revision,phase:'preparation-unconfirmed',attempted:false};
   state.error=e.message==='mail_sign_in_required'?'Owner session expired; do not send.':
    'Preparation receipt unavailable. No SMTP send was requested. Check this delivery in the outbox before proceeding.';
  }
 }finally{state.busy=false;render();}
}
async function submitSend(){
 const delivery=state.pendingSend;
 if(state.busy||!state.outgoingEnabled||!delivery||delivery.phase!=='queued'||delivery.attempted)return;
 const summary='Submit this saved plain-text email from hello@devonakins.com to '+
  delivery.draft.to.join(', ')+'? This is a real SMTP action if enabled. No automatic retry is possible.';
 if(globalThis.confirm?.(summary)!==true)return;
 delivery.attempted=true;delivery.phase='submitting';
 state.busy=true;state.error=null;state.notice=null;render();
 try{
  const result=await api('/api/mail/outbox/submit',{deliveryId:delivery.deliveryId,confirmedByOwner:true});
  if(result?.receipt?.deliveryId!==delivery.deliveryId||
   !['accepted','rejected','failed','uncertain'].includes(result.receipt.state))
   throw Error('mail_outbox_invalid_receipt');
  delivery.phase=result.receipt.state;
  state.notice=showSendStatus(delivery);
 }catch(e){
  delivery.phase='submit-unconfirmed';
  state.error=e.message==='mail_sign_in_required'?'Owner session expired during submission. Check delivery status before any further action.':
   'Submission result unavailable. The message may have been accepted. Never retry it; check outbox status.';
 }finally{state.busy=false;render();}
}
async function checkSendStatus(){
 const delivery=state.pendingSend;if(state.busy||!delivery)return;
 state.busy=true;state.error=null;state.notice=null;render();
 try{
  const result=await api('/api/mail/outbox');
  if(!Array.isArray(result?.outbox)||result.outbox.length>100)
   throw Error('mail_outbox_invalid_response');
  const matching=result.outbox.find(row=>row?.deliveryId===delivery.deliveryId);
  if(!matching||!['queued','claimed','accepted','rejected','failed','uncertain'].includes(matching.state))
   throw Error('mail_outbox_missing_receipt');
  delivery.phase=matching.state;
  state.notice=showSendStatus(delivery);
 }catch(e){
  state.error=e.message==='mail_sign_in_required'?'Owner session expired. Do not resend.':
   'Cannot confirm this delivery in the outbox. Keep the delivery ID; do not create a new attempt.';
 }finally{state.busy=false;render();}
}
function closeSendReview(){
 const delivery=state.pendingSend;if(state.busy||!delivery)return;
 if(['queued','claimed','uncertain','submit-unconfirmed','preparation-unconfirmed'].includes(delivery.phase)&&
  globalThis.confirm?.('Leave this review? Its prepared or attempted delivery remains in the outbox and is not canceled. You must not resend without checking its status.')!==true)return;
 state.pendingSend=null;
 state.error=null;
 state.notice='Review closed. The original saved draft and its separate outbox record have not been deleted or reconciled.';
 render();
}
const OUTBOX_STATES=Object.freeze(['queued','claimed','accepted','rejected','failed','uncertain']);
function outboxStateLabel(status){
 return ({queued:'Prepared / queued',claimed:'Claimed / unconfirmed',accepted:'Accepted by SMTP',
  rejected:'Rejected by SMTP',failed:'Submission failed',uncertain:'Delivery uncertain'})[status];
}
function outboxStateAdvice(status){
 if(status==='accepted')return 'Provider acceptance is not recipient delivery confirmation.';
 if(status==='queued')return 'A prepared record exists. Do not prepare another copy without reconciliation.';
 if(status==='claimed'||status==='uncertain')return 'May have been submitted. Do not retry; reconcile manually.';
 return 'Terminal receipt. This delivery cannot be automatically retried.';
}
function latestDeliveryForDraft(draftId){
 if(!state.outboxLoaded)return null;
 return state.outboxItems.find(row=>row.draftId===draftId)??null;
}
// Validate the whole response before displaying any record or permitting preparation.
async function fetchValidatedOutbox(){
 const result=await api('/api/mail/outbox');
 if(!result||!Array.isArray(result.outbox)||result.outbox.length>100)throw Error('bad_outbox_history');
 const seen=new Set();
 const list=result.outbox.map(row=>{
  if(!row||typeof row.deliveryId!=='string'||!deliveryIdValid(row.deliveryId)||
   !OUTBOX_STATES.includes(row.state)||seen.has(row.deliveryId)||
   typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))||
   typeof row.updatedAt!=='string'||!Number.isFinite(Date.parse(row.updatedAt)))
    throw Error('bad_outbox_history');
  const hasDraft=Object.hasOwn(row,'draftId'),hasRevision=Object.hasOwn(row,'draftRevision');
  if(hasDraft!==hasRevision||
   (hasDraft&&(!deliveryIdValid(row.draftId)||!Number.isSafeInteger(row.draftRevision)||
    row.draftRevision<1||row.draftRevision>1_000_000_000)))throw Error('bad_outbox_history');
  seen.add(row.deliveryId);
  return {deliveryId:row.deliveryId,state:row.state,createdAt:row.createdAt,updatedAt:row.updatedAt,
   ...(hasDraft?{draftId:row.draftId,draftRevision:row.draftRevision}:{})};
 });
 return list.reverse();
}
function validatedArchivePage(result,existingIds=new Set(),before=null){
 if(result?.providerIndependent!==true||!Array.isArray(result.entries)||
    result.entries.length>100||typeof result.hasMore!=='boolean'||
    (result.hasMore&&result.entries.length===0))
  throw Error('invalid_archive_history');
 const seen=new Set(existingIds);let previous=before;
 return result.entries.map(entry=>{
  if(!entry||!deliveryIdValid(entry.deliveryId)||!deliveryIdValid(entry.draftId)||
     !Number.isSafeInteger(entry.draftRevision)||entry.draftRevision<1||
     entry.draftRevision>1000000000||entry.state!=='accepted'||
     typeof entry.acceptedAt!=='string'||entry.acceptedAt.length>40||
     !Number.isFinite(Date.parse(entry.acceptedAt))||seen.has(entry.deliveryId)||
     (previous&&!(entry.acceptedAt<previous.acceptedAt||
      (entry.acceptedAt===previous.acceptedAt&&entry.deliveryId<previous.deliveryId))))
   throw Error('invalid_archive_history');
  seen.add(entry.deliveryId);
  previous={acceptedAt:entry.acceptedAt,deliveryId:entry.deliveryId};
  return {deliveryId:entry.deliveryId,draftId:entry.draftId,
   draftRevision:entry.draftRevision,acceptedAt:entry.acceptedAt,state:'accepted'};
 });
}
async function loadArchivedHistory(){
 if(state.busy||!state.outboxEnabled)return;
 state.busy=true;state.archiveCopy=null;state.archiveErrorId=null;state.archiveError=null;
 const epoch=++state.archiveEpoch;render();
 try{
  const result=await api('/api/mail/outbox/archive');
  const rows=validatedArchivePage(result);
  if(epoch!==state.archiveEpoch||document.visibilityState==='hidden'||!state.enabled)return;
  state.archiveEntries=rows;state.archiveLoaded=true;state.archiveHasMore=result.hasMore;
 }catch{
  if(epoch===state.archiveEpoch){
   state.archiveEntries=[];state.archiveLoaded=false;state.archiveHasMore=false;
   state.archiveError='Encrypted Sent history unavailable. Delivery receipts remain unchanged.';
  }
 }finally{state.busy=false;render();}
}
async function loadEarlierArchive(){
 if(state.busy||!state.outboxEnabled||!state.archiveLoaded||
    !state.archiveHasMore||!state.archiveEntries.length)return;
 const last=state.archiveEntries[state.archiveEntries.length-1];
 const before={acceptedAt:last.acceptedAt,deliveryId:last.deliveryId};
 const known=new Set(state.archiveEntries.map(row=>row.deliveryId));
 state.busy=true;state.archiveCopy=null;state.archiveErrorId=null;state.archiveError=null;
 const epoch=++state.archiveEpoch;render();
 try{
  const result=await api('/api/mail/outbox/archive/page',{before});
  const rows=validatedArchivePage(result,known,before);
  if(epoch!==state.archiveEpoch||document.visibilityState==='hidden'||!state.enabled)return;
  state.archiveEntries=[...state.archiveEntries,...rows];
  state.archiveHasMore=result.hasMore;
 }catch{
  if(epoch===state.archiveEpoch&&document.visibilityState!=='hidden')
   state.archiveError='Older encrypted copies could not be loaded. Existing history was preserved.';
 }finally{state.busy=false;render();}
}
async function openArchivedCopy(deliveryId){
 if(state.busy||!state.outboxEnabled||!deliveryIdValid(deliveryId))return;
 const receipt=state.outboxItems.find(x=>x.deliveryId===deliveryId&&x.state==='accepted')||
   state.archiveEntries.find(x=>x.deliveryId===deliveryId&&x.state==='accepted');
 if(!receipt?.draftId)return;
 state.busy=true;state.archiveCopy=null;state.archiveErrorId=null;
 const epoch=++state.archiveEpoch;render();
 try{
  const response=await api('/api/mail/outbox/archive/view',{deliveryId});
  const c=response?.archive;
  if(response?.providerIndependent!==true||!c||
     c.deliveryId!==deliveryId||c.draftId!==receipt.draftId||
     c.draftRevision!==receipt.draftRevision||c.state!=='accepted'||
     c.messageId!=='<'+deliveryId+'@devonakins.com>'||
     c.from!=='hello@devonakins.com'||!Array.isArray(c.to)||c.to.length>20||
     !c.to.every(a=>typeof a==='string'&&a.length<=254)||
     typeof c.subject!=='string'||c.subject.length>512||
     typeof c.body!=='string'||c.body.length>32768||
     typeof c.acceptedAt!=='string'||!Number.isFinite(Date.parse(c.acceptedAt))||
     c.providerCopyConfirmed!==false||c.recipientDeliveryConfirmed!==false)
   throw Error('archive_invalid');
  // Owner may have hidden Safari, closed the page, or changed the session
  // while the encrypted copy was in flight. Never display a stale response.
  if(epoch!==state.archiveEpoch||document.visibilityState==='hidden'||!state.enabled)return;
  state.archiveCopy={deliveryId,from:c.from,to:c.to.slice(),subject:c.subject,
   body:c.body,acceptedAt:c.acceptedAt};
 }catch{if(epoch===state.archiveEpoch&&document.visibilityState!=='hidden')state.archiveErrorId=deliveryId;}
 finally{state.busy=false;render();}
}
async function checkSentCopy(deliveryId){
 if(state.busy||!state.outboxLoaded||!state.outboxEnabled||!deliveryIdValid(deliveryId))return;
 const row=state.outboxItems.find(item=>item.deliveryId===deliveryId);
 if(!row?.draftId||!['claimed','accepted','uncertain'].includes(row.state))return;
 state.busy=true;state.sentEvidence=null;state.sentEvidenceErrorId=null;render();
 try{
  const result=await api('/api/mail/outbox/sent-check',{deliveryId});
  if(result?.deliveryId!==deliveryId||result.sentFolderExamined!==true||
   !Number.isSafeInteger(result.candidateCount)||result.candidateCount<0||result.candidateCount>10||
   result.exactHeaderVerified!==false||result.providerCopyConfirmed!==false||
   result.recipientDeliveryConfirmed!==false||result.automaticRetry!==false)
    throw Error('invalid_sent_evidence');
  state.sentEvidence={deliveryId,candidateCount:result.candidateCount};
 }catch{
  state.sentEvidenceErrorId=deliveryId;
 }finally{state.busy=false;render();}
}
async function loadOutboxHistory(){
 if(state.busy||!state.outboxEnabled)return;
 state.busy=true;state.outboxError=null;state.sentEvidence=null;state.sentEvidenceErrorId=null;
  state.archiveCopy=null;state.archiveErrorId=null;render();
 try{
  state.outboxItems=await fetchValidatedOutbox();state.outboxLoaded=true;
 }catch(e){
  // Never display previously cached delivery states after a failed owner read.
  state.outboxItems=[];state.outboxLoaded=false;
  state.outboxError=e.message==='mail_sign_in_required'?
   'Owner session expired. Sign in again to inspect mail receipts.':
   'Outbox status could not be verified. Do not resubmit or create another delivery.';
 }finally{state.busy=false;render();}
}
document.addEventListener('click',e=>{
 const clicked=e.target.closest?.('[data-mail-draft-action]');
 if(!clicked||!host()?.contains(clicked))return;
 const a=clicked.dataset.mailDraftAction;
 if(a==='outbox-refresh'){void loadOutboxHistory();return;}
 if(a==='archive-refresh'){void loadArchivedHistory();return;}
 if(a==='archive-more'){void loadEarlierArchive();return;}
 if(a==='sent-check'){void checkSentCopy(clicked.dataset.deliveryId);return;}
 if(a==='archive-open'){void openArchivedCopy(clicked.dataset.deliveryId);return;}
 if(a==='archive-close'){state.archiveEpoch++;state.archiveCopy=null;state.archiveErrorId=null;render();return;}
 if(a==='send-prepare'){void prepareSend();return;}
 if(a==='send-submit'){void submitSend();return;}
 if(a==='send-status'){void checkSendStatus();return;}
 if(a==='send-close'){closeSendReview();return;}
 if(state.pendingSend)return;
 if(a==='save'){void save();return;}
 if(a==='delete'){void remove();return;}
 if(a==='create'||a==='reload'||a==='select'){
  if(state.dirty&&!globalThis.confirm?.('Discard unsaved changes before continuing?'))return;
  state.dirty=false;state.pendingSave=null;
 }
 if(a==='create'){void create();return;}
 if(a==='reload'){void reload();return;}
 if(a==='select'){
  const selected=state.items.find(d=>d.id===clicked.dataset.mailDraftId);
  if(selected){state.selected=selected.id;state.working={...selected,to:selected.to.slice()};
   state.error=null;state.notice=null;render();}
 }
});
document.addEventListener('input',e=>{
 if(!host()?.contains(e.target)||!e.target?.dataset?.mailDraftField||state.pendingSend)return;
 capture();state.dirty=true;state.pendingSave=null;
 const review=host()?.querySelector('[data-mail-draft-action="send-prepare"]');
 if(review)review.disabled=true;
});
globalThis.StationDrafts=Object.freeze({
 mount(container,enabled,outgoingEnabled=false,outboxEnabled=false){
  if(!container)return;
  state.enabled=enabled===true;
  state.outgoingEnabled=state.enabled&&outgoingEnabled===true;
  state.outboxEnabled=state.enabled&&outboxEnabled===true;
  if(!state.enabled){state.archiveEpoch++;state.archiveCopy=null;state.archiveErrorId=null;return;}
  if(!state.loaded&&!state.busy)void reload();
  else render();
 }
});
document.addEventListener('visibilitychange',()=>{
 if(document.visibilityState==='hidden'){state.archiveEpoch++;state.archiveCopy=null;state.archiveErrorId=null;render();}
});
globalThis.addEventListener?.('pagehide',()=>{
 state.archiveEpoch++;state.archiveCopy=null;state.archiveErrorId=null;render();
});
globalThis.addEventListener?.('hashchange',()=>{
 if(globalThis.location?.hash!=='#mail'){
  state.archiveEpoch++;state.archiveCopy=null;state.archiveErrorId=null;render();
 }
});
const initial=host();
if(initial)globalThis.StationDrafts.mount(initial,initial.dataset.draftsEnabled==='true',initial.dataset.outgoingEnabled==='true',initial.dataset.outboxEnabled==='true');
})();
