# DS011-COMMS-10 — DevonStation read-only mail workspace

Status: **review-only / stacked on COMMS-09, NOT DEPLOYED**. Parent: [PR #27](https://github.com/devonalanakins/devon-station/pull/27).

## Implemented
- Added a `Mail` section in the existing DevonStation source/navigation, with untouched Idea Flow / local capture.
- Owner-only read-only UI is bundled in the same authenticated Worker shell, with a fixed personal Purelymail identity: `hello@devonakins.com`.
- Browser requests **only** `/api/mail/status`, `/api/mail/inbox` and explicit user-click `POST /api/mail/sync`. No background polling, auto-replies, SMTP or credential fields.
- Response shape checked before display. Sender/subject/body are **textContent** only; embedded HTML, remote links/pixels, scripts and instructions never execute.
- Keyboard-focusable inbox rows, readable message details, mobile stacked layout, safe-area padding, reduced-motion support, loading/empty/failure states, owner session-expiry message and explicit sync receipts.
- Synthetic jsdom tests verify DOM inertness, explicit synchronization, disabled mail setup, failed owner session and malformed API output.

## Scope / gates
The existing COMMS-09 IMAP/strict MIME transport is still synthetic-provider-tested only; real Purelymail authorization/TLS and D1 migration require isolated work and approval. Normal HTML/multipart/attachments, Sent/Drafts/Spam, search, reply, SMTP and multiaccount handling remain unavailable. Do not merge or release as full communications. This increments an actual backend-driven UI, **not** a fake inbox. No changes to Cloudflare routing, Access, DNS, SMTP, databases, credentials or production deployment.
