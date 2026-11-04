# DS011-COMMS-19 — Owner acceptance in DevonStation

November 3, 2026. **Source implemented and synthetic CI verified; NOT DEPLOYED, NOT LIVE.** This procedure supersedes the older DevTools/Console workaround. It does not authorize real SMTP transmission, loosen CSP, bypass Cloudflare Access or establish provider acceptance.

## First-party owner acceptance

When the verified source has been deployed to an appropriately owner-protected acceptance environment, open that application's HTTPS URL in Safari on iPhone or in a desktop browser. Complete Cloudflare Access sign-in until the actual **Devon Station** workspace appears; a Cloudflare Access sign-in document is not the application. Navigate to **Mail**, then select **Check connection** in **Connection and release checks**. Do not paste code into Developer Tools.

The control is a user-initiated, read-only sequence:

1. Verify a top-level Devon Station document at a secure HTTPS origin (or browser-trusted local loopback in synthetic tests), including its restrictive HTML meta CSP with `connect-src 'self'`.
2. GET `/api/session`; require an authenticated signed owner session before any mail diagnostic request.
3. GET `/api/mail/status`; validate expected mailbox/provider and sanitized configuration flags.
4. GET `/api/mail/diagnostics`; the Worker independently requires verified Cloudflare Access identity and matching owner subject. It performs a **bound, owner-scoped aggregate D1 query** returning only `cacheReady`, `indexedCount` and `revision`. No message body, recipient, subject, ciphertext, credential, raw SQL or Access token is returned.

No diagnostic step performs IMAP login, provider synchronization, draft modification, outgoing preparation or SMTP submission. A green result proves only owner-facing application/auth/config/cache-metadata paths, **not** payload decryption, authentic IMAP, SMTP acceptance or actual delivery. The normal Mail inbox is intentionally separate from diagnostics and may display authenticated message text; its own read requests are not a diagnostic operation.

## Interpretation and fail-closed behavior

- **Signed owner session not established:** finish Cloudflare Access sign-in and open the actual application. A non-JSON/HTML sign-in response, 401/403 or redirect is never counted as an authenticated endpoint response.
- **Browser/network/CSP failure:** the browser blocked a request or the network failed. Do not diagnose Purelymail credentials from this signal. Keep strict CSP and investigate the actual served context.
- **Provider configuration incomplete:** existing account, password or encryption binding readiness is insufficient; no provider socket is opened by the diagnostic.
- **D1 metadata unavailable/invalid:** the endpoint fails closed without returning any row contents. Investigate bound database and applied schema, not SMTP.
- **Read-only checks completed:** configuration and aggregate cache metadata are reachable. Run separately authorized real provider and physical-device acceptance before production release.

## Candidate selection and current limitations

The older production deployment `890cc9d9-533b-4b9a-b326-26a7c4f88402` still routes 100% to legacy version `ce64277b-124b-4177-825a-8b51d997152b` and 0% to earlier candidate `1ba61404-f7f6-4b0b-8b55-6f9f52819e70`. **Neither contains the newly implemented panel**. Do not mistake reading the old application for testing this exact source. The next candidate must be independently staged with source/version parity, existing owner-only Access, correct binding names, encryption-key recovery, and sending disabled. The already-created isolated owner-only acceptance Worker may be used after a separately verified, approved deployment, but it currently lacks IMAP and SMTP credential bindings; do not copy or expose secrets between deployments.

The historical `tools/mail-owner-canary-console.mjs` and its unit tests remain as forensic evidence of the previous CSP-context problem; they are **not** the current owner acceptance procedure. A production 0%-traffic version is not automatically opened by a normal iPhone navigation, and a newly staged candidate is not verified merely because Cloudflare reports its version ID.

## Regression and production gates

GitHub exact-head synthetic tests cover signed owner/nonowner access, forbidden writes, provider sockets untouched by diagnostics, D1 plaintext/ciphertext absence from diagnostic responses, CSP/HTML sign-in/fetch failures, real Chromium 1440/390/320 widths, original inbox/draft/outbox behavior, production-safe build, privacy boundaries, native Workerd and generated rollback artifact. Synthetic localhost HTTP exceptions exist only for browser-trusted loopback; ordinary HTTP origins are refused.

After deployment, independently verify signed owner and nonowner Access behavior, genuine read-only Purelymail IMAP and encryption-backed inbox sync, stored message reading, sender/Sent-state reconciliation, real confirmed recipient delivery **only after separate approval to transmit**, device-specific Safari/PWA behavior, and recoverable rollback before promoting or merging the existing stack. Preserve the old live Worker and D1 data until all release gates pass.
