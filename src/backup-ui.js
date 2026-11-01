/* Owner-initiated portable recovery: never sends backup content or passphrases to an API. */
(()=>{
 const dialog=document.getElementById('backup-dialog');if(!dialog)return;
 const form=document.getElementById('backup-form');const file=document.getElementById('backup-file');
 const pass=document.getElementById('backup-passphrase');const confirmation=document.getElementById('backup-repeat');
 const summary=document.getElementById('backup-summary');const error=document.getElementById('backup-error');
 const submit=document.getElementById('backup-submit');const headline=document.getElementById('backup-title');
 let mode='export',phase='unlock',staged=null,busy=false;
 function reset(){pass.required=true;pass.value='';confirmation.value='';file.value='';file.disabled=false;staged=null;phase='unlock';busy=false;error.textContent='';summary.textContent='';submit.disabled=false;}
 function show(kind){reset();mode=kind;headline.textContent=mode==='export'?'Create encrypted recovery file':'Restore encrypted recovery file';file.closest('label').hidden=mode==='export';confirmation.closest('label').hidden=mode!=='export';submit.textContent=mode==='export'?'Download encrypted file':'Unlock and preview';summary.textContent=mode==='export'?'Includes device drafts, feedback, preferences and focus markers. Excludes Notion records, passwords and tokens.':'The file will be decrypted on this device only. No cloud state will change until you separately review and sync it.';dialog.showModal();(mode==='export'?pass:file).focus();}
 function fail(err){const messages={passphrase_must_be_14_to_256_characters:'Use a passphrase with at least 14 characters.',backup_unlock_failed_or_file_modified:'Passphrase is incorrect or this file was changed.',backup_contains_unsupported_content:'This device has unsupported or sensitive notes. Review and export non-sensitive notes only.',invalid_backup_draft:'A draft contains unsupported project links or invalid metadata.',invalid_backup_state:'The file does not contain a supported owner-state backup.',invalid_backup_envelope:'Not a valid encrypted Devon Station backup.',unsupported_backup_format:'This backup format is not supported.',backup_state_limit_exceeded:'The backup exceeds private state limits.',device_storage_unavailable:'Device storage could not save the restored copy. Your cloud data remains unchanged. Keep the encrypted file.'};error.textContent=messages[err?.message]||'Backup operation failed. No cloud data was changed.';}
 document.addEventListener('click',event=>{const target=event.target.closest('button');if(!target)return;
  if(target.id==='backup-create')show('export');
  else if(target.id==='backup-open')show('restore');
  else if(target.id==='backup-cancel'||target.hasAttribute('data-backup-cancel')){if(!busy){dialog.close();reset();}}
 });
 dialog.addEventListener('close',()=>{if(!busy)reset();});
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;error.textContent='';submit.disabled=true;
  try{
   if(mode==='export'){
    if(pass.value!==confirmation.value)throw Error('passphrases_do_not_match');
    const localCopy={version:1,prefs:{...local.prefs},drafts:local.drafts,feedback:local.feedback,outcomes:local.outcomes,history:local.history};
    const fileData=await encryptPortableBackup(localCopy,pass.value);
    download(fileData,'devon-station-encrypted-'+new Date().toISOString().slice(0,10)+'.json');
    dialog.close();reset();return;
   }
   if(phase==='unlock'){
    const item=file.files?.[0];if(!item||item.size>350000)throw Error('invalid_backup_envelope');
    let raw;try{raw=JSON.parse(await item.text());}catch{throw Error('invalid_backup_envelope');}
    staged=await decryptPortableBackup(raw,pass.value);
    phase='confirm';pass.value='';pass.required=false;file.disabled=true;
    summary.textContent=`Decrypted ${staged.drafts.length} drafts and ${staged.feedback.length} feedback notes. This replaces the device copy only. The cloud stays unchanged until you choose Review device changes. Export your existing device notes first if you need them.`;
    submit.textContent='Stage on this device';return;
   }
   if(phase==='confirm'){
    if(!staged)throw Error('invalid_backup_state');
    // Put cloud sync into an explicit review-only mode *before* altering local state.
    if(globalThis.StationCloud?.stageBackupRestore){const ready=await globalThis.StationCloud.stageBackupRestore();if(!ready)throw Error('backup_sync_busy');}
    const next=JSON.parse(JSON.stringify(staged));
    next.history=[{action:'Encrypted recovery copy staged',at:new Date().toISOString()},...next.history].slice(0,30);
    const recovered={version:1,...next};
    try{sessionStorage.setItem(TAB_RECOVERY_KEY,JSON.stringify({version:1,state:recovered}))}catch{}
    try{localStorage.setItem(KEY,JSON.stringify(recovered))}
    catch{throw Error('device_storage_unavailable')}
    local=next;applyPrefs();render();
    globalThis.StationCloud?.onLocalChange?.();
    dialog.close();reset();
    notify('Backup restored on this device. Review device changes before cloud sync.');return;
   }
  }catch(e){if(e?.message==='passphrases_do_not_match')error.textContent='Passphrases do not match.';else if(e?.message==='backup_sync_busy')error.textContent='Wait for the current sync to finish, then retry.';else fail(e);}
  finally{busy=false;submit.disabled=false;}
 });
})();
