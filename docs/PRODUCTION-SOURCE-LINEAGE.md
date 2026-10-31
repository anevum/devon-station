# Production source lineage checkpoint

On October 30, 2026, a read-only inspection of the live V0.3 Worker returned
four modules. Their SHA-256 hashes matched the corresponding four modules in
the private V0.3 recovery bundle, including `worker/index.mjs` at
`b2974dde4ca177420caecd810b8f008d582c93131317c6a822b5bb821c3c8c94`.
The original server module is preserved under `legacy/v03/worker/index.mjs`.

The V0.3 authentication and notifications modules matched the later recovered
versions; the V0.3 server entry differs from the later server entry, and its
live bundle had no separate state or portfolio module. The live asset entry is
not published here because it requires its own privacy and rights review.
This historical comparison does not prove current parity after this date, or
verify configuration, database restoration, real user access, or deployment
readiness. Neither source recovery branch is a deployment owner.
