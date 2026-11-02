/* Explicit encrypted backups for personal Presence Studio.
 * Independent of generic StationCloud sync; no automatic upload or decrypt.
 * Passphrases remain in the browser's temporary form fields only.
 */
let presenceVaultBusy=false,presenceVaultPending=null,presenceVaultRevision=null;
function presenceVaultPanel(){
 return '<section class="panel ps-vault" id="ps-vault"><div class="panel-head"><div><span class="eyebrow">PERSONAL RECOVERY</span><h2>Encrypted Presence vault</h2></div><span class="ps-status">Explicit only</span></div>'+
 '<p class="tiny muted">Encrypt drafts and metrics before a backup leaves this device. An authorized Cloudflare Worker stores ciphertext only. There is no background sync, account connection or automatic post publishing.</p>'+
 '<p class="info-note warning">Your editing copy remains <strong>unencrypted in this browser</strong>. The server vault requires an approved database migration. A forgotten passphrase cannot be recovered. Export an encrypted file before replacing data.</p>'+
 '<form id="ps-vault-form"><div class="ps-vault-grid"><label>Vault passphrase<input id="ps-vault-pass" type="password" autocomplete="off" minlength="14" maxlength="256" required></label>'+
 '<label>Repeat passphrase for backups<input id="ps-vault-repeat" type="password" autocomplete="off" minlength="14" maxlength="256"></label></div>'+
 '<div class="button-row ps-vault-buttons"><button type="submit" name="vault-action" value="download">Download encrypted file</button><button type="submit" name="vault-action" value="save">Back up to private vault</button><button type="submit" name="vault-action" value="preview">Preview private vault</button></div>'+
 '<label class="ps-vault-file-label">Or unlock a saved encrypted file<input id="ps-vault-file" type="file" accept=".json,application/json"></label>'+
 '<button type="submit" name="vault-action" value="file">Preview encrypted file</button></form>'+
 '<div id="ps-vault-status" role="status" aria-live="polite" class="ps-vault-status">No remote vault has been checked.</div>'+
 '<div id="ps-vault-preview" hidden><p id="ps-vault-preview-summary"></p><button type="button" class="primary" data-ps-vault-restore>Restore preview to this device</button><button type="button" data-ps-vault-dismiss>Discard preview</button></div>'+
 '<div class="button-row"><button type="button" data-ps-vault-check>Check private vault availability</button></div></section>';
}
function presenceVaultMessage(message){
 const el=document.getElementById('ps-vault-status');if(el)el.textContent=String(message);
}
function presenceVaultClearPasswords(){
 for(const id of ['ps-vault-pass','ps-vault-repeat']){const el=document.getElementById(id);if(el)el.value='';}
}
function presenceVaultPreviewClear(){
 presenceVaultPending=null;const el=document.getElementById('ps-vault-preview');if(el)el.hidden=true;
}
async function presenceVaultAPI(method='GET',body){
 const res=await fetch('/api/presence/vault',{
  method,headers:{'X-Requested-With':'XMLHttpRequest',...(body?{'Content-Type':'application/json'}:{})},
  body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store',redirect:'manual'
 });
 if(res.status===401||res.status===403||res.type==='opaqueredirect'||(res.status>=300&&res.status<400))throw Error('Owner sign-in is required. No data was changed.');
 if(!res.headers.get('Content-Type')?.includes('application/json'))throw Error('Private vault returned an unexpected response. No data was changed.');
 const result=await res.json();
 if(!res.ok){
  if(res.status===409)throw Error('Private vault revision changed. Review the remote backup again; nothing was overwritten.');
  if(res.status===503||res.status>=500)throw Error('Encrypted vault is not configured or available. Local data remains unchanged.');
  throw Error('Private vault request rejected. No data was changed.');
 }
 return result;
}
function presenceVaultDownload(envelope){
 const blob=new Blob([JSON.stringify(envelope,null,2)],{type:'application/json'});
 const url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download='devonstation-presence-encrypted.json';a.click();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
document.addEventListener('submit',async event=>{
 if(event.target.id!=='ps-vault-form')return;event.preventDefault();
 if(presenceVaultBusy)return;
 const action=event.submitter?.value;
 if(!['download','save','preview','file'].includes(action))return;
 presenceVaultBusy=true;
 const pass=document.getElementById('ps-vault-pass')?.value||'',repeat=document.getElementById('ps-vault-repeat')?.value||'';
 const baseline=presenceLastSerialized;
 presenceVaultPreviewClear();
 try{
  if(pass.length<14||pass.length>256)throw Error('Use a passphrase of at least 14 characters.');
  if(action==='save'||action==='download'){
   if(pass!==repeat)throw Error('Backup passphrases do not match.');
   if(!presenceStorageAvailable||!presenceWritable()||localStorage.getItem(PRESENCE_STORAGE_KEY)!==baseline)throw Error('Device data changed or could not be saved. Export safely before retrying.');
   const envelope=await encryptPresenceVault(presenceState,pass);
   if(presenceConflict||localStorage.getItem(PRESENCE_STORAGE_KEY)!==baseline)throw Error('Local data changed while encrypting. No backup was written.');
   if(action==='download'){presenceVaultDownload(envelope);presenceVaultMessage('Encrypted file prepared. Keep the passphrase separately; it cannot be recovered.');}
   else{
    const remote=await presenceVaultAPI();
    presenceVaultRevision=remote.revision;
    if(remote.exists&&!window.confirm('Replace the existing encrypted private vault snapshot (revision '+remote.revision+') with a new encrypted snapshot? This does not delete your current browser drafts.'))return;
    if(presenceConflict||localStorage.getItem(PRESENCE_STORAGE_KEY)!==baseline)throw Error('Local data changed before upload. Backup stopped.');
    const result=await presenceVaultAPI('POST',{expectedRevision:remote.revision,operationId:crypto.randomUUID(),envelope});
    presenceVaultRevision=result.revision;
    presenceVaultMessage('Encrypted backup saved to private vault, revision '+result.revision+'. This is not automatic sync.');
   }
  }else{
   let incoming,revision=null,source;
   if(action==='preview'){
    const remote=await presenceVaultAPI();
    if(!remote.exists)throw Error('No encrypted private snapshot exists for this owner.');
    incoming=await decryptPresenceVault(remote.envelope,pass);revision=remote.revision;source='private vault';
   }else{
    const file=document.getElementById('ps-vault-file')?.files?.[0];
    if(!file||file.size>1100000)throw Error('Select a valid encrypted backup file, up to 1.1 MB.');
    incoming=await decryptPresenceVault(JSON.parse(await file.text()),pass);source='encrypted file';
   }
   if(presenceConflict||localStorage.getItem(PRESENCE_STORAGE_KEY)!==baseline)throw Error('Device data changed while unlocking; preview discarded.');
   presenceVaultPending={state:incoming,revision,source,baseline};
   const preview=document.getElementById('ps-vault-preview'),summary=document.getElementById('ps-vault-preview-summary');
   summary.textContent='Decrypted '+source+' preview: '+incoming.drafts.length+' drafts and '+incoming.snapshots.length+' metric snapshots'+(revision!==null?' · revision '+revision:'')+'. Nothing has been restored.';
   preview.hidden=false;
   presenceVaultMessage('Preview ready. Review the counts and export existing local work before explicitly replacing this device.');
  }
 }catch(error){presenceVaultMessage(error.message||'Encrypted backup failed. Local data remains unchanged.');}
 finally{presenceVaultClearPasswords();presenceVaultBusy=false;}
});
document.addEventListener('click',async event=>{
 const button=event.target.closest('button');if(!button||presenceVaultBusy)return;
 if('psVaultDismiss' in button.dataset){presenceVaultPreviewClear();presenceVaultMessage('Decrypted preview discarded.');return;}
 if('psVaultCheck' in button.dataset){
  presenceVaultBusy=true;
  try{const info=await presenceVaultAPI();presenceVaultRevision=info.revision;presenceVaultMessage(info.exists?'Encrypted owner vault available, revision '+info.revision+'. No automatic synchronization.':'Encrypted owner vault available, but no snapshot is stored.');}
  catch(error){presenceVaultMessage(error.message);}
  finally{presenceVaultBusy=false;}
  return;
 }
 if(!('psVaultRestore' in button.dataset))return;
 const pending=presenceVaultPending;if(!pending)return;
 presenceVaultBusy=true;
 try{
  if(presenceConflict||!presenceStorageAvailable||localStorage.getItem(PRESENCE_STORAGE_KEY)!==pending.baseline||presenceLastSerialized!==pending.baseline)throw Error('Local state changed since preview. Restore blocked to protect newer work.');
  if(pending.revision!==null){
   const current=await presenceVaultAPI();
   if(current.revision!==pending.revision)throw Error('Private vault changed after preview. Unlock its current version instead.');
  }
  if(!window.confirm('Replace the device-local Presence Studio drafts and metrics with the reviewed '+pending.source+'? Export your current local data first.'))return;
  if(presenceConflict||localStorage.getItem(PRESENCE_STORAGE_KEY)!==pending.baseline)throw Error('Device data changed before restore. No replacement was made.');
  const original=presenceState;
  try{presenceState=pending.state;presenceEditId=null;presenceSave();if(!presenceStorageAvailable)throw Error('Device storage unavailable; original data retained.');}
  catch(error){presenceState=original;throw error;}
  presenceVaultPreviewClear();render();notify('Decrypted Presence Studio snapshot restored locally. No social posts were published.');
 }catch(error){presenceVaultMessage(error.message);}
 finally{presenceVaultBusy=false;}
});
