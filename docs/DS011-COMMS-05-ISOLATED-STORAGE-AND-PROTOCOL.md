# DS011-COMMS-05 — Isolated SQLite store and restricted IMAP commands

**Status (November 2, 2026): SOURCE-ONLY / SYNTHETIC / NOT DEPLOYED.** Stacked on COMMS-04 draft PR #20, then COMMS-03 #19, MAIL01 #18 and RB01 #8.

## Added

1. **mail-sqlite-store.mjs** implements COMMS-04's readSnapshot/commitSnapshot interface with explicit, additive SQLite tables (comms_ro_mailboxes and comms_ro_messages). Each mailbox is addressed by installation ID and mailbox ID. One BEGIN IMMEDIATE transaction verifies the expected revision and replaces rows and cursor together. A stale revision returns a conflict without changing state; a failed statement rolls back. SQL input is parameterized. Schema application is explicit, never automatic.
2. **mail-imap-readonly.mjs** composes a restricted Purelymail protocol boundary using a trusted injected connector. Fixed incoming host imap.purelymail.com, TCP 993, mandatory verified TLS. It constructs only EXAMINE INBOX, bounded UID SEARCH and UID FETCH with BODY.PEEK. It never constructs SELECT/STORE/EXPUNGE/APPEND or SMTP commands. Bounded UIDVALIDITY, UID, reply and membership validation is included; aborted late-open sessions are closed. This is **not** a socket connector, authentication or MIME parser.
3. **mail-comms05.test.mjs** tests SQLite compare-and-swap, transactional rollback, installation isolation, malformed IMAP results and a synthetic end-to-end read-only poll composed with the COMMS-03 registry and COMMS-04 orchestrator.

## Verification and boundaries

The focused committed test suite runs with Node 22: node --test tests/mail-comms05.test.mjs. An additional local engineering suite tested broader SQL retention, file reopen, reset, protocol and malicious input scenarios; those expanded local-only tests are not included in this PR. The exact commit's CI is the authority for repository-wide checks.

This is not production Cloudflare D1. Node 22's node:sqlite is experimental; a separate D1 storage adapter must be designed and validated with a reviewed isolation migration, backup and restore. A shared DatabaseSync connection must not concurrently host unrelated transaction managers. Mail storage has a bounded 5,000-message snapshot rewrite and no approved retention or deletion lifecycle.

The injected connector must separately enforce real TLS identity, scoped secret custody, tagged IMAP completion semantics, RFC-conformant framing and literals, bounded MIME decoding of text/plain, message-size limits and reliable cancellation. **No live connection or credentials are present.** The new UID scan does not reconcile flags or deletions of old messages; those require independent reviewed logic.

Inbound mail content remains untrusted. No AI agent actions, link following, remote image loading, sending, SMTP, mailbox migration, public API, database deployment, cron, secrets provisioning, new billable resources or provider routing changes occur in this PR. Preserve the Anevum Cloudflare-to-Gmail forward and all owner login/recovery channels.

Before live use: independently verify Purelymail receive/reply/send, safe server-side credential and Access identity mapping, named owner/nonowner denial, authenticated D1 transaction and recoverability tests, production config parity, explicit approval and rollback. RB01 release remains NO-GO.
