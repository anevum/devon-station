# DS011-COMMS-68 — Integrated email candidate with receipt-backed Sent

November 6, 2026. Source implementation; not an acceptance activation or production release.

## Release dependency resolved

Migration 0009 is **not required** for Inbox, encrypted Drafts, explicit guarded SMTP submission, reply/forward, or receipt-backed Sent history. The send path enqueues a saved draft, claims it once, submits SMTP, and persists an accepted receipt using 0005–0008. It never reads the archive table. Existing retention refuses to erase any terminal payload when archive schema is missing; when available it requires a byte-identical archive for accepted payloads. No background retention runs.

The old Sent UI always queried `comms_sent_archive`, so its content/history depended on 0009 even though send did not. New owner-only `GET /api/mail/outbox/accepted`, `POST /accepted/page`, and `POST /accepted/view` read permanent accepted outbox receipts and their encrypted snapshots. They exclude unlinked/queued/claimed/uncertain sends. Metadata pages contain no subject, addresses, or body. History pages independently of the pending-first 100-receipt status list. Bodies decrypt only on explicit request. If deliberate retention has scrubbed the original snapshot, the existing validated archive reader supplies the copy. Missing keys or corrupt ciphertext fail closed; they never trigger a fallback transmission.

The UI uses these routes for Sent. It says SMTP accepted, with recipient delivery and provider Sent copies unconfirmed. Migration 0009 and its independent backup/recovery/authorization prerequisites remain intact for the separate permanent archive. Existing archive endpoints and cleanup checks are unchanged. This separation removes a schema dependency; it does not establish disaster recovery or authorize a release.

## Integrated branch

Continue existing PR #44 / `feature/ds011-comms62-inbox-page-filter`. Its ancestry includes PR #36, #42 offline recovery, #43 reply routing and threading, #44 page search, trusted main (merged #41), and #45 read-only release checks. Source conflicts in uploader/workflow/tests were resolved using trusted main's reviewed immutable SHA/digest pins and external Action pins. No protected/main branch or PR was merged through GitHub. Existing stacked bases and history remain preserved.

The prior inactive approved PR #36 candidate remains a different build. Its upload approval cannot be reused for this new candidate. The privileged workflow still pins PR #36 and must not be dispatched with this new source. Prepare separately reviewed source/digest pins in trusted release tooling before any new upload, after source CI and owner approval. The unchanged readback verifier intentionally still describes the old inactive version.

## Capability evidence

| Capability | Integrated source and synthetic checks | Current real-service evidence |
| --- | --- | --- |
| Inbox sync and read | Bounded IMAP/MIME, encrypted cache, reload and duplicate protection | Prior acceptance receiving documented; not retested this session or on this new candidate |
| Draft save/edit | Encrypted durable revisions, conflict/lock protection | Historical acceptance drafts; this candidate not activated |
| Guarded send | Saved-draft preparation, owner confirmation, single claim, accepted/uncertain distinction | Prior single accepted message documented; not resent |
| Reply/forward | Validated Reply-To, In-Reply-To/References, inert text-preview forwarding | Synthetic coverage; current live version lacks newer work |
| Search | Current loaded page only; preserves edits and conceals filtered reader | Synthetic browser/DOM; not acceptance-live |
| Sent | Accepted outbox metadata/paging + encrypted copy; works without 0009 | New source-only behavior; not verified against actual mail records |
| Permanent archive | Existing encrypted archive/receipt/retention guards retained | Migration 0009 unapplied; not authorized |
| iPhone Safari/PWA | Mobile-width Chromium and accessibility checks | Physical-device acceptance incomplete |

## Verification and limitations

- Application suites include pre-0009 Sent reads through a fresh store, draft deletion, retention refusal, all nonaccepted exclusions, owner isolation, 106 accepted records while 100 unresolved records crowd the status list, strict API requests, missing-key/corruption failures, and post-retention archive reads.
- Native Miniflare D1 integration checks the existing guarded HTTP SMTP path using synthetic sockets, then reads accepted metadata/body with sending off, without archive schema or a second socket/data write.
- Actual hosted-shell Chromium checks at 1440, 390 and 320px read the accepted copy after reload, preserve one synthetic SMTP attempt, reject a second signed subject, and check overflow/accessibility. These are not physical Safari or real SMTP.
- List metadata validates receipt structure, not decryption/delivery of every message. Opening verifies encrypted contents. Administrative SQL corruption and off-provider disaster recovery are not solved by a Sent list.
- This candidate uses the existing schema through 0008. No real database migration, credential/Access/DNS change, email, Worker upload, activation, or production change is part of this increment.

## Observed deployment anchors

Read-only Cloudflare inspection reconfirmed acceptance `99577640-1f02-446f-8d38-88f723f51f82` → `c31f8bd4-283d-457c-9779-87605927eec4` at 100%, and production `890cc9d9-533b-4b9a-b326-26a7c4f88402` → legacy `ce64277b-124b-4177-825a-8b51d997152b` at 100%. Both send and sender-verification flags remain false. Version 15 `523569b4-38d9-4cab-acbd-e84dd22a59aa` retains source `bba373f35f3cc913447e72fcdfff589cd6f3a073` and no serving traffic. Four distinct D1 bindings remain unchanged.

## Release disposition

**SOURCE CANDIDATE ONLY / ACCEPTANCE AND PRODUCTION NO-GO.** No claim that daily email is live. Outstanding: new exact-head CI/review and source/build pins, independent off-provider encrypted recovery with complete historical keys, scoped new-candidate inactive upload/activation approvals, genuine signed owner/nonowner Access acceptance, controlled provider-failure checks, physical iPhone Safari/PWA, and separate production approval. Migration 0009 is optional to the initial functional candidate, not a prerequisite to its accepted-receipt history. Do not repeat the prior historical test transmission.
