# DS011-COMMS-03 — Independent mail registry and bounded IMAP reconciliation

Status: source-only synthetic core (November 2, 2026); NOT a connected mailbox, live sync, sending, migration, or production release.

## Relationship to current work

This slice is stacked on draft PR #18 (Purelymail onboarding), which is in turn stacked on draft RB01 PR #8. It preserves the existing Cloudflare Email Routing for `devon@anevum.com` and Purelymail DNS for `devonakins.com` without changing either. `hello@devonakins.com` was reported created in Purelymail; real inbound/outbound acceptance remains outstanding. The current implementation adds no UI or provider credential handling. It does not reproduce any uncommitted synthetic Communications UI prototype; integration should use that reviewed UI code when it is available in a durable branch.

## Contract

- `createMailRegistry`: typed-at-runtime validation of four independently managed collections: installations, canonical mailboxes, From identities and mailbox grants. Config is passed from trusted server context; clients/roles cannot declare their own grants. A cross-installation identity or grant is rejected. Every mailbox must have an actual primary identity; aliases are explicit optional identities.
- `accessibleMailboxes` and `hasMailPermission`: server-side **installation + principal + mailbox + capability** boundaries. Display authorization is not transport health; a Cloudflare forwarding route never means an IMAP mailbox is connected.
- `evaluateFromIdentity`: policy-only outbound readiness, requiring send grant, verified originating identity and IMAP-provider outbound verification. It does not approve a draft or send; a separate signed one-time authorization/transactional outbox with idempotent receipts is required before enabling SMTP.
- `reconcileImapBatch`: no network, no persistence. A trusted service principal with the scoped `sync` capability supplies a bounded provider response (max 100 messages), an existing mailbox-scoped index, and the prior cursor. It proposes a deterministic next cursor and normalized plain-text-only rows keyed by `(installation, mailbox, UIDVALIDITY, UID)`. Replays refresh flags idempotently; changes to UIDVALIDITY retain old cohorts rather than deleting mail. Invalid provider input, cross-tenant rows or oversized batches throw before any state is committed.

## Deferred adapter and actual operations

The provider adapter must verify credentials server-side and fetch messages using TLS, fixed host/port allowlists, bounded retries/backoff, provider UIDVALIDITY, and a cursor. It must avoid logging mail content. Persist rows and cursor **atomically** with revision checks in a client-owned database; add a separate bounded flags/deletion reconciliation and explicit retention rules. This pure function cannot prevent concurrent provider poll races until a transactional adapter is implemented. Actual MIME parsing, attachments, remote content blocking, quota, quarantine, rate limiting and message-level ACL require separate implementation. Never interpolate untrusted subjects, bodies or addresses into HTML. Inbound mail may suggest tasks/drafts but must never issue instructions to an agent with elevated privileges or trigger consequential actions without explicit authenticated human approval and an audited receipt.

Before live pilot: provider-verified `hello@devonakins.com` receive/reply/send, owner-controlled app password in isolated secrets storage, signed Access principal mapping, independent nonowner denial, privacy/retention approval, isolation and fallback testing, RB01 release gates, and explicit production authorization. No live Anevum routing migration, automatic classification, send, cron, D1 migration, OAuth, R2 or new billable resource is made in this slice.

## Verify

`node --check src/communications/mail-core.mjs`

`node --test tests/mail-core.test.mjs tests/mail-onboarding.test.mjs`
