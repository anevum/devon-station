import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileOwnerStates,shouldAdoptRemote,readConfirmedSnapshot,syncEmptyState} from '../src/sync-core.mjs';
const base=()=>syncEmptyState();
const draft=(id,title,state='Draft')=>({id:'local:'+id,title,area:'Devon Works',project:null,destination:null,state,createdAt:'2026-10-28T19:00:00Z'});
const fb=(id,note)=>({id:'local:'+id,note,section:'global',category:'Design',state:'Open',createdAt:'2026-10-28T19:00:00Z'});
test('clean confirmed device can adopt newer server revision automatically',()=>{
 const s=base(),confirmation={version:1,revision:2,state:structuredClone(s)};
 const server=base();server.drafts.push(draft('r1','Server update'));
 assert.equal(shouldAdoptRemote(s,confirmation),true);
 assert.equal(shouldAdoptRemote({...s,feedback:[fb('f1','Local note')]},confirmation),false);
 assert.equal(readConfirmedSnapshot(confirmation).revision,2);
 assert.equal(readConfirmedSnapshot({...confirmation,revision:-1}),null);
 assert.equal(readConfirmedSnapshot({...confirmation,version:2}),null);
});
test('three-way merge retains independent local and remote draft/feedback changes',()=>{
 const old=base(),device=base(),cloud=base();
 device.drafts=[draft('a1','Locally created task')];
 cloud.feedback=[fb('b1','Other device feedback')];
 const result=reconcileOwnerStates(old,device,cloud);
 assert.equal(result.safe,true);
 assert.equal(result.state.drafts[0].title,'Locally created task');
 assert.equal(result.state.feedback[0].note,'Other device feedback');
});
test('same-ID divergent edits never silently overwrite either device',()=>{
 const old=base();old.drafts=[draft('a1','Initial task')];
 const device=structuredClone(old),cloud=structuredClone(old);
 device.drafts[0].title='Edited locally';cloud.drafts[0].title='Edited remotely';
 const result=reconcileOwnerStates(old,device,cloud);
 assert.equal(result.safe,false);assert.equal(result.state,null);
 assert.deepEqual(result.conflicts,['drafts:local:a1']);
 assert(!JSON.stringify(result.conflicts).includes('Edited'));
});
test('deletion versus concurrent edit requires owner review',()=>{
 const old=base();old.drafts=[draft('a1','Original')];
 const device=structuredClone(old),cloud=structuredClone(old);
 device.drafts=[];cloud.drafts[0].title='Cloud edit';
 const result=reconcileOwnerStates(old,device,cloud);
 assert.equal(result.safe,false);assert(result.conflicts.includes('drafts:local:a1'));
});
test('unchanged local copy yields remote, unchanged remote yields local',()=>{
 const old=base();old.drafts=[draft('a1','Initial')];
 const cloud=structuredClone(old);cloud.drafts[0].title='Changed in cloud';
 let merged=reconcileOwnerStates(old,structuredClone(old),cloud);
 assert.equal(merged.safe,true);assert.equal(merged.state.drafts[0].title,'Changed in cloud');
 const device=structuredClone(old);device.drafts[0].title='Changed locally';
 merged=reconcileOwnerStates(old,device,structuredClone(old));
 assert.equal(merged.safe,true);assert.equal(merged.state.drafts[0].title,'Changed locally');
});
test('unrelated preference changes merge; same-setting divergent changes block',()=>{
 const old=base(),device=base(),cloud=base();
 device.prefs.accent='violet';cloud.prefs.theme='slate';
 let res=reconcileOwnerStates(old,device,cloud);
 assert.equal(res.safe,true);assert.equal(res.state.prefs.accent,'violet');assert.equal(res.state.prefs.theme,'slate');
 cloud.prefs.accent='teal';res=reconcileOwnerStates(old,device,cloud);
 assert.equal(res.safe,false);assert(res.conflicts.includes('prefs:accent'));
});
test('unknown legacy baseline rejects differing same-ID records and preferences',()=>{
 const device=base(),cloud=base();
 device.drafts=[draft('a1','Local')];cloud.drafts=[draft('a1','Remote')];
 assert.equal(reconcileOwnerStates(null,device,cloud).safe,false);
 const clean=base();clean.drafts=[draft('a2','Independent')];
 assert.equal(reconcileOwnerStates(null,clean,cloud).safe,true);
});
test('bounded activity view merges without leaking private text into conflict diagnostics',()=>{
 const old=base(),device=base(),cloud=base();
 device.history=[{action:'Locally saved note',at:'2026-10-28T19:02:00Z'}];
 cloud.history=[{action:'Remotely saved note',at:'2026-10-28T19:01:00Z'}];
 const merged=reconcileOwnerStates(old,device,cloud);
 assert.equal(merged.safe,true);assert.equal(merged.state.history.length,2);
 assert.equal(merged.state.history[0].action,'Locally saved note');
 assert(!JSON.stringify(merged.conflicts).includes('note'));
});
test('merge fails closed when aggregate rows exceed server limits',()=>{
 const old=base(),device=base(),cloud=base();
 device.drafts=Array.from({length:200},(_,i)=>draft('d'+i,'Local'));
 cloud.drafts=[draft('other','Remote')];
 const merged=reconcileOwnerStates(old,device,cloud);
 assert.equal(merged.safe,false);assert(merged.conflicts.includes('drafts:limit'));
});
