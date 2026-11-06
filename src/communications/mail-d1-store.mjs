// COMMS-06: source-only Cloudflare D1 Workers binding adapter, no live binding or migration.
// Caller supplies an isolated trusted D1 database handle. All SQL arguments are bound.
import {validateMailStoreSnapshot} from './mail-sqlite-store.mjs';

const ID = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_RECORDS = 500;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_REVISION = 1_000_000_000;
const err = (code, status = 500) => Object.assign(new Error(code), {code, status});
const goodInt = x => Number.isSafeInteger(x) && x >= 0;
const scopeParts = scope => {
  if (!scope || typeof scope.installationId !== 'string' || !ID.test(scope.installationId) ||
      typeof scope.mailboxId !== 'string' || !ID.test(scope.mailboxId)) throw err('invalid_mail_scope', 400);
  return [scope.installationId, scope.mailboxId];
};

// Single SELECT is one consistent SQLite snapshot, including the mailbox revision.
// LEFT JOIN preserves mailbox rows with no messages; no cross-installation joins.
const READ_SQL = `SELECT m.revision AS revision, m.uid_validity AS cursor_uid_validity,
 m.highest_uid AS cursor_highest_uid, r.uid_validity AS msg_uid_validity,
 r.uid AS msg_uid, r.from_address AS from_address, r.subject AS subject,
 r.body_text AS body_text, r.received_at AS received_at, r.flags_json AS flags_json
 FROM comms_ro_mailboxes m LEFT JOIN comms_ro_messages r
 ON r.installation_id=m.installation_id AND r.mailbox_id=m.mailbox_id
 WHERE m.installation_id=? AND m.mailbox_id=?
 ORDER BY r.uid_validity, r.uid`;

// Stale CAS must FAIL the transaction instead of silently updating zero rows.
// A NULL revision violates NOT NULL, which causes D1 batch() to roll back all statements.
// The failed transaction is then distinguished from a different SQL failure by a scoped read.
const CAS_SQL = `INSERT INTO comms_ro_mailboxes
 (installation_id,mailbox_id,revision,uid_validity,highest_uid,last_operation)
 SELECT ?,?,CASE WHEN EXISTS(
   SELECT 1 FROM comms_ro_mailboxes WHERE installation_id=? AND mailbox_id=?
 ) THEN 1 WHEN ?=0 THEN 1 ELSE NULL END,?,?,?
 WHERE 1
 ON CONFLICT(installation_id,mailbox_id) DO UPDATE SET
 revision=CASE WHEN comms_ro_mailboxes.revision=?
   AND comms_ro_mailboxes.revision < 1000000000
   THEN comms_ro_mailboxes.revision+1 ELSE NULL END,
 uid_validity=excluded.uid_validity,highest_uid=excluded.highest_uid,
 last_operation=excluded.last_operation`;

const DELETE_SQL = 'DELETE FROM comms_ro_messages WHERE installation_id=? AND mailbox_id=?';
// One JSON-bound statement, rather than up to 500 individual INSERTs per batch.
// The schema must already have been created by an authorized migration.
const INSERT_SQL = `INSERT INTO comms_ro_messages
 (installation_id,mailbox_id,uid_validity,uid,from_address,subject,body_text,received_at,flags_json)
 SELECT ?,?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),
 json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),
 json_extract(value,'$[5]'),json_extract(value,'$[6]') FROM json_each(?)`;

function decodeRows(rows, scope) {
  if (!Array.isArray(rows) || rows.length > MAX_RECORDS + 1) throw err('mail_d1_invalid_snapshot');
  if (!rows.length) return {installationId:scope.installationId,mailboxId:scope.mailboxId,
    revision:0,cursor:null,records:[]};
  const rev = rows[0].revision;
  if (!Number.isSafeInteger(rev) || rev < 1 || rev > MAX_REVISION) throw err('mail_d1_invalid_snapshot');
  const cursor = rows[0].cursor_uid_validity === null ? null :
    {uidValidity:rows[0].cursor_uid_validity, highestUid:rows[0].cursor_highest_uid};
  const records = rows.filter(row => row.msg_uid !== null).map(row => {
    if (row.revision !== rev || row.cursor_uid_validity !== rows[0].cursor_uid_validity ||
        row.cursor_highest_uid !== rows[0].cursor_highest_uid ||
        typeof row.flags_json !== 'string') throw err('mail_d1_invalid_snapshot');
    let flags;
    try {flags = JSON.parse(row.flags_json);} catch {throw err('mail_d1_invalid_snapshot');}
    return {key:`${scope.installationId}/${scope.mailboxId}/${row.msg_uid_validity}/${row.msg_uid}`,
      installationId:scope.installationId,mailboxId:scope.mailboxId,
      uidValidity:row.msg_uid_validity,uid:row.msg_uid,
      from:row.from_address,subject:row.subject,text:row.body_text,
      ...(Object.hasOwn(row,'reply_to')?{replyTo:row.reply_to}:{}),
      timestamp:row.received_at,flags};
  });
  try {validateMailStoreSnapshot(scope,{cursor,records});}
  catch {throw err('mail_d1_invalid_snapshot');}
  return {installationId:scope.installationId,mailboxId:scope.mailboxId,
    revision:rev,cursor,records};
}

export function createD1MailStore(db,{cipher,ownerSub}={}) {
  if(cipher&&(typeof ownerSub!=='string'||!ownerSub))throw err('invalid_mail_scope',400);
  const context=(scope,validity,uid)=>['inbox',...scopeParts(scope),ownerSub,`${validity}/${uid}`];
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function')
    throw err('invalid_d1_binding', 503);
  // No methods of this adapter create tables, grant permissions or connect to providers.
  return Object.freeze({
    async readSnapshot(scope) {
      const [installationId,mailboxId] = scopeParts(scope);
      let result;
      try {result = await db.prepare(READ_SQL).bind(installationId,mailboxId).all();}
      catch {throw err('mail_d1_read_failed');}
      if (!result || result.success === false) throw err('mail_d1_read_failed');
      let rows=result.results;
      if(cipher){
        try{rows=await Promise.all(rows.map(async row=>{
          if(row.msg_uid===null)return row;
          if(row.from_address!==''||row.subject!=='')throw err('mail_d1_invalid_snapshot');
          const value=await cipher.open(row.body_text,context(scope,row.msg_uid_validity,row.msg_uid));
          return {...row,from_address:value.from,subject:value.subject,body_text:value.text,
            ...(Object.hasOwn(value,'replyTo')?{reply_to:value.replyTo}:{})};
        }));}catch{throw err('mail_d1_invalid_snapshot');}
      }
      return decodeRows(rows,scope);
    },
    async commitSnapshot({scope,expectedRevision,next} = {}) {
      const [installationId,mailboxId] = scopeParts(scope);
      if (!goodInt(expectedRevision) || expectedRevision >= MAX_REVISION) throw err('invalid_mail_revision',400);
      let validated;
      try {validated=validateMailStoreSnapshot(scope,next);} catch {throw err('invalid_mail_snapshot',400);}
      if (validated.rows.length > MAX_RECORDS) throw err('mail_d1_snapshot_limit',413);
      // The D1 batch's third SQL statement decodes only these prevalidated fields.
      if(!cipher&&validated.replyTargets.some(row=>Object.hasOwn(row,'replyTo')))
        throw err('mail_reply_metadata_requires_encryption',400);
      const storedRows=await Promise.all(validated.rows.map(async (r,index)=>{
        if(!cipher)return r.slice(2);
        const encrypted=await cipher.seal({from:r[4],subject:r[5],text:r[6],...validated.replyTargets[index]},context(scope,r[2],r[3]));
        return [r[2],r[3],'','',encrypted,r[7],r[8]];
      }));
      const payload = JSON.stringify(storedRows);
      if (new TextEncoder().encode(payload).byteLength > MAX_JSON_BYTES)
        throw err('mail_d1_snapshot_limit',413);
      const cursor=validated.cursor;
      const operationId = crypto.randomUUID();
      const statements = [
        db.prepare(CAS_SQL).bind(installationId,mailboxId,installationId,mailboxId,
          expectedRevision,cursor?.uidValidity ?? null,cursor?.highestUid ?? null,operationId,expectedRevision),
        db.prepare(DELETE_SQL).bind(installationId,mailboxId),
        db.prepare(INSERT_SQL).bind(installationId,mailboxId,payload)
      ];
      try {
        // D1 guarantees this batch executes as one atomic transaction.
        const results=await db.batch(statements);
        if (!Array.isArray(results) || results.length!==3 ||
            results.some(x=>!x || x.success === false)) throw err('mail_d1_batch_failed');
        return {ok:true,revision:expectedRevision+1};
      } catch {
        // Never retry a failed/unknown-commit write blindly.
        let current;
        try {current=await db.prepare('SELECT revision,last_operation FROM comms_ro_mailboxes WHERE installation_id=? AND mailbox_id=?')
          .bind(installationId,mailboxId).first();}
        catch {throw err('mail_d1_batch_failed');}
        if (current !== null && current !== undefined && !goodInt(current.revision))
          throw err('mail_d1_batch_failed');
        if (current?.last_operation === operationId && current?.revision === expectedRevision+1)
          return {ok:true,revision:expectedRevision+1};
        if ((current?.revision ?? 0) !== expectedRevision) return {ok:false};
        throw err('mail_d1_batch_failed');
      }
    }
  });
}
