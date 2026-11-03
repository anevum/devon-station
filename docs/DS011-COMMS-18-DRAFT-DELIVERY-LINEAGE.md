# DS011-COMMS-18 — Saved-draft-revision delivery lineage

Date: 2026-11-03. **SOURCE ONLY / DRAFT / NOT MERGED / NOT DEPLOYED.**

Stacks on COMMS-17 PR #34. Preserves the same open-source DevonStation repository, signed owner-only Mail APIs, D1 draft store, outbox, and guarded Purelymail SMTP implementation. No new external services or production changes.

## Problem and implementation

COMMS-17 stored durable outbox receipts but allowed a browser to prepare the same saved draft again under a different delivery UUID after reload. COMMS-18 binds each newly prepared delivery to one server-authoritative, owner-scoped `draft_id` and immutable `draft_revision`.

The HTTP preparation API now accepts **only** `deliveryId`, `draftId`, `draftRevision`, and `approvedByOwner:true`. It rejects arbitrary browser-supplied subject, recipients, body, From, and attachment objects. Server code reads the actual saved draft through the signed Access owner scope and independently validates its From entitlement and plain-text MIME before queuing.

Candidate migration `worker/migrations/0007-comms-draft-outbox-lineage.sql` adds nullable draft lineage columns and a unique partial index across installation/mailbox/owner/draft/revision. Historic outbox rows remain unlinked and unchanged. An `INSERT OR IGNORE ... SELECT ... FROM comms_mail_drafts` statement atomically checks **revision and exact saved recipients, subject, and body** while inserting the snapshot. A competing delivery ID for the same revision is refused with a content-free 409; an exact replay of the original delivery ID returns the existing receipt without a new delivery. Changed/deleted draft revisions fail closed. Cross-owner drafts cannot be prepared.

The outgoing submit API separately refuses every unlinked/legacy outbox row, even when SMTP flags would otherwise be enabled. The existing one-time CAS claim, explicit second owner confirmation, TLS-only provider transport, no automatic retry, ambiguous-acceptance handling, and provider-acceptance-not-delivery semantics are preserved. Existing legacy internal storage methods continue to work with the additive schema; they do **not** gain HTTP sending permission.

The UI now sends the draft ID/revision only. A duplicate-revision 409 tells the owner to inspect the durable outbox rather than resubmit. After an edit, the UI disables draft preparation until an explicit save.

## Verification evidence

- A local, isolated Python 3 `sqlite3` execution of the candidate SQL semantics passed: unique preparation, exact replay, stale revision, payload mismatch, signed owner separation, subsequent changed revision, and backward-compatible legacy insertion. SQLite version 3.46.1. This exercises the same SQL shape but **is not** a complete D1/Worker execution.
- New `tests/mail-draft-lineage.test.mjs` uses Node 22's actual `node:sqlite` implementation, with a D1-compatible asynchronous wrapper, for the same key behaviors including racing requests. It is included automatically by `npm test`.
- Existing `workerd-test/mail-outbox-runtime.test.mjs` now seeds candidate migrations 0005, 0006, and 0007, tests the linked outbox under actual Miniflare/D1, and rejects legacy raw HTTP sends. The existing SMTP synthetic socket test must remain one-shot. These repository tests have **not yet executed** in this environment because the GitHub checkout and npm dependencies cannot be retrieved by the container.
- The existing jsdom browser test now asserts that preparation carries only saved draft ID/revision (no message text) and rejects duplicate revision attempts without SMTP. It remains unexecuted pending exact-head CI/browser acceptance.
- JS module syntax was parsed independently for changed source. This is not the same as test, build, runtime, browser, provider, or release verification.

## Migration and live release gates

`0007` is **not** an automatic migration. Apply only to a separately authorized, backed-up dedicated MAIL_DB after 0005 and 0006 are present, validate schema/index uniqueness and immutable owner rows, then separately run synthetic read/write and cold restore rehearsals before considering any production migration. Historical rows cannot safely be inferred as Sent; never relabel them. Do not delete old delivery tombstones or change existing forwarding to simplify the transition.

The unique index blocks repeated preparation for **the same saved revision**, not deliberate resends from a newly saved revision or mail provider duplicates. Draft-to-Sent provider reconciliation, user-visible Sent state, encryption at rest/application-layer protections for queued plaintext, retention, D1 backup and restore, exact-head CI, real IMAP and SMTP owner identity tests, Access/nonowner controls, iPhone acceptance, and guarded deployment/rollback remain production NO-GO. No DNS, secrets, access, infrastructure, deploy, merge, or real provider send is authorized by this PR.
