// COMMS-05: isolated SQLite store for a scoped read-only mail index.
// Caller owns database and applies schema explicitly. No credentials or network.
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const FLAGS = new Set(['seen', 'answered', 'flagged', 'draft']);
const fail = (code, status = 400) => { const e = new Error(code); e.code = code; e.status = status; throw e; };
const integer = value => Number.isSafeInteger(value) && value >= 0;
function scopeKey(scope) {
  if (!scope || !ID.test(scope.installationId) || !ID.test(scope.mailboxId)) fail('invalid_mail_scope');
  return [scope.installationId, scope.mailboxId];
}
function validateNext(scope, next) {
  if (!next || !Array.isArray(next.records) || next.records.length > 5000) fail('invalid_mail_snapshot');
  const cursor = next.cursor;
  if (cursor !== null && (!cursor || !Number.isSafeInteger(cursor.uidValidity) || cursor.uidValidity < 1 || !integer(cursor.highestUid))) {
    fail('invalid_mail_snapshot');
  }
  if (cursor === null && next.records.length) fail('invalid_mail_snapshot');
  const seen = new Set();
  const rows = next.records.map(row => {
    if (!row || row.installationId !== scope.installationId || row.mailboxId !== scope.mailboxId ||
        !Number.isSafeInteger(row.uidValidity) || row.uidValidity < 1 ||
        !Number.isSafeInteger(row.uid) || row.uid < 1 ||
        row.key !== `${scope.installationId}/${scope.mailboxId}/${row.uidValidity}/${row.uid}` ||
        seen.has(row.key) || typeof row.from !== 'string' || row.from.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.from) ||
        typeof row.subject !== 'string' || row.subject.length > 512 ||
        typeof row.text !== 'string' || row.text.length > 4096 ||
        typeof row.timestamp !== 'string' || row.timestamp.length > 40 ||
        !Number.isFinite(Date.parse(row.timestamp)) ||
        !Array.isArray(row.flags) || row.flags.length > 16 || !row.flags.every(f => FLAGS.has(f)) ||
        Object.hasOwn(row, 'html') || Object.hasOwn(row, 'raw') || Object.hasOwn(row, 'attachments')) fail('invalid_mail_snapshot');
    seen.add(row.key);
    return [scope.installationId, scope.mailboxId, row.uidValidity, row.uid, row.from, row.subject,
      row.text, row.timestamp, JSON.stringify([...new Set(row.flags)])];
  });
  return { cursor, rows };
}
export const MAIL_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS comms_ro_mailboxes (
 installation_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 uid_validity INTEGER, highest_uid INTEGER,
 PRIMARY KEY(installation_id, mailbox_id),
 CHECK((uid_validity IS NULL AND highest_uid IS NULL) OR (uid_validity > 0 AND highest_uid >= 0))
);
CREATE TABLE IF NOT EXISTS comms_ro_messages (
 installation_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
 uid_validity INTEGER NOT NULL CHECK(uid_validity > 0),
 uid INTEGER NOT NULL CHECK(uid > 0),
 from_address TEXT NOT NULL, subject TEXT NOT NULL, body_text TEXT NOT NULL,
 received_at TEXT NOT NULL, flags_json TEXT NOT NULL CHECK(json_valid(flags_json)),
 PRIMARY KEY(installation_id, mailbox_id, uid_validity, uid),
 FOREIGN KEY(installation_id, mailbox_id) REFERENCES comms_ro_mailboxes(installation_id, mailbox_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS comms_ro_message_order ON comms_ro_messages(installation_id, mailbox_id, received_at DESC);
`;
export function createSqliteMailStore(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') fail('invalid_sqlite_handle');
  const mailbox = db.prepare('SELECT revision, uid_validity, highest_uid FROM comms_ro_mailboxes WHERE installation_id=? AND mailbox_id=?');
  const messages = db.prepare('SELECT uid_validity,uid,from_address,subject,body_text,received_at,flags_json FROM comms_ro_messages WHERE installation_id=? AND mailbox_id=? ORDER BY uid_validity,uid');
  const insertMailbox = db.prepare('INSERT INTO comms_ro_mailboxes(installation_id,mailbox_id,revision,uid_validity,highest_uid) VALUES(?,?,1,?,?)');
  const updateMailbox = db.prepare('UPDATE comms_ro_mailboxes SET revision=revision+1,uid_validity=?,highest_uid=? WHERE installation_id=? AND mailbox_id=? AND revision=?');
  const deleteMessages = db.prepare('DELETE FROM comms_ro_messages WHERE installation_id=? AND mailbox_id=?');
  const insertMessage = db.prepare('INSERT INTO comms_ro_messages(installation_id,mailbox_id,uid_validity,uid,from_address,subject,body_text,received_at,flags_json) VALUES(?,?,?,?,?,?,?,?,?)');
  return Object.freeze({
    async readSnapshot(scope) {
      const [installationId, mailboxId] = scopeKey(scope);
      let active = false;
      try {
        db.exec('BEGIN'); active = true;
        const found = mailbox.get(installationId, mailboxId);
        const rows = found ? messages.all(installationId, mailboxId) : [];
        const records = rows.map(row => ({
          key: `${installationId}/${mailboxId}/${row.uid_validity}/${row.uid}`,
          installationId, mailboxId, uidValidity: row.uid_validity, uid: row.uid,
          from: row.from_address, subject: row.subject, text: row.body_text,
          timestamp: row.received_at, flags: JSON.parse(row.flags_json)
        }));
        db.exec('COMMIT'); active = false;
        return {installationId, mailboxId, revision: found?.revision ?? 0,
          cursor: found ? (found.uid_validity === null ? null : {uidValidity: found.uid_validity, highestUid: found.highest_uid}) : null,
          records};
      } catch {
        if (active) db.exec('ROLLBACK');
        fail('mail_store_read_failed', 500);
      }
    },
    async commitSnapshot({scope, expectedRevision, next} = {}) {
      const [installationId, mailboxId] = scopeKey(scope);
      if (!integer(expectedRevision) || expectedRevision > 1000000000) fail('invalid_mail_revision');
      const {cursor, rows} = validateNext(scope, next);
      let active = false;
      try {
        db.exec('BEGIN IMMEDIATE'); active = true;
        const found = mailbox.get(installationId, mailboxId);
        if ((found?.revision ?? 0) !== expectedRevision) {
          db.exec('ROLLBACK'); active = false;
          return {ok: false};
        }
        if (!found) insertMailbox.run(installationId, mailboxId, cursor?.uidValidity ?? null, cursor?.highestUid ?? null);
        else if (updateMailbox.run(cursor?.uidValidity ?? null, cursor?.highestUid ?? null, installationId, mailboxId, expectedRevision).changes !== 1) {
          db.exec('ROLLBACK'); active = false;
          return {ok: false};
        }
        deleteMessages.run(installationId, mailboxId);
        for (const row of rows) insertMessage.run(...row);
        db.exec('COMMIT'); active = false;
        return {ok: true, revision: expectedRevision + 1};
      } catch {
        if (active) db.exec('ROLLBACK');
        fail('mail_store_transaction_failed', 500);
      }
    }
  });
}

// Share the exact validated record/cursor contract with the D1-compatible store.
export {validateNext as validateMailStoreSnapshot};
