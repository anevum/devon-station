import { createHash, randomUUID } from 'node:crypto';

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
export function createFoundation({ identity, projects, clock = () => new Date().toISOString() }) {
  shape(identity,['principalId','role','scopeKind','scopeId']); id(identity.principalId); id(identity.scopeId);
  if (identity.role !== 'owner' || !['personal','business','creative'].includes(identity.scopeKind)) fail('unauthorized');
  const claim = clone(identity), projectMap = new Map(), actions = new Map(), receipts = [], operations = new Map();
  if (!Array.isArray(projects) || projects.length > 100) fail('invalid projects');
  for (const raw of projects) { const p = projection(raw); if (p.scopeKind !== claim.scopeKind || p.scopeId !== claim.scopeId || projectMap.has(p.projectId)) fail('scope or project conflict'); projectMap.set(p.projectId,p); }
  function auth(actor) { shape(actor,['principalId','role','scopeKind','scopeId']); if (Object.keys(claim).some(k => actor[k] !== claim[k])) fail('unauthorized'); }
  function mutate(actor, input, kind) {
    auth(actor);
    if (kind === 'propose') shape(input,['operationId','recordId','projectId','summary','expectedRevision']);
    else shape(input,['operationId','recordId','decision','expectedRevision']);
    id(input.operationId); id(input.recordId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('invalid revision');
    if (kind === 'propose') { id(input.projectId); clean(input.summary); if (!projectMap.has(input.projectId)) fail('unknown project'); }
    else if (!['approved','rejected'].includes(input.decision)) fail('invalid decision');
    const fingerprint = hash({kind, actor: claim, input});
    const prior = operations.get(input.operationId);
    if (prior) { if (prior.fingerprint !== fingerprint) fail('operation conflict'); return clone(prior.receipt); }
    const old = actions.get(input.recordId);
    if (kind === 'propose' && (old || input.expectedRevision !== 0)) fail('revision conflict');
    if (kind === 'decide' && (!old || old.revision !== input.expectedRevision || old.status !== 'proposed')) fail('revision conflict');
    const now = date(clock());
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
    export(actor) { auth(actor); const data={scope:{scopeKind:claim.scopeKind,scopeId:claim.scopeId},projects:[...projectMap.values()],actions:[...actions.values()],receipts}; return JSON.stringify({format:'devonstation-synthetic',version:1,algorithm:'sha256',data,checksum:hash(data)}); }
  });
}

// Integrity verification, not authentication: an attacker can recalculate an unkeyed digest.
export function verifyImport(serialized, expectedScope) {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 1024*1024) fail('invalid export size');
  let envelope; try { envelope=JSON.parse(serialized); } catch { fail('invalid JSON'); }
  shape(envelope,['format','version','algorithm','data','checksum']);
  if (envelope.format !== 'devonstation-synthetic' || envelope.version !== 1 || envelope.algorithm !== 'sha256' || envelope.checksum !== hash(envelope.data)) fail('integrity failure');
  const d=envelope.data; shape(d,['scope','projects','actions','receipts']); shape(d.scope,['scopeKind','scopeId']);
  shape(expectedScope,['scopeKind','scopeId']);
  if (d.scope.scopeKind !== expectedScope.scopeKind || d.scope.scopeId !== expectedScope.scopeId) fail('scope mismatch');
  if (!Array.isArray(d.projects) || !Array.isArray(d.actions) || !Array.isArray(d.receipts) || d.projects.length>100 || d.actions.length>1000 || d.receipts.length>2000) fail('invalid history');
  const ps=new Set(); for (const raw of d.projects) { const p=projection(raw); if (p.scopeKind!==d.scope.scopeKind || p.scopeId!==d.scope.scopeId || ps.has(p.projectId)) fail('invalid project'); ps.add(p.projectId); }
  const as=new Map(); for (const a of d.actions) {
    shape(a,['schemaVersion','recordId','projectId','scopeKind','scopeId','summary','status','revision','createdAt','updatedAt']);
    id(a.recordId); id(a.projectId); clean(a.summary); date(a.createdAt); date(a.updatedAt);
    if (a.schemaVersion!==1 || !ps.has(a.projectId) || a.scopeKind!==d.scope.scopeKind || a.scopeId!==d.scope.scopeId || as.has(a.recordId) || !['proposed','approved','rejected'].includes(a.status) || a.revision !== (a.status==='proposed'?1:2)) fail('invalid action'); as.set(a.recordId,a);
  }
  const histories=new Map(), receiptIds=new Set(); for (const r of d.receipts) {
    shape(r,['receiptId','recordId','scopeId','action','result','revision','timestamp','payloadDigest']);
    if (typeof r.receiptId!=='string' || !/^[0-9a-f-]{36}$/.test(r.receiptId) || receiptIds.has(r.receiptId) || !/^[0-9a-f]{64}$/.test(r.payloadDigest)) fail('invalid receipt');
    receiptIds.add(r.receiptId); date(r.timestamp); const a=as.get(r.recordId), n=(histories.get(r.recordId)||0)+1;
    if (!a || r.scopeId!==d.scope.scopeId || r.revision!==n || (n===1 ? r.action!=='propose'||r.result!=='proposed' : n!==2||r.action!=='decide'||r.result!==a.status)) fail('invalid receipt history'); histories.set(r.recordId,n);
  }
  for (const a of as.values()) if (histories.get(a.recordId)!==a.revision) fail('incomplete history');
  return clone(d);
}
