import { createHash, randomUUID } from 'node:crypto';

// Accommodates the worst-case bounded synthetic history, including JSON escaping.
const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const shape = (o, required, optional = []) => {
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some(k => ![...required, ...optional].includes(k)) || required.some(k => !Object.hasOwn(o, k))) fail('invalid fields');
};
const id = v => { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v)) fail('invalid identifier'); return v; };
const clean = (v, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || Buffer.byteLength(v) > max || /[\u0000-\u001f]|bearer\s|(?:token|secret|password|api[_-]?key)\s*[:=]/i.test(v)) fail('invalid text');
  return v;
};
const date = v => { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail('invalid timestamp'); return v; };
function projection(p) {
  shape(p, ['projectId','scopeKind','scopeId','title','freshness','source']);
  id(p.projectId); id(p.scopeId); clean(p.title);
  if (!['personal','business','creative'].includes(p.scopeKind) || !['cached','current'].includes(p.freshness)) fail('invalid scope or freshness');
  shape(p.source,['sourceSystem','sourceType','sourceId','observedAt'],['sourceRevision','sourceUrl']);
  id(p.source.sourceSystem); id(p.source.sourceType); id(p.source.sourceId); date(p.source.observedAt);
  if (p.source.sourceRevision !== undefined) id(p.source.sourceRevision);
  if (p.source.sourceUrl !== undefined) {
    const raw = clean(p.source.sourceUrl, 512); let u; try { u = new URL(raw); } catch { fail('unsafe URL'); }
    if (u.protocol !== 'https:' || !['www.notion.so','notion.so','github.com'].includes(u.hostname) || u.port || u.username || u.password || u.search || u.hash || u.href !== raw) fail('unsafe URL');
  }
  return clone(p);
}

// Trusted adapter supplies claims. This module does not authenticate identities.
export function createFoundation(options) { return buildFoundation(options); }
function buildFoundation({ identity, projects, clock = () => new Date().toISOString() }, restored) {
  shape(identity,['principalId','role','scopeKind','scopeId']); id(identity.principalId); id(identity.scopeId);
  if (identity.role !== 'owner' || !['personal','business','creative'].includes(identity.scopeKind)) fail('unauthorized');
  const claim = {principalId:identity.principalId,role:identity.role,scopeKind:identity.scopeKind,scopeId:identity.scopeId}, projectMap = new Map(), actions = new Map(), receipts = [], operations = new Map();
  if (!Array.isArray(projects) || projects.length > 100) fail('invalid projects');
  for (const raw of projects) { const p = projection(raw); if (p.scopeKind !== claim.scopeKind || p.scopeId !== claim.scopeId || projectMap.has(p.projectId)) fail('scope or project conflict'); projectMap.set(p.projectId,p); }
  if (restored) {
    for (const a of restored.actions) actions.set(a.recordId, clone(a));
    for (const r of restored.receipts) receipts.push(clone(r));
    const byReceipt = new Map(receipts.map(r => [r.receiptId, r]));
    for (const op of restored.operations) operations.set(op.operationId, {fingerprint:op.fingerprint, receipt:byReceipt.get(op.receiptId)});
  }
  function auth(actor) { shape(actor,['principalId','role','scopeKind','scopeId']); if (Object.keys(claim).some(k => actor[k] !== claim[k])) fail('unauthorized'); }
  function mutate(actor, input, kind) {
    auth(actor);
    if (kind === 'propose') shape(input,['operationId','recordId','projectId','summary','expectedRevision']);
    else shape(input,['operationId','recordId','decision','expectedRevision']);
    id(input.operationId); id(input.recordId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('invalid revision');
    if (kind === 'propose') { id(input.projectId); clean(input.summary); if (!projectMap.has(input.projectId)) fail('unknown project'); }
    else if (!['approved','rejected'].includes(input.decision)) fail('invalid decision');
    // Canonical field order makes retries independent of caller object insertion order.
    const normalized = kind === 'propose'
      ? {operationId:input.operationId,recordId:input.recordId,projectId:input.projectId,summary:input.summary,expectedRevision:input.expectedRevision}
      : {operationId:input.operationId,recordId:input.recordId,decision:input.decision,expectedRevision:input.expectedRevision};
    const fingerprint = hash({kind, actor: claim, input:normalized});
    const prior = operations.get(input.operationId);
    if (prior) { if (prior.fingerprint !== fingerprint) fail('operation conflict'); return clone(prior.receipt); }
    const old = actions.get(input.recordId);
    if (kind === 'propose' && (old || input.expectedRevision !== 0)) fail('revision conflict');
    if (kind === 'decide' && (!old || old.revision !== input.expectedRevision || old.status !== 'proposed')) fail('revision conflict');
    if (kind === 'propose' && actions.size >= 1000) fail('history limit');
    if (receipts.length >= 2000) fail('history limit');
    const now = date(clock());
    if (old && now < old.updatedAt) fail('clock moved backwards');
    const next = kind === 'propose' ? {schemaVersion:1,recordId:input.recordId,projectId:input.projectId,scopeKind:claim.scopeKind,scopeId:claim.scopeId,summary:input.summary,status:'proposed',revision:1,createdAt:now,updatedAt:now} : {...old,status:input.decision,revision:old.revision+1,updatedAt:now};
    const receipt = {receiptId:randomUUID(),recordId:next.recordId,scopeId:claim.scopeId,action:kind,result:next.status,revision:next.revision,timestamp:now,payloadDigest:fingerprint};
    actions.set(next.recordId,next); receipts.push(receipt); operations.set(input.operationId,{fingerprint,receipt}); return clone(receipt);
  }
  return Object.freeze({
    projects(actor) { auth(actor); return clone([...projectMap.values()]); },
    actions(actor) { auth(actor); return clone([...actions.values()]); },
    receipts(actor) { auth(actor); return clone(receipts); },
    propose(actor,input) { return mutate(actor,input,'propose'); },
    decide(actor,input) { return mutate(actor,input,'decide'); },
    export(actor) { auth(actor); const data={owner:claim,scope:{scopeKind:claim.scopeKind,scopeId:claim.scopeId},projects:[...projectMap.values()],actions:[...actions.values()],receipts,operations:[...operations].map(([operationId,entry])=>({operationId,fingerprint:entry.fingerprint,receiptId:entry.receipt.receiptId}))}; return JSON.stringify({format:'devonstation-synthetic',version:2,algorithm:'sha256',data,checksum:hash(data)}); }
  });
}

// Integrity verification, not authentication: an attacker can recalculate an unkeyed digest.
export function verifyImport(serialized, expectedScope) {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_EXPORT_BYTES) fail('invalid export size');
  let envelope; try { envelope=JSON.parse(serialized); } catch { fail('invalid JSON'); }
  shape(envelope,['format','version','algorithm','data','checksum']);
  if (envelope.format !== 'devonstation-synthetic' || envelope.version !== 2 || envelope.algorithm !== 'sha256' || envelope.checksum !== hash(envelope.data)) fail('integrity failure');
  const d=envelope.data; shape(d,['owner','scope','projects','actions','receipts','operations']); shape(d.scope,['scopeKind','scopeId']);
  shape(d.owner,['principalId','role','scopeKind','scopeId']); id(d.owner.principalId); id(d.owner.scopeId);
  if (d.owner.role !== 'owner' || !['personal','business','creative'].includes(d.owner.scopeKind) || d.owner.scopeKind!==d.scope.scopeKind || d.owner.scopeId!==d.scope.scopeId) fail('invalid owner');
  shape(expectedScope,['scopeKind','scopeId']);
  if (d.scope.scopeKind !== expectedScope.scopeKind || d.scope.scopeId !== expectedScope.scopeId) fail('scope mismatch');
  if (!Array.isArray(d.projects) || !Array.isArray(d.actions) || !Array.isArray(d.receipts) || !Array.isArray(d.operations) || d.operations.length!==d.receipts.length || d.projects.length>100 || d.actions.length>1000 || d.receipts.length>2000) fail('invalid history');
  const ps=new Set(); for (const raw of d.projects) { const p=projection(raw); if (p.scopeKind!==d.scope.scopeKind || p.scopeId!==d.scope.scopeId || ps.has(p.projectId)) fail('invalid project'); ps.add(p.projectId); }
  const as=new Map(); for (const a of d.actions) {
    shape(a,['schemaVersion','recordId','projectId','scopeKind','scopeId','summary','status','revision','createdAt','updatedAt']);
    id(a.recordId); id(a.projectId); clean(a.summary); date(a.createdAt); date(a.updatedAt);
    if (a.schemaVersion!==1 || !ps.has(a.projectId) || a.scopeKind!==d.scope.scopeKind || a.scopeId!==d.scope.scopeId || as.has(a.recordId) || !['proposed','approved','rejected'].includes(a.status) || a.revision !== (a.status==='proposed'?1:2) || a.updatedAt<a.createdAt || (a.status==='proposed' && a.updatedAt!==a.createdAt)) fail('invalid action'); as.set(a.recordId,a);
  }
  const histories=new Map(), receiptIds=new Set(); for (const r of d.receipts) {
    shape(r,['receiptId','recordId','scopeId','action','result','revision','timestamp','payloadDigest']);
    if (typeof r.receiptId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.receiptId) || receiptIds.has(r.receiptId) || !/^[0-9a-f]{64}$/.test(r.payloadDigest)) fail('invalid receipt');
    receiptIds.add(r.receiptId); date(r.timestamp); const a=as.get(r.recordId), n=(histories.get(r.recordId)||0)+1;
    if (!a || r.scopeId!==d.scope.scopeId || r.revision!==n || (n===1 ? r.action!=='propose'||r.result!=='proposed' : n!==2||r.action!=='decide'||r.result!==a.status) || r.timestamp !== (n===1 ? a.createdAt : a.updatedAt)) fail('invalid receipt history'); histories.set(r.recordId,n);
  }
  for (const a of as.values()) if (histories.get(a.recordId)!==a.revision) fail('incomplete history');
  const seenOps=new Set(), linked=new Set(), receiptMap=new Map(d.receipts.map(r=>[r.receiptId,r]));
  for (const op of d.operations) {
    shape(op,['operationId','fingerprint','receiptId']); id(op.operationId);
    const r=receiptMap.get(op.receiptId);
    if (seenOps.has(op.operationId) || linked.has(op.receiptId) || !r || typeof op.fingerprint!=='string' || op.fingerprint!==r.payloadDigest) fail('invalid operation');
    seenOps.add(op.operationId); linked.add(op.receiptId);
    const a=as.get(r.recordId);
    const input=r.action==='propose'
      ? {operationId:op.operationId,recordId:a.recordId,projectId:a.projectId,summary:a.summary,expectedRevision:0}
      : {operationId:op.operationId,recordId:a.recordId,decision:r.result,expectedRevision:1};
    if (hash({kind:r.action,actor:d.owner,input})!==op.fingerprint) fail('operation fingerprint mismatch');
  }
  return clone(d);
}

// Restores only after full validation; trusted identity must match the exported owner.
export function restoreFoundation({identity, serialized, clock}) {
  shape(identity,['principalId','role','scopeKind','scopeId']);
  const data=verifyImport(serialized,{scopeKind:identity.scopeKind,scopeId:identity.scopeId});
  if (Object.keys(data.owner).some(k=>identity[k]!==data.owner[k])) fail('unauthorized');
  return buildFoundation({identity,projects:data.projects,clock},data);
}
