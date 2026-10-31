import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createFoundation, verifyImport, restoreFoundation } from '../src/foundation.mjs';
const owner={principalId:'owner',role:'owner',scopeKind:'personal',scopeId:'scope1'};
const project={projectId:'project1',scopeKind:'personal',scopeId:'scope1',title:'Synthetic project',freshness:'cached',source:{sourceSystem:'notion',sourceType:'project',sourceId:'source1',sourceRevision:'rev1',sourceUrl:'https://www.notion.so/example',observedAt:'2026-01-01T00:00:00.000Z'}};
const scope={scopeKind:'personal',scopeId:'scope1'};
const setup=()=>createFoundation({identity:owner,projects:[project],clock:()=> '2026-01-01T00:00:00.000Z'});
const proposed={operationId:'op1',recordId:'action1',projectId:'project1',summary:'Review synthetic plan',expectedRevision:0};
test('projection, approval, private receipts and independent import',()=>{ const f=setup(); assert.deepEqual(f.projects(owner),[project]); f.propose(owner,proposed); const d=f.decide(owner,{operationId:'op2',recordId:'action1',decision:'approved',expectedRevision:1}); assert.equal(d.result,'approved'); const data=verifyImport(f.export(owner),scope); assert.deepEqual(data.projects,[project]); assert.deepEqual(data.actions,f.actions(owner)); assert.deepEqual(data.receipts,f.receipts(owner)); assert.ok(!JSON.stringify(data.receipts).includes(proposed.summary)); assert.ok(!JSON.stringify(data.receipts).includes('source1')); data.receipts[0].result='modified'; assert.equal(f.receipts(owner)[0].result,'proposed'); });
test('explicit rejection and invalid transitions',()=>{ const f=setup(); f.propose(owner,proposed); f.decide(owner,{operationId:'op2',recordId:'action1',decision:'rejected',expectedRevision:1}); assert.equal(f.actions(owner)[0].status,'rejected'); assert.throws(()=>f.decide(owner,{operationId:'op3',recordId:'action1',decision:'approved',expectedRevision:2})); });
test('unauthorized identities and cross scope denied',()=>{ const f=setup(); for(const a of [{...owner,principalId:'other'},{...owner,scopeId:'other'},{...owner,role:'viewer'}]) { assert.throws(()=>f.projects(a)); assert.throws(()=>f.propose(a,proposed)); assert.throws(()=>f.export(a)); } assert.throws(()=>createFoundation({identity:owner,projects:[{...project,scopeId:'other'}]})); });
test('revision conflicts, retry and conflicting operation reuse',()=>{ const f=setup(); const r=f.propose(owner,proposed); assert.deepEqual(f.propose(owner,proposed),r); assert.throws(()=>f.propose(owner,{...proposed,summary:'Different'})); assert.throws(()=>f.decide(owner,{operationId:'op2',recordId:'action1',decision:'approved',expectedRevision:0})); const d={operationId:'op2',recordId:'action1',decision:'approved',expectedRevision:1}; assert.deepEqual(f.decide(owner,d),f.decide(owner,d)); assert.equal(f.receipts(owner).length,2); assert.deepEqual(f.projects(owner),[project]); });
test('bad fields, unsafe URLs, secret-shaped text and oversized inputs rejected',()=>{ for(const url of ['http://github.com/a','https://github.com.evil.test/a','https://user@github.com/a','https://github.com/a?token=x','https://github.com/a#x']) assert.throws(()=>createFoundation({identity:owner,projects:[{...project,source:{...project.source,sourceUrl:url}}]})); assert.throws(()=>createFoundation({identity:owner,projects:[{...project,privateBody:'x'}]})); const f=setup(); for(const summary of ['x'.repeat(201),'token=abc','Bearer abc']) assert.throws(()=>f.propose(owner,{...proposed,summary})); assert.throws(()=>verifyImport('x'.repeat(1024*1024+1),scope)); });
test('tampering, unsupported version and wrong scope rejected',()=>{ const f=setup(); f.propose(owner,proposed); const e=JSON.parse(f.export(owner)); e.data.actions[0].summary='changed'; assert.throws(()=>verifyImport(JSON.stringify(e),scope)); const original=JSON.parse(f.export(owner)); original.version=99; assert.throws(()=>verifyImport(JSON.stringify(original),scope)); assert.throws(()=>verifyImport(f.export(owner),{...scope,scopeId:'other'})); });

const checksum = e => { e.checksum=createHash('sha256').update(JSON.stringify(e.data)).digest('hex'); return JSON.stringify(e); };
test('mutable restore preserves history, operation retries and independent state',()=>{
 const f=setup(); const p=f.propose(owner,proposed); const decision={operationId:'op2',recordId:'action1',decision:'approved',expectedRevision:1}; const d=f.decide(owner,decision);
 const restored=restoreFoundation({identity:owner,serialized:f.export(owner),clock:()=> '2026-01-01T00:00:01.000Z'});
 assert.deepEqual(restored.propose(owner,{summary:proposed.summary,expectedRevision:0,projectId:'project1',recordId:'action1',operationId:'op1'}),p);
 assert.deepEqual(restored.decide(owner,decision),d); assert.throws(()=>restored.decide(owner,{...decision,decision:'rejected'}),/operation conflict/);
 restored.propose(owner,{operationId:'op3',recordId:'action2',projectId:'project1',summary:'Another synthetic action',expectedRevision:0});
 assert.equal(restored.actions(owner).length,2); assert.equal(f.actions(owner).length,1); assert.equal(restored.receipts(owner).length,3);
 assert.throws(()=>restoreFoundation({identity:{...owner,principalId:'other'},serialized:f.export(owner)}),/unauthorized/);
 assert.throws(()=>restoreFoundation({identity:{...owner,scopeId:'other'},serialized:f.export(owner)}),/scope mismatch/);
});
test('recomputed checksum cannot hide malformed history or broken operation associations',()=>{
 const f=setup(); f.propose(owner,proposed); f.decide(owner,{operationId:'op2',recordId:'action1',decision:'rejected',expectedRevision:1}); const original=JSON.parse(f.export(owner));
 const cases=[
  e=>e.data.actions[0].summary='altered',
  e=>e.data.receipts[1].result='approved',
  e=>e.data.receipts.pop(),
  e=>e.data.operations[1].operationId=e.data.operations[0].operationId,
  e=>e.data.operations[1].receiptId=e.data.operations[0].receiptId,
  e=>e.data.operations[0].fingerprint='0'.repeat(64),
  e=>e.data.receipts[0].timestamp='2020-01-01T00:00:00.000Z',
  e=>e.data.actions[0].privateBody='not allowed',
  e=>e.data.projects[0].source.sourceUrl='https://github.com/x?secret=y',
  e=>e.data.owner.principalId='other',
 ];
 for(const change of cases){const e=structuredClone(original); change(e); assert.throws(()=>verifyImport(checksum(e),scope));}
});
test('clock regressions and invalid v1 exports fail closed',()=>{
 let now='2026-01-02T00:00:00.000Z'; const f=createFoundation({identity:owner,projects:[project],clock:()=>now}); f.propose(owner,proposed); now='2026-01-01T00:00:00.000Z'; assert.throws(()=>f.decide(owner,{operationId:'op2',recordId:'action1',decision:'approved',expectedRevision:1}),/clock/);
 const e=JSON.parse(f.export(owner)); e.version=1; assert.throws(()=>verifyImport(checksum(e),scope));
});
test('restored pending proposal can be rejected and re-exported',()=>{
 const f=setup(); f.propose(owner,proposed); const restored=restoreFoundation({identity:owner,serialized:f.export(owner),clock:()=> '2026-01-01T00:00:01.000Z'});
 const request={operationId:'op2',recordId:'action1',decision:'rejected',expectedRevision:1}; const receipt=restored.decide(owner,request);
 const again=restoreFoundation({identity:owner,serialized:restored.export(owner)}); assert.equal(again.actions(owner)[0].status,'rejected'); assert.deepEqual(again.decide(owner,request),receipt); assert.deepEqual(again.projects(owner),[project]);
});
