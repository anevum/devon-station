# DS011-RB02-01A — Source-only immutable Newsroom edition

**State:** source-only feature candidate, not deployed, merged or enabled in the existing Worker. **Owner:** `anevum/devon-station`. **Issue:** [#9](https://github.com/anevum/devon-station/issues/9). **Base:** current RB01 draft branch (stacked review). **License:** repository AGPL-3.0-only.

## What is implemented in source

- `worker/newsroom.mjs`: an **unmounted** independent request handler for one fictional, nonclinical organization. Cloudflare Access must validate a trusted user subject; active role membership is fetched server-side from the Newsroom DB. Browser-supplied role, subject or org cannot confer access. All writes require same-origin JSON. No role grants, Cloudflare policies or production Worker routes change.
- `worker/newsroom-contract.mjs`: strict, size-bounded original text blocks with stable anchor IDs, safe HTTPS citation URLs, canonical JSON and SHA-256 of immutable published source. No images, PHI, copyrighted test materials or file uploads.
- `worker/migrations/0004-newsroom-p1a.sql`: proposed additive D1 schema for separate **synthetic-only** target. A publish trigger checks optimistic generation and current version, and immutable triggers forbid revision or published-block updates/deletes. This file is **not** applied by the build or by request handling.
- `worker/newsroom-render.mjs`: static, script-free, print-friendly accessible HTML edition with article navigation and responsive typography. It is intentionally smaller than the visual Newsroom prototype: real discussion/chat is not in this feature.
- `worker/newsroom-recovery.mjs`: an **offline function only** to restore a published-edition archive into an independently created, empty synthetic org with matching active fictional publisher identities. No remote import endpoint or permissions bypass exists.
- `tests/newsroom-editions.test.mjs`: Node 22+ synthetic SQLite/D1-equivalent transaction testing, signed fabricated Access verification, publication/revision and privacy checks, export/empty-target restore. `node:sqlite` is experimental in Node 22; the actual D1/workerd runtime is not validated by these tests.

## Deployment boundary and prerequisites

1. **Do not add this handler to the existing `worker/index.mjs`** or remove its owner-email restriction. RB01 has not completed its production safety gates.
2. The handler is inert without **all** of: a separately authorized and verified Cloudflare Access protected test origin, a **dedicated empty synthetic D1** with the migration applied under review, an explicit nonclinical organization and approved test subjects, `NEWSROOM_SYNTHETIC_ONLY='true'`, `NEWSROOM_DB`, `NEWSROOM_ORG_ID`, `APP_ORIGIN`, and pinned `ACCESS_AUD` / `ACCESS_ISSUER` / `ACCESS_JWKS_URL` (as required by the existing trusted Access boundary).
3. The `ctx.access` identity is trusted only within a verified Access-protected Workers deployment. Never inject it from a request header or browser payload. New org subjects require a separately approved multiuser policy and actual nonowner denial tests. Do **not** reuse RB01's single-owner test scope for this.
4. Every real D1 migration, binding change, Access grant, deployment, invitation, production cutover or external publication requires its own approval. No ChatGPT/Notion credentials, clinical data or actual center content in a first test.

## HTTP contract — separate future test handler only

| Route | Authorization | Behavior |
|---|---|---|
| `GET /api/newsroom/editions` | active reader+ | List released issues, no draft titles |
| `POST /api/newsroom/drafts` | publisher/owner | Create structured source draft |
| `GET /api/newsroom/drafts/:id` | publisher/owner | Read current draft generation |
| `PUT /api/newsroom/drafts/:id` | publisher/owner | Optimistic generation-controlled edit |
| `POST /api/newsroom/drafts/:id/publish` | publisher/owner | Atomic immutable version, idempotent operation receipt |
| `GET /api/newsroom/editions/:id/revisions/:version` | active reader+ | Published manifest, digest, and stable anchors; `?format=html` is accessible static edition |
| `GET /api/newsroom/editions/:id/export` | active reader+ | Published versions and publish-retry metadata, **no hidden drafts** |

No thread routes, topic rooms, private messages, automated notifications, AI workflows, clinical records, multi-tenant invites or publication to public audiences exist here. A read/annotation is never an organizational approval.

## Verification and recovery expectations

Run from the repository root using existing scripts: `npm test`, `npm --prefix foundation test`, `npm run build`, `npm run verify:privacy`, `npm run test:runtime:dom`, relevant browser/workerd suites, and `git diff --check`. The added standalone test file can be exercised with `node --test tests/newsroom-editions.test.mjs` independently. Exercise 320/390/1440px render, keyboard skip link, and no horizontal overflow. **Local browser injection is not a real Access test or production deployment.**

For isolated recovery, `GET /export` yields published revisions with source SHA-256, original revision IDs, block IDs, and operation receipts. `restoreSyntheticEdition()` is not a network endpoint; it checks that the independently approved fictional destination is empty, is the same `orgId`, and contains the expected active fictional publishers; it rejects tampering before any transaction. Do not apply the restore function to patient/business records. Never import this archive into an existing journal or nonempty D1.

**Rollback:** Since this stage changes no deployment, removing the stacked source branch suffices to abandon the code candidate. The migration file has not been applied; no runtime DB or existing tables are affected. Later separately approved D1 testing must document snapshot, additive migration rollback, retained history, compatible bundle and real nonowner denial before release.

## Next gated increment

**RB02-01B:** one real authenticated paragraph-anchored thread shared between two distinct authorized test subjects, with durable receipts, retained revision references, secure org isolation, export/recovery and a corrected mobile discussion UI. Do not begin this as a production route until 01A and the RB01 gate are independently accepted.
