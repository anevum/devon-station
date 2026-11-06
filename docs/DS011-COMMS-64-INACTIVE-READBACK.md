# Proposed next candidate pins — COMMS-68

Pending explicit owner approval; this draft does not authorize a release.

- Application PR #44 source: `be6644f58297dedfcd1c1d60ec2aef17e64b0f35`.
- Independently rebuilt 44-module candidate SHA-256: `07491e2aa5aa9dab75d8a1ce211645c70d367011310e481e4febd811bc764aa1`.
- Exact-head CI: [server](https://github.com/devonalanakins/devon-station/actions/runs/42306610375), [foundation](https://github.com/devonalanakins/devon-station/actions/runs/42306610374), [release source checks](https://github.com/devonalanakins/devon-station/actions/runs/42306610359) all passed.
- Initial Sent is accepted outbox receipt history and on-demand encrypted contents; no migration 0009 is needed. Application/schema/Access/provider/device requirements are documented in the [candidate record](https://github.com/devonalanakins/devon-station/blob/be6644f58297dedfcd1c1d60ec2aef17e64b0f35/docs/DS011-COMMS-68-INTEGRATED-EMAIL-CANDIDATE.md).

The draft release tooling pins this new source/digest and checks PR #44 head, while the existing version-15 readback remains explicitly anchored to the older approved PR #36 source. Both are deliberately distinct. Trusted main's active workflow remains unchanged until separately approved integration. Candidate-side checks stay unprivileged; the credential-bearing job still executes trusted source, checks exact source/digest before credentials, and can only upload an inactive acceptance version. No traffic or real database changes, Access changes, or email are authorized. Earlier approval for the old version was already exercised and cannot authorize this new one.

Before any upload, independently inspect protected main and the acceptance environment's approval/branch restrictions and obtain scoped authorization to integrate this release PR and perform one inactive upload. Off-provider recovery remains a separate acceptance-release prerequisite; an inactive upload does not touch encrypted records and does not itself require migration 0009. After upload, verify the new source/version/bindings while confirming both traffic anchors unchanged. The old readback cannot validate a new UUID: do not silently replace its baseline. Acceptance activation, provider actions and production remain separate gates.

The historical instructions below describe version 15 only; their original source/checksum pins remain historical evidence.

---

# DS011-COMMS-64 — Inactive acceptance version readback

Date: November 6, 2026. Source-only readback tooling; **no migration, traffic activation, SMTP send or production release**.

## Purpose

PR #36's immutable approved application was uploaded to the isolated acceptance Worker as version 15, then deliberately left inactive. This helper checks that exact version's provenance, compatibility, bindings, owner policy and database isolation against two unchanged serving-deployment anchors. It is designed to **fail closed on drift**, never automatically approve activation.

The script `tools/comms-acceptance-readback.mjs` exports `readbackInactiveAcceptance({request,accountId})`. Supply a read-only Cloudflare request adapter returning the unwrapped API `result` (not the Cloudflare envelope). The helper itself calls the reviewed `preflightAcceptance` from `tools/comms-acceptance-upload.mjs`. Its adapter allows exactly eight GET endpoint shapes: two Worker settings, two deployment lists, the acceptance subdomain, the owner Access app and its policies, and a single exact approved version. There is **no POST, multipart form, database query, secret-value read, SMTP command, or rollout operation**.

Synthetic regression command on the reviewed branch:

```sh
node --check tools/comms-acceptance-readback.mjs
node --test tests/comms-acceptance-readback.test.mjs
node --test tests/comms-acceptance-upload.test.mjs
```

The existing source-review workflow now runs the focused synthetic readback tests on changes to either new file; it does not run against the live provider and does not receive release credentials.

## Immutable reference points

| Target | Exact reference |
| --- | --- |
| Uploaded *inactive* acceptance version | `523569b4-38d9-4cab-acbd-e84dd22a59aa` (version 15) |
| Approved source commit | `bba373f35f3cc913447e72fcdfff589cd6f3a073` (PR #36) |
| Serving acceptance deployment | `99577640-1f02-446f-8d38-88f723f51f82`, older version `c31f8bd4-283d-457c-9779-87605927eec4` at 100% |
| Serving production deployment | `890cc9d9-533b-4b9a-b326-26a7c4f88402`, legacy version `ce64277b-124b-4177-825a-8b51d997152b` at 100%, prior candidate `1ba61404-f7f6-4b0b-8b55-6f9f52819e70` at 0% |

The tool refuses changed active deployment IDs, changed percentages or version IDs, a version-15 traffic entry even at 0%, and deviations in reviewed annotations, runtime, required bindings, disabled sending, Access policy, preview URLs or distinct D1 identities. It reads active deployments a second time after inspecting the uploaded version to detect activation during the check.

The return object contains only stable version/deployment IDs, status booleans and an evidence-scope marker; it never emits mailbox data, owner email, key material, database contents or secret values. Production and acceptance flags `MAIL_SEND_ENABLED` and `MAIL_SENDER_VERIFIED` must remain false.

## Proof boundaries

A green synthetic test demonstrates only the verifier's behavior against fixtures. A successful read-only provider result proves the observed metadata **at the time of the reads**, not that the Worker code is authenticated and usable by an owner on a physical iPhone, that keys are independently recoverable, or that a real SMTP message was delivered. It does not validate the exact deployed module bytes by itself; the prior approved artifact and receipt provide that separate evidence.

If a mismatch appears, **stop and investigate**. Do not automatically upload a replacement version, amend baselines to the current deployment, bypass GitHub environment approval, run migration 0009 or increase acceptance traffic. Review the source and Cloudflare environment with the owner. After valid future authorization, create a fresh verified checkpoint and specifically update the pins rather than weakening these guards.

The live user-path rollout still requires independent recovery evidence, a separately approved acceptance-only migration, authentic owner/nonowner Access sessions, an explicit controlled sending test, recipient-side and provider-Sent evidence, and Safari/installed-PWA acceptance. Production remains no-go until those gates are satisfied.

## DS011-COMMS-65 — acceptance migration 0009 read-only readiness

The **actual isolated acceptance** MAIL_DB was queried with read-only SQLite statements through the connected D1 API on November 6, 2026. The API uses HTTP POST for read-only `SELECT` / `PRAGMA` operations. No SQL writes or database migrations were sent. Inspect only schema/object metadata, ledger **names** and aggregate counts; never export or display encrypted payloads, owner identities, addresses or email bodies.

Observed point-in-time baseline: migration ledger contains exactly `0004`–`0008`; the dedicated `comms_outbox` table and both saved-draft uniqueness indexes have their reviewed shapes; `comms_sent_archive` and its triggers/index are absent. One outbox row exists, it is an accepted saved-draft-linked record whose envelope identifies AES-GCM, and it is the only eligible backfill record; there are zero unresolved outgoing records. These are **counts only**, not proof the actual ciphertext is decryptable in a disconnected recovery environment.

`tools/comms-migration-readiness.mjs` implements a separate fixed-SQL, pinned-acceptance-DB preflight. It refuses an unexpected migration ledger entry or order, changed table definition/column metadata, missing or changed indexes, already-present archive objects, non-integer aggregates, changed accepted/backfill/unresolved counts or query failure. Its output contains only audit status, expected backfill count, and the exact limitation `READ_ONLY_METADATA_AND_AGGREGATES_AT_CHECK_TIME`. A read-only SQL adapter must be provided; do not attach a broad SQL execution interface to an untrusted caller. The feature neither creates a migration runner nor authorizes migration.

The existing release-control source-review workflow now runs `node --test tests/comms-migration-readiness.test.mjs` in a **synthetic** environment alongside the original uploader and inactive-version checks. It is not the actual D1 client and cannot prove provider availability. This preflight is conservative and is intended to stop on any changed acceptance data; an intentional new email or schema change requires a fresh review rather than silently updating expected counts.

**Release remains NO-GO:** independent off-provider backup and separately controlled complete key-ring recovery have not been verified. Owner approval for applying migration 0009 and for activating the inactive acceptance version are distinct outstanding gates. Do not migrate the real acceptance DB or enable SMTP based on this metadata result. Production stays untouched.

## DS011-COMMS-66 — migration-ledger checksum integrity

The earlier migration-0009 preflight checked the sequence of migration names and the current SQL schema, but failed to validate the `sha256` field already stored with each applied migration. A malicious or accidentally altered ledger with the correct names could therefore pass. The preflight now selects `name, sha256` and requires **exact SHA-256 parity for every applied migration 0004–0008**.

The five expected hashes were independently computed from the exact SQL bytes in approved application PR #36 (`bba373f35f3cc913447e72fcdfff589cd6f3a073`) and compared to the isolated acceptance D1's recorded checksums. No migration source was changed; the historical values match. Synthetic regression cases reject modified, missing, swapped, non-string or otherwise noncanonical hashes.

This tightens **read-only integrity evidence only**. It neither verifies the historical act of applying each migration nor proves a real off-provider restore, decryption, authenticated user path, or approval to run migration 0009. A mismatch is a stop signal for review, not permission to rewrite the migration ledger.

## DS011-COMMS-67 — detect preflight drift across read passes

The migration-readiness tool now reads its four fixed SQL metadata/aggregate views **twice**. Each pass must satisfy the exact approved source SHA, ledger, schema, index, and accepted/outstanding-record invariants. The tool compares the first and second result snapshots and refuses if any view differs. This detects schema, ledger or count drift visible during the preflight, including unexpected inbound changes and interrupted reads, rather than treating the first successful sequence as a durable release approval.

**Important limitation:** D1's four API queries are not a single snapshot-isolated database transaction; two successful passes do not prove atomicity, freeze future mailbox activity, detect changes that retain the same reported aggregates, or authorize an actual migration. Re-run independent readiness checks immediately before any separately approved migration. The SQL remains fixed SELECT/PRAGMA against isolated acceptance D1; no mail payloads or keys are exported. The new checks are covered by synthetic second-pass drift and redacted-provider-failure regression tests.
