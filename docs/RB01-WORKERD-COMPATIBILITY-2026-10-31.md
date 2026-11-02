# RB01 local workerd compatibility

The public recovered Worker and foundation module graph execute inside local `workerd` using Miniflare `4.20260730.0`, the lockfile-pinned `workerd` `1.20260730.1`, compatibility date `2026-07-30`, and the `nodejs_compat` flag. This is a synthetic test configuration, not evidence of the current production Worker's settings.

Run `npm ci --prefix workerd-test --ignore-scripts --no-audit --no-fund` and `npm test --prefix workerd-test`. The fixture Worker injects generated RSA-signed synthetic Access identities through the existing verifier and supplies two separately initialized in-memory D1 instances. It calls the actual `createStation` Worker and scoped foundation modules, not a mock implementation. The fixture-only initialization and metadata-change endpoints are never part of the application Worker.

The test verifies owner access, unrelated-subject and expired-token denial, a granted source project, proposal/approval and original receipts, idempotent retry, refusal to overwrite a populated journal, restoration into a separate empty D1 instance with a recovery receipt, and review/approval of changed source metadata while preserving decision receipts. No external provider or real data is used.

This does not establish actual deployed compatibility flags, `ctx.access` identity behavior, production Access policy, authentic D1 export or restoration, private frontend rendering, durable restart, physical device acceptance, or authorization to release. The D1 instances and identity keys are test fixtures. The recovered frontend remains private and unlicensed. Run real-owner/nonowner, authentic restore and rollback acceptance independently before any cutover.

## October 28 compatibility-date replay (additive CI gate)

The same pinned Miniflare `4.20260730.0` test harness is replayed at `DS_WORKERD_COMPAT_DATE=2026-10-28` with a separately installed, **exact-version** `workerd@1.20261030.1` binary supplied through Miniflare's documented `MINIFLARE_WORKERD_PATH` override. It exercises the actual recovered Worker, signed synthetic identities, two isolated synthetic D1 stores, decision receipts, source reconciliation and empty-target recovery. The original July 30 workerd test remains independently executed on its lockfile-pinned binary. The October 28 replay is a blocking CI check.

Reproduce where the pinned dependencies can be installed:

```sh
npm ci --prefix workerd-test --ignore-scripts --no-audit --no-fund
npm test --prefix workerd-test
mkdir -p /tmp/ds011-oct-workerd
npm install --prefix /tmp/ds011-oct-workerd --ignore-scripts --no-audit --no-fund --no-save --package-lock=false workerd@1.20261030.1
MINIFLARE_WORKERD_PATH=/tmp/ds011-oct-workerd/node_modules/@cloudflare/workerd-linux-64/bin/workerd DS_WORKERD_COMPAT_DATE=2026-10-28 npm test --prefix workerd-test
```

The first attempt to use the July 30 engine for October 28 was **observed to fail at startup**: its binary supports dates only through `2026-08-06` ([CI failure](https://github.com/anevum/devon-station/actions/runs/41270715579)). This is a test-engine ceiling, not a failed application assertion. The second test uses a pinned October 30 engine and still does **not** establish the hosted Cloudflare runtime, D1 service, `ctx.access` or production compatibility. Actual isolated Cloudflare acceptance remains mandatory. This document records the updated test design, not an unobserved pass.

The reviewed unified application and PWA artwork are now AGPL-3.0-only in draft PR #8; historical statements above that the frontend is private/unlicensed are superseded.

The first supplemental replay attempt installed the correct `workerd` version but passed its **Node launcher** to `MINIFLARE_WORKERD_PATH`. That launcher does not preserve Miniflare's `--control-fd` and caused `Bad file descriptor`/`EPIPE` before application execution ([CI](https://github.com/anevum/devon-station/actions/runs/41270778978)). The corrected command points to the native package binary. The fix is test-harness-only.
