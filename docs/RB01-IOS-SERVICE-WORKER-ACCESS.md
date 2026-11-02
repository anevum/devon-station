# RB01 — iOS service-worker registration behind Cloudflare Access

**Status:** Proposed security-boundary fix. **NOT activated in Cloudflare.** Date: 2026-11-01.
**Owner:** Personal DevonStation RB01 isolated acceptance only. **Production remains unchanged.**

## Verified facts and hypothesis

- The owner's physical iPhone Home Screen app reaches the protected RB01 shell and owner-state revision 14.
- Notification setup fails at `navigator.serviceWorker.register('/sw.js', {scope:'/'})` with the browser `SecurityError: The operation is insecure`. "Retry setup" repeats that failure; permission and Apple Push delivery were never attempted.
- The isolated Cloudflare Access self-hosted application covers the **entire** `devon-station-rb01-isolated.devonakins.workers.dev` hostname and allows exactly one owner email.
- The application's Worker authenticates **before serving** `/sw.js`; it cannot serve that file to a request lacking valid Access identity. The standalone SW file is a generic event handler (push and notification-click) and does not contain workspace data, API tokens, cache interceptors, or private content.
- Cloudflare Access may redirect unauthenticated service-worker script fetches to the sign-in page, which service-worker registration cannot follow. This is the **leading hypothesis**, not a verified network trace from the iPhone. Other browser-specific causes remain possible. Do not broaden Access by guesswork.

Cloudflare documentation: [Workers Access and rule hierarchy](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [Application-path precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [Path-specific Bypass](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).

## Code prepared in draft PR #8

`worker/index.mjs` supports an **explicitly disabled-by-default** `PUBLIC_SERVICE_WORKER='true'` flag. With that flag enabled, it returns only a static `GET` or `HEAD` response for the **exact** `/sw.js` path with no query string, the original JavaScript MIME type, `Service-Worker-Allowed: /`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: no-store`, without requiring app identity. Wrong methods are rejected. All other URLs still require the exact signed owner identity, and wrong origins are rejected before this exception. The server must never return login pages or private data as service-worker JavaScript.

No Cloudflare binding, Access policy, routing, secrets, deployed Worker version, D1 or production site has been changed for this proposal. Existing VAPID credentials remain private on the isolated test Worker.

## Separate explicit authorization required before a live test

1. Obtain approval for **one narrowly scoped public Access exception** and the matching isolated Worker version/binding. Do not reuse this approval for production or any other host.
2. Create a separate self-hosted Access application for **exactly** `devon-station-rb01-isolated.devonakins.workers.dev/sw.js`, with a single `Bypass / Everyone` policy. Preserve the original hostname-wide one-owner Allow application unchanged. Cloudflare evaluates the more specific path application first. Bypass removes Access logging for that path; keep it restricted to the static worker script only.
3. Create a new isolated Worker version from the CI-verified PR head with only `PUBLIC_SERVICE_WORKER='true'` added to bindings, retaining current Access audience/issuer, original D1, owner/project grants, runtime, all VAPID bindings and the inherited private key. Keep the previous isolated version as rollback.
4. Validate **without an Access cookie**, on the live hostname, that `GET /sw.js` returns `200` JavaScript with `Service-Worker-Allowed: /`, no redirect, and no private information. Also validate that `GET /`, `GET /api/session`, `GET /index.html`, `GET /LICENSE.txt` remain Access-protected for a separate unauthenticated client, and never expose owner data. If either gate fails, **stop/roll back**. An internal Worker test alone cannot prove Cloudflare routing.
5. Owner reopens the **existing** Home Screen PWA (do not reinstall), attempts registration once, permits notifications via a direct button gesture and requests one generic test notification only if prior checks pass. A push-service acceptance response is not proof the alert appeared on the phone.

## Rollback and remaining gates

On error, restore the old isolated Worker version and remove the *specific* path-bypass application as a single bounded recovery (requires authorization). Verify owner-only Access and unchanged D1 immediately. Do not alter the original hostname policy, worker preview restrictions, production resources, or clinical/business content. A real denied nonowner Access session and eventual production release remain separate gates.

If the exception still does not resolve WebKit's error, revert it and investigate device/browser evidence instead of widening the bypass. 
