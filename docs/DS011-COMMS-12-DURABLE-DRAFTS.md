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

## Bounded large-mailbox catch-up — November 3, 2026

The previous next task (SEARCH pagination) is implemented. EXAMINE must provide exactly one valid UIDNEXT, as required by RFC 3501 §§6.3.2/2.3.1.1. Each sync searches at most sixteen inclusive 256-UID ranges, all below the observed UIDNEXT. Both SEARCH endpoints are validated; the wire transport rejects reversed, wildcard, oversized or out-of-protocol ranges. Existing raw-response/result limits remain intact rather than being raised for large inboxes.

A trusted `scannedThrough` watermark extends the existing provider batch contract; reconciliation validates it against fetched UIDs, prior cursor and protocol limits. It advances the existing cursor only in the same atomic D1 CAS as the indexed messages. Partially consumed ranges stop at the last selected UID. Empty ranges can advance safely below UIDNEXT; future arrivals are not skipped. Missing FETCH results now reject the whole batch, including messages expunged between SEARCH and FETCH; retrying performs a fresh search. This intentionally favors retry over silently skipping a missing message.

Verification: 289 Node tests and 35 foundation tests, full runtime DOM suites, 33 actual local workerd/D1 checks per pinned July/October compatibility run, 38-module/7-asset build and source privacy checks passed. A synthetic 601-message inbox drains in order across 61 ten-message polls using real Node SQLite, with no duplicate imports or omitted UIDs. Four additional owner-handler/synthetic-wire/real-local-D1 scenarios persist capped empty-range progress over multiple polls and then fetch a later arrival. Handler/transport run in Node; these remain synthetic provider tests, not live Purelymail or deployed Worker evidence.

No schema migration is added. `highestUid` now also represents safely scanned historical empty UID space. All pre-existing retention, storage-size (5,000 indexed records / 4 KiB text), mailbox identity, MIME integrity, real browser/provider, exact-head CI and production approval gates still apply. No production, mailbox, forwarding, Access, secrets or SMTP action occurred.

Next bounded implementation: explicit catch-up progress and cancellation in the existing Mail UI, so users can distinguish one completed batch from a fully caught-up inbox. No automatic background mailbox polling is introduced by this increment.

## Explicit catch-up controls — November 3, 2026

The Mail UI now distinguishes a single sync batch from an explicit user-started catch-up run capped at ten batches. Trusted provider `hasMore` metadata is validated before the existing CAS and returned only after commit; absent metadata remains unknown (`null`) for legacy adapters, and the client refuses to auto-continue without a boolean. The Purelymail adapter always supplies the flag relative to its checked UIDNEXT snapshot.

The UI displays confirmed batch/import counts, remaining catch-up work and snapshot-qualified completion. Stop After Batch and navigation stop subsequent POSTs after the in-flight batch settles; this does not abort/undo a database commit. Interrupted or malformed responses retain confirmed counts and explicitly warn that an unconfirmed request may have committed. Reload Cached Inbox performs authenticated GETs only. Session expiry stops continuation and removes cached messages from view. No automatic/background polling, SMTP action or new persistence is added.

Passed locally: 291 Node tests, 35 foundation tests, 33 actual local workerd/D1 checks per pinned compatibility run, full runtime DOM suites including 12 mail UI cases, integrated 38-module/7-asset build, privacy and diff checks. UI cases cover explicit initiation, snapshot completion, ten-batch cap, stop during pending request, navigation, partial failure, malformed continuation, expired owner session and safe cached reload. Actual Chromium/mobile/device layout remains pending under the recorded browser-download blocker; DOM tests are not visual acceptance. No live provider, production or release approval claim.

Next bounded task: inbox pagination in the existing reader, exposing indexed messages beyond the current first 50. All earlier production, retention/backup, full-fidelity-storage, MIME integrity, real-provider and exact-head CI gates remain in force.

## Revision-pinned cached inbox pages — November 3, 2026

The existing reader now exposes Older/Newer controls, exact message ranges and 50-message pages. It keeps only the current page in memory. Page GETs carry the snapshot revision obtained from the first page. The existing single-SELECT D1 snapshot makes revision checks consistent: a changed index returns 409, retains the visible page and disables further paging until cached reload or successful sync. Reload/sync returns to the newest page. No page action opens IMAP or modifies provider flags/messages.

Responses must match requested offset, 50-item limit, revision and expected row count. Invalid responses/network failures retain the previous page; owner-session expiry clears cached rows and selection. Page and sync requests serialize through the existing busy guard. New pager controls use native disabled buttons, an accessible navigation label, wrapping layout and minimum 44-pixel height; actual Chromium/mobile layout acceptance remains pending.

Passed locally: 292 Node tests, 35 foundation tests, full runtime DOM suites including 17 Mail UI cases, and 34 real local workerd/D1 checks per pinned compatibility date. A 123-message local D1 index is read across three owner HTTP pages, without duplicates/omissions, then rejects an old revision after a concurrent index commit. Invalid revision tokens, other-owner denial, stale/malformed UI pages, session expiry, request serialization and post-sync reset are covered. Build remains 38 Worker modules / 7 assets; privacy/diff checks pass. No provider socket is used by pagination tests.

Capacity clarification: the generic service/Node SQLite contract allows up to 5,000 records, but the actual D1 adapter intentionally remains capped at **500 records and 256 KiB serialized snapshot payload**. Earlier 601-message drain evidence used Node SQLite, not D1. This pagination change does not raise either D1 cap or alter retention. No production data, DNS/forwarding, Access, secrets, mailbox contents, deployment or SMTP action changed.

Next bounded release task: isolated backup/restore rehearsal for inbox and unsent drafts, using synthetic data only. Existing exact-head CI, browser/provider, MIME archive-integrity, full-fidelity storage, retention/encryption and production approval gates remain open.

## Isolated mail cold-recovery rehearsal — November 3, 2026

Added `workerd-test/mail-recovery-runtime.test.mjs` to the normal pinned-runtime test command. It uses only synthetic records and temporary file-backed Miniflare D1, closes the runtime before copying all persistence files (including SQLite sidecars), records/reloads a SHA-256 manifest, and restores only into a fresh persistence directory. There is no production restore endpoint or new application capability exposed to users.

The rehearsal preserves every row of the inbox, mailbox cursor/revision/retry state, owner-scoped drafts and an unrelated sentinel table. It verifies two installations and two draft-owner subjects, retained UIDVALIDITY cohorts, an empty-space scan watermark, exact successful save replay, altered-replay/stale-write denial, a new post-recovery save and a second process/runtime restart. Source data deliberately diverges after backup to prove the restored point is independent. Corrupt backups fail before target creation; interrupted copy removes only the fresh target; existing targets are refused without changes.

Integrity checks run on a disposable clone: even read-only SQLite access can update shared-memory sidecars. The original backup's complete file fingerprints remain unchanged throughout. All copied SQLite databases pass `integrity_check` and `foreign_key_check`; exactly one contains the application mail tables. The manifest detects accidental corruption; it is not a signature or encrypted backup format. All temporary state is removed in cleanup, with dependent phases failing fast.

Passed locally: 292 Node tests, 44 actual local workerd/D1 checks on each pinned July 30/October 28 compatibility run, integrated 38-module/7-asset build and privacy/diff checks. The ten new counted checks are the recovery suite plus its nine phases. No application source or production settings changed.

This is **local, quiesced, version-pinned Miniflare persistence recovery**, not Cloudflare-hosted D1 export/Time Travel, online backup, live owner recovery, approved encryption/retention, or a production disaster-recovery procedure. Exact-head CI, provider/browser acceptance and the existing release approvals remain open. No production database, mailbox, DNS/forwarding, Access, secrets, service deployment or SMTP action was touched.

Next priority: diagnose the persistent GitHub Actions queue so independent exact-head CI can execute before further release integration.

## CI queue diagnosis and component lifecycle safeguards — November 3, 2026

Observed repository Actions inventory reported 24 in-progress / 121 queued runs. Its returned active entries included 19 older COMMS-11 foundation runs. Two inspected browser jobs were still inside `node browser/workspace-component-check.cjs` more than two hours after starting; other jobs in those runs had passed. This establishes stuck browser jobs contributing to runner pressure, not a billing diagnosis or proof that every queued run has the same cause. In-progress job logs were unavailable from GitHub at inspection.

The harness's ordinary `server.close()` can wait indefinitely for an unfinished HTTP response before reaching Miniflare disposal. Added a tested local-QA lifecycle helper that closes remaining HTTP connections, attempts runtime disposal independently and reports cleanup failures. Setup failures dispose the runtime; per-viewport teardown attempts all resources. A 120-second process watchdog fails stuck QA; all existing browser/security/accessibility assertions remain unchanged. Both workflows retain all jobs and triggers, gain 15-minute job timeouts and workflow/event/PR-or-ref-scoped concurrency cancellation for superseded runs. The component step also has a five-minute timeout. These safeguards apply to future runs using this source, not already running old definitions.

Passed locally: 295 Node tests (including native pending-HTTP teardown, disposal-failure and watchdog-child regressions), 35 foundation tests, YAML parsing/timeout validation, browser-script syntax, unchanged 38-module/7-asset build and source privacy/diff checks. Full Chromium component acceptance remains pending because this runtime lacks its browser executable; no passing browser or exact-head CI claim is made. The application/Worker bundle is unchanged.

Run `41630316056` at superseded head `979c02717eb7d265719c3f3f841f02c0c64951aa` was requested cancelled through GitHub UI and visibly verified Cancelled. Automatic approval review rejected the next cancellation batch, stating that diagnosis/code changes did not authorize cancelling those specific active workflow runs. No workaround or further cancellation was attempted. Current #30/#31 heads and all production/mail infrastructure remain untouched by cancellation.

Remaining identified superseded COMMS-11 run IDs awaiting explicit approval (revalidate status/head before action): `41630294144`, `41630281730`, `41630273548`, `41630275280`, `41630268007`, `41630263631`, `41630262172`, `41630257613`, `41630253528`, `41630074875`, `41630043743`, `41629988180`, `41629953001`, `41629937300`, `41629883855`, `41629879394`, `41629850507`, `41629805353`.

Next gate: explicit approval to cancel these obsolete runs, preserving the current #30/#31 checks, then observe exact-head execution and resolve any actual failure. No merge, deployment, DNS, Access, credentials, production data or SMTP change occurred.
