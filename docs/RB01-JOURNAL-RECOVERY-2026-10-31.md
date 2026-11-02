# Scoped journal recovery and source review

This follow-on completes client-encrypted journal backup and an explicit source-metadata review flow in the existing RB01 runtime. It introduces no provider resource, database migration, external dispatcher or replacement application. Recovered frontend integration remains private and publication-gated.

## Recovery behavior

The authenticated `GET /api/workspace/backup` transfers only the selected owner's scoped foundation history and governance receipts. The browser derives an AES-256-GCM key with PBKDF2-SHA256 (310,000 iterations), a fresh 16-byte salt and a fresh 12-byte IV, using a workspace-specific authenticated context. A 14–256 character passphrase stays on the client. Only ciphertext is offered as a download; unlocking happens locally. This is separate from the pre-existing encrypted device-note backup, which now also accepts feedback from the integrated Workspace section.

After unlocking, the authenticated same-origin `POST /api/workspace/restore-review` validates the owner subject, principal, scope, schema, current approved project metadata, original foundation receipts and governance digest chain. It returns counts and a digest binding the exact review. `POST /api/workspace/restore` requires that review digest, an operation ID and expected generation zero. It only inserts into an empty journal. An existing journal is never replaced, merged or deleted. The original action/decision receipts survive unchanged, and an additional restore receipt is recorded. Replaying an identical request returns its receipt; conflicting IDs, stale reviews and racing inserts fail closed.

The target must independently have the correct identity/project grants and compatible approved portfolio metadata. A backup does not grant permissions, provision a target, seed the source cache, or restore Cloudflare configuration. It is not a whole-D1 disaster recovery export. Ciphertext and its passphrase must be kept separately by the owner. Application storage remains unencrypted by this adapter.

## Source reconciliation

`GET /api/workspace/review` reports additions, changes and removals against the already granted current source projection. Metadata for removed projects is withheld. A reviewed `POST /api/workspace/reconcile` replaces only those projections and preserves all actions, original decision receipts and retry history. Approval is bound to the current generation, journal digest and source projection; a changed review or concurrent mutation requires another review.

Removing a project with saved history remains blocked. No automatic deletion, hidden archival store or cross-scope transfer is introduced. Restore the appropriate grant or separately establish an authorized history-retention policy. Unused project removal and approved additions/metadata updates can be reconciled. Scope/principal revocation cannot be approved from the client.

`worker/workspace-journal.mjs` accepts both the earlier raw foundation export and the versioned journal wrapper. Governance receipts have chained digests, separate request fingerprints and operation-ID checks. Unkeyed hashes detect accidental corruption; they do not authenticate records against a database attacker. An owner-authorized imported file is still validated as data, not trusted instructions. Text screening is not a clinical compliance control; regulated data remains out of scope.

## Verification and limits

Ten additional synthetic tests cover encrypted round-trip recovery into an independently reopened SQLite target, wrong passphrase/tampering/KDF rejection, overwrite refusal, subject/principal/scope/source checks, stale review and concurrent approval, source removal with history, failed storage, legacy snapshot compatibility, governance corruption, sensitive-content validation on import, and device-note backup compatibility.

Private DOM checks exercise the actual recovered HTML and Worker: encrypted download contents, passphrase absence from network requests and remaining form values, populated-target refusal, explicit source approval preserving receipts, empty-target restore, governance receipt display and scoped automated accessibility excluding rendered contrast. Existing workflow/capture/restart/isolation DOM checks remain in place.

Run `npm test` and `npm --prefix foundation test` on the public tree. The private combined tree additionally runs its original hosted build/privacy checks and `npm run test:runtime:dom` after installing pinned development dependencies. The updated build contains three assets and twelve Worker modules. Actual integrated Chromium, rendered layout/contrast, physical iPhone/PWA/push, workerd execution, real Access sessions, authentic D1 restore and live rollback remain unverified release gates. Source/asset rights and an approved OSI license are still required before publishing the recovered frontend. No production change or real-data migration was performed.

Next bounded job: verify the public runtime in a pinned workerd compatibility test, then exercise the private integrated UI in a permitted browser environment. Retain current production and release gates.
