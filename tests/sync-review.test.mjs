import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileOwnerStates,resolveOwnerConflicts,syncEmptyState} from '../src/sync-core.mjs';
const initial=()=>syncEmptyState();
const draft=(id,title)=>({id:'local:'+id,title,area:'Devon Works',project:null,destination:null,state:'Draft',createdAt:'2026-10-28T21:00:00Z'});
const feedback=(id,note)=>({id:'local:'+id,note,section:'settings',category:'Behavior',state:'Open',createdAt:'2026-10-28T21:00:00Z'});
function conflict(){
 const b=initial();b.drafts=[draft('same','Original')];
 const d=structuredClone(b),r=structuredClone(b);
 d.drafts[0].title='Local change';r.drafts[0].title='Cloud change';
 return {b,d,r};
}
test('explicit owner decision can keep the device version of a divergent draft',()=>{
 const {b,d,r}=conflict();const label='drafts:local:same';
 assert.deepEqual(reconcileOwnerStates(b,d,r).conflicts,[label]);
 const output=resolveOwnerConflicts(b,d,r,{[label]:'device'});
 assert.equal(output.drafts[0].title,'Local change');
 assert.equal(r.drafts[0].title,'Cloud change');
});
test('explicit owner decision can keep the cloud version without a second draft',()=>{
 const {b,d,r}=conflict();
 const output=resolveOwnerConflicts(b,d,r,{'drafts:local:same':'cloud'});
 assert.deepEqual(output.drafts,r.drafts);
 assert.equal(output.drafts.length,1);
});
test('deleting an item and editing it concurrently requires a side selection',()=>{
 const {b,d,r}=conflict();d.drafts=[];
 assert.equal(resolveOwnerConflicts(b,d,r,{'drafts:local:same':'device'}).drafts.length,0);
 assert.equal(resolveOwnerConflicts(b,d,r,{'drafts:local:same':'cloud'}).drafts[0].title,'Cloud change');
});
test('independent feedback and history survive a decision on a conflicting draft',()=>{
 const {b,d,r}=conflict();d.feedback=[feedback('f1','From this device')];r.feedback=[feedback('f2','From cloud')];
 d.history=[{action:'Local capture saved',at:'2026-10-28T21:01:00Z'}];
 r.history=[{action:'Cloud capture saved',at:'2026-10-28T21:02:00Z'}];
 const output=resolveOwnerConflicts(b,d,r,{'drafts:local:same':'device'});
 assert.equal(output.feedback.length,2);assert.equal(output.history.length,2);
 assert.equal(output.drafts[0].title,'Local change');
});
test('preferences, outcomes and feedback can be decided independently',()=>{
 const b=initial(),d=initial(),r=initial();b.feedback=[feedback('f1','Initial')];d.feedback=[feedback('f1','Device')];r.feedback=[feedback('f1','Cloud')];
 d.prefs.accent='violet';r.prefs.accent='teal';d.outcomes=['one'];r.outcomes=['two'];
 const output=resolveOwnerConflicts(b,d,r,{'feedback:local:f1':'cloud','prefs:accent':'device',outcomes:'cloud'});
 assert.equal(output.feedback[0].note,'Cloud');assert.equal(output.prefs.accent,'violet');assert.deepEqual(output.outcomes,['two']);
});
test('incomplete, extraneous and invalid decisions fail closed',()=>{
 const {b,d,r}=conflict();
 for(const choices of [null,{}, {'drafts:local:same':'choose-latest'}, {'drafts:local:same':'device',another:'cloud'}]){
  assert.throws(()=>resolveOwnerConflicts(b,d,r,choices));
 }
 assert.throws(()=>resolveOwnerConflicts(b,d,r,{'__proto__':'device'}));
});
test('row limit cannot be overridden by decisions',()=>{
 const b=initial(),d=initial(),r=initial();
 d.drafts=Array.from({length:200},(_,i)=>draft('device'+i,'Device item '+i));
 r.drafts=[draft('cloud','Cloud item')];
 const review=reconcileOwnerStates(b,d,r);assert(review.conflicts.includes('drafts:limit'));
 assert.throws(()=>resolveOwnerConflicts(b,d,r,{'drafts:limit':'device'}),/sync_capacity_exceeded/);
});
test('no-conflict reconciliation does not accept fabricated decisions',()=>{
 const b=initial(),d=initial(),r=initial();d.drafts=[draft('device','One')];
 assert.equal(resolveOwnerConflicts(b,d,r,{}).drafts[0].title,'One');
 assert.throws(()=>resolveOwnerConflicts(b,d,r,{'prefs:theme':'device'}),/unexpected_conflict_decision/);
});
