import test from 'node:test';
import assert from 'node:assert/strict';
import {createClientDiagnostics} from '../src/diagnostics-core.mjs';
const privateState={
 drafts:[{id:'local:1',title:'PRIVATE-DO-NOT-EXPORT-SECRET',area:'Shinewell',destination:'https://private.example.test'}],
 feedback:[{note:'ANOTHER-SENSITIVE-FEEDBACK'}],outcomes:['private-project-ref'],
 history:[{action:'Do not reveal owner name'}],prefs:{theme:'slate'}
};
test('diagnostics emit only bounded counts, never draft content or private identifiers',()=>{
 const report=createClientDiagnostics({local:privateState,cloud:{mode:'blocked',revision:42,pending:true,subject:'hidden-sub',email:'hidden@example.test'},storageAvailable:true,journalPresent:true});
 assert.deepEqual(report.device,{localStorageWritesWorking:true,tabRecoveryJournalPresent:true,draftCount:1,feedbackCount:1,focusMarkCount:1,activityCount:1});
 assert.deepEqual(report.privateSync,{status:'blocked',revision:42,unconfirmedChanges:true,externalTabChangeObserved:false});
 const text=JSON.stringify(report);
 for(const secret of ['PRIVATE-DO-NOT-EXPORT','SENSITIVE-FEEDBACK','private-project-ref','hidden-sub','hidden@example','private.example','Do not reveal owner'])assert(!text.includes(secret));
 assert(report.security.containsDraftText===false);
});
test('diagnostics reject arbitrary mode, revision, or date metadata from untrusted session values',()=>{
 const report=createClientDiagnostics({cloud:{mode:'<img onerror=alert(1)>',revision:-3,pending:'true',externalChange:1},local:{drafts:'not-array'},generatedAt:'<script>',version:'other'});
 assert.equal(report.privateSync.status,'unknown');assert.equal(report.privateSync.revision,null);
 assert.equal(report.privateSync.unconfirmedChanges,false);assert.equal(report.device.draftCount,0);
 assert.equal(report.generatedAt,'unknown');assert.equal(report.appVersion,'unknown');
});
