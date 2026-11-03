// COMMS-05: restricted IMAP command-level adapter. The connector is trusted server code.
// Not a TLS socket, credential vault or MIME parser; no live provider connection here.
import {PURELYMAIL} from './mail-onboarding.mjs';
const MAX_SEARCH = 500;
const SEARCH_WINDOW = 256;
const MAX_SEARCH_WINDOWS = 16;
const MAX_UID = 0xffffffff;
const safeUid = n => Number.isSafeInteger(n) && n > 0 && n <= MAX_UID;
function reject(code) {const e = new Error(code); e.code = code; throw e;}
export function parseUidValidity(reply) {
  if (typeof reply !== 'string' || reply.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(reply)) reject('invalid_imap_examine');
  const values = [...reply.matchAll(/\[UIDVALIDITY ([0-9]+)\]/gi)];
  if (values.length !== 1) reject('invalid_imap_examine');
  const value = Number(values[0][1]);
  if (!safeUid(value)) reject('invalid_imap_examine');
  return value;
}
export function parseUidNext(reply) {
  if (typeof reply !== 'string' || reply.length > 2048) reject('invalid_imap_examine');
  const values = [...reply.matchAll(/\[UIDNEXT ([0-9]+)\]/gi)];
  if (values.length !== 1 || !safeUid(Number(values[0][1]))) reject('invalid_imap_examine');
  return Number(values[0][1]);
}
export function parseSearchUids(reply, startingUid, endingUid = MAX_UID) {
  if (!safeUid(startingUid) || !safeUid(endingUid) || endingUid < startingUid || typeof reply !== 'string' || reply.length > 4096 ||
      !/^\* SEARCH(?: [0-9]+)*\r?\n?$/.test(reply)) reject('invalid_imap_search');
  const tokens = reply.trim().split(' ').slice(2);
  if (tokens.length > MAX_SEARCH) reject('imap_search_limit');
  const uids = tokens.map(Number);
  if (uids.some(uid => !safeUid(uid) || uid < startingUid || uid > endingUid) || new Set(uids).size !== uids.length) reject('invalid_imap_search');
  return uids.sort((a, b) => a - b);
}
function readonlyOptions({cursor, uidValidity, limit}) {
  if (!safeUid(uidValidity) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) reject('invalid_imap_options');
  if (cursor !== null && cursor !== undefined && (!safeUid(cursor.uidValidity) ||
      !Number.isSafeInteger(cursor.highestUid) || cursor.highestUid < 0 || cursor.highestUid > MAX_UID)) reject('invalid_imap_options');
  const start = cursor?.uidValidity === uidValidity ? cursor.highestUid + 1 : 1;
  // A stable UIDVALIDITY cohort cannot assign another UID above the protocol ceiling.
  // Still EXAMINE first so a new cohort restarts correctly from one.
  if (start === MAX_UID + 1) return {start:null};
  if (!safeUid(start)) reject('invalid_imap_options');
  return {start};
}
/** Only the four audited read-only verbs below may reach a trusted connector. */
export function createReadOnlyImapProvider({connector} = {}) {
  if (!connector || typeof connector.open !== 'function') reject('imap_connector_unavailable');
  return Object.freeze({
    async openReadOnly({mailbox, readOnly, peek, signal} = {}) {
      if (readOnly !== true || peek !== true || signal?.aborted || mailbox?.provider !== 'purelymail' ||
          mailbox?.mode !== 'imap' || typeof mailbox.address !== 'string' ||
          !/^[a-z0-9._+-]+@[a-z0-9.-]+$/.test(mailbox.address)) reject('imap_readonly_required');
      // Host, port, TLS policy and command grammar are fixed by trusted source, never by request JSON.
      const connection = await connector.open(Object.freeze({
        host: PURELYMAIL.incoming.host, port: PURELYMAIL.incoming.port,
        tlsRequired: true, rejectUnauthorized: true, servername: PURELYMAIL.incoming.host,
        username: mailbox.address, signal
      }));
      if (!connection || typeof connection.exchange !== 'function' || typeof connection.close !== 'function') {
        try {await connection?.close?.();} catch {}
        reject('invalid_imap_connection');
      }
      let closed = false;
      async function exchange(command, commandSignal) {
        if (closed || commandSignal?.aborted || signal?.aborted) reject('imap_session_cancelled');
        return connection.exchange(command, {signal: commandSignal ?? signal});
      }
      if (signal?.aborted) {
        closed = true; await connection.close(); reject('imap_session_cancelled');
      }
      return Object.freeze({
        async fetchBatch({cursor = null, limit = 50, peek: wantsPeek, readOnly: wantsReadOnly, signal: stepSignal} = {}) {
          if (closed || wantsPeek !== true || wantsReadOnly !== true) reject('imap_readonly_required');
          const examine = await exchange('EXAMINE "INBOX"', stepSignal);
          const uidValidity = parseUidValidity(examine);
          const uidNext = parseUidNext(examine);
          const options = readonlyOptions({cursor, uidValidity, limit});
          if (options.start === null) return {uidValidity, messages: []};
          // Never scan future UID space: arrivals after EXAMINE have UID >= UIDNEXT.
          const last = uidNext - 1;
          if (options.start > last) return {uidValidity, messages: []};
          let start = options.start, scannedThrough = start - 1;
          const uids = [];
          for (let windows = 0; windows < MAX_SEARCH_WINDOWS && start <= last && uids.length < limit; windows++) {
            const end = Math.min(start + SEARCH_WINDOW - 1, last);
            const found = parseSearchUids(await exchange(`UID SEARCH UID ${start}:${end}`, stepSignal),start,end);
            if (found.length > SEARCH_WINDOW) reject('imap_search_limit');
            const selected = found.slice(0, limit - uids.length);
            uids.push(...selected);
            scannedThrough = selected.length < found.length ? selected.at(-1) : end;
            start = end + 1;
          }
          if (!uids.length) return {uidValidity, messages: [], scannedThrough};
          const raw = await exchange(`UID FETCH ${uids.join(',')} (UID FLAGS INTERNALDATE BODY.PEEK[])`, stepSignal);
          // Full RFC 5322 octets are decoded by the trusted bounded MIME layer; never treat raw/HTML as safe text.
          if (!raw || !Array.isArray(raw.messages) || raw.messages.length !== uids.length) reject('invalid_imap_fetch');
          const selected = new Set(uids), seen = new Set();
          for (const row of raw.messages) {
            if (!row || !selected.has(row.uid) || seen.has(row.uid) ||
                Object.hasOwn(row,'html') || Object.hasOwn(row,'raw') || Object.hasOwn(row,'attachments') ||
                typeof row.text !== 'string' || typeof row.subject !== 'string' || typeof row.from !== 'string') {
              reject('invalid_imap_fetch');
            }
            seen.add(row.uid);
          }
          return {uidValidity, messages: raw.messages, scannedThrough};
        },
        async close() {if (closed) return; closed = true; await connection.close();}
      });
    }
  });
}
