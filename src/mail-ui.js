// COMMS-10: strict, nonpersistent, read-only client of the signed owner mail API.
// All email content is appended via textContent, never HTML; no images or remote links.
(function(){
  'use strict';
  const URLS={status:'/api/mail/status',inbox:'/api/mail/inbox?limit=50&offset=0',sync:'/api/mail/sync'};
  const state={phase:'checking',status:null,items:[],selected:null,total:0,error:null,busy:false,initialized:false,receipt:null};
  function node(tag,className,text){
    const el=document.createElement(tag);
    if(className)el.className=className;
    if(text!==undefined)el.textContent=String(text);
    return el;
  }
  function button(title,action){
    const el=node('button','mail-action',title);
    el.type='button';
    el.dataset.mailAction=action;
    return el;
  }
  function sanitizeResponse(value){
    if(!value || typeof value!=='object' || !Array.isArray(value.messages) || value.messages.length>50 ||
       !Number.isSafeInteger(value.total) || value.total<0) throw Error('invalid_mail_response');
    const keys=new Set();
    const messages=value.messages.map(row=>{
      if(!row || typeof row.key!=='string' || row.key.length>256 || keys.has(row.key) ||
         typeof row.from!=='string' || row.from.length>254 || typeof row.subject!=='string' ||
         row.subject.length>512 || typeof row.text!=='string' || row.text.length>4096 ||
         typeof row.timestamp!=='string' || !Number.isFinite(Date.parse(row.timestamp)) ||
         !Array.isArray(row.flags) || row.flags.some(f=>!['seen','answered','flagged','draft'].includes(f)))
        throw Error('invalid_mail_response');
      keys.add(row.key);
      return Object.freeze({key:row.key,from:row.from,subject:row.subject,text:row.text,
        timestamp:row.timestamp,flags:Object.freeze(row.flags.slice())});
    });
    return {messages,total:value.total};
  }
  async function json(path,method='GET'){
    const options={method,credentials:'same-origin',cache:'no-store',redirect:'manual',
      headers:{'Accept':'application/json'}};
    if(method==='POST'){options.headers['Content-Type']='application/json';options.body='{}';}
    const response=await fetch(path,options);
    if(!response.ok || !response.headers.get('Content-Type')?.toLowerCase().includes('application/json'))
      throw Error(response.status===401||response.status===403?'mail_sign_in_required':'mail_request_failed');
    return response.json();
  }
  function render(){
    const root=document.getElementById('station-mail');
    if(!root)return;
    root.replaceChildren();
    const header=node('div','mail-header');
    const who=node('div','mail-identity');
    who.append(node('strong','', 'hello@devonakins.com'));
    const sub=node('span','mail-small',state.status?.configured?'Purelymail · Owner-only · Read-only':'Purelymail · Setup incomplete');
    who.append(sub);
    const controls=node('div','mail-controls');
    const refresh=button(state.busy?'Synchronizing…':'Synchronize Inbox','sync');
    refresh.disabled=state.busy || !state.status?.configured;
    controls.append(refresh);
    header.append(who,controls);
    root.append(header);
    const notice=node('p','mail-banner','Receiving is read-only. Sending, drafts, HTML and attachments are not enabled in this release.');
    root.append(notice);
    const live=node('p','mail-live');
    live.setAttribute('role','status');
    live.setAttribute('aria-live','polite');
    const phase={
      checking:'Checking account configuration…',
      unavailable:'Account is not configured in this installation. No mailbox connection was attempted.',
      ready: state.receipt || 'Cached inbox records. Synchronization only runs when you select Synchronize Inbox.',
      loading:'Loading previously synchronized messages…',
      syncing:'Synchronizing with the mail provider…',
      error:state.error || 'Unable to load mail. Your existing mailbox remains unchanged.'
    };
    live.textContent=phase[state.phase]||phase.ready;
    root.append(live);
    if(state.error && state.phase!=='error')root.append(node('p','mail-error',state.error));
    const body=node('div','mail-layout');
    const listing=node('section','mail-list');
    listing.setAttribute('aria-label','Received messages');
    listing.append(node('div','mail-list-title',state.status?.configured?
      'Inbox · '+state.total+' indexed':'Inbox · not connected'));
    if(state.items.length){
      for(const item of state.items){
        const row=button('', 'select');
        row.className='mail-message';
        row.dataset.mailKey=item.key;
        row.setAttribute('aria-pressed',String(item.key===state.selected));
        row.append(node('strong','mail-sender',item.from));
        row.append(node('span','mail-subject',item.subject || '(No subject)'));
        row.append(node('span','mail-preview',item.text.replace(/\s+/g,' ').slice(0,120)));
        row.append(node('time','mail-time',new Date(item.timestamp).toLocaleString()));
        listing.append(row);
      }
    } else {
      listing.append(node('p','mail-empty',state.status?.configured?
        'No synchronized messages. Select Synchronize Inbox to check for mail.':
        'The initial mailbox must be configured and authorized before it can be used.'));
    }
    const reader=node('article','mail-reader');
    reader.setAttribute('aria-label','Selected message');
    const item=state.items.find(x=>x.key===state.selected);
    if(item){
      reader.append(node('span','mail-eyebrow','MESSAGE READER / PLAIN TEXT'));
      reader.append(node('h2','mail-reader-subject',item.subject || '(No subject)'));
      const meta=node('dl','mail-details');
      const date=node('time','',new Date(item.timestamp).toLocaleString());
      const dt=node('dt','','From');const dd=node('dd','',item.from);
      const dt2=node('dt','','Date');const dd2=node('dd');dd2.append(date);
      meta.append(dt,dd,dt2,dd2);
      reader.append(meta);
      const text=node('div','mail-body',item.text);
      text.setAttribute('aria-label','Plain text message body');
      reader.append(text);
      reader.append(node('p','mail-footnote','Untrusted message content. Links and remote assets are never loaded.'));
    } else {
      reader.append(node('div','mail-placeholder','Select a message to read it securely.'));
    }
    body.append(listing,reader);
    root.append(body);
  }
  async function start(){
    if(state.busy)return;
    state.busy=true;
    state.phase='checking';
    state.error=null;
    render();
    try{
      const status=await json(URLS.status);
      if(typeof status.configured!=='boolean' || status.address!=='hello@devonakins.com')
        throw Error('invalid_mail_response');
      state.status=status;
      if(!status.configured){
        state.phase='unavailable';state.items=[];state.total=0;state.selected=null;
      }else{
        state.phase='loading';render();
        const result=sanitizeResponse(await json(URLS.inbox));
        state.items=result.messages;state.total=result.total;
        if(!state.items.some(x=>x.key===state.selected))state.selected=state.items[0]?.key??null;
        state.phase='ready';
      }
    }catch(error){
      state.phase='error';
      state.error=error?.message==='mail_sign_in_required'?'Your owner session has expired. Sign in again.':
        'Unable to read the private mailbox. No messages were sent or changed.';
    }finally{state.busy=false;render();}
  }
  async function sync(){
    if(state.busy || !state.status?.configured)return;
    state.busy=true;state.phase='syncing';state.error=null;state.receipt=null;render();
    try {
      const result=await json(URLS.sync,'POST');
      if(!Number.isSafeInteger(result.imported)||!Number.isSafeInteger(result.updated))
        throw Error('invalid_mail_response');
      const latest=sanitizeResponse(await json(URLS.inbox));
      state.items=latest.messages;state.total=latest.total;
      if(!state.items.some(x=>x.key===state.selected))state.selected=state.items[0]?.key??null;
      state.receipt='Synchronization completed: '+result.imported+' new, '+result.updated+' updated.';
      state.phase='ready';
    }catch{
      state.phase='error';state.error='Synchronization failed. No successful delivery or import is claimed.';
    }finally{state.busy=false;render();}
  }
  document.addEventListener('click',e=>{
    const button=e.target.closest?.('[data-mail-action]');
    if(!button || !document.getElementById('station-mail')?.contains(button))return;
    const action=button.dataset.mailAction;
    if(action==='sync'){void sync();return;}
    if(action==='select'){
      const key=button.dataset.mailKey;
      if(state.items.some(x=>x.key===key)){state.selected=key;render();}
    }
  });
  globalThis.StationMail=Object.freeze({
    mounted(section){
      if(section!=='mail')return;
      render();
      if(!state.initialized){state.initialized=true;void start();}
    },
    refresh(){if(document.getElementById('station-mail'))return start();}
  });
  if(location.hash==='#mail' && document.getElementById('station-mail'))globalThis.StationMail.mounted('mail');
})();
