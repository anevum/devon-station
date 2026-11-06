# DS011-COMMS-52 — offline mail recovery verification

This is an owner-operated, read-only check of two private SQLite mail copies. It performs no export, restore, migration, SMTP/IMAP operation or release. It supplements the workspace recovery checker with the mail schema and actual encrypted application readers. It does not establish real backup availability, secure key custody, provider acceptance, HTTP authorization or production readiness.

## Private prerequisites

Use a trusted copy of this source, Node 22 or later, and a disconnected recovery machine. Obtain a consistent, quiescent SQLite source snapshot and restore the encrypted backup to a separate fresh SQLite file. Close writers; WAL/shared-memory/journal sidecars are refused. Do not point at an active database. SQL exports must first be restored into an isolated SQLite file using a separately reviewed process; this tool never executes imported SQL.

Supply a separate, owner-held private JSON key file with `activeKeyId`, `keys` (the historical ID-to-base64-key map used by the application), and `ownerSub` (the original inbox owner identity). All referenced historical keys must remain available. This file must belong to the current OS user with no group/other permissions (for example mode 0600), and cannot be a symlink. Keep keys and the backup passphrase separate from backup storage. Prepare and retain them through the owner's secure process, never chat, command arguments containing secret values, environment variables, Git or ordinary project records. Disk encryption and appropriate physical custody are still required; file permissions alone do not provide them.

The application currently supports one inbox owner per mail database; mailbox/installation scopes and draft/outbox owners are read from records and cryptographically authenticated. This command does not grant anyone access.

## Run offline

The command takes paths only, with no key values or passphrases:

```sh
node tools/verify-mail-recovery.mjs source.sqlite restored.sqlite private-recovery-keys.json
```

If the whole backup uses the existing encrypted-database envelope, first use the owner-operated decrypt command, which requests its passphrase privately:

```sh
node tools/d1-backup-local.mjs decrypt encrypted-backup.json restored.sqlite
```

It refuses existing destination files. Treat the restored SQLite file as sensitive even though mail bodies are encrypted. Follow the private recovery environment's retention/cleanup rules; ordinary deletion is not a promise of secure erasure.

## What passes

The tool checks independent file identities, quiescent rollback-mode SQLite, integrity/foreign keys, exact mail schema against reviewed migrations 0004–0008 with optional 0009, and complete typed-row equality across all mail application tables. It ignores provider-owned metadata explicitly. It then uses the actual inbox, draft and outbox/Sent readers to decrypt every retained payload in the restored copy, preserving owner/mailbox/delivery cryptographic contexts. Every archive must match a permanent accepted receipt. An accepted receipt whose outbox payload was scrubbed must have a recoverable Sent archive; loss of its last content copy refuses success. Scrubbed failed/rejected payloads are counted as unavailable terminal payloads, not described as recovered content.

It does not mutate receipts or claims and never retries queued, claimed or uncertain mail. Exact row comparison includes claim identifiers, draft revisions, operation identifiers and unresolved states. Source/restored file identities and hashes are checked again after reads to detect changes during the check. Inputs must be trusted and quiescent; this is not a defense against an attacker concurrently replacing local paths.

Successful output contains a status, aggregate row counts and explicit limitation flags. No messages, addresses, owner identities, key IDs or secret values are printed. Empty tables can pass equality, but zero payloads do not prove recovery of real messages. A fixed refusal message and nonzero exit code cover missing/corrupt copies, wrong/missing keys, wrong inbox owner, schema/row divergence, undecryptable content or invalid Sent lineage. Do not infer the cause by publishing private files.

## Required real release evidence

The synthetic test creates old/new-key encrypted inboxes and saved drafts, plus accepted, queued, claimed, uncertain, failed and rejected outbox records and Sent history. It encrypts a whole SQLite backup, checks that keys/plaintext are absent from the outer archive, restores with the existing decrypt function and runs this CLI in a fresh process with separately supplied synthetic keys. Negative cases cover missing old keys, wrong owner, equal-but-corrupt copies, receipt mismatch, missing rows/schema/immutable triggers, pre-archive compatibility, missing backups, alias paths, WAL files and unsafe key-file permissions.

These tests demonstrate the procedure with fabricated data. Before a real mail release, the owner still needs an actual independent backup, independently held historical keys and a successful private run against representative real data. Record only the result and counts through an authorized private channel. After that, separately review the acceptance migration, code activation, real-device/provider checks and eventual production release. Keep the established approved application candidate intact while this source-only helper is reviewed on its own branch.
