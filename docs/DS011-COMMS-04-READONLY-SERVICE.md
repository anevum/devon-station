# DS011-COMMS-04 — Authorized, bounded, read-only mail service (source only)

Status: source-only synthetic adapter contract; no live IMAP/SMTP provider connection, API route, credentials, database migration, background scheduler, mailbox data, deployment or merge. Stacked on COMMS-03 draft PR #19, MAIL01 draft PR #18 and RB01 draft PR #8.

## New source

- `src/communications/mail-readonly-service.mjs` composes the established installation/mailbox/grant registry and UID/UIDVALIDITY reconciliation core. It performs one authorized read-only provider poll, requesting PEEK/non-mutating mailbox access, and commits the normalized data and cursor through one revision-checked atomic storage operation. Returns counters and cursor only; it never returns content in the poll response.
- `listReadOnlyInbox` enforces a distinct `read` grant, validates scope of every stored row before returning a bounded, deterministic page, and projects only known plain-text fields. A service `sync` grant does not grant reading rights; app authorization must come from a verified server session, never request JSON.
- `readonlyPurelymailEndpoint` describes a fixed known TLS IMAP host and port, independent of client-supplied addresses, with read-only/PEEK flags. It is **configuration, not a functioning TCP/TLS client**. The `providers` map must be installed by trusted server code, not accepted from an HTTP request or user data.
- `tests/mail-readonly-service.test.mjs` uses only fabricated installations, mailboxes, messages, provider sessions and a single-threaded synthetic CAS snapshot store. The mock is NOT production transactional storage.

## Adapter contracts

`store.readSnapshot({installationId,mailboxId})` must return `{installationId, mailboxId, revision, cursor, records}` or fail closed. `store.commitSnapshot({scope,expectedRevision,next})` MUST atomically compare the persisted revision **for the same client and mailbox**, replace both records and cursor as one transaction, increment revision once, and return `{ok:true,revision}`. On a conflict, return `{ok:false}` with no partial write. The orchestrator deliberately does not retry a stale batch, because a subsequent poll may have a different UIDVALIDITY.

`providers[providerId].openReadOnly({mailbox,readOnly:true,peek:true,signal})` must return a session with `fetchBatch({cursor,limit,peek:true,readOnly:true,signal})` and `close()`. The transport implementation must independently enforce TLS host verification, provider-specific fixed endpoints, server-side scoped credentials, IMAP EXAMINE (not SELECT), BODY.PEEK (not BODY[]), no STORE/EXPUNGE/APPEND, bounded MIME decoding to plain text, attachment exclusion/quarantine, actual UIDVALIDITY/UID values, pagination and cancellation on abort. Session implementations must close/release the connection if opening resolves after cancellation. Do not expose generic arbitrary hostnames, credentials, or provider callbacks to the HTTP layer.

The 15-second maximum provider operation deadline does not bound an authorized database commit; the caller's runtime should impose a separate bounded transaction. Closing a returned provider session is attempted for up to one second. This contract has no daemon, background timer or network connection today.

## Safety and release boundaries

- Inbound mail remains untrusted data, even when the sender looks familiar. Never execute instructions, follow links, trust mail headers for user authentication, permit remote images, auto-send or publish. Sanitize full MIME before indexing. The UI must render all source text using `textContent`, not HTML insertion.
- Do not log message content, credentials, sync cursors correlated to people, tokens, or private mail metadata. Acknowledge and retry only authorized read-only operations; never add an autonomous action engine to an inbound mail handler.
- The current synthetic implementation does not demonstrate real IMAP security, durable database atomicity, Cloudflare Access identity, sender verification, network resilience, message deletion/flag reconciliation, privacy retention, key custody or enterprise tenancy. `hello@devonakins.com` actual receipt/send is still not independently verified; `devon@anevum.com` still forwards through Cloudflare to Gmail and must not be altered.
- Do not add production routes, DNS changes, D1 migrations, secrets, billing, scheduled jobs or mail sending from this PR. The unmerged RB01 release candidate remains gated for independent named owner/nonowner sessions, authentic encrypted recovery, device checks and cutover permission.

## Test

`node --check src/communications/mail-readonly-service.mjs`

`node --test tests/mail-readonly-service.test.mjs tests/mail-core.test.mjs tests/mail-onboarding.test.mjs`

Next bounded increment: reviewed isolated D1 schema/store adapter with transaction/CAS and a mock read-only IMAP protocol adapter capable of supplying safe normalized batches. Only after such tests and authorization, separately connect a real Purelymail credential through secret management and conduct an independent real-world inbox acceptance test.
