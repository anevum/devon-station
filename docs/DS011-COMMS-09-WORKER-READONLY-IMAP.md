# DS011-COMMS-09 — Workers-native read-only IMAP transport and owner API

Status: **SOURCE-ONLY, DRAFT, NOT DEPLOYED AND NOT A CONNECTED PERSONAL MAILBOX**. Stacked on COMMS-08 PR #26, inheriting COMMS-07/06/05/04/03/MAIL01 and RB01 release gates.

## Implemented

- `src/communications/mail-imap-transport.mjs` uses an injected Cloudflare Workers `cloudflare:sockets` native `connect` function, fixed `imap.purelymail.com:993` with `secureTransport:'on'`, prechecked host/servername, bounded CRLF line and literal framing, an abortable session, LOGIN, tagged-command replies and constrained EXAMINE/UID SEARCH/UID FETCH support. It cannot send SMTP or IMAP mutation commands.
- `mail-imap-readonly.mjs` requests a complete raw MIME entity via `BODY.PEEK[]`. Existing COMMS-08 decoder remains deliberately strict: unsupported multipart, HTML, attachments or oversized messages produce a failure, not a lossy or risky text rendering.
- `worker/mail-api.mjs` provides only owner-subject-bound `GET /api/mail/status`, `GET /api/mail/mailboxes`, `GET /api/mail/inbox` and explicit `POST /api/mail/sync`. Requests pass through DevonStation's existing signed owner authentication and same-origin JSON checks before mail code runs. The server-created registry is Personal / hello only, sending disabled.
- `worker/index.mjs` routes authenticated requests; `tools/build-worker.mjs` packages the real communications source into the existing modular Worker entry and injects the native socket factory. The application does not automatically sync or schedule polling.
- Tests add transport framing / policy denial / failure-path cases and Worker API + disposable D1 read-only sync with bounded real MIME octets; all messages and passwords in fixtures are synthetic.

## Explicit deployment requirements (not applied)

These are intentionally not provided, provisioned or enabled in production by this PR:

- `MAIL_DB`: dedicated, access-scoped D1 binding. Apply `worker/migrations/0004-comms-ro-mail.sql` first to a **separately approved disposable database**; independently verify backup and restore and privacy policy before any persistent real mail data is written. **Do not apply migration 0004 to production.**
- `MAIL_OWNER_SUB`: exact independently verified authenticated Cloudflare Access owner subject. No email-only match is sufficient.
- `MAIL_ENABLED=true`, `MAIL_IMAP_ADDRESS=hello@devonakins.com`, and a restricted secret `MAIL_IMAP_PASSWORD`. Never place passwords in source, GitHub, Notion, CI, request bodies or logs.
- Real on-provider TLS/hostname verification and IMAP login/read must be observed in the intended Cloudflare environment with an authorized mailbox; passing a synthetic socket test alone is not production verification.
- The app still has **no visual Communications interface**, full MIME/attachment support, folder operations, outbound SMTP, draft persistence, composing, recipient validation, delivery receipts, message-body retention/encryption policy or qualified multi-tenant installation. No cross-provider migration, DNS, Cloudflare Email Routing, Anevum forwarding or recovery changes.

## Security and limits

The fixed service fails closed when configuration is missing or owner subject differs. IMAP commands are restricted to EXAMINE, UID SEARCH and UID FETCH with PEEK. Per fetched raw entity <=64 KiB, protocol line <=8192 bytes, staged replies <=3.4 MiB, maximum 50 FETCH items, bounded 12-second on-demand poll; D1 remains transaction/CAS scoped. This strict subset is for integration verification, *not* a general-purpose RFC-complete mail client. IMAP literal parser is deliberately restrictive, and needs real-provider interoperability hardening before production.

No attempts are made to handle HTML or attachments here. Inbound email must remain inert and untrusted; no autonomous actions or SMTP sends are wired. Failed transport and MIME errors return a sanitized `mail_operation_failed` to the owner. No external state changes are made by the source-only PR.

## Release

Run `node --test tests/mail-imap-transport.test.mjs tests/mail-runtime-api.test.mjs`, `npm test`, `npm run build`, `npm run verify:privacy`, native workerd/Miniflare D1 tests and exact-head GitHub Actions. Review the full stacked PR diff and preserve independent RB01 auth/recovery gates. Next coherent engineering step is protocol interoperability and full MIME support, followed by interactive authenticated UI and explicit provider testing. Merge/deploy only after relevant acceptance and approval gates.

Cloudflare TCP reference: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
