// COMMS-10: strict, nonpersistent, read-only client of the signed owner mail API.
// All email content is appended via textContent, never HTML; no images or remote links.
(function(){
  'use strict';
  const OPEN_DIAGNOSTIC_CODES=new Set(['imap_tls_connect_failed','imap_greeting_failed','imap_login_failed','imap_login_rejected','imap_session_cancelled']);
  const SYNC_DIAGNOSTIC_CODES=new Set([...OPEN_DIAGNOSTIC_CODES, "imap_transport_failed", "imap_command_failed", "imap_invalid_fetch", "invalid_imap_fetch", "imap_invalid_search", "invalid_imap_search", "imap_invalid_framing", "imap_invalid_mime", "imap_literal_limit", "imap_response_limit", "imap_stream_closed", "imap_unexpected_literal", "imap_unexpected_response", "imap_tag_mismatch", "invalid_imap_examine", "imap_search_limit", "imap_session_cancelled", "provider_timeout", "mail_d1_read_failed", "mail_d1_invalid_snapshot", "mail_d1_snapshot_limit", "mail_d1_batch_failed", "invalid_mail_snapshot", "invalid_scoped_snapshot", "mail_payload_unavailable", "mail_validation_failed", "mail_sender_address_invalid", "mime_wire_limit", "mime_parse_failed", "mime_invalid_from", "mime_subject_limit", "mime_html_conversion_failed", "mime_body_index_limit", "mail_sync_unclassified"]);
  const URLS={status:'/api/mail/status',inbox:'/api/mail/inbox?limit=50&offset=0',sync:'/api/mail/sync'};
  const state={phase:'checking',status:null,items:[],selected:null,total:0,offset:0,revision:null,stale:false,error:null,busy:false,initialized:false,receipt:null,hasMore:null,stopRequested:false,run:null,diagnostic:{phase:'idle',summary:'Checks have not been run.',items:[]},provider:{phase:'idle',summary:'Provider login has not been tested.'}};
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
  function sanitizeResponse(value,offset=0){
    if(!value || typeof value!=='object' || !Array.isArray(value.messages) || value.messages.length>50 ||
       !Number.isSafeInteger(value.total) || value.total<0 || value.total>5000 ||
       !Number.isSafeInteger(value.revision) || value.revision<0 || value.offset!==offset || value.limit!==50 ||
       value.messages.length!==Math.min(50,Math.max(0,value.total-offset))) throw Error('invalid_mail_response');
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
    return {messages,total:value.total,offset,revision:value.revision};
  }
  async function json(path,method='GET'){
    const options={method,credentials:'same-origin',cache:'no-store',redirect:'manual',
      headers:{'Accept':'application/json'}};
    if(method==='POST'){options.headers['Content-Type']='application/json';options.body='{}';}
    if(path===URLS.sync)options.headers['X-DevonStation-Mail-Diagnostics']='1';
    let response;
    try{response=await fetch(path,options);}
    catch(error){if(path===URLS.sync)throw Error('mail_sync_response:network_failed');throw error;}
    const isJson=response.headers.get('Content-Type')?.toLowerCase().includes('application/json');
    if(path===URLS.sync){
      if(response.status===401||response.status===403)throw Error('mail_sign_in_required');
      if(response.status===409)throw Error('mail_inbox_changed');
      let value;
      if(isJson){
        try{value=await response.json();}
        catch{throw Error('mail_sync_response:invalid_json');}
      }
      if(response.status===502&&value?.error==='mail_operation_failed'&&SYNC_DIAGNOSTIC_CODES.has(value.diagnosticCode))
        throw Error('mail_sync_diagnostic:'+value.diagnosticCode);
      if(!response.ok)throw Error('mail_sync_response:'+(
        Number.isInteger(response.status)&&response.status>=0&&response.status<=599?'http_'+response.status:'invalid_status'));
      if(!isJson)throw Error('mail_sync_response:non_json');
      return value;
    }
    if(!response.ok || !isJson)
      throw Error(response.status===401||response.status===403?'mail_sign_in_required':
        response.status===409?'mail_inbox_changed':'mail_request_failed');
    return response.json();
  }
  function render(){
    const root=document.getElementById('station-mail');
    if(!root)return;
    root.replaceChildren();
    const header=node('div','mail-header');
    const who=node('div','mail-identity');
    who.append(node('strong','', 'hello@devonakins.com'));
    const sub=node('span','mail-small',state.status?.outgoingEnabled===true?'Purelymail · Owner-only · Outgoing configured':state.status?.configured?'Purelymail · Owner-only · Read-only':'Purelymail · Setup incomplete');
    who.append(sub);
    const controls=node('div','mail-controls');
    const refresh=button(state.phase==='syncing'?'Synchronizing…':state.hasMore===true?'Sync Next Batch':'Synchronize Inbox','sync');
    refresh.disabled=state.busy || !state.status?.configured;
    controls.append(refresh);
    if(state.phase==='syncing'){
      const stop=button(state.stopRequested?'Stopping after batch…':'Stop After Batch','stop');
      stop.disabled=state.stopRequested;controls.append(stop);
    }else{
      const catchup=button('Catch Up · Up to 10 Batches','catchup');
      catchup.disabled=state.busy||!state.status?.configured;controls.append(catchup);
      const reload=button('Reload Cached Inbox','reload');reload.disabled=state.busy;controls.append(reload);
    }
    header.append(who,controls);
    root.append(header);
    // Owner-controlled, read-only runtime acceptance. No message contents or credentials are displayed.
    const acceptance=node('section','mail-diagnostic');
    acceptance.setAttribute('aria-label','Owner mail release checks');
    const acceptanceHead=node('div','mail-diagnostic-head');
    acceptanceHead.append(node('strong','', 'Connection and release checks'));
    const check=button(state.diagnostic.phase==='running'?'Checking…':'Check connection','diagnose');
    check.disabled=state.diagnostic.phase==='running'||state.provider.phase==='running';
    acceptanceHead.append(check);acceptance.append(acceptanceHead);
    acceptance.append(node('p','mail-small','Checks the signed owner session, server configuration and cache metadata without reading message contents or contacting the mail provider.'));
    const diagnosticStatus=node('p','mail-diagnostic-status',state.diagnostic.summary);
    // Keep the existing inbox role=status as the primary mail live region.
    diagnosticStatus.setAttribute('aria-live','polite');
    diagnosticStatus.dataset.check=state.diagnostic.phase;acceptance.append(diagnosticStatus);
    const probe=button(state.provider.phase==='running'?'Checking Purelymail…':'Test IMAP login (read-only)','provider-check');
    probe.disabled=state.diagnostic.phase!=='checked'||state.provider.phase==='running';
    acceptance.append(probe);
    acceptance.append(node('p','mail-small','Optional provider test: opens a TLS session and EXAMINEs INBOX without downloading messages. It does not send mail.'));
    const providerStatus=node('p','mail-diagnostic-status',state.provider.summary);
    providerStatus.setAttribute('aria-live','polite');
    providerStatus.dataset.providerCheck=state.provider.phase;acceptance.append(providerStatus);
    if(state.diagnostic.items.length){
      const results=node('ul','mail-diagnostic-results');
      for(const item of state.diagnostic.items)results.append(node('li','',item));
      acceptance.append(results);
    }
    root.append(acceptance);
    if(state.status?.draftsEnabled){const draftHost=node('section','mail-drafts-host');draftHost.id='mail-drafts';draftHost.dataset.draftsEnabled='true';draftHost.setAttribute('aria-label','Stored unsent drafts');root.append(draftHost);}
    const notice=node('p','mail-banner',state.status?.draftsEnabled && state.status?.outgoingEnabled===true?'Outgoing mail requires a separately saved draft, two explicit owner actions, and a confirmed SMTP outbox. Recipient delivery is not guaranteed. HTML and attachments remain unavailable.':state.status?.draftsEnabled?'Sending, HTML and attachments are not enabled in this release. Drafts are stored privately but never sent.':'Receiving is read-only. Sending, drafts, HTML and attachments are not enabled in this release.');
    root.append(notice);
    const live=node('p','mail-live');
    live.setAttribute('role','status');
    live.setAttribute('aria-live','polite');
    const phase={
      checking:'Checking account configuration…',
      unavailable:'Account is not configured in this installation. No mailbox connection was attempted.',
      ready: state.receipt || 'Cached inbox records. Synchronization only runs when you select Synchronize Inbox.',
      loading:'Loading previously synchronized messages…',
      paging:'Loading the selected inbox page…',
      syncing:'Batch '+((state.run?.batches??0)+1)+' in progress. '+(state.run?.batches??0)+' confirmed; '+(state.run?.imported??0)+' new messages saved.'+(state.stopRequested?' Will stop after this batch.':''),
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
    if(state.status?.configured){
      const pages=node('nav','mail-pagination');pages.setAttribute('aria-label','Inbox pages');
      const newer=button('Newer','newer'),older=button('Older','older');
      newer.disabled=state.busy||state.stale||state.offset===0;
      older.disabled=state.busy||state.stale||state.offset+state.items.length>=state.total;
      const range=node('span','mail-page-range',state.total?
        (state.offset+1)+'–'+(state.offset+state.items.length)+' of '+state.total:'0 indexed messages');
      pages.append(newer,range,older);listing.append(pages);
    }
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
    if(state.status?.draftsEnabled)globalThis.StationDrafts?.mount?.(root.querySelector('#mail-drafts'),true,state.status?.outgoingEnabled===true,state.status?.outboxEnabled===true);
  }
  function diagnostic(phase,summary,items=[]){
    state.diagnostic={phase,summary,items};render();
  }
  async function diagnose(){
    if(state.diagnostic.phase==='running')return;
    diagnostic('running','Checking the active DevonStation owner session…');
    // An Access sign-in document is not the DevonStation application. Do not probe APIs
    // from a foreign origin, embedded frame, sign-in document, or restrictive page CSP.
    const meta=document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const connect=meta?.getAttribute('content')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('connect-src '));
    // Local loopback is a trustworthy browser testing context; all other
    // non-TLS origins remain blocked, and the Worker still authenticates.
    const securePage=location.protocol==='https:'||
      (location.protocol==='http:'&&['127.0.0.1','localhost'].includes(location.hostname));
    if(!securePage||window.top!==window.self||
       document.title!=='Devon Station'||!document.querySelector('.app main#view')||
       !document.getElementById('station-mail')){
      diagnostic('blocked','Open the signed-in DevonStation workspace, not the Cloudflare Access sign-in page.');return;
    }
    if(!connect||!connect.split(/\s+/).includes("'self'")){
      diagnostic('blocked','The running page policy does not permit same-origin checks. No request was attempted.');return;
    }
    async function read(path){
      let response;
      try{
        response=await fetch(path,{method:'GET',credentials:'same-origin',cache:'no-store',
          redirect:'manual',headers:{Accept:'application/json'}});
      }catch{return {kind:'network'};}
      if(response.type==='opaqueredirect'||response.status>=300&&response.status<400)return {kind:'sign_in'};
      if(response.status===401||response.status===403)return {kind:'sign_in'};
      if(!response.headers.get('content-type')?.toLowerCase().includes('application/json'))return {kind:'not_json'};
      if(!response.ok)return {kind:'unavailable'};
      try{return {kind:'ok',body:await response.json()};}catch{return {kind:'invalid_json'};}
    }
    function failure(stage,result){
      const reason=result.kind==='network'?'The browser blocked the request or the connection failed. Check the active page policy and network; provider credentials were not tested.':
        result.kind==='sign_in'||result.kind==='not_json'?'Cloudflare Access sign-in or an expired owner session was detected. Sign in to DevonStation and try again.':
        'The '+stage+' endpoint did not return a valid authorized response. No mailbox changes were made.';
      diagnostic('blocked',reason);return;
    }
    const session=await read('/api/session');
    if(session.kind!=='ok'||session.body?.authenticated!==true||session.body?.mode!=='owner'){
      failure('session',session.kind==='ok'?{kind:'sign_in'}:session);return;
    }
    const activeVersion=session.body.workerVersionId??null;
    if(activeVersion!==null&&(typeof activeVersion!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(activeVersion))){
      diagnostic('blocked','Invalid Worker version metadata. Release identity cannot be verified.');return;
    }
    diagnostic('running','Owner session verified. Checking mail configuration…',['Signed owner session: verified']);
    const status=await read('/api/mail/status');
    if(status.kind!=='ok'){failure('mail status',status);return;}
    const flags=status.body;
    if((flags?.workerVersionId??null)!==activeVersion){diagnostic('blocked','Different Worker versions handled the owner session and mail status. No provider test was attempted.');return;}
    if(!flags||typeof flags.configured!=='boolean'||flags.address!=='hello@devonakins.com'||flags.provider!=='purelymail'){
      diagnostic('blocked','Mail status returned an unexpected response. No provider operation was attempted.');return;
    }
    const lines=['Signed owner session: verified',
      'Worker version: '+(activeVersion??'not reported (cannot prove staged source)'),
      'Purelymail configuration: '+(flags.configured?'available':'incomplete'),
      'Saved drafts: '+(flags.draftsEnabled===true?'enabled':'disabled'),
      'Outgoing submission: '+(flags.outgoingEnabled===true?'enabled; recipient delivery remains unverified':'disabled'),
      'Outbox: '+(flags.outboxEnabled===true?'enabled':'disabled')];
    if(!flags.configured){
      diagnostic('blocked','Provider configuration is incomplete. No mailbox connection was attempted.',lines);return;
    }
    diagnostic('running','Mail configuration is available. Checking isolated cache metadata…',lines);
    // This endpoint returns only aggregate D1 metadata: no message plaintext,
    // ciphertext, provider credentials or raw SQL.
    const cache=await read('/api/mail/diagnostics');
    if(cache.kind!=='ok'){failure('mail cache',cache);return;}
    if((cache.body?.workerVersionId??null)!==activeVersion){
      diagnostic('blocked','Different Worker versions handled the mail cache and owner session. No provider test was attempted.',lines);return;
    }
    if(cache.body?.cacheReady!==true||
       !Number.isSafeInteger(cache.body.indexedCount)||cache.body.indexedCount<0||cache.body.indexedCount>500||
       !Number.isSafeInteger(cache.body.revision)||cache.body.revision<0){
      diagnostic('blocked','Mail cache metadata returned an invalid response. No provider sync was attempted.',lines);return;
    }
    lines.push('Isolated D1 cache metadata: reachable ('+cache.body.indexedCount+' indexed messages)');
    diagnostic('checked','Read-only application checks completed. Decryption, real IMAP, SMTP and recipient delivery remain unverified.',lines);
  }
  async function providerCheck(){
    if(state.diagnostic.phase!=='checked'||state.provider.phase==='running')return;
    state.provider={phase:'running',summary:'Checking Purelymail TLS login and read-only INBOX selection…'};render();
    const finish=(phase,summary)=>{state.provider={phase,summary};render();};
    let response;
    try{
      response=await fetch('/api/mail/diagnostics/imap-check',{
        method:'POST',credentials:'same-origin',cache:'no-store',redirect:'manual',
        headers:{Accept:'application/json','Content-Type':'application/json','X-DevonStation-Mail-Diagnostics':'1'},body:'{}'
      });
    }catch{
      finish('blocked','Browser or network prevented provider testing. No email was sent or synchronized.');return;
    }
    if(response.type==='opaqueredirect'||response.status===401||response.status===403||
       response.status>=300&&response.status<400){
      finish('blocked','Owner session expired or Cloudflare Access sign-in is required.');return;
    }
    if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')){
      finish('blocked','Unexpected sign-in or non-JSON response. No provider result was accepted.');return;
    }
    if(!response.ok){
      if(response.status===502){
        let failure;try{failure=await response.json();}catch{}
        if(failure?.error==='mail_imap_probe_failed'&&OPEN_DIAGNOSTIC_CODES.has(failure.diagnosticCode)){
          finish('blocked','The secure IMAP check stopped ('+failure.diagnosticCode+'). No message was downloaded or sent.');return;
        }
      }
      finish('blocked',response.status===503?'Provider credentials or encryption configuration are incomplete.':
        'The secure IMAP login or read-only INBOX check did not complete. Check credentials and connectivity.');return;
    }
    let value;
    try{value=await response.json();}catch{
      finish('blocked','Provider diagnostic returned invalid JSON.');return;
    }
    if(value?.imapAuthenticated!==true||value.inboxReadOnly!==true||
       value.messageContentRead!==false||value.remoteMailboxModified!==false||
       value.cacheModified!==false||value.smtpContacted!==false){
      finish('blocked','Provider diagnostic returned unexpected safety flags. No result was accepted.');return;
    }
    finish('checked','IMAP TLS login and read-only INBOX selection succeeded. Message synchronization, decryption, SMTP and delivery remain unverified.');
  }
  async function start(){
    if(state.busy)return;
    state.busy=true;
    state.phase='checking';
    state.error=null;state.receipt=null;state.hasMore=null;
    render();
    try{
      const status=await json(URLS.status);
      if(typeof status.configured!=='boolean' || status.address!=='hello@devonakins.com')
        throw Error('invalid_mail_response');
      state.status=status;
      if(!status.configured){
        state.phase='unavailable';state.items=[];state.total=0;state.selected=null;state.offset=0;state.revision=null;
      }else{
        state.phase='loading';render();
        const result=sanitizeResponse(await json(URLS.inbox));
        state.items=result.messages;state.total=result.total;state.offset=result.offset;state.revision=result.revision;state.stale=false;
        if(!state.items.some(x=>x.key===state.selected))state.selected=state.items[0]?.key??null;
        state.phase='ready';
      }
    }catch(error){
      state.phase='error';
      state.error=error?.message==='mail_sign_in_required'?'Your owner session has expired. Sign in again.':
        'Unable to read the private mailbox. No messages were sent or changed.';
      if(error?.message==='mail_sign_in_required'){state.items=[];state.total=0;state.selected=null;state.offset=0;state.revision=null;}
    }finally{state.busy=false;render();}
  }
  async function page(offset){
    if(state.busy||state.stale||!state.status?.configured||state.revision===null||offset<0||offset>=state.total)return;
    state.busy=true;state.phase='paging';state.error=null;render();
    try{
      const result=sanitizeResponse(await json('/api/mail/inbox?limit=50&offset='+offset+'&revision='+state.revision),offset);
      if(result.revision!==state.revision)throw Error('mail_inbox_changed');
      state.items=result.messages;state.total=result.total;state.offset=result.offset;
      state.selected=state.items[0]?.key??null;state.phase='ready';
    }catch(error){
      if(error?.message==='mail_inbox_changed')state.stale=true;
      state.phase='error';state.error=error?.message==='mail_inbox_changed'?
        'The inbox changed. Reload Cached Inbox before paging again. Your current page is retained.':
        error?.message==='mail_sign_in_required'?'Owner session expired. Sign in again.':
        'Unable to load that page. Your current page is retained; retry or reload the cached inbox.';
      if(error?.message==='mail_sign_in_required'){state.items=[];state.total=0;state.selected=null;state.offset=0;state.revision=null;}
    }finally{state.busy=false;render();}
  }
  async function sync(maxBatches=1){
    if(state.busy || !state.status?.configured)return;
    state.busy=true;state.phase='syncing';state.error=null;state.receipt=null;
    state.stopRequested=false;state.run={batches:0,imported:0,updated:0};render();
    try {
      for(let i=0;i<maxBatches;i++){
        const result=await json(URLS.sync,'POST');
        if(!result||typeof result!=='object'||!Number.isSafeInteger(result.imported)||result.imported<0||result.imported>100||
           !Number.isSafeInteger(result.updated)||result.updated<0||result.updated>100||
           typeof result.hasMore!=='boolean')throw Error('mail_sync_response:invalid_receipt');
        state.run.batches++;state.run.imported+=result.imported;state.run.updated+=result.updated;
        state.hasMore=result.hasMore;
        if(state.stopRequested||!result.hasMore||!document.getElementById('station-mail'))break;
        if(i+1<maxBatches)render();
      }
      const latest=sanitizeResponse(await json(URLS.inbox));
      state.items=latest.messages;state.total=latest.total;state.offset=latest.offset;state.revision=latest.revision;state.stale=false;
      if(!state.items.some(x=>x.key===state.selected))state.selected=state.items[0]?.key??null;
      state.receipt=state.run.batches+' batch(es) confirmed: '+state.run.imported+' new, '+state.run.updated+' updated. '+
        (state.stopRequested?'Stopped after the current batch. ':'')+
        (state.hasMore?'More catch-up remains. Select Sync Next Batch or Catch Up to continue.':
          'Caught up to the provider snapshot checked during this run; later arrivals need another check.');
      state.phase='ready';
    }catch(error){
      state.phase='error';
      state.error=error?.message==='mail_sign_in_required'?'Owner session expired. Sign in again.':
        (error?.message?.startsWith('mail_sync_diagnostic:')?'Synchronization stopped ('+error.message.slice(21)+'). ':
        error?.message?.startsWith('mail_sync_response:')?'Synchronization response unavailable ('+error.message.slice('mail_sync_response:'.length)+'). ':'Confirmation or inbox refresh unavailable. ')+state.run.batches+' batch(es) confirmed, '+state.run.imported+
        ' new messages saved. An unconfirmed request may still have committed; reload before retrying.';
      if(error?.message==='mail_sign_in_required'){state.items=[];state.total=0;state.selected=null;state.offset=0;state.revision=null;}
    }finally{state.busy=false;render();}
  }
  document.addEventListener('click',e=>{
    const button=e.target.closest?.('[data-mail-action]');
    if(!button || !document.getElementById('station-mail')?.contains(button))return;
    const action=button.dataset.mailAction;
    if(action==='diagnose'){void diagnose();return;}
    if(action==='provider-check'){void providerCheck();return;}
    if(action==='older'){void page(state.offset+50);return;}
    if(action==='newer'){void page(state.offset-50);return;}
    if(action==='sync'){void sync();return;}
    if(action==='catchup'){void sync(10);return;}
    if(action==='reload'){void start();return;}
    if(action==='stop'){state.stopRequested=true;render();return;}
    if(action==='select'){
      const key=button.dataset.mailKey;
      if(state.items.some(x=>x.key===key)){state.selected=key;render();}
    }
  });
  globalThis.StationMail=Object.freeze({
    mounted(section){
      if(section!=='mail'){if(state.phase==='syncing')state.stopRequested=true;return;}
      render();
      if(!state.initialized){state.initialized=true;void start();}
    },
    refresh(){if(document.getElementById('station-mail'))return start();}
  });
  if(location.hash==='#mail' && document.getElementById('station-mail'))globalThis.StationMail.mounted('mail');
})();
