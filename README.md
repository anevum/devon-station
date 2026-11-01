# DevonStation

DevonStation is Devon Akins's personal operating workspace: source-linked projects, scoped proposals and decisions, durable receipts, private capture and encrypted portable recovery. Original software and the original DS icon are licensed under **GNU AGPL version 3 only**. See [LICENSE](LICENSE).

## Development status

The unified recovered application is now present in the review branch, including frontend, build tools and approved replacement PWA artwork. It is a tested development candidate, not an accepted production cutover. The recovered authentication implementation and legacy recovery history remain preserved. [Draft PR #8](https://github.com/anevum/devon-station/pull/8) contains the combined review.

Use fabricated records for development. Each subject/principal/scope and project grant is supplied by trusted server configuration. Approving an action records a decision; the journal has no external dispatcher. Client-encrypted recovery requires explicit review and an empty authorized target. Source changes retain action/receipt history; removing projects with history requires a separate retention policy.

## Build and verify

Node 22 or later:

```sh
npm ci --ignore-scripts
npm test
npm --prefix foundation test
npm run build
npm run verify:privacy
npm run test:runtime:dom
```

The build creates an empty-of-private-data hosted shell and a protected Worker module bundle. Generated outputs, private review records, database exports, browser results and credentials are excluded from Git history.

For browser suites, install `requirements-browser.txt` in a Python environment and supply `DS_CHROME` pointing to a supported Chromium executable:

```sh
npm run test:runtime:browser
npm run test:browser
```

The full-shell browser suites use generated test identities and isolated synthetic data; the older Python suites simulate private APIs. Workerd compatibility is independently tested with pinned dependencies in `workerd-test/`. Neither test substitutes for real Cloudflare Access or authentic production recovery.

## Architecture and release gates

Cloudflare-first, portable application contracts and replaceable adapters. Worker authentication, source cache and scope authorization sit in front of the foundation project/decision model. The current journal adapter uses Node crypto compatibility; deploy only with independently verified bindings and compatibility configuration. The additive scoped-journal migration is never run automatically by an HTTP request.

Before production: physical iPhone/Safari/PWA/push acceptance, named Access owner/nonowner sessions, authentic isolated D1 export/restore, deployed-source/configuration parity and a guarded rollback. Clinical records and cross-business pooling are outside this candidate's authorization. Merge, deployment, real-data movement and infrastructure retirement require their own acceptance and authorization.

[Runtime contract](docs/RB01-UNIFIED-RUNTIME-2026-10-31.md) · [Journal recovery](docs/RB01-JOURNAL-RECOVERY-2026-10-31.md) · [Source import](docs/SOURCE-IMPORT-2026-10-31.md) · [Workerd test](docs/RB01-WORKERD-COMPATIBILITY-2026-10-31.md)

[Current release comparison, ordered acceptance and guarded fallback](docs/RB01-RELEASE-ACCEPTANCE.md) records the remaining production gates and the offline six-table fallback rehearsal.
