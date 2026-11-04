# DS011-COMMS-19 — Browser owner acceptance preflight

November 3, 2026. This corrects an ambiguous manual testing procedure; it does **not** lower the application Content Security Policy, activate SMTP, or establish real provider acceptance.

## What the browser error proves

The owner reported three `TypeError: Failed to fetch` errors. Chrome/Edge explicitly reported **Content Security Policy refused the connection** for both `/api/session` and `/api/mail/status`. As these never reached an HTTP response, they do not establish a failed IMAP login, bad mailbox app password, encryption-key failure, or D1 fault.

An independent Cloudflare Browser Rendering request without a signed owner session received **`Sign in ・ Cloudflare Access`** at `https://ds.devonakins.com`. That login page is *not* the DevonStation owner application; it can enforce a different CSP. The owner may also have used the wrong Developer Tools execution context. **The screenshot alone cannot distinguish those possibilities.**

The candidate owner application's HTTP CSP in `worker/index.mjs` and compiled HTML's meta CSP both declare `connect-src 'self'`. The hosted-shell build replaces source template `connect-src 'none'` with `connect-src 'self'`. Cloudflare zone response-header rulesets have no custom CSP transformer. Keep deny-by-default `default-src 'none'`; do not add `*`, disable CSP or bypass Access to make a test pass.

## Bounded, read-only preflight

On a laptop:

1. Visit `https://ds.devonakins.com` and complete Cloudflare Access authentication until the actual **Devon Station** page, navigation rail and workspace are visible. A page titled **Sign in ・ Cloudflare Access** is not sufficient.
2. Open Developer Tools Console **on the DevonStation tab and its top-level frame**. The linked `tools/mail-owner-canary-console.mjs` is an audited, self-contained read-only browser acceptance script. Copy its contents into the Console; do not use an unrelated file-preview context.
3. Observe `DS-MAIL-ACCEPTANCE` results. Preflight verifies HTTPS origin, top-level frame, actual application DOM, and same-origin **HTML meta** CSP before any network call. A denied preflight makes **zero** requests.
4. If preflight passes, the script performs **GET** `/api/session` first and only proceeds when it receives `authenticated: true` as owner JSON. It then explicitly selects the `0%` read-only canary by setting `Cloudflare-Workers-Version-Overrides: devon-station="1ba61404-f7f6-4b0b-8b55-6f9f52819e70"` for **GET** `/api/mail/status`.
5. The console emits only stage, verdict, HTTP status and safe boolean configuration flags. No email bodies, credentials, Access tokens, private headers or user details are logged or copied.

Interpretation: `NOT_APP` means finish Access sign-in; `WRONG_FRAME` means switch Console execution context; `BLOCKED_BY_PAGE_CSP` means investigate the delivered page's CSP before changes; `NETWORK_OR_CSP_BLOCK` means a request was blocked and requires browser evidence; `LOGIN_REDIRECT` or `NOT_JSON` means authentication/session response is not verified. `OWNER_SESSION_VERIFIED` + `STATUS_RECEIVED` is an authenticated **configuration** result only. It **does not** prove real IMAP or SMTP connectivity.

## Explicit release boundaries

Cloudflare deployment `890cc9d9-533b-4b9a-b326-26a7c4f88402` routes **100%** of ordinary production traffic to previous Worker `ce64277b-124b-4177-825a-8b51d997152b`; canary `1ba61404-f7f6-4b0b-8b55-6f9f52819e70` receives **0%** absent an explicit version override. Canary `MAIL_ENABLED` and `MAIL_DRAFTS_ENABLED` are true, but `MAIL_SEND_ENABLED`, `MAIL_OUTBOX_ENABLED` and `MAIL_SENDER_VERIFIED` remain **false**. Never enable real sending, merge the stacked PRs or promote this candidate based on a browser preflight alone.

The next independent release gates remain authenticated owner/nonowner runtime, real Purelymail read-only IMAP sync and encrypted storage confirmation, safe SMTP test with recipient-side delivery evidence and provider Sent reconciliation, iPhone/Safari/PWA acceptance and source-to-production parity/rollback. Do not put credentials, mail content, or JWTs into logs, screenshots, GitHub, or Notion.

## Reproducible test evidence

`node --test tests/mail-owner-canary-console.test.mjs` exercises six negative/positive cases: Access sign-in page, wrong origin/frame, restrictive CSP, valid owner request ordering, TypeError handling and HTML/401 response rejection. The suite uses Node built-ins with no external network or dependencies. It is **synthetic regression evidence**, not a live browser/provider test.
