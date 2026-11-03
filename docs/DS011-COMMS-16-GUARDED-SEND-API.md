# DS011-COMMS-16 — Explicit owner-confirmed SMTP submission API

Date: 2026-11-03. **SOURCE ONLY / NOT MERGED / NOT DEPLOYED.**
Stacked on COMMS-15 draft PR #32 (itself based on #31 and earlier RB01/Communications drafts).
This change does not establish a working live mailbox or authorize email sending, Cloudflare secrets, Access changes, DNS changes, migrations, or a production release.

## Bounded implementation

- A separate \`POST /api/mail/outbox/submit\` takes exactly \`{"deliveryId":"<lowercase UUID>","confirmedByOwner":true}\`. It never accepts SMTP credentials, sender, recipients, a message, or an arbitrary mailbox from the browser. The existing \`POST /api/mail/outbox/prepare\` must have previously stored a separately owner-approved immutable snapshot.
- The enclosing \`createStation\` router still requires the signed named owner, exact origin, and same-origin JSON for POST; the mail API additionally requires the specific signed \`MAIL_OWNER_SUB\`.
- \`MAIL_SEND_ENABLED === 'true'\` is an **independent, disabled-by-default** activation gate, separate from \`MAIL_OUTBOX_ENABLED\` and \`MAIL_SENDER_VERIFIED\`. Server-owned sender identity must be \`hello@devonakins.com\`, with a valid private \`MAIL_SMTP_PASSWORD\`, a D1 binding and a native socket function. The handler does not configure any of these.
- The only submit path delegates to the existing durable D1 outbox dispatcher. It re-verifies send entitlement before claiming, atomically claims a queued delivery only once, uses the existing implicit-TLS-only Purelymail SMTP adapter, and never retries claimed, accepted, rejected, failed or uncertain deliveries automatically.
- A bounded abort signal combines the request signal and a 20-second timeout. An SMTP acknowledgement after DATA is **server acceptance, not recipient delivery**. Lost acknowledgements can leave an **uncertain** state, and an unrecorded accepted submission can leave a **claimed** state: neither may be automatically retried.
- The response returns an owner-scoped receipt with \`deliveryConfirmed:false\` and \`automaticRetry:false\`; provider banners, credentials, recipients and message text are not included. After any ambiguous submit failure, the caller must **read the outbox state** rather than generating another delivery ID.
- \`GET /api/mail/status\` reports the gated \`outgoingEnabled\` boolean; existing read-only inbox and draft APIs remain independent. This slice intentionally does **not** add a send button or enable browser-visible submissions.

## Verification path

- \`tests/mail-send-api.test.mjs\` covers default-off and independent flags, missing/invalid credentials, subject denial, invalid confirmation/IDs and zero attempted SMTP sockets before authorization.
- \`workerd-test/mail-outbox-runtime.test.mjs\` adds a synthetic owner HTTP roundtrip against actual Miniflare D1, with a fake TLS socket. It checks no send on preparation, explicit second confirmation, single SMTP DATA write, disabled/mismatched configuration, one-use claim and sanitized response.
- Run \`npm test\`, \`npm run build\`, \`npm run verify:privacy\`, \`npm run test:runtime:dom\`, and both pinned dates of \`workerd-test\` as configured by repository workflows. Inspect the exact-head CI run and review bundle. These checks are **required** before marking this branch verified; writing this document does not claim they ran.
- The externally reported CI queue from PR #32 is still a potential blocker. No previously rejected cancellation of obsolete Actions jobs is authorized by this source change.

## Release NO-GO and future work

Production currently lacks independently accepted SMTP/IMAP connection and signed owner session verification for this candidate. The source outbox retains plaintext payloads and permanent delivery tombstones; encryption/retention, backup/restore, access policy, real provider credentials, forwarding/recovery, secure migration, live SMTP and incoming IMAP roundtrips, iPhone UX and rollback require explicit staged acceptance.

Still missing from the complete application: owner send UI with message review and safe pending/uncertain display; reconciliation of sent copies and unsent drafts; reply/forward, CC/BCC, attachments and MIME fidelity; full folder/search/organization and multiple domains. No production mail should be sent from this branch without those explicit gates. Preserve Anevum's existing forwarding and all RB01 recovery constraints.
