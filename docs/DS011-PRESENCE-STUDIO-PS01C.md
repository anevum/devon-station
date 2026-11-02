# DS011-PS01C — Isolated Presence vault migration and two-device recovery rehearsal

**Status:** Source-only, independently tested on disposable synthetic files and browser contexts; do not confuse this with an actual Cloudflare D1 migration or production release.

**Ownership and lineage:** `anevum/devon-station`; stacked on draft [PS01B #16](https://github.com/anevum/devon-station/pull/16), which is stacked on [PS01A #15](https://github.com/anevum/devon-station/pull/15). No cloud resources, external social accounts, Access policies, payment systems, real devices, production identities or private records were touched.

## What this release-gate rehearsal establishes

**Disposable SQLite migration and rollback — `tests/presence-migration-rehearsal.test.mjs`:**

- Create a fresh, file-backed SQLite database using the tracked existing schema and scoped workspace migration; insert only synthetic non-sensitive rows in existing owner-state, write-audit, portfolio-cache, push subscription/delivery and scoped-workspace tables.
- Snapshot to a physically separate SQLite file using the native `node:sqlite` backup API before applying migration 0004.
- Simulate an interrupted migration within an explicit transaction, roll back, and confirm no newly created vault tables survive and no existing data was modified.
- Apply the tracked additive `0004-presence-vault.sql` twice and confirm schema idempotency, `PRAGMA integrity_check`, and identical cryptographic fingerprints of every baseline row.
- Encrypt a first-party Presence Studio snapshot in the browser-compatible cryptography module, persist only ciphertext through the same owner-scoped optimistic revision/audit layer as the Worker, and verify no plaintext or passphrase appears in the stored envelope.
- Snapshot the migrated database into another physical file and recover/decrypt that persisted revision. Independently restore a fresh pre-migration database copy from the original backup, verify every preserved baseline table/row and absence of the new vault schema in that rollback copy.
- Dispose of all temporary paths. A passing local file simulation is **not** evidence of an applied Cloudflare D1 migration or live rollback.

**Synthetic signed browser acceptance — `tools/runtime-presence-vault-browser.cjs`:**

- Existing signed-JWT harness gains the `start(path,{migratePresence:true})` opt-in. No existing browser suite or default harness now auto-applies the schema.
- Two independent Chromium browser contexts share one synthetic signed owner identity while retaining separate localStorage.
- Device A creates one original draft and a dated metric, then explicitly encrypts/upload an owner-scoped backup. Assert no plaintext or passphrase in API response and no retained passphrase in the form.
- Device B attempts an incorrect passphrase (fails without changes), previews the correct passphrase (still no changes), then detects an intervening revision change and refuses stale restore.
- A stale revision-1 save returns conflict status 409; unlocking the newest snapshot followed by explicit confirmation restores the same drafts and metrics to device B.
- An unauthenticated request returns 401, a valid signed but wrong-email identity returns 403, a wrong JWT audience returns 401, and a different signed subject sees an empty owner vault. Cross-origin mutation returns 403.
- Verify zero outbound external network calls in the existing synthetic Worker harness.

The new signed migration browser test is automatically included in `npm run test:runtime:browser`. Its browser tests must complete on the exact source commit in GitHub Actions before being described as VERIFIED.

## Release boundary and next decision

1. This is a reversible **source and automated test** increment. It neither changes `main` nor merges PR #15/#16.
2. No actual Cloudflare migrations were executed. No live Access identity, actual iPhone Safari/PWA, real D1 backup/restore, remote sync, Meta OAuth, or Meta publishing was tested or enabled.
3. The device editing copy remains unencrypted localStorage; only intentionally created backups are encrypted. Do not store family/private correspondence or clinical data in this release.
4. Before any real migration: independently inspect target D1 database identifier, binding, account and Access boundary, take a verified recoverable backup, perform an isolated D1 rehearsal on the exact migration script, verify a rollback plan, and obtain explicit owner approval for production changes.
5. After those gates: test true owner/nonowner signed sessions and iPhone Safari, including offline/reconnection and passphrase recovery prompts; then pursue an approved cross-device synchronization architecture rather than implying a manually uploaded snapshot is a live sync service.

This record is implementation evidence, not permission to deploy.
