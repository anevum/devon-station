# DS011-COMMS-39 — Encrypted Sent archive: release and acceptance gate

**Status: IMPLEMENTED IN PR #36, SOURCE ONLY; migration not applied; release NO-GO.**

## November 5, 2026 — real acceptance logical restore checkpoint (COMMS-41)

**VERIFIED: owner-authorized, private, independent D1 application-data copy. NOT a downloaded SQL export, external backup, encryption-key recovery test, or applied migration.**

- The original dedicated acceptance database remains unchanged. A separate, unbound, nonreplicated D1 database named `devon-station-mail-acceptance-restore-20261105` now retains its complete **application** schema and records. Provider-managed `_cf_KV` is intentionally excluded.
- Compared all **5 application tables**, **4 explicit indexes**, and **14 application rows** against the source: table/index SQL text matched exactly and independent SHA-256 digests of every table's canonical row data matched. SQLite `PRAGMA foreign_key_check` returned zero violations. Source rows were re-read and rehashed after copying to rule out a concurrent data change during the operation.
- The backup has **one** linked, encrypted SMTP-accepted outbox record, matching the source's eligibility count. No raw email, subject, body, encryption key, signed export link, or other private row was written to GitHub/Notion/chat output. Treat the retained backup database as sensitive private data even if payloads are encrypted.
- Cloudflare's official SQL export job reached completion, but downloading its short-lived signed URL through this connection returned **HTTP 403**. The alternative used a provider-internal logical copy with bound SQL values. It is not byte-for-byte SQLite/physical export and is not an off-provider disaster-recovery backup.
- Cloudflare D1 disallows `PRAGMA integrity_check` through the connected API (`SQLITE_AUTH`). Verification used exact schema/text, row-hash, and foreign-key comparisons instead. This limitation must not be reported as a passing physical integrity test.
- The new backup is not bound to a Worker. Both outbound flags remained `false`, the existing acceptance Worker deployment is unchanged, and production remains untouched. **Migration 0009 has NOT been applied** to either source or backup.
- **Still required before live migration:** confirm off-provider/key custody and whether this logical restore meets the owner's formal recovery requirement; preserve the private backup until explicitly authorized cleanup, verify a safe recovery path, then obtain **separate authorization** to migrate the real acceptance database. Do not treat a generic backup success as approval to change its schema.

## Why this exists

The single approved acceptance email was received by Gmail (in Spam), while the owner-triggered Purelymail `Sent` folder search found zero candidates. SMTP acceptance is independent of a remote Sent-folder copy. Do not resend to fix missing provider Sent history.

The current encrypted outbox holds an immutable snapshot for an outgoing attempt. The optional terminal-payload expiration can remove it later. The `0009-comms-sent-archive.sql` migration creates a separate owner-scoped archive that retains the existing AES-GCM envelope on the **claimed → accepted** database transition. An archive is not a provider-delivery receipt, and no message body is fetched from Purelymail. Source-only API paths `GET /api/mail/outbox/archive` and `POST /api/mail/outbox/archive/view` read local D1 metadata / ciphertext only.

## Security invariants

1. Cloudflare Access must authenticate a **signed, allowed owner** before any mail handler; the POST must also pass the same-origin JSON CSRF gate. Wrong owner, malformed ID, disabled/missing encryption keys and missing schema must fail closed.
2. The full plain-text message is never in the archive list response; it is decrypted on the Worker only for an explicit owner-initiated view. The browser renders it with `textContent`, never HTML, links or remote images; the decrypted view is cleared on close, pagehide, background, or leaving Mail. A late response must not redisplay it.
3. The copied ciphertext retains the original outbox AES-GCM AAD `['outbox',installationId,mailboxId,ownerSub,deliveryId]`. Another identity or delivery ID cannot decrypt it, and the encryption key remains in Worker secrets, not D1.
4. Archive only a valid **saved-draft-linked** SMTP-accepted entry; `queued`, `claimed`, `uncertain`, `failed` and `rejected` remain distinct, non-retryable statuses as appropriate. No archive lookup, list, or migration may transmit email.
5. A failed archive trigger aborts the accepted-state DB update. After the external SMTP call the original outbox remains **claimed**, not retried, until reviewed. Never equate archive absence or provider folder absence with unsent mail.
6. Existing outbox receipt and draft lineage, unique-per-draft index, provider settings and production data must not be erased, weakened, or changed. A decrypted archive view also must cross-check its linked draft, accepted state and acceptance timestamp against the permanent owner-scoped outbox receipt.
6a. The permanent outbox receipt store is not subject to a lifetime 100-row cap. Only queued, claimed, and uncertain attempts count toward the 100-active-attempt safety limit. The bounded outbox history view must prioritize queued/unresolved records over terminal history, while accepted archived messages remain independently pageable.
6b. The archive is append-only for ordinary D1 application UPDATE/DELETE operations via protective SQL triggers. A privileged administrator can still drop the triggers/table, so **this is not WORM storage** or a substitute for independently secured backups. Future encrypted-key rotation requires a separately reviewed migration.
7. Archive pages contain at most 100 owner-scoped metadata records. The owner can load older pages with an explicit `accepted_at` / `delivery_id` keyset cursor. No message bodies are decrypted or sent while paging, and records are not deleted.

## Before applying migration (separate authorization required)

- Verify the source PR head and both exact-head GitHub workflows; inspect bundled UI/API, CSS and release manifest. A green CI result does not authorize a live schema change.
- Use the existing dedicated isolated acceptance `MAIL_DB`, **never** the production D1. Verify the four D1 IDs are still distinct, and Access is owner-only with preview routes disabled.
- Take a versioned D1 backup of acceptance and **independently restore** it into an isolated test database; verify message/draft/outbox row counts and encryption-safe readback. Keep encrypted backups and recovery keys under separate custody; do not log or publish them.
- Compare the actual schema with migrations `0005` through `0008`. Ensure archive table/trigger do not already exist with different definitions. Count preexisting accepted linked encrypted rows with `payload_json!='null'`, `json_valid`, `$.v=1`, `$.alg='A256GCM'` without returning sensitive fields. The read-only preflight previously observed **1** eligible accepted row, **0** unresolved rows, and no existing archive table/trigger; recheck before execution.
- Independently inspect migration SQL and verify backward compatibility, size/retention policy and that old deployments can continue to read existing tables. The migration is forward-only by default; do not drop archive data as a "rollback."
- Obtain specific approval to apply the migration to acceptance, apart from approval of a Worker code version.

## Acceptance verification after separately approved staging migration + code activation

1. Verify exactly one historical linked accepted entry backfills into `comms_sent_archive`; no other row states and no duplicate rows; compare count/checksum, not body content in logs.
2. As owner, open the manually requested **Encrypted Sent history**, then **View encrypted Sent copy**. Confirm the historical message's recipients, subject, body and stable Message-ID; no external IMAP Sent record is required.
3. Close the view, navigate away and background Safari; verify decrypted content is cleared, and a delayed response cannot reappear.
4. Confirm `MAIL_SEND_ENABLED=false` and `MAIL_SENDER_VERIFIED=false` throughout; inspect D1 outbox count and states, drafts, incoming mail, production deployment and all distinct D1 resources before and after.
5. Exercise real nonowner Access denial separately. Validate key-custody/recovery and controlled provider failure without sending another live message. Complete physical iPhone Safari/PWA navigation, offline/no-caching, and accessibility checks.
6. Repeat read-only counts after the operation and record exact source SHA, deployed version/deployment ID, D1 migration receipt, verified restore ID, CI run URLs and evidence in the existing PR / Notion record. Never claim production is complete without a separate production authorization.

## Rollback and failure handling

- Code: preserve the previous acceptance Worker version and redeploy its exact traffic split only when approved and safe; re-read send flags and acceptance/production deployment IDs after the action.
- Data: **do not** delete the archive table, trigger, or accepted rows as an automatic rollback. Old code ignores the additive archive. Trigger failures after a provider accepted mail leave a non-retryable claimed record; investigate, never transmit again on the basis of missing archive state.
- Keys: inability to decrypt an archived message is a key-custody/recovery issue, not a reason to resend. Maintain a separately verified key rotation/restore procedure before release.
- Availability: if the migration is missing or fails, the new archive endpoints respond with bounded errors; existing outbox receipts remain the system of record.

**Release decision:** staging migration approval pending. Production merge and deploy remain separately gated.
