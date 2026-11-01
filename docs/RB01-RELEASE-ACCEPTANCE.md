# RB01 release acceptance and guarded fallback

Status: preparation and synthetic verification only. This procedure authorizes
no upload, migration, Access change, real-data export, merge or deployment.
The owning DS-011 Notion record holds private target identifiers and approvals.
Keep account/database IDs, identity subjects, grants, credentials and authentic
exports out of this public repository.

## Verified comparison on November 1, 2026 (UTC)

Reviewed application baseline: `6da693a39f6ee5e2c1f36245257375611bc491c6`
in [draft PR #8](https://github.com/anevum/devon-station/pull/8), targeting
`recovery/server-source-job-021`. Both exact-commit CI workflows passed. This
branch is the canonical AGPL-3.0-only application source; private recovery ZIPs
are historical inputs. The PR remains unmerged.

The observed service still serves the V0.3 module graph, not RB01. Its server
entry matches `legacy/v03/worker/index.mjs` SHA-256
`b2974dde4ca177420caecd810b8f008d582c93131317c6a822b5bb821c3c8c94`.
The comparison read deployed source/configuration and schema metadata only,
not application rows. Do not mistake this source identity for release acceptance.

| Boundary | Observed service | RB01 requirement / remaining evidence |
| --- | --- | --- |
| Module graph | Four V0.3 modules | Build emits twelve modules and seven protected assets, including license and approved icons |
| Runtime | Compatibility date `2026-10-28`, no flags | Node crypto imports require `nodejs_compat`; local workerd is tested at `2026-07-30`, not the current service date |
| Workspace authority | Workspace grant bindings absent | Trusted JSON arrays `WORKSPACE_GRANTS` and `WORKSPACE_PROJECT_GRANTS`; explicitly approved verified subject, principal, scope and source project mapping |
| Persistence | Five application tables and two explicit indexes | Retain all five tables; additive `0003-scoped-workspace.sql` creates the sixth, `station_workspace_state` |
| Source cache | Cache table exists; contents not inspected | Approved minimal project metadata must actually be present and source-linked; never infer grants from an area label |
| Notion connector | Refresh credential/source bindings absent | Existing cache-only work is possible; do not enable refresh or seed real records without separate source/privacy approval |
| Access | Configured audience matches application; owner-only allow policy | Named owner/nonowner sessions, expiry/logout and actual runtime subject mapping remain untested |
| Routing | Workers subdomain enabled, previews disabled; no matching custom domain or personal-zone route observed | Preserve current entry point; confirm final target and full routing before any authorized upload |
| Fallback | Historical V0.3 behavior recoverable from source | Assemble a guarded fallback retaining reviewed authentication; do not assume a historical deployment contains later hardening |

The hardened `worker/access.mjs` is unchanged: Git blob
`64a6d1cd5437a1490a594ed31a451ed5b7ee45b8`, SHA-256
`63e81e184542f3a05d312a7c4329044bd8e8c9116ec11631829b699e96e6fac1`.

## Ordered acceptance gates

1. **Freeze exact inputs.** Record final commit, build/module and asset hashes,
   lockfiles, license/source links, target Worker/D1, binding types, origin,
   compatibility date/flags, Access application/policies and authorized operator
   privately. Resolve the runtime-date difference through isolated testing.
   Recheck CI at the final commit. Review the PR's recovery-branch base and the
   final integration diff; do not merge historical stacked PRs indiscriminately.
2. **Approve an isolated test target.** Confirm an independent database and an
   Access-protected test origin, zero production bindings, test-only project
   records and exact grants. A proposed target name is not a provisioned target.
   Do not create resources or widen identity policies through this checklist.
3. **Run real identity and device acceptance using fabricated records.** Confirm
   unsigned, expired and unrelated-subject denial, owner access, business-scope
   separation and stable subject mapping. On a physical iPhone, record model,
   iOS/Safari version and standalone PWA state; check safe areas, keyboard-open
   scrolling, large text, VoiceOver, reduced motion, touch, install/launch/icon,
   proposal/review/approve/reject, encrypted recovery, restart and no duplicate
   receipts. Push needs separately authorized isolated credentials and an
   observed phone receipt. Browser emulation cannot close this gate.
4. **Authorize authentic recovery separately.** Record exact source and distinct
   destination IDs, operator, privacy/encryption/access controls, export downtime
   window, storage destination, retention and disposal policy. Never run the
   synthetic restore helper on a real export. Restore only to the approved
   isolated target; compare approved schema/integrity evidence, existing owner
   documents, revision audits, push records and cache. Apply the additive journal
   migration twice there; verify source/grant and journal boundaries. Keep all
   rows and sensitive evidence private. This session performed no authentic export.
5. **Prove guarded fallback on that target.** Use the preserved V0.3 server entry
   with the reviewed hardened Access module and reviewed assets/configuration.
   Verify named-user denial/allow behavior and push/state preservation before
   declaring an exact fallback artifact accepted. RB01 writes and receipts must
   remain recoverable when returning from fallback. Keep additive tables; never
   drop tables, rewind D1 or erase new receipts as part of a code fallback.
6. **Approve a concrete cutover.** Only after the above evidence passes, approve
   exact merge/source, target, migration, runtime/bindings, operator, window,
   fallback artifact and rollback authority. Recheck current deployment and
   backups immediately before acting. No DNS, Access, vendor or billing change
   is implied. After an authorized release, independently verify the intended
   endpoint, owner/nonowner behavior, journal persistence, recovery and errors.

Stop before release on missing/mismatched source/grants, runtime errors,
authentication failures, wrong D1 target, missing recovery evidence or incomplete
device acceptance. During an authorized cutover, any cross-scope disclosure,
lost state/receipt, persistent journal write failure or owner lockout is a
rollback trigger. The operator must have explicit rollback authority and the
accepted guarded artifact; stop further writes and retain evidence. A code
fallback does not restore database contents. Cloudflare explains the distinction
in its [rollback documentation](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Reproducible offline fallback checks

```sh
node --test tests/legacy-rollback-compat.test.mjs
npm test
```

Five cases cover legacy endpoint behavior, push ownership and owner-state
preservation; same-origin restrictions; upgrade through the additive sixth table,
two durable RB01 decision receipts, legacy fallback and return with all original
rows/journal bytes preserved; and actual hardened JWT signature/claim validation
with generated keys, including malformed optional times, expired/forged tokens,
wrong issuer/audience and nonowner rejection. The test pins both the legacy
server hash and hardened verifier hash. It sends no push or other external operation.

This uses in-memory SQLite with a D1-shaped adapter and fabricated records.
Generated JWTs and a stubbed JWKS endpoint are not actual Access acceptance.
Existing workerd/full-shell tests remain separate evidence. No physical device,
authentic D1 restore, deployed fallback or production cutover is proven here.
