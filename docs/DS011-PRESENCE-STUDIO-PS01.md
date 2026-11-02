# Presence Studio — Manual-first personal social management (DS011-PS01)

**Status:** Source-only feature branch, not production. **Owner:** Devon. **Scope:** personal Facebook Professional Mode, Instagram and Threads. **Source:** `feature/ds011-presence-studio-manual-v1`, branched from protected RB01 review head `d9c629550551db95db0c376691d05d11a1b8537a`.

## User-visible scope

- A new **Presence Studio** navigation section with distinct Facebook, Instagram and Threads follower cards. Empty metrics are shown as unavailable, not zero or fabricated live analytics.
- A single creator desk with three editable platform-specific captions, format selection, opt-in target platforms and explicit family/media privacy review.
- Local editorial queue; preview/edit before publishing; transition to **Ready** only after review and nonempty destination captions; manual native publishing. Copying captions does not publish.
- Owner-entered published post URLs validated against each supported platform's HTTPS domain; labeled *owner-entered*, not confirmed by Meta APIs. Already published content cannot be silently edited.
- Manual follower, views and engagement observations in explicit 7/28/30/90-day reporting windows. Missing optional metrics remain null. Duplicate platform/date/window snapshots refused.
- An evidence-labeled goals panel computes the next proposed working milestone from an entered Facebook/Instagram snapshot, separately from the 1,000,000-follower stretch ambition. Without an observed baseline, progress is unavailable, never zero.
- Browser-local JSON import/export with bounded size and strict input sanitation, plus confirm-to-delete individual drafts.
- Responsive mobile/desktop layout. Uses existing accessible DevonStation contrast/focus/motion rules.

## Ownership, privacy and data honesty

- `src/presence-core.mjs` contains the pure validated contract and is directly unit-testable.
- `src/presence-ui.js` stores `{version:1,drafts,snapshots}` under `devon-station:presence:v1` in **unencrypted localStorage**. This is intentionally **not** part of the existing owner-state sync journal; the current Cloudflare Worker/D1 does not accept or persist Presence Studio data. It is **not cross-device**. A tab-conflict banner warns of concurrent writes.
- Never enter credentials, private DMs, identifiable third-party contacts, financial information, protected clinical data or children's private details. A checkbox is not proof of consent from others.
- No Meta API, OAuth, Cloudflare secrets, Meta scraping, autoposting, scheduling, new infrastructure or new dependencies.
- The source tree includes no real historical follower metrics. If a user enters old observations, timestamps and "manual" provenance remain explicit.
- One record per personal content idea; platform versions share a draft but have separate captions and publication links.

## Build and verify

The existing `tools/build-hosted-shell.mjs` now bundles Presence Studio core/UI/CSS directly into the same existing owner-authenticated HTML shell. No new route or public endpoint is added.

```sh
npm ci --ignore-scripts
node --test tests/presence-studio.test.mjs
npm test
npm run build
npm run verify:privacy
npm run test:runtime:dom
```

Relevant acceptance: invalid URLs and text rejected, privacy check required for ready state, no implied publication, metrics are source-labeled, CSS at 320px/390px/desktop does not overflow, and unrelated owner-recovery behavior remains intact. Native iOS/real Access and CI tests remain separate.

## Release gates and next slice

This PR targets **draft RB01 PR #8** rather than `main`. Do not merge/deploy until the RB01 release/identity/recovery gates have passed and a specifically authorized integrated release has been reviewed. A successful source test does not make the feature live.

Next independent slice: source-only first-party encrypted owner-data persistence design with explicit user migration/export, conflict receipts and cross-device recovery. Only after that, evaluate eligible Instagram/Threads APIs with OAuth approval. **Facebook Professional Mode personal-profile features remain manual until a documented permitted API is verified.**

The previously paused unrelated DevonStation calendar and business work is not restarted by this targeted social module.
