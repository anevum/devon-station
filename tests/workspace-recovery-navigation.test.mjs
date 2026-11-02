import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../src/workspace-ui.js',import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function harness(){
  let present=true,downloads=0;
  const root={innerHTML:'',setAttribute(){},insertAdjacentHTML(_where,text){this.innerHTML+=text;}};
  const controls=new Map(['ws-backup-pass','ws-backup-repeat','ws-backup-file'].map(id=>[id,{value:'Synthetic navigation passphrase',files:[],focus(){}}]));
  const events={},calls=[],scope={scopeKind:'personal',scopeId:'synthetic'};
  const document={activeElement:null,getElementById:id=>id==='station-workspace'?(present?root:null):controls.get(id),createElement:()=>({click(){downloads++;}}),addEventListener(type,fn){(events[type]??=[]).push(fn);}};
  const sandbox={document,URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}},URLSearchParams,Blob,setTimeout:()=>0,
    StationWorkspaceBackup:{encrypt:async()=>({payload:'synthetic'}),decrypt:async()=>({snapshot:'synthetic'})},
    fetch:async(path,options)=>{calls.push({path,options});const data=path==='/api/workspaces'?{scopes:[scope]}:path.startsWith('/api/workspace/restore-review')?{actions:1,receipts:2,journalEvents:0,canRestore:true,reviewDigest:'synthetic'}:path.startsWith('/api/workspace/backup')?{snapshot:'synthetic'}:{projects:[],actions:[],receipts:[],generation:1};return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data};}};
  runInNewContext(source,sandbox);
  const recovery=mode=>events.click.forEach(fn=>fn({target:{closest:()=>({dataset:{wsRecovery:mode}})}}));
  const submit=mode=>events.submit.forEach(fn=>fn({target:{id:mode==='export'?'ws-backup-form':'ws-unlock-form'},preventDefault(){}}));
  const mounted=value=>{present=value;sandbox.StationWorkspace.mounted();};
  return {root,controls,sandbox,calls,recovery,submit,mounted,downloads:()=>downloads};
}
test('leaving during journal encryption suppresses late download and permits a fresh recovery',async()=>{
  const b=harness();await tick();let finish;
  b.sandbox.StationWorkspaceBackup.encrypt=()=>new Promise(resolve=>finish=resolve);
  b.recovery('export');b.submit('export');await tick();assert.equal(typeof finish,'function');
  b.mounted(false);b.mounted(true);finish({payload:'synthetic'});await tick();
  assert.equal(b.downloads(),0,'Cancelled recovery must not download after navigation');
  assert(!b.root.innerHTML.includes('Encrypted backup prepared'));
  b.sandbox.StationWorkspaceBackup.encrypt=async()=>({payload:'fresh'});
  b.recovery('export');b.submit('export');await tick();assert.equal(b.downloads(),1);
});
test('leaving while reading or decrypting a journal never starts a late review request',async()=>{
  for(const phase of ['read','decrypt']){
    const b=harness();await tick();let finish;
    const wait=()=>new Promise(resolve=>finish=resolve);
    b.controls.get('ws-backup-file').files=[{size:2,text:phase==='read'?wait:async()=>'{}'}];
    if(phase==='decrypt')b.sandbox.StationWorkspaceBackup.decrypt=wait;
    b.recovery('restore');b.submit('restore');await tick();assert.equal(typeof finish,'function');
    b.mounted(false);b.mounted(true);finish(phase==='read'?'{}':{snapshot:'synthetic'});await tick();
    assert.equal(b.calls.filter(c=>c.path.includes('restore-review')).length,0,'No decrypted transfer after navigation');
    assert(!b.root.innerHTML.includes('Backup unlocked'));
  }
});
test('an already-sent review reply cannot reopen recovery or finish a newer operation',async()=>{
  const b=harness();await tick();const fetch=b.sandbox.fetch;let reviewReply,encryptDone;
  b.sandbox.fetch=(path,options)=>path.includes('restore-review')?new Promise(resolve=>reviewReply=resolve):fetch(path,options);
  b.controls.get('ws-backup-file').files=[{size:2,text:async()=>'{}'}];
  b.recovery('restore');b.submit('restore');await tick();assert.equal(typeof reviewReply,'function');
  b.mounted(false);b.mounted(true);
  b.sandbox.StationWorkspaceBackup.encrypt=()=>new Promise(resolve=>encryptDone=resolve);
  b.recovery('export');b.submit('export');await tick();
  reviewReply({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({actions:1,canRestore:true})});await tick();
  assert(!b.root.innerHTML.includes('Backup unlocked'));assert(b.root.innerHTML.includes('Working…'));
  encryptDone({payload:'fresh'});await tick();assert.equal(b.downloads(),1);
});
