# Presence Studio — Manual-First Owner Workspace (01A)

Status: **source implementation / review only**. Target: the existing authenticated DevonStation host. This increment is neither merged into the recovery candidate nor deployed to production. It does not restart or bypass RB01 authentication, genuine owner/nonowner acceptance, or recovery gates.

## Owner workflow

Visit the Presence Studio section of the existing Station navigation.

1. Compose one original idea. Select Facebook, Instagram and/or Threads, provide editable platform-specific captions, and choose a format.
2. Review the intended audience, consent, rights to images/music, and family privacy. Saving produces a browser-local **draft only**.
3. Press **Prepare handoff** only when all selected channels have captions and the privacy review is checked.
4. Publish **manually in the native application**. Afterward, record that platform's HTTPS post URL. This is labeled **owner-entered**, not a verified provider response. Partial cross-posting is represented explicitly. The app never posts or schedules on Meta.
5. Record actual follower, view and engagement observations with the dashboard's original 7-, 28-, 30- or 90-day reporting window and observation date. Optional missing fields remain null. Viewers and views are not conflated. Account follower counts are never summed as unique people.
6. View the proposed 250 / 1,000 / 3,000 / 6,000 / 10,000 working checkpoints separately from the 1,000,000 Facebook and Instagram stretch ambitions. These are proposals, not probability-weighted forecasts.
7. Explicitly export/import a versioned JSON backup when moving between devices. Import replaces existing browser-local records only after confirmation; the importer sanitizes every record.

## Boundaries

- No Facebook, Instagram, Threads, cloud, ad-network, or contact-list API calls; no credentials, secrets, scraping, automated messages, social posting or social scheduling.
- No new D1 migration, Worker API, Cloudflare Access policies, encryption key, R2 bucket, provider account, recurring job, payment or other infrastructure change.
- Records are **unencrypted on the current browser device**, kept under `devon-station:presence:v1`; they are **not** included in existing StationCloud owner-state sync, its journal, existing encrypted backup or server-side recovery. This is visible in the UI.
- Do not save identifiable children, private family/location/contact information, DMs, clinical, banking, identity or password data. A keyword guard only catches some cases; it does not replace judgment.
- Multi-tab conflicts are detected and **refuse silent overwrite**. Export and reload before retrying, or explicitly confirm an imported replacement. Storage-disabled sessions require an export.
- Recording a URL does not verify it exists or that the author owns it. URL validation rejects non-HTTPS/unrecognized platform/profile URLs and strips common tracking query fields.
- A personal Facebook Professional Mode profile is not equivalent to a Facebook Page API account. Direct provider integrations are deferred until verified account eligibility, approved scopes and separate authorization.
- Source is public under the project's existing AGPL-3.0 license; only synthetic records belong in source/tests.

## Files

- `src/presence-core.mjs`: bounded, pure source record validators, provenance, imported-record sanitization and milestone calculations.
- `src/presence-ui.js` and `src/presence.css`: view and interactions in the existing private owner shell, not a second standalone hosted app.
- `src/core.mjs`, `src/app.js`: navigation entry and renderer.
- `tools/build-hosted-shell.mjs`: bundles Presence Studio into the existing hosted shell while preserving the original private-inventory exclusion.
- `tests/presence-core.test.mjs`: synthetic lifecycle, data-safety, post-URL, snapshot and goal tests.

## Review gates

1. Run `node --test tests/presence-core.test.mjs`, `npm test`, `npm run build`, `npm run verify:privacy` and the existing DOM/browser smoke suites.
2. Confirm the original owner-only Access boundary and the existing service-worker and backup contracts remain unchanged; test on iPhone/Safari and desktop before release.
3. Validate real-device offline data export/import and multi-tab collisions with synthetic records only.
4. Audit mobile layout 320/390px and desktop with keyboard, visible focus, labels, screen-reader announcements and reduced-motion preference. Account for new sidebar navigation scrolling.
5. Review existing RB01 draft PR and obtain independent release approval before merge or deploy. Never treat the existence of this source as a LIVE capability.

Future increments: scoped encrypted/cloud-synced private data, native-platform handoff support, safe media library, per-post 7/28-day metrics, structured relationship reflections, and officially approved Instagram/Threads API access only when separately justified.
