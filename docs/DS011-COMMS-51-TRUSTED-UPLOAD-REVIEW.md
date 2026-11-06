# DS011-COMMS-51 — trusted inactive upload review

November 5, 2026. Source-only work on draft PR #41; application PR #36 stays unchanged.

## Identified and repaired defects

**High: self-consistent artifacts were not independently authorized.** Previously, the privileged CLI validated candidate hashes against the candidate-supplied manifest. A forged bundle could retain the approved source SHA, regenerate its checksums, and pass that integrity check. The trusted CLI now requires both owner-approved source `bba373f35f3cc913447e72fcdfff589cd6f3a073` and independently reproduced candidate SHA-256 `119ef1d3b3212f34be707a7262be11071b177fd532e9661768a4d74d9125d32d`. These pins live in reviewed uploader source. Changes need renewed review/authorization. The flexible `--verify` path remains an unprivileged integrity check, not an upload authorization.

**Medium: mutable Action tags in the credential-bearing pipeline.** All Actions in both release-control workflows now use exact commit IDs resolved from their upstream v4 refs. The manual workflow also restricts input to the approved application SHA before building and again before uploading.

The privileged job replaces artifact-supplied checksum-file processing with trusted `--verify-approved`. It still checks out the trusted workflow commit, runs only trusted tooling, uses no candidate package installation or build, and exposes Cloudflare credentials only to the final CLI step. The CLI rechecks the immutable pins in that step before any provider request. The candidate modules remain inert upload data.

The exported lower-level transport functions remain synthetic-test/transport primitives; they do not establish owner authorization. The supported privileged workflow entry point is the gated CLI. The connected-code generator is unchanged and is not used as a workaround for the blocked workflow.

## Verification

- `node --check tools/comms-acceptance-upload.mjs`, workflow YAML parsing, embedded shell `bash -n`, and `git diff --check`: passed.
- `node --test tests/comms-acceptance-upload.test.mjs`: 24 passed. New cases demonstrate the old checker accepts a self-consistent synthetic forgery while the trusted pin rejects it, enforce immutable Action refs, and execute the actual `--upload` CLI against a forged artifact in a disposable Git checkout. The CLI rejects before credential/transport validation.
- Exact application SHA: `npm test` passed 421/421.
- Native Workerd/D1: `npm test --prefix workerd-test` passed 53/53 at the July compatibility date. October verification uses the separate pinned `workerd@1.20261030.1` binary with `MINIFLARE_WORKERD_PATH` and `DS_WORKERD_COMPAT_DATE=2026-10-28`, matching CI; the older default binary cannot support that date. The pinned October run passed 53/53 after correcting that initial local binary mismatch.
- Clean application rebuild using `node tools/prepare-rb01-review.mjs` reproduced the approved digest above, 44 modules. Trusted `verifyApprovedRelease` accepted those real rebuilt bytes offline.
- `node --test tests/d1-backup-envelope.test.mjs tests/mail-payload-crypto.test.mjs tests/mail-sent-archive.test.mjs`: 28 passed. These existing synthetic cases cover serialized encrypted backup transport, corruption/wrong-key rejection, independent SQLite restore/decryption, draft/outbox claim and owner isolation, migration 0009/backfill/immutability, archive retention and failed-archive atomicity. They do not prove real key custody or off-provider backup availability.

## Security gates still block upload

Observed default branch `main` is still `protected:false` at `b9334242862f8f4d9535e08b2bf9942cd1ca8f73`. The connected GitHub App receives 403 for branch-protection details. Environment and variable endpoint families are unsupported by this connector: required reviewers, deployment-branch restrictions, administrator bypass and `DS011_MAIL_ACCEPTANCE_STAGE_ENABLED` cannot be independently verified here.

Before integration, the repository owner must establish or independently verify a trusted default-branch policy and a protected `ds011-mail-acceptance` environment restricted to the approved main workflow, with required human approval. Confirm whether self-review/bypass is possible and choose an approver who can satisfy the policy. Keep `DS011_MAIL_ACCEPTANCE_STAGE_ENABLED` disabled until this is verified. Confirm the existing token's scope and account privately; never paste credentials into chat or source. These are owner configuration decisions, not actions authorized by this source change.

After those controls are verified, separately authorize integration of PR #41. It remains draft/unmerged until then. The already authorized operation is only one inactive upload of the exact approved application artifact. No dispatch or direct API workaround was performed in this session.

## Recovery and migration disposition

The synthetic recovery and migration checks are source evidence only. Existing provider-internal logical backups do not establish independence from the original account. Owner-controlled recovery still requires encrypted backup bytes accessible outside that account and a separately held complete historical payload-key ring. In a disconnected recovery environment, restore to a fresh database, verify database integrity plus inbox/draft/outbox/archive consistency, and decrypt representative records using the real application paths. Record only outcome, hashes and counts; do not publish keys, private messages or backup locations. Retain all historical keys until every retained ciphertext is demonstrably recoverable. Missing/tampered backup and wrong/missing key must fail closed.

Migration 0009 remains a separately authorized, acceptance-only, additive forward migration. Review exact schema and migration ledger, rehearse against an isolated copy, record eligible accepted-row counts without contents, and preserve the original database plus verified restore. Apply only after private recovery is proven and specifically approved. Verify archive/receipt linkage and immutable triggers afterwards. Roll back incompatible code to a schema-compatible prior version; do not drop the new archive or blindly replay one-time migration 0007. Production schema is outside this action.

## Provider anchors and remaining acceptance

Read-only Cloudflare checks observed:

| Target | Deployment | Serving version |
| --- | --- | --- |
| acceptance | `99577640-1f02-446f-8d38-88f723f51f82` | `c31f8bd4-283d-457c-9779-87605927eec4` at 100% |
| production | `890cc9d9-533b-4b9a-b326-26a7c4f88402` | `ce64277b-124b-4177-825a-8b51d997152b` at 100%; old candidate at 0% |

Both sending flags remain false. Four bound D1 resource IDs are distinct. Secret binding names/types were inspected, never values. No email, live database write, migration, Access/DNS/secret change, merge, version upload or deployment occurred.

Remaining real acceptance: owner/nonowner signed Access, actual IMAP interruption/refresh/encrypted read at the approved candidate, specifically authorized SMTP with recipient-side arrival and provider Sent evidence, session expiration, physical iPhone Safari/installed PWA, offline behavior, independent real recovery and authorized activation. The existing older acceptance UI and historical provider evidence do not certify the new candidate.

**PR #41: improved source, integration blocked. PR #36: approved SHA preserved, not uploaded. Production release NO-GO.**
