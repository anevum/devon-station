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
