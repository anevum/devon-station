# DS011-FIN01 — Financial source projection (draft, source-only)

## Current scope

This additive, source-only change implements a GET-only, owner-bound `/api/finance/summary` within DevonStation's authenticated Worker. It is stacked on the existing RB01 integration branch because `main` is still a recovery stub, and must not be merged or deployed until RB01 release gates are met. It does not activate live banking, payments, transfers, brokerage order entry, or production secrets.

## Provider adapters

- **Mercury:** server-side GET-only requests to `https://api.mercury.com/api/v1/accounts` with `limit=100`, `order=asc`, and a bounded `start_after` cursor chain. Read the required nested `page.nextPage` UUID, fetch every page (maximum 10), and reject missing cursor metadata, duplicate IDs, failed pages, cursor loops and oversized responses. Output allowlist: **owned Mercury** account label, kind, status, current and available balances in exact decimal cent strings. Exclude linked/external accounts from owned cash; omit raw account IDs, account/routing numbers, legal names and all other bank data. Incomplete evidence reports `unavailable` rather than a misleading partial total. No provider tokens or raw responses are serialized.
- **Alpaca:** server-side GET-only calls to `https://paper-api.alpaca.markets/v2/account` and `/v2/positions`. Expose only account state, aggregate equity/cash/buying power, position count and `mode: paper`; no positions, account IDs, orders or keys. `ALPACA_FINANCE_MODE=live` returns `live_access_not_authorized` without contacting a live endpoint.
- Both sources independently report `available`, `unavailable` or `not_configured`; bank balances and paper-market values are intentionally **not** combined into a financial net-worth claim.
- **TPD:** returns `unavailable_pending_reconciliation` until complete dated broker valuations and external cash transfers can be independently reconciled with RHEN TPD% PR #497. This report is distinct from any promised rate of return or bank interest.

## Access and provider credentials

- DevonStation's existing Cloudflare Access-signed owner authentication still precedes the endpoint. The authenticated subject must additionally match the `FINANCE_OWNER_SUBJECT` Worker environment binding.
- `FINANCE_READ_MODE=read_only` is required. There is no finance route that accepts POST, PUT, PATCH or DELETE, and any query string is rejected. No D1 migration, storage, scheduled background job or cross-account combining is added.
- Unconfigured sources make **zero upstream requests**.
- Configure only after independent permission review: `MERCURY_FINANCE_READ_TOKEN` is a separate backend **read-only** Mercury API token, not the token or authenticated session used by ChatGPT's Mercury connector. `ALPACA_FINANCE_PAPER_KEY`, `ALPACA_FINANCE_PAPER_SECRET`, `ALPACA_FINANCE_MODE=paper` are separate restricted paper broker credentials. Never commit credentials in public source, Notion, logs or client code.
- Provider HTTP responses are byte-bounded (1.25 MB), time-bounded (8 seconds), redirect-rejecting and parsed with strict complete evidence checks. Failed providers only return coarse `unavailable` metadata, not provider response bodies or secrets. Response inherits `Cache-Control: no-store, private`.

## Release packaging compatibility

This source branch additionally updates the **review-only** RB01 package verifier
(`tools/prepare-rb01-review.mjs`) to recognize the finance Worker import:
the original 12-module recovery-only package remains valid, and the 13th
`worker/finance-readonly.mjs` module becomes mandatory when
`worker/index.mjs` imports it. Unreferenced additional modules and a missing
imported finance module are rejected. The guarded legacy fallback **remains
four modules** with no finance backend. Review manifests use the exact
`sourceCommit` as provenance and leave `sourceBranch` unasserted, so a
stacked or detached CI checkout is not misreported as RB01's original branch.

`tests/release-preparation.test.mjs` adds synthetic module-graph acceptance
and negative cases. This resolves an otherwise deterministic finance review
bundle rejection after FIN01 expanded the generated bundle from 12 to 13
modules. Only source/isolated tests are available while GitHub Actions remain
queued; this does not authorize production packaging or deployment.

## Verification and release conditions

The isolated finance adapter suite contains 15 synthetic test cases, including multi-page Mercury cursors, duplicate detection, failed second pages and external account exclusion. Run `node --test tests/finance-readonly.test.mjs tests/finance-route.test.mjs` and `npm test` at the *exact candidate head*, then the existing npm build, privacy checker and relevant Worker/runtime-browser suites. Test real signed owner/nonowner identities and provider sandbox/read-only entitlements before considering deployment. The source-only synthetic tests cannot prove Mercury API authorization, account onboarding, Alpaca access, or complete portfolio reconciliation.

**No merge or deployment is approved by this PR.** Preserved source ownership: RHEN calculates investment account TPD and strategy risk; DevonStation displays private owner-bound, read-only bank/paper brokerage sources; Mercury and Alpaca each remain their own financial custody.

Related: [RHEN TPD source-only PR #497](https://github.com/devonalanakins/rhen/pull/497), [DevonStation RB01 review PR #8](https://github.com/devonalanakins/devon-station/pull/8).
