# DS011-COMMS-17 — Reviewed owner-only outgoing email UI

Date: 2026-11-03. **Source-only. Draft branch stacked on COMMS-16 PR #33; not deployed and no real mail sent.**

## Existing integration, not a replacement

Extends the existing DevonStation one-viewport Mail workspace. The signed server /api/mail/status exposes `outgoingEnabled` only after independently verified, server-side settings are present. The saved D1 draft editor is not replaced; the send UI is hidden completely when the status reports outgoing disabled.

When sending is explicitly enabled, the owner must first save a draft, review a persistent confirmed revision, click **Review Saved Draft for Sending**, and then independently click **Confirm and Submit Email** and accept a native confirmation dialog. The prepare request only creates an immutable, owner-scoped outbox snapshot; it never opens SMTP. The final confirmation sends only the delivery UUID, not arbitrary sender, recipient, account, body, or credentials, to the disabled-by-default endpoint added in PR #33.

The review displays From, To, Subject and the full body using textContent/createElement, never HTML interpretation or remote requests. It locks draft editing and selection while reviewing. Ambiguous preparation receipts preserve the same delivery ID and can be checked without generating a replacement. If a submission is attempted, this browser session will never retry it: the user can only check the durable outbox status. SMTP acceptance is **not** end-to-end recipient delivery; claimed and uncertain states remain explicit. The original saved draft is retained. Closing a review never deletes/cancels the queued or attempted durable outbox record.

## Verification

- New `tools/mail-send-ui-dom.test.mjs`: disabled outgoing flag, unsaved-draft block, one explicit prepare with no send, inert payload rendering, rejected native confirmation, exactly one owner-submission, unchanged saved draft, no retry after uncertain response, and read-only status lookup.
- Included in existing `npm run test:runtime:dom` script.
- JavaScript sources parsed successfully in a Code Mode syntax check. The DOM tests have been added but were **not run locally** because this environment cannot clone the repository or install its jsdom dependencies. Do not claim passing runtime DOM, Chromium, build, privacy, Miniflare or exact-head CI without evidence from GitHub Actions.
- Source changes are limited to `src/mail-ui.js`, `src/mail-drafts-ui.js`, `src/mail-ui.css`, the new DOM test and `package.json`. No production, DNS, Cloudflare Access, secrets, D1 schema, SMTP, or external send mutation.

## Release blockers

This is intentionally not an operational live sender. Neither this PR nor the stacked mail PRs are merged/deployed. The live Worker has no MAIL_ bindings. Outbox snapshots remain plaintext and retain tombstones indefinitely; encryption, retention, backup/restore, owner/alternate-session Access, provider IMAP/SMTP credentials, true inbound/outbound roundtrip, owner iPhone review, independent tests/CI, Sent and draft reconciliation, full folders, searching, reply/forward and attachments, and rollback/release authorization remain incomplete.

One known limit: pending UI review state is session-local, while an already prepared outbox item is durable. Reloading the browser does not cancel an item, nor does it authorize retry. A future reconciliation view should allow safe owner inspection of existing receipts without recreating a send. No autonomous mail-triggered agents or sends are allowed.
