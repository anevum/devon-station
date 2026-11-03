# DS011-COMMS-12 — Owner-scoped durable unsent drafts

**Lifecycle:** ACTIVE implementation, **source-only / draft; NOT MERGED OR DEPLOYED**. Parent is COMMS-11 PR #30, inheriting #29, #27 and the prior Communications / RB01 stack.

## Implemented in the existing DevonStation application

- Introduced `src/communications/mail-drafts.mjs`: dedicated, parameterized D1 draft-store adapter with exact `installationId`, `mailboxId`, and signed Access `ownerSub` scope. No mailbox credentials or outgoing-provider access are used.
- New `worker/migrations/0005-comms-drafts.sql` is a **candidate** migration to a dedicated `MAIL_DB`, not a production migration. It creates separate `comms_mail_drafts` and scoped index. This is not retrofitted into legacy application D1.
- New `worker/mail-drafts-api.mjs` and existing authenticated `/api/mail/` router implement `GET /api/mail/drafts`, explicit `POST /api/mail/drafts/create`, `POST /api/mail/drafts/save` and `POST /api/mail/drafts/delete`. Routes share DevonStation's existing signed JWT-owner gate and same-origin JSON request validation; they independently enforce the exact owner subject and require `MAIL_DRAFTS_ENABLED=true`, `MAIL_DB` and `MAIL_OWNER_SUB`.
- Draft saves are optimistic-CAS via bounded revision and server-side transaction. Retrying the same creation UUID reuses the same draft. A revision-checked save with the same operation UUID replays without a second mutation if payload matches; a stale revision or changed replay returns conflict 409. Delete requires an exact revision.
- A maximum of **20 drafts per owner/mailbox**, max **20 To recipients**, 512-character subject, 32,768-character text body, explicit validation against control/Bidi header injection and recipient duplicates. The `From` identity is the fixed `hello@devonakins.com`. No unverified aliases can be selected.
- `src/mail-drafts-ui.js`, the existing Mail section and styles now expose a private drafts list, explicit New/Save/Delete, editable To/Subject/plain-text Body, conflict and owner-session messaging. The delete control requires explicit confirmation. No send button or send action exists.
- D1 binding for drafts can be configured independently of the IMAP password; the read-only mail status clearly distinguishes inbox connectivity, draft storage readiness and outgoing sending (disabled). When storage is unavailable, drafts are disabled instead of simulated.
- Added Node SQLite-shaped D1 tests, real disposable Miniflare/workerd D1 tests for both pinned compatibility dates, authenticated worker API tests, jsdom UI tests, module-allowlist/release graph updates and privacy/release checks. All messages, identities and credentials in tests are synthetic.

## Security and release gates — NOT SATISFIED

**DO NOT** apply migration 0005 to live data without an approved isolated D1 database, scoped Access principal confirmation, backup/restore test, retention policy and incident/rollback procedure. This revision stores draft contents as **plaintext inside D1** and does not yet implement application-level content encryption, retention deletion scheduling, historical revisions or actual mailbox synchronization verification. A reviewed private-data retention/encryption decision is required before real personal messages are saved.

The system does **not** send email: no SMTP socket, no relay credentials, no provider grants, no queue or send endpoint; message authoring must not be confused with delivery. Live Purelymail login, owner/nonowner production Access, multi-mailbox switching, MIME attachment download, folders and search, threading, drafts-to-Sent reconciliation, real authorized send/reply round trip and Cloudflare production deployment remain unverified/unimplemented.

No DNS/MX, Cloudflare Email Routing, Anevum forwarding, paid services, real outbound test emails, production D1 migrations, Access grants, secrets or release settings were changed.

## Verification procedure

- `npm test` verifies draft store, owner HTTP behavior and existing communications regressions.
- `npm ci --prefix workerd-test --ignore-scripts --no-audit --no-fund && npm test --prefix workerd-test` exercises actual isolated D1 with both pinned compatibility runs.
- `npm run build && npm run verify:privacy && npm run test:runtime:dom` verifies the integrated UI and reviewed 38-module Worker bundle.
- `node tools/prepare-rb01-review.mjs` checks exact-head source, guarded Access hash, fallback and canonical manifest. All checks must independently pass exact-head GitHub Actions before any merge.

**Next engineering increment:** complete IMAP interoperability and full-fidelity message/attachment handling, add production-grade outbound SMTP with authenticated sender permissions and idempotent delivery-state reconciliation, and verify the mail stack in isolated Cloudflare Workers before requesting approval for an exact-impact production release.


## Continued verification — November 3, 2026

- Reconciled #30 at `12f2d7f77d4b565016d879fdb71b897a9312a787` and #31 at `76d9412fa12f016e6dcdbf8de6e4956812eb5481`. The PRs remain draft and stacked correctly. Their PR-triggered workflows were queued at inspection, not passing; no checks were restarted.
- Reproduced a draft DOM harness failure: the disabled-drafts test unnecessarily created and immediately closed a second enabled-drafts window while its status request was pending. Removed only that unrelated fixture. All disabled-feature, conflict, inert-content and no-send assertions remain intact.
- Bounded IMAP interoperability increment: parse exactly one complete FETCH frame, accepting UID, FLAGS and INTERNALDATE before or after its literal in all 24 requested-field orders. Require each requested attribute exactly once, complete closure and matching literal length. Preserve hard message/line/reply bounds, pinned TLS and read-only commands. Close the socket after exchange failure so a partially consumed frame cannot be reused.
- Regression coverage includes fragmented wire data, empty flags, duplicate/unknown fields, premature tagged completion, closure injection, owner HTTP error redaction and unchanged D1 state/cursor after rejection. The new complete owner-handler → synthetic socket → MIME → actual local Miniflare D1 test verifies both rejection and successful retry with isolated data. Handler/socket execution is in Node; D1 is real local workerd, not a provider or deployed Worker acceptance test.
- Local verification: 281 Node tests, 35 foundation tests, all runtime DOM suites and 18 workerd/D1 tests on each pinned compatibility run (2026-07-30 and 2026-10-28) passed. The integrated build produces 38 Worker modules / 7 assets; source privacy checks pass. Local Node is v24.22.1; GitHub's pinned Node 22 verification remains a separate gate.
- Chromium browser verification is pending: no browser executable is installed, and the Playwright download returned invalid/truncated archives. Runtime DOM checks passed; they do not replace Chromium or real iPhone acceptance.
- Protocol references: [IMAP4rev1 FETCH response](https://www.rfc-editor.org/rfc/rfc3501#section-7.4.2) and [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/). This remains a deliberately restricted FETCH subset, not a general IMAP parser or evidence of real Purelymail delivery.

Production remains **NO-GO**. No DNS, forwarding, Access, secrets, production data, real mailbox contents or deployments changed. SMTP stays absent/disabled. The next bounded implementation should address bounded incremental UID SEARCH interoperability (including an empty polling result after the highest UID), followed by authorized isolated real-provider acceptance. Full-fidelity storage, vendor-archive integrity, retention/backup and release gates above remain open.

## Incremental polling verification — November 3, 2026

- Reproduced four new failing regressions before implementation. Replaced `UID SEARCH UID next:*` with `UID SEARCH UID next:4294967295`, avoiding IMAP's reversed wildcard range semantics while retaining strict rejection of stale, duplicate, malformed and oversized search responses. Reference: [RFC 3501 §6.4.8](https://www.rfc-editor.org/rfc/rfc3501#section-6.4.8).
- Provider and wire transport enforce nonzero unsigned 32-bit UIDs; cursor high-water marks may also be zero for an empty cohort. SEARCH and FETCH command validation reject out-of-range IDs before network writes. At the UID ceiling, EXAMINE still detects UIDVALIDITY changes, but a stable cohort performs no SEARCH/FETCH. A changed cohort restarts at one.
- Ten sequential owner HTTP → fragmented synthetic IMAP → MIME → real local Miniflare D1 cases verify empty initial/idle results, sparse arrivals, stale/duplicate rejection, empty/new UIDVALIDITY cohorts, ceiling exhaustion and reset. Existing message cohorts remain intact; rejected replies preserve the entire snapshot. Successful idle polls retain records/cursor and still increment the existing CAS snapshot revision; this does not introduce no-op storage semantics or message deletion/flag synchronization.
- Local verification passed: 285 Node tests, runtime DOM suites, 29 real local workerd/D1 checks per pinned July 30 and October 28 compatibility run, integrated build (38 modules / 7 assets) and privacy checks. The application/transport execute in Node against synthetic socket responses; only D1 executes in workerd. No real Purelymail/provider or deployed Worker claim is made.
- Chromium and authentic owner-device/provider acceptance remain pending under the earlier recorded environment and approval gates. Exact-head GitHub CI must pass independently; the previous head's workflows were still queued at session start. No reruns requested, production changes, live mail access or SMTP action occurred.

**Next bounded implementation:** safe bounded SEARCH pagination for mailboxes exceeding the current 500-result cap. The existing 10-message FETCH, 256 KiB wire-message, 4 KiB indexed-text, full-fidelity-storage, retention/backup, upstream MIME archive-integrity and production approval gates remain unchanged. This increment remains source-only and NOT LIVE.
