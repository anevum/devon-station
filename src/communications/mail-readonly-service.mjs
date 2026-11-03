// COMMS-04: source-only, provider-neutral read-only orchestration. No network or database driver.
// All configuration, provider factories, store handles and identity context MUST be server-owned.
import {accessibleMailboxes, hasMailPermission, reconcileImapBatch} from './mail-core.mjs';
import {PURELYMAIL} from './mail-onboarding.mjs';

const MAX_POLL = 100;
const MAX_PAGE = 50;
const MAX_RECORDS = 5000;
const MAX_TIMEOUT_MS = 15000;

export class MailReadOnlyError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'MailReadOnlyError';
    this.code = code;
    this.status = status;
  }
}
const scopeOf = (context, mailboxId) => Object.freeze({installationId: context.installationId, mailboxId});
const isSafeInt = value => Number.isSafeInteger(value) && value >= 0;

function requirePermission(registry, context, mailboxId, permission) {
  // Never inspect another mailbox or call storage/providers before authorization.
  if (!hasMailPermission(registry, context, mailboxId, permission)) {
    throw new MailReadOnlyError('mailbox_not_authorized', 403);
  }
  return registry.mailboxes.find(box => box.id === mailboxId && box.installationId === context.installationId);
}

function safeSnapshot(snapshot, scope) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      snapshot.installationId !== scope.installationId || snapshot.mailboxId !== scope.mailboxId ||
      !isSafeInt(snapshot.revision) || !Array.isArray(snapshot.records) ||
      snapshot.records.length > MAX_RECORDS) {
    throw new MailReadOnlyError('invalid_scoped_snapshot', 500);
  }
  if (snapshot.cursor !== null && snapshot.cursor !== undefined &&
      (!isSafeInt(snapshot.cursor.highestUid) ||
        !Number.isSafeInteger(snapshot.cursor.uidValidity) || snapshot.cursor.uidValidity <= 0)) {
    throw new MailReadOnlyError('invalid_scoped_snapshot', 500);
  }
  const keys = new Set();
  for (const row of snapshot.records) {
    if (!row || row.installationId !== scope.installationId || row.mailboxId !== scope.mailboxId ||
        !Number.isSafeInteger(row.uidValidity) || row.uidValidity <= 0 ||
        !Number.isSafeInteger(row.uid) || row.uid <= 0 ||
        row.key !== `${scope.installationId}/${scope.mailboxId}/${row.uidValidity}/${row.uid}` ||
        keys.has(row.key) || typeof row.from !== 'string' || typeof row.subject !== 'string' ||
        typeof row.text !== 'string' || row.text.length > 4096 || row.subject.length > 512 ||
        typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp)) ||
        !Array.isArray(row.flags) || row.flags.length > 16 ||
        row.flags.some(flag => !['seen','answered','flagged','draft'].includes(flag))) {
      throw new MailReadOnlyError('invalid_scoped_snapshot', 500);
    }
    keys.add(row.key);
  }
  return snapshot;
}

/** Build a fixed descriptor, not a client-supplied hostname or dynamic URL. */
export function readonlyPurelymailEndpoint(mailbox) {
  if (!mailbox || mailbox.provider !== 'purelymail' || mailbox.mode !== 'imap' ||
      typeof mailbox.address !== 'string' || !/^[a-z0-9._+\-]+@[a-z0-9.-]+$/.test(mailbox.address)) {
    throw new MailReadOnlyError('unsupported_mail_provider', 400);
  }
  return Object.freeze({protocol:'imap',host:PURELYMAIL.incoming.host,port:PURELYMAIL.incoming.port,
    tls:true,username:mailbox.address,readOnly:true,peek:true,allowWriteCommands:false});
}

async function providerStep(operation, signal) {
  if (signal.aborted) throw new MailReadOnlyError('provider_timeout', 504);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, new MailReadOnlyError('provider_timeout', 504));
    signal.addEventListener('abort', abort, {once:true});
    // The operation runs only while the provider deadline is valid.
    Promise.resolve().then(operation).then(
      value => finish(resolve, value),
      error => finish(reject, error));
  });
}

/**
 * One read-only provider poll followed by a *single atomic, revision-checked* store commit.
 * `openReadOnly`/`fetchBatch` MUST be trusted implementation, not a mailbox-controlled callback.
 * The production adapter must select INBOX read-only and use BODY.PEEK (never mark seen).
 * The store must enforce tenant+mailbox scope and CAS in ONE transaction; no mock store is safe for production.
 * This orchestrator emits counts only, never message content, provider credentials or send receipts.
 */
export async function pollReadOnlyMailbox({registry, context, mailboxId, store, providers,
  limit = 50, timeoutMs = 10000} = {}) {
  const box = requirePermission(registry, context, mailboxId, 'sync');
  if (box.mode !== 'imap') throw new MailReadOnlyError('mailbox_not_imap', 409);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_POLL ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new MailReadOnlyError('invalid_readonly_poll_options', 400);
  }
  const open = providers?.[box.provider]?.openReadOnly;
  if (typeof open !== 'function' || !store || typeof store.readSnapshot !== 'function' ||
      typeof store.commitSnapshot !== 'function') {
    throw new MailReadOnlyError('readonly_adapter_unavailable', 503);
  }
  const scope = scopeOf(context, mailboxId);
  // Read before connecting; failed storage cannot cause external traffic.
  const existing = safeSnapshot(await store.readSnapshot(scope), scope);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let session;
  try {
    const request = Object.freeze({mailbox: Object.freeze({id:box.id, installationId:scope.installationId,
      address:box.address, provider:box.provider, mode:box.mode}), readOnly:true,peek:true,
      signal:controller.signal});
    // Adapter is responsible for TLS+verified credentials, and cannot be provided by requesters.
    session = await providerStep(() => open(request), controller.signal);
    if (typeof session?.fetchBatch !== 'function' || typeof session?.close !== 'function') {
      throw new MailReadOnlyError('invalid_readonly_session', 502);
    }
    const batch = await providerStep(() => session.fetchBatch(Object.freeze({cursor:existing.cursor ?? null,
      limit,peek:true,readOnly:true,signal:controller.signal})), controller.signal);
    if (controller.signal.aborted) throw new MailReadOnlyError('provider_timeout',504);
    if (Object.hasOwn(batch,'hasMore') && typeof batch.hasMore !== 'boolean')
      throw new MailReadOnlyError('invalid_readonly_progress',502);
    clearTimeout(timer); // Provider deadline must not abort an in-flight atomic database commit.
    const proposal = reconcileImapBatch({registry,context,mailboxId,cursor:existing.cursor ?? null,
      batch,existing:existing.records});
    if (controller.signal.aborted) throw new MailReadOnlyError('provider_timeout',504);
    // The implementation MUST atomically compare `revision` and persist rows+cursor together.
    const committed = await store.commitSnapshot(Object.freeze({scope,expectedRevision:existing.revision,
      next:Object.freeze({cursor:proposal.cursor,records:proposal.records})}));
    if (!committed || committed.ok !== true || !isSafeInt(committed.revision) ||
        committed.revision !== existing.revision + 1) {
      throw new MailReadOnlyError('mailbox_revision_conflict', 409);
    }
    return Object.freeze({installationId:scope.installationId,mailboxId,revision:committed.revision,
      imported:proposal.imported,updated:proposal.updated,uidValidityReset:proposal.uidValidityReset,
      cursor:proposal.cursor,hasMore:typeof batch.hasMore === 'boolean'?batch.hasMore:null});
  } finally {
    clearTimeout(timer);
    // Client should release the read-only session even if parsing, CAS or timeout failed.
    if (session && typeof session.close === 'function') {
      try { await providerStep(() => session.close(), AbortSignal.timeout(1000)); }
      catch { /* no message, credential or provider detail in logs */ }
    }
  }
}

/** Explicit `read` privilege is separate from service-only `sync` privilege. */
export async function listReadOnlyInbox({registry,context,mailboxId,store,limit = 25,offset = 0} = {}) {
  requirePermission(registry, context, mailboxId, 'read');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_RECORDS) {
    throw new MailReadOnlyError('invalid_inbox_page',400);
  }
  if (!store || typeof store.readSnapshot !== 'function') {
    throw new MailReadOnlyError('readonly_storage_unavailable',503);
  }
  const scope=scopeOf(context,mailboxId);
  const snapshot=safeSnapshot(await store.readSnapshot(scope),scope);
  // Project only known plain-text fields. Never return storage/provider object wholesale.
  const rows=snapshot.records.slice().sort((a,b)=>
    Date.parse(b.timestamp)-Date.parse(a.timestamp) || b.uidValidity-a.uidValidity || b.uid-a.uid)
    .slice(offset,offset+limit).map(row=>Object.freeze({key:row.key,from:row.from,
      subject:row.subject,text:row.text,timestamp:row.timestamp,flags:Object.freeze([...row.flags])}));
  return Object.freeze({mailboxId,revision:snapshot.revision,total:snapshot.records.length,
    offset,limit,messages:Object.freeze(rows)});
}

/** Metadata only, and only for `read`-authorized mailboxes. */
export function listReadOnlyMailboxes(registry,context){return accessibleMailboxes(registry,context);}
