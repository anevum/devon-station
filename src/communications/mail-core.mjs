// Provider-neutral, source-only Communications core. No network, secrets, SMTP or DB writes.
// All principals and configuration must be supplied from trusted server-side state.
const RIGHTS = new Set(['read', 'draft', 'send', 'sync']);
const MODES = new Set(['imap', 'forward-only']);
const ADDRESS = /^[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const ID = /^[a-z][a-z0-9-]{0,62}$/;

function requireId(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`Invalid ${field}`);
  return value;
}
function requireAddress(value) {
  if (typeof value !== 'string' || value !== value.toLowerCase() || value.length > 254 ||
      !ADDRESS.test(value) || value.includes('..')) throw new TypeError('Invalid email address');
  return value;
}
function immutable(item) { return Object.freeze(item); }
function distinct(items, key, kind) {
  const seen = new Set();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new TypeError(`Duplicate ${kind}`);
    seen.add(value);
  }
}

/** Build independent installation/mailbox/identity/grant records; never insert credentials here. */
export function createMailRegistry({installations, mailboxes, identities, grants} = {}) {
  if (![installations, mailboxes, identities, grants].every(Array.isArray)) {
    throw new TypeError('Mail registry requires four arrays');
  }
  const installs = installations.map(({id, domain}) => {
    requireId(id, 'installation ID');
    const normalized = requireAddress(`owner@${domain}`).split('@')[1];
    return immutable({id, domain: normalized});
  });
  distinct(installs, item => item.id, 'installation');
  const installMap = new Map(installs.map(item => [item.id, item]));
  const boxes = mailboxes.map(({id, installationId, address, provider, mode, sendVerified = false}) => {
    requireId(id, 'mailbox ID');
    if (!installMap.has(installationId)) throw new TypeError('Unknown mailbox installation');
    requireAddress(address);
    if (!address.endsWith(`@${installMap.get(installationId).domain}`)) {
      throw new TypeError('Mailbox domain must belong to installation');
    }
    if (typeof provider !== 'string' || !ID.test(provider) || !MODES.has(mode) || typeof sendVerified !== 'boolean') {
      throw new TypeError('Invalid mailbox provider or mode');
    }
    if (mode !== 'imap' && sendVerified) throw new TypeError('Forward-only mailbox cannot be send verified');
    return immutable({id, installationId, address, provider, mode, sendVerified});
  });
  distinct(boxes, item => item.id, 'mailbox');
  distinct(boxes, item => `${item.installationId}/${item.address}`, 'mailbox address');
  const boxMap = new Map(boxes.map(item => [item.id, item]));
  const addrs = identities.map(({address, mailboxId, kind, sendVerified = false}) => {
    requireAddress(address);
    const box = boxMap.get(mailboxId);
    if (!box) throw new TypeError('Unknown identity mailbox');
    if (!address.endsWith(`@${installMap.get(box.installationId).domain}`)) {
      throw new TypeError('Identity must remain in installation domain');
    }
    if (!['primary', 'alias'].includes(kind) || typeof sendVerified !== 'boolean') {
      throw new TypeError('Invalid from identity');
    }
    if (kind === 'primary' && address !== box.address) throw new TypeError('Primary identity mismatch');
    if (sendVerified && (box.mode !== 'imap' || !box.sendVerified)) {
      throw new TypeError('Unverified provider cannot authorize send');
    }
    return immutable({address, mailboxId, installationId: box.installationId, kind, sendVerified});
  });
  distinct(addrs, item => `${item.installationId}/${item.address}`, 'from identity');
  for (const box of boxes) {
    if (!addrs.some(item => item.mailboxId === box.id && item.kind === 'primary')) {
      throw new TypeError('Mailbox requires primary identity');
    }
  }
  const permissions = grants.map(({installationId, principalId, mailboxId, capabilities}) => {
    requireId(principalId, 'principal ID');
    const box = boxMap.get(mailboxId);
    if (!box || box.installationId !== installationId || !Array.isArray(capabilities) || !capabilities.length ||
        !capabilities.every(value => RIGHTS.has(value)) || new Set(capabilities).size !== capabilities.length) {
      throw new TypeError('Invalid mailbox grant');
    }
    return immutable({installationId, principalId, mailboxId, capabilities: immutable([...capabilities])});
  });
  distinct(permissions, item => `${item.installationId}/${item.principalId}/${item.mailboxId}`, 'mailbox grant');
  return immutable({installations: immutable(installs), mailboxes: immutable(boxes),
    identities: immutable(addrs), grants: immutable(permissions)});
}

function trustedContext(context) {
  if (!context || typeof context !== 'object') throw new TypeError('Trusted context required');
  requireId(context.installationId, 'context installation');
  requireId(context.principalId, 'context principal');
  return context;
}
export function hasMailPermission(registry, context, mailboxId, right) {
  trustedContext(context);
  if (!RIGHTS.has(right)) throw new TypeError('Unknown capability');
  const box = registry.mailboxes.find(item => item.id === mailboxId && item.installationId === context.installationId);
  return !!box && registry.grants.some(grant => grant.installationId === context.installationId &&
    grant.principalId === context.principalId && grant.mailboxId === mailboxId && grant.capabilities.includes(right));
}
export function accessibleMailboxes(registry, context) {
  trustedContext(context);
  return registry.mailboxes.filter(box => box.installationId === context.installationId &&
    hasMailPermission(registry, context, box.id, 'read')).map(box =>
    immutable({id: box.id, address: box.address, provider: box.provider, mode: box.mode,
      // Read permission does not imply a connected/operational mailbox.
      connectionStatus: box.mode === 'forward-only' ? 'external-forwarding' : 'provider-connection-unverified'}));
}
/** Evaluate send eligibility only. It never sends, queues, or signs an approval. */
export function evaluateFromIdentity(registry, context, mailboxId, address) {
  const allowed = hasMailPermission(registry, context, mailboxId, 'send');
  const box = registry.mailboxes.find(item => item.id === mailboxId && item.installationId === context.installationId);
  const identity = registry.identities.find(item => item.mailboxId === mailboxId && item.address === address &&
    item.installationId === context.installationId);
  const blockers = [];
  if (!allowed) blockers.push('mailbox-send-grant');
  if (!box || box.mode !== 'imap' || !box.sendVerified) blockers.push('provider-outbound-verification');
  if (!identity || !identity.sendVerified) blockers.push('from-identity-verification');
  return immutable({allowed: blockers.length === 0, blockers: immutable(blockers)});
}

const MAX_BATCH = 100;
const MAX_BODY = 4096;
function textField(value, max) {
  if (typeof value !== 'string') throw new TypeError('Expected plain text');
  // Keep source text untrusted. The UI must render with textContent, never innerHTML.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max);
}
function positiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid ${name}`);
  return value;
}
function safeCursor(cursor) {
  if (cursor == null) return null;
  if (typeof cursor !== 'object' || Array.isArray(cursor)) throw new TypeError('Invalid sync cursor');
  return immutable({uidValidity: positiveInt(cursor.uidValidity, 'cursor UIDVALIDITY'),
    highestUid: Number.isSafeInteger(cursor.highestUid) && cursor.highestUid >= 0 ? cursor.highestUid : (() => {throw new TypeError('Invalid highest UID');})()});
}
function messageRecord({uidValidity, installationId, mailboxId, item}) {
  const uid = positiveInt(item?.uid, 'message UID');
  const from = requireAddress(item.from);
  if (typeof item.subject !== 'string' || typeof item.text !== 'string') {
    throw new TypeError('Message must contain plain text');
  }
  if (item.html !== undefined || item.raw !== undefined || item.attachments !== undefined) {
    throw new TypeError('Only safe plain text is accepted by the index');
  }
  const timestamp = item.timestamp;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError('Invalid message timestamp');
  }
  const flags = item.flags ?? [];
  if (!Array.isArray(flags) || flags.length > 16 || !flags.every(f => ['seen','answered','flagged','draft'].includes(f))) {
    throw new TypeError('Unsupported message flags');
  }
  return immutable({key: `${installationId}/${mailboxId}/${uidValidity}/${uid}`, installationId, mailboxId,
    uidValidity, uid, from, subject: textField(item.subject, 512), text: textField(item.text, MAX_BODY),
    timestamp: new Date(timestamp).toISOString(), flags: immutable([...new Set(flags)])});
}
/** Deterministic, atomic *proposal* for a batch already fetched by a trusted provider adapter.
 * Caller must persist records + cursor together, with a revision/transaction check.
 * UIDVALIDITY changes retain earlier records for explicit retention/reconciliation.
 */
export function reconcileImapBatch({registry, context, mailboxId, cursor = null, batch, existing = []} = {}) {
  if (!hasMailPermission(registry, context, mailboxId, 'sync')) throw new Error('Mailbox sync not authorized');
  const box = registry.mailboxes.find(item => item.id === mailboxId && item.installationId === context.installationId);
  if (box?.mode !== 'imap') throw new Error('No IMAP connector configured');
  if (!batch || typeof batch !== 'object' || !Array.isArray(batch.messages) ||
      batch.messages.length > MAX_BATCH || !Array.isArray(existing) || existing.length > 5000) {
    throw new TypeError('Invalid or oversized sync batch');
  }
  const validity = positiveInt(batch.uidValidity, 'UIDVALIDITY');
  const previous = safeCursor(cursor);
  const reset = !!previous && previous.uidValidity !== validity;
  const records = new Map();
  for (const record of existing) {
    if (!record || record.installationId !== context.installationId || record.mailboxId !== mailboxId ||
        typeof record.key !== 'string' || record.key !== `${record.installationId}/${record.mailboxId}/${record.uidValidity}/${record.uid}` ||
        !Number.isSafeInteger(record.uid) || !Number.isSafeInteger(record.uidValidity)) {
      throw new Error('Existing mail index violates mailbox isolation');
    }
    if (records.has(record.key)) throw new TypeError('Duplicate stored message key');
    records.set(record.key, record);
  }
  const seen = new Set();
  let greatest = reset || !previous ? 0 : previous.highestUid;
  let imported = 0, updated = 0;
  for (const item of batch.messages) {
    const record = messageRecord({uidValidity: validity, installationId: context.installationId, mailboxId, item});
    if (seen.has(record.key)) throw new TypeError('Duplicate UID within sync batch');
    seen.add(record.key);
    greatest = Math.max(greatest, record.uid);
    if (!records.has(record.key)) imported++;
    else updated++;
    records.set(record.key, record);
  }
  if (records.size > 5000) throw new TypeError('Mailbox sync index limit exceeded');
  return immutable({installationId: context.installationId, mailboxId, imported, updated,
    uidValidityReset: reset, cursor: immutable({uidValidity: validity, highestUid: greatest}),
    records: immutable([...records.values()].sort((a,b) =>
      a.uidValidity - b.uidValidity || a.uid - b.uid).map(item => immutable({...item})))});
}
