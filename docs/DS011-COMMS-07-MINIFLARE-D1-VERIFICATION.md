# DS011-COMMS-07 — Local workerd/Miniflare D1 acceptance

Status: SOURCE-ONLY test harness, no production database, credentials, or deployment. Stacked on draft COMMS-06 PR #24. This increment **does not** make DevonStation email usable.

## Motivation

COMMS-06's D1-like mock proved SQLite SQL logic, but not the actual D1 Workers binding. COMMS-07 adds `workerd-test/mail-d1-runtime.test.mjs` to the repository's existing pinned `miniflare@4.20260730.0` workerd suite. It uses an **ephemeral local-only** `MAIL_TEST` D1 binding and executes the existing, unapplied candidate migration directly in the test environment. It does not add any runtime dependency or modify the production Worker.

The existing `npm test --prefix workerd-test` invocation in `.github/workflows/recovery-server.yml` now runs both the recovered Worker suite and this D1 acceptance suite. The existing CI job also runs that command with a pinned alternate workerd executable and 2026-10-28 compatibility date. Both versions are checked against the **exact PR head**.

## Assertions

- The D1 store fails closed when the mail tables do not exist; migration is explicit and idempotent.
- A real local D1 batch atomically writes revision, cursor and messages; stale CAS cannot change them.
- Two competing writes based on the same revision cannot both commit.
- An intentionally rejected `INSERT` rolls back the earlier CAS and row deletion in the same batch.
- Identical mailbox IDs under separate installations cannot read or alter each other's rows.
- UIDVALIDITY rollover retains previous UID cohorts; SQLite integrity and foreign keys remain sound.
- The test contains only synthetic mail, uses no network, and disposes the local Miniflare instance.

## Verification and release boundaries

Local Node 22 `node --check` and the existing three mail suites (39 tests) are runnable without Miniflare. This development container does not contain the pinned Miniflare dependency and has no outbound GitHub/npm network, so the newly added workerd test **cannot be claimed locally passed**. Accept it only after the GitHub Actions `Recovered server verification` workerd job reports success at the exact head. If that job fails, inspect and fix the test or production adapter rather than skipping the gate.

Miniflare runs the Workers runtime with local emulated D1; it is **not** a remotely deployed Cloudflare D1 database, official backup/restore validation or actual concurrent production workload. Do not apply the COMMS-06 migration to an existing database on the strength of this test. No Production DNS/Access, email routing, mail credentials, API endpoints, IMAP/SMTP, patient data, scheduling or publishing change is authorized by this PR. RB01 cutover remains NO-GO.

Next independent increment: review a **separately owned disposable** D1 binding and recovery/restore; build a real TLS-validated IMAP/MIME plain-text adapter and explicit authenticated mail-read UI before a user-authorized pilot.
