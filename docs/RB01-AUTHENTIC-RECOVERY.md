# Whole-database recovery evidence

Status: offline tooling implemented; authentic export/restore NOT accepted.
The existing DS-011 checkpoint owns exact private database identifiers, operator,
encrypted storage location, retention, export window and authorization. This
document does not authorize export, resource creation, migration or cutover.

The client-encrypted journal backup is not a whole-database backup. Preserve
owner documents, every write audit, device subscriptions, delivery history and
portfolio cache as well as any later scoped journal. The current production
application has five tables and two explicit indexes; isolated RB01 adds
`station_workspace_state`. Provider schema inspection read no application rows
and wrote zero rows. Do not reuse either occupied synthetic acceptance database
as an authentic restore destination or overwrite its accepted recovery evidence.

## Exact comparison after an authorized restore

`tools/verify-d1-restore.mjs` compares two separately obtained, quiescent SQLite
copies in an approved private environment. It does not download exports, execute
input SQL, encrypt files, provision D1, apply migrations or contact a provider.
Do not feed it live databases, patient records or files with unreviewed provenance.
Authentic copies must remain outside the repository, CI, ordinary chat, Notion,
and public artifacts. Paths below are placeholders for separately approved files.

```sh
# Before additive migration: exact match of all reviewed application tables.
node tools/verify-d1-restore.mjs /approved/source.sqlite /approved/restored.sqlite

# After the authorized journal migration has been applied twice to the target:
node tools/verify-d1-restore.mjs /approved/source.sqlite /approved/migrated.sqlite additive-empty-journal

# Later fallback/return comparison when both copies contain the journal:
node tools/verify-d1-restore.mjs /approved/rb01-before.sqlite /approved/rb01-after.sqlite
```

The verifier opens existing regular files read-only, uses read transactions and
query-only mode, disables trusted schema, and accepts only the reviewed five- or
six-table schema. It compares complete typed row multisets, preserving duplicate
counts, nulls, binary values, Unicode and 64-bit integers without relying on
insertion order or matching row counts. SQLite integrity and foreign-key checks
must pass. The additive mode requires an unchanged five-table source and an
otherwise identical target with an empty sixth journal. It cannot accept a
populated journal as a migration success or erase it to make the check pass.

Missing indexes, changed constraints, additional tables/triggers, unexpected
schema, identical paths/hard links, symlinks, missing files, WAL mode/sidecars,
oversized inputs and changed file hashes are refused. Limits are 64 MiB per
copy and one million rows per table; exceeding them requires a reviewed change.
Both inputs' bytes must remain unchanged. Output contains fixed status fields
and aggregate table counts; raw records, endpoints, subjects, hashes of private
content, paths and SQLite errors are not printed. Treat even counts as private
operational evidence. This is not a hostile-file sandbox or a general SQL parser.

`_cf_KV` is Cloudflare-managed metadata. Its known schema may be present, but its
values are deliberately neither read nor compared. The report explicitly says
`providerMetadataCompared: false`. Do not import provider-internal metadata as
portable application state. Any new provider schema requires review.

## Remaining authentic acceptance

1. Record exact source and a distinct empty destination, operator, approved
   private encrypted storage/key custody, export window, retention and disposal
   decision in the existing private checkpoint. Recheck worker bindings and
   absence of production routes to the destination. Do not assume an occupied
   synthetic target is disposable or a proposed target has been created.
2. Under that authorization, obtain a consistent complete source export; retain
   its private checksum, encrypt it and independently test decryption. SQL and
   temporary plaintext require the approved private environment. The existing
   synthetic SQL rehearsal helper must never process authentic exports.
   Cloudflare's export API can make D1 unavailable while exporting and requires
   continued polling. The approved window must account for this interruption;
   do not start an export as a harmless read-only preflight. Keep download URLs
   and polling bookmarks private; an abandoned export is not a retained backup.
3. Restore only into the authorized empty destination. Obtain an independent
   target export and reconstruct separate local copies there. Run exact
   comparison before migration, then additive comparison after both migration
   applications. Record provider success and source/destination provenance
   independently; two matching local files alone cannot prove a D1 restore.
4. Before enabling any authentic copy in a test Worker, verify exact owner-only
   Access, subject/grants, absent public preview and no production bindings.
   Restored push endpoints are authentic device credentials: use a non-delivering
   configuration and do not send test notifications to restored devices.
5. Accept the exact guarded fallback on that destination, then return to the
   candidate with preserved records and any new journal receipts. Code rollback
   never drops tables, restores an earlier D1 snapshot or rewinds receipts.
   Deployment, write pause and rollback authority require their recorded scope.
6. Retain the encrypted evidence through the approved period. Disposal is a
   separate explicit decision; the comparator performs no cleanup of inputs.
   Production remains unchanged until all release gates and cutover approval.

Passing fabricated offline tests proves the comparator's stated behavior. It
does not prove authentic audit validity, cryptographic provenance, owner-visible
recovery, actual Cloudflare restore, identity/session/device acceptance or a
production release. Those gates remain in `RB01-RELEASE-ACCEPTANCE.md`.
