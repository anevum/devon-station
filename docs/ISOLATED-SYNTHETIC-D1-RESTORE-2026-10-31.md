# DS011 synthetic D1 / SQLite restore compatibility drill — October 31, 2026

**Status:** Synthetic recovery drill, not an authentic Cloudflare D1 restore, security certification, production-data processing, or authorization to deploy.

This test extends the existing single-owner backup test. It exercises the recovered `worker/schema.sql`, additive `0002-owner-state.sql` migration, `worker/state.mjs` read/write logic and a protected state API using **fabricated records only**.

## How to reproduce

With Node 22 or later in the existing draft recovery branch:

```sh
node --test tests/isolated-restore.test.mjs
npm test
```

The test creates SQLite databases in memory, writes deterministic synthetic push subscriptions, delivery logs, owner documents, revision audits and a placeholder portfolio cache, uses Node's `node:sqlite` backup to create temporary snapshots, then reopens them. It automatically removes its temporary databases. It neither reads Cloudflare bindings nor contacts providers.

## Explicit acceptance cases

1. A complete synthetic snapshot round-trips both owner scopes, legacy push subscriptions, delivery history, portfolio cache and audit rows without changes. Re-running the additive migration preserves rows. A previously committed operation is an idempotent retry after restoration; stale revisions remain rejected.
2. A legacy push-only schema snapshot can be restored and migrated twice without losing push records or creating an owner document.
3. An intentionally tampered synthetic document with an unchanged audit SHA-256 fails the *test-side recovery consistency check* even when SQLite's physical integrity check reports `ok`.
4. The recovered HTTP state API returns different synthetic state by verified subject selected by the test harness and rejects an email that differs from the owner configuration. This is a mocked authentication boundary, **not a real Access session**.
5. Missing reviewed schema indexes fail the test-side integrity gate instead of silently passing.

The test-side recovery check validates only the known synthetic schema, its tables/indexes, and the current document's latest audit checksum. It is **not** a deployed D1 data integrity verifier and does not authenticate older historical revisions; it cannot prove recovery of unknown production tables or real data.

## Remaining release conditions

The following still block a “clean-slate-ready” claim: an owner-authorized **authentic isolated production D1 export and restore** with privacy controls, verified deployed source/schema parity, named owner/nonowner Cloudflare Access sessions, recoverability and rollback of existing V0.3, physical iPhone/PWA/push acceptance, and fully reviewed source/asset rights plus an explicitly approved open-source license. The unlicensed R3 frontend and unresolved PWA graphics remain outside the public recovery PR. No production change is performed by these tests.


## Follow-on SQL-shaped D1 export rehearsal (combined draft PR #8)

The original five checks above use Node's temporary SQLite backup files. A follow-on **SQL-shaped export import** test now exercises a different restoration path: `tools/synthetic-d1-sql-restore.mjs` and `tests/synthetic-d1-sql-restore.test.mjs`. This is still **synthetic**, local-only, unlicensed recovery source in draft, and is not evidence of restoring the actual Cloudflare production export.

Run from the integrated review branch on Node 22 or later:

```sh
node --test tests/synthetic-d1-sql-restore.test.mjs
npm test
```

The tests construct a fabricated SQL dump using the versioned schema already recovered in this repository. The helper requires an explicit synthetic fixture marker, reconstructs schema and rows in a disposable **in-memory** SQLite instance, rejects unexpected schema objects and missing indexes, validates current document against its last audit hash and contiguous audit revisions, and executes the additive owner-state migration twice without losing legacy push rows, owner documents or portfolio cache. Test cases intentionally inject changed state, orphan/gapped audits, extra indexes, incomplete/invalid SQL, and disallowed statements. Only table counts and high-level synthetic flags are returned, not saved documents or push endpoints.

This is an internal test helper, **not a secure sandbox for untrusted SQL or a privacy scanner**. The marker is merely an operator-provided assertion, not proof that contents are synthetic. Never pass real owner, household, business or clinical records to this test. The helper deliberately rejects unreviewed schema drift; real D1 exports may contain platform-managed or otherwise unfamiliar objects requiring separate review. It does not prove older historical audit payload authenticity, live Cloudflare D1 compatibility, database permissions, restore rollback, real users, or any production service state.

For a future owner-authorized authentic restore, first verify the exact provider, database, scope, privacy controls, downtime impact, and independently isolated target. Cloudflare documents that `wrangler d1 export --remote --output=<path>` creates a SQL export and can temporarily block database requests while exporting; do **not** run it merely to satisfy this synthetic test. See [official D1 import/export guidance](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and [Wrangler command documentation](https://developers.cloudflare.com/d1/wrangler-commands/). Full authentic isolated restore and guarded rollback remain release gates, not completed milestones.
