import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../src/backup-ui.js',import.meta.url),'utf8');
const secret='Synthetic browser passphrase only';
function harness({encrypt=async()=>({ciphertext:'synthetic'}),decrypt=async()=>({drafts:[],feedback:[],history:[]})}={}){
  const ids=['backup-dialog','backup-form','backup-file','backup-passphrase','backup-repeat','backup-summary','backup-error','backup-submit','backup-title'];
  const controls=new Map(ids.map(id=>[id,{id,value:'',disabled:false,required:true,textContent:'',events:{},label:{hidden:false},closest(){return this.label;},focus(){},addEventListener(name,fn){this.events[name]=fn;}}]));
  const dialog=controls.get('backup-dialog');dialog.open=false;dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;dialog.events.close?.();};
  const document={getElementById:id=>controls.get(id),events:{},addEventListener(name,fn){this.events[name]=fn;}};
  const writes=[],downloads=[],calls=[];
  const sandbox={document,local:{version:1,prefs:{},drafts:[],feedback:[],outcomes:[],history:[]},
    encryptPortableBackup:async(state,password)=>{calls.push(password);return encrypt(state,password);},
    decryptPortableBackup:async(raw,password)=>{calls.push(password);return decrypt(raw,password);},
    download:value=>downloads.push(value),KEY:'synthetic-local',TAB_RECOVERY_KEY:'synthetic-tab',
    sessionStorage:{setItem:(...args)=>writes.push(args)},localStorage:{setItem:(...args)=>writes.push(args)},
    applyPrefs(){},render(){},notify(){}};
  runInNewContext(source,sandbox);
  const click=id=>document.events.click({target:{closest:()=>({id,hasAttribute:()=>false})}});
  const submit=()=>controls.get('backup-form').events.submit({preventDefault(){}});
  const fill=()=>{controls.get('backup-passphrase').value=secret;controls.get('backup-repeat').value=secret;};
  return {controls,dialog,click,submit,fill,writes,downloads,calls,sandbox};
}

test('export clears both secret fields before pending encryption and on crypto/mismatch failures',async()=>{
  let reject;const b=harness({encrypt:()=>new Promise((_,no)=>reject=no)});
  b.click('backup-create');b.fill();const pending=b.submit();
  assert.equal(b.controls.get('backup-passphrase').value,'');assert.equal(b.controls.get('backup-repeat').value,'');
  assert.deepEqual(b.calls,[secret]);assert.equal(b.controls.get('backup-submit').disabled,true);
  reject(Error('Synthetic secret must not be displayed'));await pending;
  assert.equal(b.controls.get('backup-passphrase').value,'');assert.equal(b.controls.get('backup-repeat').value,'');
  assert.equal(b.controls.get('backup-submit').disabled,false);assert.equal(b.downloads.length,0);assert.equal(b.writes.length,0);
  assert(!b.controls.get('backup-error').textContent.includes('Synthetic secret'));
  b.fill();b.controls.get('backup-repeat').value='different';await b.submit();
  assert.equal(b.controls.get('backup-passphrase').value,'');assert.equal(b.controls.get('backup-repeat').value,'');
  assert.equal(b.calls.length,1);assert.match(b.controls.get('backup-error').textContent,/do not match/);
});

test('restore captures secret before file reading, clears on unlock failure and retains explicit staging confirmation',async()=>{
  let read;const b=harness();b.click('backup-open');b.fill();
  b.controls.get('backup-file').files=[{size:10,text:()=>new Promise(resolve=>read=resolve)}];
  const pending=b.submit();assert.equal(b.controls.get('backup-passphrase').value,'');assert.equal(b.controls.get('backup-repeat').value,'');
  read('{}');await pending;assert.deepEqual(b.calls,[secret]);assert.equal(b.writes.length,0);assert.equal(b.dialog.open,true);
  assert.match(b.controls.get('backup-summary').textContent,/device copy only/);
  await b.submit();assert.equal(b.writes.length,2);assert.equal(b.dialog.open,false);
  const failed=harness({decrypt:async()=>{throw Error('backup_unlock_failed_or_file_modified');}});
  failed.click('backup-open');failed.fill();failed.controls.get('backup-file').files=[{size:2,text:async()=>'{}'}];await failed.submit();
  assert.equal(failed.controls.get('backup-passphrase').value,'');assert.equal(failed.writes.length,0);
});

test('busy encryption blocks Escape, duplicate submit, mode changes and cancel; completion permits close',async()=>{
  let resolve;const b=harness({encrypt:()=>new Promise(yes=>resolve=yes)});
  b.click('backup-create');b.fill();const pending=b.submit();
  let prevented=false;b.dialog.events.cancel?.({preventDefault(){prevented=true;}});assert.equal(prevented,true);
  b.click('backup-open');b.click('backup-cancel');await b.submit();
  assert.equal(b.controls.get('backup-title').textContent,'Create encrypted recovery file');assert.equal(b.dialog.open,true);assert.equal(b.calls.length,1);
  resolve({ciphertext:'synthetic'});await pending;assert.equal(b.downloads.length,1);assert.equal(b.dialog.open,false);
  b.click('backup-create');prevented=false;b.dialog.events.cancel?.({preventDefault(){prevented=true;}});assert.equal(prevented,false);
  b.fill();b.click('backup-cancel');assert.equal(b.controls.get('backup-passphrase').value,'');assert.equal(b.controls.get('backup-repeat').value,'');
});
