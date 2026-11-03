# Communications: encrypted storage and integrated acceptance

November 3, 2026. Continues PR #36 on its existing branch, preserving the full stacked implementation. **Source implemented; release NO-GO.** No real message has been sent or received through this candidate. No application deployment, production migration, credential activation, routing change, or existing CI cancellation is authorized by this document.

## What changed

- Server-only AES-256-GCM envelopes, independent 96-bit random nonces, authenticated purpose/installation/mailbox/owner/record identity, strict version/size/encoding checks, sanitized errors, and up to four explicitly retained rotation keys. Encrypted readers never fall back to plaintext.
- Inbox sender/subject/body are encrypted in `body_text`; sender/subject columns are empty. Draft recipient/subject/body are encrypted together in `recipients_json`; subject/body columns are empty. Outgoing immutable snapshots are encrypted in `payload_json`. Existing SQL schemas and migration history are preserved; JSON/length constraints remain enforced. Metadata (identifiers, timestamps, flags, receipt state) remains readable.
- All authenticated incoming/draft routes require valid encryption configuration. Preparation and SMTP activation also fail closed without it. Secret key material is never included in a client response or build asset. Direct legacy adapters remain available for historical synthetic tests; authenticated routes always select the cipher.
- Encrypted draft-to-outbox preparation decrypts/compares the trusted saved draft, then atomically pins its exact ciphertext and revision in `INSERT SELECT`. Unique delivery lineage, immutable saved-draft guards, one claim, and no automatic retry remain intact.
- Explicit terminal-payload expiry accepts only a cutoff at least 30 days old. It clears accepted/rejected/failed payloads while retaining receipts and unique draft tombstones. Queued/claimed/uncertain payloads are never expired. This is a maintenance method, not an enabled scheduler or public purge endpoint.
- Fixed three incomplete SQLite D1 test adapters that lacked unbound `first()`. The old exact source failed four tests before this correction; production safeguards were not weakened.
- Added native Workerd encrypted persistence/restart/tamper tests and a signed hosted-shell Chromium mail test at 1440, 390 and 320px. Test socket streams are explicitly synthetic; they never open a network connection.
- New workflow runs use their own concurrency group and do not automatically cancel existing runs. Feature push duplication remains disabled. This preserves the owner's explicit cancellation approval gate; it does not clear the existing queue.

## Secret and recovery requirements

`MAIL_PAYLOAD_KEY_ID` identifies the active key. `MAIL_PAYLOAD_KEYS_JSON` is a Worker secret containing a JSON map of key IDs to canonical base64 32-byte random keys. No real value has been generated or installed by this change. Retain old keys until every retained row and backup has been deliberately migrated or expired. Key loss makes its encrypted content unrecoverable. Keep recovery keys separately from database backups, in owner-controlled secure storage.

This is server-side encryption for database exports/backups, not end-to-end encryption: the authorized Worker can decrypt content; the provider still receives mail normally. A compromised Worker plus its secrets is outside this protection. Never log bodies, recipients, ciphertext envelopes, passwords, keys, or authentication headers.

Older plaintext rows are deliberately rejected, not silently converted, deleted, or resent. A fresh isolated mail database is the preferred first activation target. Any existing mail dataset needs a reviewed, separately authorized conversion with recoverable backup. `0007` contains one-time `ALTER TABLE` statements and must be applied exactly once; do not rerun the entire migration directory blindly. Use the actual applied schema/migration ledger to select pending files.

Restore into an isolated target with `MAIL_SEND_ENABLED` disabled. A historical backup cannot establish whether an email was sent after that backup. Before enabling sending, reconcile every restored queued/claimed/uncertain delivery against retained receipts/provider evidence and obtain explicit owner approval. Restoring a backup must never be used to grant a new send attempt.

## Executed evidence

Local tests run against the actual combined checkout, not disconnected examples:

| Check | Observed result |
| --- | --- |
| `npm test` | 355 tests passed on both Node 22.16.0 and Node 24.22.1, including crypto, actual SQLite, IMAP/SMTP socket fixtures, authorization and migration/recovery cases |
| `npm test --prefix foundation` | 35 tests passed |
| `npm test --prefix workerd-test` | 53 passed, 0 failed, including native encrypted persistence/restart/tamper tests |
| October replay: workerd `1.20261030.1`, compatibility `2026-10-28` | 53 passed, 0 failed, including encryption executing inside the Worker |
| `npm run build` / `npm run verify:privacy` | 43 Worker modules, seven assets; generated/public-source privacy checks passed |
| `npm run test:runtime:dom` | Existing runtime/recovery checks and 17 inbox, 3 draft, 11 send DOM tests passed |
| `DS_CHROME=... npm run test:runtime:browser` | Original signed workspace/recovery browser checks plus new mail flow; desktop/mobile sizes exercised locally |
| New `tools/runtime-mail-browser.cjs` | Each of 1440/390/320px: incoming read, saved draft/review, dismissed confirmation makes no send, one synthetic SMTP submission, accepted distinct from delivered, refresh + explicit history retrieval, nonowner 403, zero external fetch calls, zero overflow/page errors, zero serious/critical WCAG 2 A/AA mail-region violations |
| `DS_CHROME=... npm run test:browser` | All six existing Python/Chromium application, conflict, backup, cross-tab and diagnostics scenarios passed |

Browser tests used temporary Chromium 153.0.8010.0 installed outside the repository; no browser dependency or binary was added to the application. These are Chromium viewport tests, **not physical iPhone/Safari/PWA acceptance**.

### Hosted isolated Cloudflare D1 rehearsal

A new, unbound synthetic-only database was created for this task: `devon-station-comms-synthetic-acceptance-20261103`, ID `b9daf5aa-7cf6-451c-8b1f-e9f7daedae22`. It is separate from production `devon-station-private` (`d26bcc9b-229e-4af7-a1f9-7f229e9a40d8`) and has no Worker binding or credentials.

Applied exact candidate migrations 0004–0008 to that empty test database after seeding an unrelated sentinel. Stored synthetic AES-GCM draft/outbox envelopes and a claimed receipt. A competing delivery for the same draft at revision 3 inserted zero rows, preserving the original claimed receipt. Owner-scoped foreign query returned zero rows.

Baseline bookmark: `00000000-0000000a-00005118-568de743287b6642e8238e2107d120f4`. Seeded bookmark: `00000000-00000012-00005118-db953f384901eace6bccd54a0f547e0b`.

Actual Cloudflare Time Travel rollback to baseline returned one preserved sentinel and zero Communications tables. Roll-forward to the seeded bookmark recovered the exact ciphertext bytes and nonretryable claimed receipt, with zero foreign-owner rows. This is real hosted D1 schema/constraint/Time Travel evidence, **not a production-data restore or signed hosted email trial**. `PRAGMA integrity_check` is unavailable through this D1 API; local native SQLite integrity/recovery tests are separate evidence. Reapplying 0007 correctly failed at an already-existing column; it is a one-time migration, not idempotent directory replay.

The disposable synthetic database was deleted after verification. No test binding, real message, credential, or persistent test resource remains.

## Current production and CI evidence

Production Worker `devon-station` remained version `5e2357ad-376d-49f0-ada3-eb0cfc8a73c4` at 100%, with no `MAIL_` bindings. The real production D1 schema has owner state, push and portfolio tables, no Communications tables. Access includes `ds.devonakins.com` and the Workers hostname; its allow policy names the existing owner email. Real signed owner/nonowner sessions remain unverified.

DNS already points MX to `mailserver.purelymail.com`, with Purelymail SPF/DKIM/DMARC records; Cloudflare Email Routing is disabled. No DNS change is proposed. DNS does not prove that `hello@devonakins.com` exists or that provider credentials work. Provider administration currently presents a sign-in form; no authenticated provider session or usable mail credentials were available.

PR #36's original exact-head workflows `41705458712` and `41705458747` were queued with runner ID 0 and no steps. Inspection also found 19 older in-progress foundation workflows, including `41630462752` browser job `125898399005` stuck at workspace-component checks; the repository queue contained 230 runs at inspection. This shows runner/scheduling backlog, not an application-test result or proof of a billing problem. No run was cancelled. Current branch already has bounded component lifecycle/deadline safeguards; historical executions cannot be fixed by changing their source.

## Minimum release acceptance ledger

| Owner criterion | Evidence/status |
| --- | --- |
| Sign in to live site | Access configuration inspected; authentic sign-in not exercised |
| Real inbox and externally generated incoming message | Not verified; provider account/credentials and approved activation required |
| Open/read real message | Signed synthetic browser + encrypted D1 passed; no real mail read |
| Compose/submit real email | Source/browser path passed with synthetic sockets; real send disabled/unactivated |
| Controlled destination receives outgoing message | Not verified; explicit test-send approval and recipient-side evidence required |
| Correct delivery state | Local/native tests separate accepted, failed, uncertain and recipient delivery; real outcome unknown |
| Refresh preserves history | Signed hosted-shell local browser passed with encrypted SQLite and explicit history retrieval |
| Desktop/mobile | Chromium 1440/390/320 passed; physical iPhone Safari/PWA pending |
| Security/backup/rollback/tests | Local/native plus hosted isolated D1 evidence above; exact-head GitHub CI and real identity/provider gates pending |

No stack merge or application deployment has occurred. Remaining gates: provider sign-in/account verification, secure IMAP/SMTP credential provisioning and separately approved activation, exact-head CI, provider Sent reconciliation, independent recovery-key/backup procedure, native iPhone acceptance, release/source parity with current production assets, and explicit deployment/test-send authorization. Existing 4,096-character indexed-body / 500-record / 256 KiB snapshot and 20-draft / 100-receipt limits also require deliberate review; large mail currently fails safely without advancing the cursor. This is not yet the full mail client or the verified live MVP.
