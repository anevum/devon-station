// COMMS-12: manually saved, owner-only D1 drafts. No send transport, HTML preview or AI action.
// DOM is composed exclusively with createElement/textContent/value, not innerHTML.
(function(){
'use strict';
const path='/api/mail/drafts';
const state={enabled:false,loaded:false,busy:false,items:[],selected:null,working:null,
 dirty:false,error:null,notice:null,pendingCreate:null,pendingSave:null};
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
 refresh.disabled=create.disabled=state.busy;
 controls.append(refresh,create);bar.append(controls);root.append(bar);
 const info=element('p','mail-draft-live',state.busy?'Saving drafts…':
  state.error||state.notice||'Drafts are private and never sent until sending is separately enabled.');
 info.setAttribute('role','status');info.setAttribute('aria-live','polite');
 root.append(info);
 if(!state.loaded){root.append(element('p','mail-draft-empty','Loading protected drafts…'));return;}
 if(state.items.length){
  const listing=element('div','mail-draft-list');
  for(const entry of state.items){
   const button=action((entry.subject||'(Untitled draft)')+' · '+new Date(entry.updatedAt).toLocaleString(),'select');
   button.className='mail-draft-entry';button.dataset.mailDraftId=entry.id;
   button.setAttribute('aria-pressed',String(entry.id===state.selected));
   button.disabled=state.busy;listing.append(button);
  }
  root.append(listing);
 }else if(!state.working)root.append(element('p','mail-draft-empty','No saved drafts. Create one to compose without sending.'));
 if(!state.working)return;
 const form=element('section','mail-draft-editor');form.setAttribute('aria-label','Unsent draft editor');
 form.append(element('p','mail-draft-notice','UNSENT DRAFT · From hello@devonakins.com · No send function'));
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
  input.disabled=state.busy;
  label.append(input);form.append(label);
 }
 const actions=element('div','mail-draft-buttons');
 const save=action(state.busy?'Saving…':'Save Draft','save');save.disabled=state.busy;
 const remove=action('Delete Draft','delete');remove.disabled=state.busy;
 actions.append(save,remove);form.append(actions);
 root.append(form);
}
async function reload(){
 if(state.busy)return;
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
 if(state.busy)return;
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
 if(state.busy||!state.working)return;
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
  state.error=e.message==='mail_draft_conflict'?
   'Another version was saved. Copy your unsaved edits before reloading; no overwrite occurred.':
   e.message==='mail_sign_in_required'?'Owner session expired; your unsaved edits remain in this page.':
   'Save confirmation unavailable. Select Save Draft to retry this exact operation.';
 }finally{state.busy=false;render();}
}
async function remove(){
 if(state.busy||!state.working)return;
 if(!globalThis.confirm?.('Permanently delete this unsent draft?'))return;
 const d=state.working;
 state.busy=true;state.error=null;state.notice=null;render();
 try{
  const response=await api(path+'/delete',{id:d.id,revision:d.revision});
  if(response?.deleted!==true)throw Error('mail_draft_invalid_response');
  state.items=state.items.filter(x=>x.id!==d.id);state.selected=null;state.working=null;
  state.dirty=false;state.pendingSave=null;state.notice='Draft deleted by explicit user action.';
 }catch(e){state.error=e.message==='mail_draft_conflict'?
  'Draft changed before deletion; reload it first.':'Could not confirm deletion. Draft may still exist.';}
 finally{state.busy=false;render();}
}
document.addEventListener('click',e=>{
 const clicked=e.target.closest?.('[data-mail-draft-action]');
 if(!clicked||!host()?.contains(clicked))return;
 const a=clicked.dataset.mailDraftAction;
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
 if(!host()?.contains(e.target)||!e.target?.dataset?.mailDraftField)return;
 capture();state.dirty=true;state.pendingSave=null;
});
globalThis.StationDrafts=Object.freeze({
 mount(container,enabled){
  if(!container)return;
  state.enabled=enabled===true;
  if(!state.enabled)return;
  if(!state.loaded&&!state.busy)void reload();
  else render();
 }
});
const initial=host();
if(initial)globalThis.StationDrafts.mount(initial,initial.dataset.draftsEnabled==='true');
})();
