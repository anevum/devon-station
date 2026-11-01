import test from 'node:test';
import assert from 'node:assert/strict';
import {readTabRecoveryJournal,restoreLocal} from '../src/core.mjs';
import {syncEmptyState,trustedLegacyTabBaseline,reconcileOwnerStates} from '../src/sync-core.mjs';
const draft=(id,title)=>({id:'local:'+id,title,area:'Devon Works',project:null,destination:null,state:'Draft',createdAt:'2026-10-28T21:00:00Z'});

test('per-tab unsynced journal is recoverable even when shared localStorage was replaced',()=>{
 const a=syncEmptyState();a.drafts=[draft('a','Tab A')];
 const b=syncEmptyState();b.drafts=[draft('b','Tab B')];
 const journal={version:1,state:a};
 const recovered=readTabRecoveryJournal(journal);
 assert.deepEqual(restoreLocal(recovered,[]).drafts,a.drafts);
 assert.notDeepEqual(recovered.drafts,b.drafts);
});
test('malformed or oversized tab journals are rejected without loading arbitrary data',()=>{
 const state=syncEmptyState();
 for(const record of [null,{}, {version:2,state}, {version:1,state:{version:1,drafts:'wrong'}}, {version:1,state:{...state,history:Array(1000).fill({action:'A'.repeat(300),at:'now'})}}]){
  assert.equal(readTabRecoveryJournal(record),null);
 }
});
test('shared previous-confirmation snapshot is trusted only if this tab is identical',()=>{
 const origin=syncEmptyState();origin.drafts=[draft('a','First tab')];
 const other=syncEmptyState();other.drafts=[draft('b','Second tab')];
 const record={version:1,revision:2,state:other};
 assert.equal(trustedLegacyTabBaseline(origin,record),null);
 assert.deepEqual(trustedLegacyTabBaseline(other,record),record);
 assert.equal(trustedLegacyTabBaseline(other,{...record,revision:-1}),null);
});
test('tab-isolated baselines merge independent edits without treating another tab addition as deletion',()=>{
 const base=syncEmptyState();const a=structuredClone(base),b=structuredClone(base);
 a.drafts=[draft('a','A original')];b.drafts=[draft('b','B original')];
 const good=reconcileOwnerStates(base,a,b);
 assert(good.safe);assert.deepEqual(new Set(good.state.drafts.map(x=>x.title)),new Set(['A original','B original']));
 const contaminated=reconcileOwnerStates(b,a,b);
 assert.deepEqual(contaminated.state.drafts.map(x=>x.title),['A original']);
});
