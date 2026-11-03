# DS011-FIN02 - owner-only Finance screen (source-only)

## Status

Source implementation lives in draft stacked review branch
`feature/ds011-fin02-private-finance-screen-20261103`, based on FIN01
`feature/ds011-fin01-readonly-sources-20261103`. This is **NOT merged,
deployed, configured for real financial providers, or live**.

## User outcome

The existing DevonStation PWA gains a **Finance** navigation section with:

- Mercury banking account cards: independent current and available balances, exact cents, and provider status. An unfunded account is shown as `$0.00`, not `unavailable`.
- Alpaca **PAPER / SIMULATED** card: paper equity, paper cash, paper buying power, and count of open paper positions. Never add these values to real bank balances.
- TPD% research: explicitly `Not available` pending complete, verified cash-flow-adjusted broker valuation history from RHEN. A 0.1% daily research target is not presented as a yield, promise, or earned performance.
- Explicit notice that no banking transfers, broker orders, live strategies, automated allocation, or net-worth aggregation are available.
- An owner-triggered **Refresh read-only data** control. No polling, localStorage, IndexedDB, analytics, or source data persistence is introduced.

All external provider observations are fetched via the signed-owner
`GET /api/finance/summary` server route from FIN01. The browser makes
exactly one same-origin GET request when opening or refreshing this panel.
Requests use `credentials: same-origin`, `redirect: manual` and
`cache: no-store`.

## Security and correctness

- The existing signed Cloudflare Access identity check precedes the route,
  plus the FIN01 `FINANCE_OWNER_SUBJECT` server-side binding.
- The browser independently validates the v1 response schema, capabilities
  all being `false`, two read-only source descriptors, timestamp,
  Mercury account list, cent strings, paper-only broker values and
  TPD provenance status. Any unsafe/incompatible payload fails closed,
  with **no balances shown**.
- No raw banking account ID, routing number, developer token, or unknown
  provider field is emitted into the UI.
- Provider-controlled text uses `textContent`, never interpolated HTML,
  and never enters error messages, URLs or data attributes.
- Route and bank/source failures are explicit and do not turn into
  fabricated `$0` balances. A 401/403 or HTML sign-in redirect cannot
  populate financial cards.
- Section switches abort in-flight requests and prevent stale data from
  being displayed on a later route. Manual refresh does not authorize
  any side effect.
- Existing keyboard Alt1-Alt9 and Alt0 section shortcuts are preserved.
  Finance is independently reachable through navigation and search.
- The rail gains vertical scrolling at small heights so eleven sections
  remain reachable. Breakpoints use one-column financial cards on
  smaller screens and stacked metrics on narrow phones.

## Source and review boundary

- New: `src/finance-view.mjs` (pure normalization/currency formatting),
  `src/finance-ui.js` (safe ephemeral DOM), `src/finance-ui.css`,
  `tests/finance-view.test.mjs`, `tests/finance-ui.test.mjs`.
- Updated: `src/core.mjs`, `src/app.js`,
  `tools/build-hosted-shell.mjs`, and `tests/hosted-build.test.mjs`.
- FIN01 also fixes the previously missing `worker/finance-readonly.mjs`
  entry in the generated Worker module bundle and its packaging test.
- The hosted shell embeds the pure contract, UI runtime and style
  through the **existing** build process; no replacement application,
  external frontend framework, CDN or external service is introduced.
- No real banking or brokerage details are checked into source.

## Reproducible acceptance

```sh
node --test tests/finance-view.test.mjs tests/finance-ui.test.mjs
npm ci --ignore-scripts
npm test
npm run build
npm run verify:privacy
npm run test:runtime:dom
npm run test:runtime:browser
```

Additional gates: test sign-in and non-owner denial on the real Access-protected
origin, verify actual configured **read-only** Mercury developer API permissions,
verify Alpaca paper credentials and accurate account scope, reconcile TPD against
broker evidence, check accessible keyboard/focus and viewport behavior on an iPhone,
and obtain explicit production release authorization. Do not claim that a locally
rendered/synthetic finance screen proves a live account integration.

No merge, live deployment, provider credentials, permission changes, movement
of money, or broker order placement is approved by this source-only review.
