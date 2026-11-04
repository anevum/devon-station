# DS011 — sanitized frontend/build source intake gate (October 31, 2026)

Status: **local candidate independently checked; publication and release NOT APPROVED**. This review is limited to DevonStation. No source ZIP, actual owner data, production backup, deployment bundle, icon asset, or private record was imported into GitHub by this job.

## Candidate identity and local reproducibility

- Candidate: `DevonStation_V048_PublicSafe_Source_Review_R2_2026-10-31.zip`, SHA-256 `2dd678cbcafd2e12163e678e91321dad2c154221c4d5c04353606b593e95ff5f`.
- A clean extraction included 58 source and review files; it did **not** include `src/snapshot.json`, production evidence, a live backup, credentials or generated build outputs.
- Node 22: `npm test` passed 54/54 in the sanitized source; `npm run build` generated an empty-private-data hosted shell, six assets and six Worker modules; pre- and post-build privacy checks passed.
- Six offline synthetic Chromium suites passed (phone and desktop views, sync/reconcile, protected backup review, conflicting edits, tab recovery and diagnostics). These are not physical-iPhone or actual Access acceptance tests.
- Separate local integration trial copied the candidate and retained the already-reviewed Access JWT time-claim hardening from [PR #1](https://github.com/anevum/devon-station/pull/1), with regression assertions: 54/54 tests, build and privacy checks passed. The resulting `worker/access.mjs` Git blob identity matched the existing hardened recovery branch. The **original R2 archive** remains unchanged.

## Automated source-intake blockers and human gates

Run `node tools/source-intake.mjs <clean-extracted-candidate> <current-reviewed-worker/access.mjs>` from a safe local checkout. The script scans source paths, embedded identifiers, credentials and the currently reviewed verifier, without exposing file contents or secret values. Its six synthetic tests run in regular recovery CI. This is a *preflight*, not legal rights validation, security certification or a deployment gate.

The untouched clean R2 candidate was blocked for three verified reasons:

1. **Authentication regression risk:** `worker/access.mjs` precedes the fixed NumericDate validation in the recovery PR. Preserve the hardened file and tests rather than overwriting them.
2. **Unresolved open-source terms:** source package declares `UNLICENSED` and contains no license text. Ownership, contribution rights, license choice and third-party dependency review need explicit resolution before a public source import.
3. **Unverified graphic rights:** the three PNG PWA icon files have no independently verified origin/redistribution permission. Metadata-free PNGs are not evidence of ownership.

The preflight also deliberately blocks private snapshots, generated deployment output, SQL databases, credentials and symlink-based escape attempts. Re-running it on a **built working directory** will flag `hosted-dist/` and `deployment/`; run it against a clean source extraction intended for commit instead. The tool can report automated success, but it always reports `publicationAuthorized: false`: a human rights/privacy/production review remains mandatory.

## Import order and release boundary

Continue in existing [recovery draft PR #1](https://github.com/anevum/devon-station/pull/1), not a new application or deployer. First resolve rights/license for the exact source and PWA graphics or exclude unapproved assets. Retain the hardened verifier and historical V0.3 recovery files. Then add only audited frontend, build and tests to the draft in one bounded reviewable change, requiring exact-head tests, build, privacy scan and device/browser checks. GitHub publication is separately gated from Cloudflare production release.

Before any live cutover: independently verify source/deployment parity, authentic D1 export and isolated restore, named owner and nonowner Access sessions, real iPhone PWA/push acceptance, documented V0.3 rollback and owner authorization. This source review does not satisfy those gates or justify a clean-slate-ready claim.
