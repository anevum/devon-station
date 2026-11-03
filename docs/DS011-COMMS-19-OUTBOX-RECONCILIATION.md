# DS011-COMMS-19 — Saved draft and delivery receipt reconciliation (read only)

Date: November 3, 2026. **Source implementation only. Not merged or deployed.**

## Problem and bounded change

COMMS-18 links prepared outgoing deliveries to a trusted saved draft ID and revision, but the browser still required manual receipt inspection and could try preparing a different revision of a previously attempted draft. COMMS-18 constrained one delivery per revision; COMMS-19 additionally constrains one delivery per draft across revisions, while preserving existing unlinked outbox rows.

COMMS-19 extends the existing Mail/Drafts UI and adds a separate, candidate-only D1 safety migration; it does not change the provider:

- Validates all owner-scoped outbox receipts before displaying or caching them. Requires RFC-style lowercase delivery UUID, known state, bounded timestamps and either both saved-draft ID/revision or neither; invalid/partial lineage fails closed and clears unverified history. No incoming email HTML or attachment execution.
- Shows existing delivery state beside each saved draft when the owner explicitly requests outbox history, using text-only DOM elements. Historical unlinked deliveries remain status-only; they must not be retroactively matched to drafts.
- Before any new prepare, explicitly refetches the complete, bounded owner-scoped outbox and refuses preparation if **any** previous delivery exists for that saved draft ID, even at another revision. A missing/unauthorized/malformed history blocks preparation and does not allocate another UUID.
- Candidate migration `0008-comms-one-delivery-per-draft.sql` adds an owner-scoped unique index on draft ID (regardless of revision); the outbox lookup now detects prior delivery IDs across revisions. This is the authoritative defense under concurrent requests. The browser preflight is supplementary, **not** an authorization control. A deliberate second send requires creating a new draft ID.
- No automatic send, retry, polling, deletion, draft-to-Sent promotion, external HTML, or provider-sent claim. SMTP acceptance is not recipient delivery. When no prior delivery exists and full history read succeeds, the existing separate prepare/review/native-confirm/submit flow is unchanged.

## Focused regression additions

The existing `tools/mail-send-ui-dom.test.mjs` now seeds provider-style outbox receipts with timestamps and exercises:

- saved draft with a prior SMTP-accepted receipt at an earlier revision blocks another prepare;
- UI shows the durable delivery status beside that draft, without interpreting message text;
- unavailable owner outbox read prevents preparation and SMTP;
- incomplete draft lineage fails closed and blocks preparation;
- the older reviewed-send, disabled-default, and ambiguous outcome cases retain their intended behavior.

These tests are committed but are **not yet recorded as passing** on the exact branch head. They require jsdom and the full repository checkout/Actions runner. Existing PR #35 and parent branches remain unmerged. The complete release still needs live provider and owner-identity validation, encryption/retention, backup/restore, full incoming/outgoing message management, browser/mobile review and a passing exact-head CI result.

## Migration and verification boundary

Migration `0008` is an **additive, source-only candidate** layered after migrations `0005`, `0006`, and `0007`. It preserves previously queued, accepted, rejected, failed, claimed, uncertain and historically unlinked outbox rows. If an existing isolated database already contains more than one linked delivery for a single owner/draft across revisions, the new UNIQUE index **fails closed**: inspect and reconcile those records before any migration. Do not delete, requeue or relabel them. A cold backup and restore rehearsal is mandatory before any authorized production D1 change.

An independent in-memory SQLite 3.46.1 test executed the proposed constraint and the existing atomic `INSERT OR IGNORE ... SELECT` preparation shape. It passed duplicate prevention across revised drafts, owner isolation, legitimate separate drafts, preservation of unlinked rows, and failure when preexisting duplicates would violate migration. This is **isolated SQLite evidence, not a passing Node/D1/Miniflare/browser CI run**. Additional Node SQLite and Workerd tests have been updated to exercise the new migration but remain unexecuted locally pending the queued GitHub Actions runners.

The constraint is intentionally per saved draft ID. If the owner wants to send a separate message, they must create another draft; automatic retries and provider/recipient delivery verification remain out of scope. It does not guarantee that the external mail provider won't duplicate messages, nor does it reconcile all Sent folder state.

## Operational boundary

No Cloudflare Mail bindings, DNS/MX/Email Routing changes, GitHub merge, production deployment, secret update, production D1 migration, SMTP send, or provider access were performed. Preserve current Anevum forwarding and prior DevonStation release checkpoints.
