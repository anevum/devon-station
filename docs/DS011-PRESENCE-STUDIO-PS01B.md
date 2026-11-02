# DS011-PS01B — Encrypted, owner-scoped Presence Studio vault

**Status:** source-only review candidate. **Lineage:** stacked on [Presence Studio PR #15](https://github.com/anevum/devon-station/pull/15); not merged or deployed. Personal Facebook, Instagram and Threads data only. No migration has been applied to production.

## Bounded outcome

1. Reuse DevonStation's existing signed Cloudflare Access owner identity and same-origin JSON write protection. Add two endpoints only: `GET /api/presence/vault` to read an encrypted snapshot and its revision; `POST /api/presence/vault` to store one opaque encrypted snapshot using `expectedRevision` and a unique `operationId`.
2. Use a separate additive owner-scoped D1 table and content-free write-audit table, declared in `worker/migrations/0004-presence-vault.sql`. No public endpoint, third-party service, cloud secret, new database, multi-tenant grants, or deployment settings are introduced.
3. In the browser, explicitly encrypt user-selected Presence Studio records with WebCrypto AES-256-GCM and a PBKDF2-SHA-256 passphrase-derived key (310,000 iterations, random salt/nonce, authenticated purpose/version). Passphrase and plaintext never enter the API body or server database. Metadata and ciphertext are opaque to the server.
4. Present **Download encrypted file**, **Back up to private vault**, **Preview private vault**, and **Preview encrypted file** controls. Restoring requires decryption, local state conflict checks, an explicit confirmation, and a current remote revision check where applicable.
5. Preserve original local editing: all social drafts and analytics continue to exist in unencrypted, browser-local storage under `devon-station:presence:v1`. This feature is **not automatic cross-device sync**. Cloud backup is an explicit, owner-initiated snapshot, and recovery is explicit. No Meta posting, scheduling, messaging or API connections.

## Safety and recovery contracts

- The private API requires authenticated matching owner email and signed subject; no cross-subject access.
- Mutations require same-origin `Origin`, JSON media type, a validated envelope and a bounded request size; stale revisions and reused operation IDs with different payloads fail closed.
- Server audit stores operation ID, revision, content hash and timestamp only. It does not log post captions, private contacts or passphrases.
- Unknown or malformed backup fields, corrupted ciphertext, incorrect passphrases, invalid imported records, duplicate record identities, unsupported platforms and future-dated metrics are rejected. Never convert missing metrics to zero.
- Do not include children's identifying details, private DMs, contacts, medical/clinical data, credentials or financial identifiers. Encryption is not authorization to store restricted data.
- **No server-side password reset or key escrow.** Losing the passphrase makes previously encrypted backups unrecoverable. Store it securely outside the app.
- A current cloud revision must be inspected before replacing the remote snapshot. Local restore checks for concurrent device edits, previews counts only, and asks for confirmation. No implicit migration or overwrite.
- The vault is unavailable until the additive migration is reviewed, backups and rollback are prepared, an isolated D1 rehearsal succeeds, and release gates pass. When unavailable, local data remains intact and the UI reports a failure.

## Files

- `src/presence-vault-crypto.mjs`: first-party encryption, authenticated envelope and decrypted-record validation.
- `src/presence-vault-ui.js`: explicit backup/download/preview/restore flow.
- `worker/presence-vault.mjs`: bounded owner-scoped ciphertext-only persistence with revision checking and idempotency.
- `worker/migrations/0004-presence-vault.sql`: source-only additive D1 schema.
- `worker/index.mjs`: routes after existing authentication/CSRF checks.
- `tools/build-worker.mjs`, `tools/build-hosted-shell.mjs`: include new protected server and first-party browser modules.
- `tests/presence-vault.test.mjs`: synthetic round-trip crypto, wrong-password and tamper denial, bearer isolation, CSRF, revisions, oversized payloads, migration repeatability and existing-row retention.
- Release review manifest and its expected module list now explicitly include the thirteenth protected module; pinned legacy and Access code hashes are unchanged.

## Required verification before release

At exact feature head, confirm `npm test`, `npm run build`, `npm run verify:privacy`, `npm run test:runtime:dom`, `npm run test:runtime:browser`, `npm run test:browser`, and the existing synthetic foundation/workerd jobs all pass. Inspect GitHub Actions logs and exact diff. Separately test actual iPhone Safari/PWA backup, passphrase clearing, wrong-password feedback, offline/expired sign-in, local tab conflicts and local/remote revision conflicts.

**Further approval required:** a named-user Access session and a nonowner denial, a verified isolated D1 migration with data-preserving backup and rollback, real deployed source/config parity, and a separately authorized production merge/deploy. No migration, credential modification, or production release is authorized by creating this PR.

**Next small increment:** if this source slice is accepted, implement safer protected owner-state synchronization for Presence Studio (without an unencrypted browser-only working copy), conflict reconciliation and genuine device recovery. Investigate official Instagram and Threads APIs only after eligibility, OAuth and permission review. The personal Facebook Professional Mode profile should remain manual unless a supported specific profile API is confirmed.
