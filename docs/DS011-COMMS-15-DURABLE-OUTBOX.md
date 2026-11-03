# COMMS-15 — Durable owner-scoped outbox integration

Source-only, not merged or deployed. Extends existing stacked PR #32, retaining its integrated #31 parent and SMTP/MIME source. No replacement application or new provider.

## Implemented

Candidate dedicated MAIL_DB migration 0006 stores immutable delivery snapshots under installation/mailbox/owner subject and delivery UUID. A one-statement UPDATE RETURNING atomically changes queued to claimed with an independent claim UUID. Finalization requires that exact claim. Terminal states are accepted, rejected, failed and uncertain; none can be requeued or reclaimed. A crash or failed acceptance-record write leaves claimed permanently non-retryable. There is no timeout-based lease reclaim, automatic sender, scheduler or transport retry.

The dispatcher rechecks trusted sender entitlement before claiming and integrates the existing SMTP transport. Enqueue retry preserves its original date, MIME Message-ID and immutable payload. Changed payload under the same UUID conflicts. SMTP acceptance is explicitly not delivery. Lost DATA acknowledgement becomes uncertain. Finalization failure cannot downgrade accepted mail to a retryable failure.

Existing signed-owner Worker routing now exposes GET /api/mail/outbox and POST /api/mail/outbox/prepare behind MAIL_OUTBOX_ENABLED and verified server-side sender configuration. Preparation requires explicit owner approval and never sends. Status contains no recipients/message body; signed owner, existing JSON/Origin checks and mailbox scope remain enforced. There is deliberately no HTTP submit route. Provider transport, MIME and outbox modules are included in the actual 42-module/7-asset candidate, with exact release allowlists and negative security tests retained.

## Verification

312 Node tests, runtime DOM suites and 50 actual local workerd/D1 checks per pinned July/October compatibility run pass. D1 tests cover idempotent immutable enqueue, claim races, owner isolation, terminal denial, actual existing SMTP+MIME with synthetic sockets, accepted and uncertain outcomes, failed acceptance persistence, and Worker API preparation/status with no HTTP SMTP path. Provider traffic and credentials are synthetic; this does not verify real Purelymail or recipient delivery.

Production readback: V0.3 icon version 5e2357ad-376d-49f0-ada3-eb0cfc8a73c4 remains at 100%. No MAIL_ bindings observed. Devon domain MX/SPF/three DKIM CNAMEs remain Purelymail; no DMARC TXT was observed in the returned DNS records. Anevum MX remains Cloudflare and Email Routing reports enabled. No DNS, forwarding, Access, secret, production D1, deploy or real mail action was changed. Exact literal forwarding-rule readback was unavailable through the attempted account endpoint; do not claim independent rule verification from MX alone.

## Remaining gates

Exact-head CI remains queued behind previously diagnosed obsolete browser runs. Cancellation of the 18 specifically listed COMMS-11 runs still awaits explicit authorization after automatic approval review rejected that action in the preceding session. New generic continuation instructions have not been used to bypass that boundary.

This source stores plaintext queued snapshots and retains delivery tombstones indefinitely; its 100-record per-owner bound is a testing guard, not approved production retention/encryption. No migration applied, real identity attestation, live app password, full message/attachment storage, SMTP UI/submit endpoint, Sent reconciliation, reply/forward/CC/BCC, production backup, browser/iPhone or provider roundtrip acceptance is complete. Production remains NO-GO. Next gate is authorize obsolete-run cancellation and obtain independent CI; then continue explicit send UI/API and isolated provider acceptance with separately approved secret bindings and test messages.
