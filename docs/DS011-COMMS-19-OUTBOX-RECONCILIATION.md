# DS011-COMMS-19 — Saved draft and delivery receipt reconciliation (read only)

Date: November 3, 2026. **Source implementation only. Not merged or deployed.**

## Problem and bounded change

COMMS-18 links prepared outgoing deliveries to a trusted saved draft ID and revision, but the browser still required manual receipt inspection and could try preparing a different revision of a previously attempted draft. The database uniqueness guarantee prevents duplicates for the **same saved revision**, not for different revisions of the same draft.

COMMS-19 extends the existing Mail/Drafts UI without changing the provider or database schema:

- Validates all owner-scoped outbox receipts before displaying or caching them. Requires RFC-style lowercase delivery UUID, known state, bounded timestamps and either both saved-draft ID/revision or neither; invalid/partial lineage fails closed and clears unverified history. No incoming email HTML or attachment execution.
- Shows existing delivery state beside each saved draft when the owner explicitly requests outbox history, using text-only DOM elements. Historical unlinked deliveries remain status-only; they must not be retroactively matched to drafts.
- Before any new prepare, explicitly refetches the complete, bounded owner-scoped outbox and refuses preparation if **any** previous delivery exists for that saved draft ID, even at another revision. A missing/unauthorized/malformed history blocks preparation and does not allocate another UUID.
- The already-implemented server constraint in COMMS-18 independently serializes simultaneous preparations of the same revision. The browser check is additional defensive UX, **not** an authorization control or a substitute for server-side draft-wide uniqueness.
- No automatic send, retry, polling, deletion, draft-to-Sent promotion, external HTML, or provider-sent claim. SMTP acceptance is not recipient delivery. When no prior delivery exists and full history read succeeds, the existing separate prepare/review/native-confirm/submit flow is unchanged.

## Focused regression additions

The existing `tools/mail-send-ui-dom.test.mjs` now seeds provider-style outbox receipts with timestamps and exercises:

- saved draft with a prior SMTP-accepted receipt at an earlier revision blocks another prepare;
- UI shows the durable delivery status beside that draft, without interpreting message text;
- unavailable owner outbox read prevents preparation and SMTP;
- incomplete draft lineage fails closed and blocks preparation;
- the older reviewed-send, disabled-default, and ambiguous outcome cases retain their intended behavior.

These tests are committed but are **not yet recorded as passing** on the exact branch head. They require jsdom and the full repository checkout/Actions runner. Existing PR #35 and parent branches remain unmerged. The complete release still needs live provider and owner-identity validation, encryption/retention, backup/restore, full incoming/outgoing message management, browser/mobile review and a passing exact-head CI result.

## Known limitation

The current database unique index is per saved revision. COMMS-19 blocks a repeat from the standard browser path after a successful history read, but direct or concurrent authenticated requests targeting **different saved revisions** could still prepare two deliveries for the same draft ID. For production-grade prevention, strengthen the database policy or introduce a separate server-owned explicit re-send lineage, with concurrent D1 tests and a deliberate retry/recovery design. This draft does not claim final duplicate-send protection.

## Operational boundary

No Cloudflare Mail bindings, DNS/MX/Email Routing changes, GitHub merge, production deployment, secret update, production D1 migration, SMTP send, or provider access were performed. Preserve current Anevum forwarding and prior DevonStation release checkpoints.
