# DS011-RB02-01C — Private edition reader and anchored discussion UI

**Status:** source-only, synthetic nonclinical demonstration. **Owner:** DevonStation / Workspace Core. **Stack:** RB01 draft PR #8 → RB02-01A draft PR #10 → RB02-01B draft PR #11 → this review. Nothing here authorizes a merge, deployment, real-member Access rule, actual D1 migration, or clinical data.

## One complete interaction

1. An authorized member reads the exact published article and source revision at `GET /newsroom/reader/:editionId/revisions/:version`.
2. Each existing immutable block has a `Discuss passage` control. Selecting it loads `GET /api/newsroom/conversations/:revisionId/:blockId`. The UI checks the returned digest and exact anchor before showing the quote or messages.
3. An authorized publisher, commenter, or owner can post up to 1,600 characters to that exact block using the existing `POST .../messages` contract. Read-only readers cannot post. Replies are never interpreted as authorization or an operational task.
4. An uncertain post keeps the draft and reuses its operation ID on retry; a confirmed server receipt clears it. Session expiry, redirects, HTML masquerading as JSON, 404 revocation, and source-integrity mismatches fail visibly and do not clear the draft.
5. Closing the mobile drawer returns keyboard focus to the relevant paragraph. The reading experience also works without JavaScript or in print (discussion unavailable).

## Implementation

- `worker/newsroom-reader.mjs` is an **unmounted** Worker view handler that composes the existing signed-identity `createNewsroomHandler` API, database-verified membership and an immutable edition response. It revalidates the source digest before rendering; unauthorized users receive no title/content. It does not modify any RB01/01A/01B production route or permission.
- Rendering uses a no-dependency, newspaper-style HTML/CSS structure and a tightly scoped static inline script carrying a per-request cryptographic CSP nonce. Comments and author identifiers enter the document via DOM `textContent` only; published original text is HTML-escaped on the server. No remote fonts, trackers, scripts, images, SDKs, or new infrastructure.
- Page returns `Cache-Control: private, no-store`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, restrictive CSP (`script-src` nonce, `connect-src 'self'`, `frame-ancestors 'none'`) and `nosniff`.
- Desktop layout: table of contents, editorial sheet, sticky conversation desk. Narrow screens: horizontal article index, full-height conversation drawer, Escape/close focus return, mobile viewport safe-area padding. User-adjustable text and reduced-motion preferences retained. The static edition and print view remain available through 01A.
- The UI reflects current **backend limitation**: the first 100 messages are displayed with an explicit truncation warning when more exist; pagination, moderation, rate limiting, archival interface, encryption and real-person identity labels remain future work.

## Verification evidence to attach before merge

- Node 22 synthetic SQLite: `node --test tests/newsroom-reader.test.mjs` covering authorized/unauthorized/read-only roles, forged claims, XSS escaping, CSP/nonce, version separation, configuration/no-origin failures and no database mutation. Existing `tests/newsroom-conversations.test.mjs` continues to pass.
- Pinned workerd native D1: `npm test --prefix workerd-test` after adding `newsroom-reader.test.mjs` to the existing native runtime suite. Requires publisher/reader/commenter signed synthetic Access subjects and separate D1; revoke must deny both page and conversation.
- Local browser smoke (not automatically part of GitHub workflows): Chromium desktop 1440px and phone widths 390px/320px. Assert zero horizontal overflow and page errors, keyboard/drawer focus, successful reply, saved draft across authentication loss/unexpected HTML, and no submission on mismatched source digest. Browser synthetic `fetch` was stubbed on a blank page because the container disallows navigation to external/local origins; this does **not** test live network, actual iOS Safari, or Cloudflare Access sessions.
- Exact-head GitHub Actions: full application, foundation, pinned workerd, build, privacy, DOM and rendered-browser CI. Review only after green tests.

## Explicit non-goals and release gates

The endpoint is not mounted in `worker/index.mjs`, neither merged nor deployed. No Access identities/policies, new D1 database, provider binding, domain, billing, actual clinical data, real-user messaging, direct messaging, topic rooms, notifications, publish to external audience, or business decisions. This test-only reader is NOT a production communications service. RB01 recovery and actual independent Access acceptance remain separate prerequisites; then a reviewed isolated hosted synthetic Cloudflare trial and eventual accessibility/retention/security acceptance would be required. The new reader is not permission to invite staff or clients.
