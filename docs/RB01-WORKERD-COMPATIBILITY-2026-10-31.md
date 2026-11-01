# RB01 local workerd compatibility

The public recovered Worker and foundation module graph execute inside local `workerd` using Miniflare `4.20260730.0`, the lockfile-pinned `workerd` `1.20260730.1`, compatibility date `2026-07-30`, and the `nodejs_compat` flag. This is a synthetic test configuration, not evidence of the current production Worker's settings.

Run `npm ci --prefix workerd-test --ignore-scripts --no-audit --no-fund` and `npm test --prefix workerd-test`. The fixture Worker injects generated RSA-signed synthetic Access identities through the existing verifier and supplies two separately initialized in-memory D1 instances. It calls the actual `createStation` Worker and scoped foundation modules, not a mock implementation. The fixture-only initialization and metadata-change endpoints are never part of the application Worker.

The test verifies owner access, unrelated-subject and expired-token denial, a granted source project, proposal/approval and original receipts, idempotent retry, refusal to overwrite a populated journal, restoration into a separate empty D1 instance with a recovery receipt, and review/approval of changed source metadata while preserving decision receipts. No external provider or real data is used.

This does not establish actual deployed compatibility flags, `ctx.access` identity behavior, production Access policy, authentic D1 export or restoration, private frontend rendering, durable restart, physical device acceptance, or authorization to release. The D1 instances and identity keys are test fixtures. The recovered frontend remains private and unlicensed. Run real-owner/nonowner, authentic restore and rollback acceptance independently before any cutover.
