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
