# RB01 isolated acceptance target and review-only artifacts

**Status:** Exact public-safe specification, NOT an approved target or deployment instruction. The final account, hostname, database identity, owner and nonowner user subjects, Access application, credentials, approved source records, operator and window must be confirmed **privately**. Do not put those values in Git, logs, public CI, or artifact names. No resource is created by this document.

## Artifact provenance and immutable inputs

- Canonical source: existing draft PR #8, `feature/ds011-rb01-integrated-review` against `recovery/server-source-job-021`. The manifest records the **exact Git checkout commit** for each build; do not substitute the PR's moving branch name for the SHA.
- License: `AGPL-3.0-only`, including `LICENSE.txt` and the corresponding-source link. Only tracked, owner-approved source and original PWA artwork are inputs; never use older private ZIPs, production downloads or a D1 export.
- Reproduce with Node 22+: `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, `npm run build`, `npm run verify:privacy`, `node tools/prepare-rb01-review.mjs`, then `(cd release-review && sha256sum -c SHA256SUMS)`. The existing full-shell/browser/workerd CI checks remain mandatory at the same checkout.
- Candidate artifact: `release-review/candidate.modules.json`, **12 modules, seven protected assets**. The manifest records the SHA-256 of the file, every module's source bytes and every decoded asset. Nothing in this generated bundle establishes deployability.
- Guarded fallback artifact: `release-review/guarded-v03.modules.json`, **four modules**, the fingerprint-pinned V0.3 server entry, unchanged hardened `worker/access.mjs`, current reviewed push helper and a small **read-only recovery screen** with the approved icons/manifest, service worker and AGPL license. It intentionally does not present the RB01 workspace controls that V0.3 cannot service. This is degraded operation, not a transparent restoration of the V0.3 UI.
- Manifest: `release-review/manifest.json`, plus `SHA256SUMS`; generated output is ignored by Git and made available only as a short-retention, synthetic-source CI artifact. The embedded `sourceCommit` and hashes identify the actual build. Reproduce twice at the **same commit** and compare checksums before trusting reproducibility.
- **PR versus push provenance:** workflows must checkout the triggering PR **head** SHA (not GitHub's transient synthetic merge ref). The artifact manifest `sourceCommit` must equal that head and the push build's `sourceCommit`. Compare the uncompressed candidate/fallback module bytes and their `SHA256SUMS`; the outer ZIP digests may differ due to archive metadata. Fail acceptance on a differing source commit or inner file checksum.
- Hard pins: V0.3 server SHA-256 `b2974dde4ca177420caecd810b8f008d582c93131317c6a822b5bb821c3c8c94`; hardened Access with Workers-compatible, no-follow JWKS transport SHA-256 `1f3127c82f2079f82685f8f4ee56a82c390cf36dd7ef36273b4623e9ab3c9654`, Git blob `69ec253eddfe6ad26268bef2d2a270cd3faa947d`. A changed hard pin fails packaging. See the November 1 transport continuation in [release acceptance](RB01-RELEASE-ACCEPTANCE.md) for the reason the historical verifier pin changed.

## Exact isolated target acceptance contract (currently UNASSIGNED)

| Field / boundary | Required separately authorized value or control |
| --- | --- |
| Operator, approver and window | Named owner/operator, approved start/end and independent stop/rollback authority. None assigned. |
| Account / origin | Explicit **new isolated test Worker** and its exact HTTPS origin. `APP_ORIGIN` must equal the actual request origin byte-for-byte. The current production Worker/hostname and custom routes must not be changed or bound. |
| D1 | Dedicated test D1 instance with an independently checked ID **different from production**. Worker `DB` binding must point only there; do not reuse aliases or production secrets. No database has been provisioned. |
| Runtime | Isolated compatibility date **`2026-10-28`** with **`nodejs_compat`**, subject to actual on-platform verification. Production presently uses that date with no flags; pinned synthetic workerd uses `2026-07-30` with the flag. The latter is insufficient to close the difference. |
| Access | Dedicated approved test Access application/policy, exact `ACCESS_AUD`, `ACCESS_ISSUER` and `ACCESS_JWKS_URL` (= issuer plus `/cdn-cgi/access/certs`). Explicit named owner and nonowner sessions; MFA, cookie and `ctx.access` behavior require observed evidence. No existing policy changes. |
| Owner identity | `OWNER_EMAIL` is the exact approved owner's canonical email; grant `subject` is the actual trusted Access user UUID/JWT `sub` observed **after** validation, not browser input. Test another valid, ungranted subject and one wrong email. Never include these real values in a public fixture. |
| Grants | `WORKSPACE_GRANTS` and `WORKSPACE_PROJECT_GRANTS` must be typed **JSON arrays** in trusted Worker configuration, not JSON strings or request parameters. Exact principal/scope/project relation verified privately. Empty/missing grants fail closed. |
| Source | Only explicitly approved **synthetic** Notion-style project metadata in the isolated cache. No real portfolio refresh, `NOTION_READ_TOKEN` or `NOTION_PORTFOLIO_SOURCE_ID` until a separate source/privacy authorization. `notionWrites` stays false. |
| Push | No VAPID secrets or actual notifications in basic synthetic testing. Physical-device push acceptance later needs separately approved isolated push credentials, controlled test device and observed receipt. |
| Durable data | Five existing tables/indexes from `worker/schema.sql` plus additive `worker/migrations/0003-scoped-workspace.sql` creating `station_workspace_state`. Test migration twice and retain all six tables. No schema downgrade or HTTP auto-migration. |

**Fabricated configuration example (never deploy without replacing and approving each field):**

```json
{
  "APP_ORIGIN": "https://REPLACE-WITH-INDEPENDENT-TEST-ORIGIN.example.test",
  "OWNER_EMAIL": "synthetic-owner@example.test",
  "ACCESS_ISSUER": "https://REPLACE-TEAM.cloudflareaccess.com",
  "ACCESS_AUD": "REPLACE-DEDICATED-TEST-AUDIENCE",
  "ACCESS_JWKS_URL": "https://REPLACE-TEAM.cloudflareaccess.com/cdn-cgi/access/certs",
  "WORKSPACE_GRANTS": [
    {"subject":"synthetic-owner-subject","principalId":"test-owner","scopeKind":"personal","scopeId":"personal-a","role":"owner"}
  ],
  "WORKSPACE_PROJECT_GRANTS": [
    {"principalId":"test-owner","scopeKind":"personal","scopeId":"personal-a","projectId":"project-a","area":"Devon Works"}
  ]
}
```

`DB` is a resource binding, not a JSON credential. The JSON example is a **shape illustration only**: `.example.test` is not a deployed Workers origin, and the fabricated Access subject will not match a real Access session. For one synthetic source project, the cache row must have `owner_sub` equal to the verified subject, a test-only source ID, a valid millisecond fetch time and a JSON payload with matching `id`, `name`, `area` and an HTTPS Notion host `record`. Use an approved test Notion record for actual source-link acceptance; never infer a grant from area names or use production cache contents. Even a successful HTTP read of a synthetic placeholder link is not proof of live source ownership.

## Independent acceptance and stop conditions

1. **Freeze and review:** read the exact artifact manifest and `SHA256SUMS`; compare two clean builds at the same checkout; check license, PNG sizes, seven assets, all twelve candidate modules, four guarded-fallback modules, hard-pinned verifier and all source/binary hashes. Examine final PR diff against the recovery branch. Record the private runtime/binding snapshot separately.
2. **Prove isolation before data:** compare Worker routes, deployed origin, account and D1 binding ID against production; reject any overlap. Deny anonymous, expired, forged, wrong issuer/audience, unrelated-subject, wrong-email and cross-scope actions. Confirm owner, MFA/session expiry/logout and stable subject/principal/project mapping with actual signed-in sessions. Run at `2026-10-28` + `nodejs_compat` on the isolated Cloudflare runtime; a local July workerd pass is not equivalent.
3. **Exercise fabricated records:** populate only approved test metadata. Propose, approve and reject; restart; test duplicate operations, stale generations, revoked grants, source changes/reconciliation, encrypted journal export and reviewed **empty-target** restore. All receipts must remain readable; no external operation is dispatched. Run iPhone/Safari/PWA/accessibility/push checks separately with the physical device and authorized test push credentials.
4. **Authentic recovery gate (separate approval):** before touching real data, record exact source and independently isolated destination IDs, operator, encryption/storage, access restrictions, retention/disposal, privacy review, and export/downtime window. Restore only to the specifically approved isolated target; independently compare table/index inventory, audit continuity, push and documents without exposing row contents in public results. Reapply additive journal migration twice. Never run synthetic helper on real exports.
5. **Guarded fallback acceptance:** deploy the **reviewed** four-module fallback only to the approved isolated target, not to production. Verify real owner/nonowner, protected read-only recovery screen, no RB01 mutations, legacy push behavior as allowed, six-table and receipt integrity and successful return to the twelve-module candidate without journal loss. Check PWA service worker and old tabs on the physical device. Historical provider-version rollback is **not** this guarded package and would restore the obsolete verifier.
6. **Release gate:** no merge, production migration or cutover until all previous evidence, identity mapping, signed artifact fingerprints, accepted device/restore/fallback behavior, exact operator/window and rollback authorization exist. Before any later authorized cutover, recheck the actual production deployment and backups. Stop on wrong target, unauthorized scope, runtime/module error, missing receipt, failed restore, owner lockout or uncertain rollback. Code fallback must not rewind D1 or drop the sixth table.

**Current decision:** artifact construction and synthetic CI may proceed without provider changes; real Access/device/isolated D1 acceptance and any authentic export remain **BLOCKED pending exact target, identity, privacy and window approval**. RB01 remains active. This document is not an RB02–RB05 plan.
