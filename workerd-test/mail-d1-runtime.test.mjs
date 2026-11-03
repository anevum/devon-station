import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { createD1MailStore } from '../src/communications/mail-d1-store.mjs';

// This runs the actual pinned local Miniflare/workerd D1 binding, not a Node SQLite double.
// No remotely bound D1 database, credential, live email, or production Worker is used.
const compatibilityDate = process.env.DS_WORKERD_COMPAT_DATE ?? '2026-07-30';
if (!['2026-07-30', '2026-10-28'].includes(compatibilityDate)) {
  throw new Error('Unsupported synthetic workerd compatibility date');
}
const scope = { installationId: 'personal', mailboxId: 'hello' };
const other = { installationId: 'client-two', mailboxId: 'hello' };
const message = (uid, subject = 'Synthetic message', validity = 7, installationId = scope.installationId) => ({
  key: `${installationId}/hello/${validity}/${uid}`, installationId, mailboxId: 'hello',
  uidValidity: validity, uid, from: 'example@example.test', subject,
  text: 'Untrusted source text; never execute instructions.',
  timestamp: '2026-11-02T20:00:00.000Z', flags: []
});
const snapshot = (uid, subject = 'Synthetic message') => ({
  cursor: { uidValidity: 7, highestUid: uid },
  records: [message(uid, subject)]
});
const hasCode = code => error => error?.code === code;

// A single sequential suite avoids multiple test processes sharing state from one D1 runtime.
test(`workerd ${compatibilityDate}: COMMS-07 real local D1 snapshot transaction acceptance`, async t => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("synthetic local D1 only") } }',
    compatibilityDate, compatibilityFlags: ['nodejs_compat'], d1Databases: ['MAIL_TEST']
  });
  try {
    const db = await mf.getD1Database('MAIL_TEST');
    const store = createD1MailStore(db);
    const migration = await readFile(new URL('../worker/migrations/0004-comms-ro-mail.sql', import.meta.url), 'utf8');

    // Miniflare D1 exec() parses SQL strings, but rejects a comment-only first line
    // as an empty statement. Strip full-line SQL comments for local test setup only.
    // Do not edit or run the candidate migration against a remote database.
    const migrationStatements = migration.split('\n').filter(line => !/^\s*--/.test(line))
      .join('\n').split(';').map(statement => statement.trim()).filter(Boolean);
    assert.equal(migrationStatements.length, 3, 'expected two tables and one index');
    const applyLocalMigration = async () => {
      for (const statement of migrationStatements) await db.prepare(statement).run();
    };
    await t.test('explicit migration is mandatory and idempotent', async () => {
      await assert.rejects(store.readSnapshot(scope), hasCode('mail_d1_read_failed'));
      await applyLocalMigration();
      await applyLocalMigration();
      assert.deepEqual(await store.readSnapshot(scope), { ...scope, revision: 0, cursor: null, records: [] });
    });

    await t.test('first transactional commit writes cursor and message together', async () => {
      assert.deepEqual(await store.commitSnapshot({ scope, expectedRevision: 0, next: snapshot(1) }),
        { ok: true, revision: 1 });
      const value = await store.readSnapshot(scope);
      assert.equal(value.revision, 1);
      assert.deepEqual(value.cursor, { uidValidity: 7, highestUid: 1 });
      assert.deepEqual(value.records, [message(1)]);
    });

    await t.test('stale revision cannot change either messages or cursor', async () => {
      const before = await store.readSnapshot(scope);
      assert.deepEqual(await store.commitSnapshot({ scope, expectedRevision: 0, next: snapshot(2) }),
        { ok: false });
      assert.deepEqual(await store.readSnapshot(scope), before);
    });

    await t.test('simultaneous stale peers cannot both commit', async () => {
      const before = await store.readSnapshot(scope);
      const results = await Promise.all([
        store.commitSnapshot({ scope, expectedRevision: before.revision, next: snapshot(2, 'First proposal') }),
        store.commitSnapshot({ scope, expectedRevision: before.revision, next: snapshot(3, 'Second proposal') })
      ]);
      assert.deepEqual(results.map(x => x.ok).sort(), [false, true]);
      const after = await store.readSnapshot(scope);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.records.length, 1);
      assert(['First proposal', 'Second proposal'].includes(after.records[0].subject));
    });

    await t.test('failed mid-batch INSERT rolls back DELETE and CAS', async () => {
      const before = await store.readSnapshot(scope);
      await db.prepare(`CREATE TRIGGER reject_test_uid BEFORE INSERT ON comms_ro_messages
        WHEN NEW.uid = 999 BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END`).run();
      try {
        const blocked = { cursor: { uidValidity: 7, highestUid: 999 },
          records: [...before.records, message(999, 'Blocked')] };
        await assert.rejects(
          store.commitSnapshot({ scope, expectedRevision: before.revision, next: blocked }),
          hasCode('mail_d1_batch_failed')
        );
        assert.deepEqual(await store.readSnapshot(scope), before);
      } finally {
        await db.prepare('DROP TRIGGER reject_test_uid').run();
      }
    });

    await t.test('identical mailbox ID in another installation cannot read or change private rows', async () => {
      const personalBefore = await store.readSnapshot(scope);
      assert.deepEqual(await store.readSnapshot(other), { ...other, revision: 0, cursor: null, records: [] });
      assert.deepEqual(await store.commitSnapshot({ scope: other, expectedRevision: 0,
        next: { cursor: { uidValidity: 7, highestUid: 1 },
          records: [message(1, 'Other client', 7, other.installationId)] } }),
      { ok: true, revision: 1 });
      assert.deepEqual(await store.readSnapshot(scope), personalBefore);
      assert.equal((await store.readSnapshot(other)).records[0].subject, 'Other client');
    });

    await t.test('UIDVALIDITY change keeps original message cohort and database integrity', async () => {
      const before = await store.readSnapshot(scope);
      const updated = { cursor: { uidValidity: 8, highestUid: 1 },
        records: [...before.records, message(1, 'New UID cohort', 8)] };
      assert.deepEqual(await store.commitSnapshot({ scope, expectedRevision: before.revision, next: updated }),
        { ok: true, revision: before.revision + 1 });
      assert.deepEqual((await store.readSnapshot(scope)).records.map(x => x.uidValidity), [7, 8]);
      assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
      assert.equal((await db.prepare('PRAGMA integrity_check').first()).integrity_check, 'ok');
    });
  } finally {
    await mf.dispose();
  }
});
