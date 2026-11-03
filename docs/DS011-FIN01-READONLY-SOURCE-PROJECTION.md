# DS011-FIN01 — Financial source projection (draft, source-only)

## Current scope

This additive, source-only change implements a GET-only, owner-bound `/api/finance/summary` within DevonStation's authenticated Worker. It is stacked on the existing RB01 integration branch because `main` is still a recovery stub, and must not be merged or deployed until RB01 release gates are met. It does not activate live banking, payments, transfers, brokerage order entry, or production secrets.

## Provider adapters

- **Mercury:** server-side GET request to `https://api.mercury.com/api/v1/accounts?limit=1000&order=asc`. Output allowlist: account label, kind, status, current and available balance in exact *decimal cent strings*. Omit raw account IDs, account/routing numbers, legal names and all other bank data. If the provider indicates more pages or returns an ambiguous/malformed amount, report `unavailable` rather than incomplete totals. No provider tokens or raw responses are serialized.
- **Alpaca:** server-side GET-only calls to `https://paper-api.alpaca.markets/v2/account` and `/v2/positions`. Expose only account state, aggregate equity/cash/buying power, position count and `mode: paper`; no positions, account IDs, orders or keys. `ALPACA_FINANCE_MODE=live` returns `live_access_not_authorized` without contacting a live endpoint.
- Both sources independently report `available`, `unavailable` or `not_configured`; bank balances and paper-market values are intentionally **not** combined into a financial net-worth claim.
- **TPD:** returns `unavailable_pending_reconciliation` until complete dated broker valuations and external cash transfers can be independently reconciled with RHEN TPD% PR #497. This report is distinct from any promised rate of return or bank interest.

## Access and provider credentials

- DevonStation's existing Cloudflare Access-signed owner authentication still precedes the endpoint. The authenticated subject must additionally match the `FINANCE_OWNER_SUBJECT` Worker environment binding.
- `FINANCE_READ_MODE=read_only` is required. There is no finance route that accepts POST, PUT, PATCH or DELETE, and any query string is rejected. No D1 migration, storage, scheduled background job or cross-account combining is added.
- Unconfigured sources make **zero upstream requests**.
- Configure only after independent permission review: `MERCURY_FINANCE_READ_TOKEN` is a separate backend **read-only** Mercury API token, not the token or authenticated session used by ChatGPT's Mercury connector. `ALPACA_FINANCE_PAPER_KEY`, `ALPACA_FINANCE_PAPER_SECRET`, `ALPACA_FINANCE_MODE=paper` are separate restricted paper broker credentials. Never commit credentials in public source, Notion, logs or client code.
- Provider HTTP responses are byte-bounded (1.25 MB), time-bounded (8 seconds), redirect-rejecting and parsed with strict complete evidence checks. Failed providers only return coarse `unavailable` metadata, not provider response bodies or secrets. Response inherits `Cache-Control: no-store, private`.

## Verification and release conditions

Run `node --test tests/finance-readonly.test.mjs tests/finance-route.test.mjs` and `npm test` at the *exact candidate head*, then the existing npm build, privacy checker and relevant Worker/runtime-browser suites. Test real signed owner/nonowner identities and provider sandbox/read-only entitlements before considering deployment. The source-only synthetic tests cannot prove Mercury API authorization, account onboarding, Alpaca access, or complete portfolio reconciliation.

**No merge or deployment is approved by this PR.** Preserved source ownership: RHEN calculates investment account TPD and strategy risk; DevonStation displays private owner-bound, read-only bank/paper brokerage sources; Mercury and Alpaca each remain their own financial custody.

Related: [RHEN TPD source-only PR #497](https://github.com/devonalanakins/rhen/pull/497), [DevonStation RB01 review PR #8](https://github.com/devonalanakins/devon-station/pull/8).
