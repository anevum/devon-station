# DS011-COMMS-06 - source-only Cloudflare D1-compatible mail store

Status: SYNTHETIC / SOURCE-VERIFIED only. NOT MERGED, DEPLOYED, OR ATTACHED TO A REAL D1 DATABASE.

## Increment

- `src/communications/mail-d1-store.mjs` implements the COMMS-04 `readSnapshot` and `commitSnapshot` contract over a Cloudflare D1 Workers Binding-shaped `prepare`, `bind`, `all`, `first`, and `batch` interface. It never creates tables, accepts user-owned provider callbacks, sends messages, or controls credentials.
- `worker/migrations/0004-comms-ro-mail.sql` is a **candidate**, unapplied, additive migration for two mail-only tables. It includes an operation marker to distinguish a truly stale CAS conflict from a successful transaction whose acknowledgement was lost. All mail keys include both installation ID and mailbox ID. Foreign keys must remain enabled.
- `src/communications/mail-sqlite-store.mjs` only exports its existing validated row/cursor contract so D1 and SQLite adapters share input validation. No behavior change in the SQLite reference store.
- `tests/mail-comms06-d1.test.mjs` runs a D1 API-shaped double with **real disposable SQLite transactions** under Node 22. It verifies missing-schema denial, schema idempotency, scoped read, CAS, rollback on SQL failure, lost acknowledgement recovery, installation isolation, UIDVALIDITY reset, SQL injection resistance, size constraints, corrupt row rejection, file reopen, and composition with COMMS-04 read-only orchestration.

## Explicit guarantees and caveats

- D1 `batch([...])` is documented by Cloudflare as atomic. Three bound prepared statements in **one batch** perform conditional revision CAS, deletion of this mailbox's old indexed rows, and replacement from a bounded JSON array. The first statement raises a constraint violation for a stale or missing expected revision; it is not a conditional update whose zero-change result could accidentally permit downstream writes.
- A trusted server-generated operation UUID is written in the same transaction. If the acknowledgement is lost, a scoped primary read checks whether **this** operation committed; only a matching marker plus expected next revision is treated as success. Other advanced revisions are conflicts, not proof of this operation's success. Unknown outcomes fail closed and are never blindly retried.
- A **single LEFT JOIN SELECT** reads the mailbox revision/cursor and its rows consistently, and validates the normalized stored data before returning it. No dynamic SQL identifiers, unbound values, cross-tenant joins, or arbitrary user-supplied table names.
- Each snapshot is currently capped at **500 messages** and **256 KiB serialized**. This is intentionally stricter than the COMMS-04 generic 5,000-record in-memory maximum. Real retention, incremental storage and paging must be approved and built before the cap is reached; failed oversized snapshots do not alter the cursor.
- Tests use **Node's experimental SQLite** and an in-process D1 binding double. They do NOT demonstrate real Cloudflare D1 `batch` parity, remote D1 consistency/availability, tenancy under actual sessions, actual database backups, or provider delivery. Do not deploy or apply the migration based only on these tests.

## Production gates

1. Keep the migration unapplied and review the schema with the actual owning installation, database binding, access model, backup/export, restore and rollback plan. Separate legal-entity/client installations should have independent databases and credentials; a composite installation/mailbox key in one test database is **not** by itself an authorization boundary.
2. Test this same adapter with disposable isolated Cloudflare D1 and its official Worker API, including concurrent revision conflicts, interrupted batch acknowledgement, `PRAGMA foreign_key_check`, close/reopen, authentic export and restore. Do not use real inbox data during these tests.
3. Implement and independently verify a real TLS-validated Purelymail IMAP connector, bounded RFC-compliant MIME text/plain decoding, credential custody, server-side Access principal mapping and owner/nonowner negative tests. No mail-triggered agent actions or autonomous sending.
4. Establish approved retention, deletion, privacy and incident recovery policies before storing real messages. RB01 release remains NO-GO until separately approved.

There are no API routes, scheduled triggers, production D1 migrations, Cloudflare changes, Purelymail login, SMTP sends, DNS changes, account purchases, data transfers, or deployments in this change.

References: https://developers.cloudflare.com/d1/worker-api/d1-database/ and https://developers.cloudflare.com/d1/best-practices/read-replication/
