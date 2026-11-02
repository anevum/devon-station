# DS011-RB01 — Source recovered, private rebuild candidate verified (2026-10-31)

**Status:** The original V0.4.8 source has been recovered and privately built against the existing public RB01 integration tree. This is **not** permission to publish the recovered frontend, merge this draft, deploy the Worker, migrate D1, or declare AAA acceptance.

## Current evidence

- The owner's persistent file library contains the V0.4.8 R3 review source; archive SHA-256 `d4f9f4d395755b8df6217c6849f4917a24e3dda839c2a3da7793d3350e2a65da` matches the recorded checkpoint.
- The R3 staged source contains 49 allowlisted files, with hardened Access verifier Git blob `64a6d1cd5437a1490a594ed31a451ed5b7ee45b8`. All staged file SHA-256 values matched the embedded review manifest.
- Compared with the public integration tree: **16 matching files**, **28 absent/recovered files**, and **5 deliberate conflicts** (`package.json`, plus four existing recovered-server tests). The privately combined tree adds only missing files, preserves the already-reviewed Worker/auth/tests, and reconciles scripts **locally only**. The three unverified PWA PNGs remain excluded.
- The public GitHub branch's tracked files match the private combined tree at commit `e8bd31f828b267970d2128b1e17c7afefd2a5664`, except for the local-only build-script change to `package.json`.
- After independent private source extraction, the combined tree passed **89/89** recovered-server tests, **35/35** foundation tests, the complete hosted shell and six-module Worker build, the source/privacy scan (93 source files), and six offline Chromium suites with fabricated data. A separate clean extraction of the private rebuild package passed tests, build, and privacy checks again.
- The public PR remains **draft and unmerged**, with CI for the public-source boundary, foundation browser/interop, and recovered server green. Its source-only GitHub Actions bundle contains public tracked files **only**; the R3 frontend was never committed or uploaded to a public workflow.
- A read-only Cloudflare metadata check found `devon-station` last listed as deployed **2026-10-28 19:01 UTC**, with the existing D1 and Access-related bindings present. This is metadata evidence only, **not** source parity, real session security, independent backup, or service health verification.

## Rights and acceptance gates still open

1. **Legal provenance and privacy:** The archive declares `UNLICENSED`. A hash check proves integrity, not authorship, third-party license compliance or grant to redistribute. The source review found no copyright/SPDX headers or nonlocal JS module imports, but that is not independent proof of ownership. Select and explicitly approve an appropriate OSI open-source license only after reviewing contributions and assets.
2. **PWA artwork:** Three inherited icon files have unresolved provenance and were excluded; their replacements must be original/rights-cleared, responsive and separately device-accepted.
3. **Client feature parity:** The private R4 and earlier sanitized candidate contain client-source differences from R3. Do not discard those references or claim all features are restored until an owner-reviewed feature-diff and UI acceptance are complete.
4. **Runtime integration:** The recovered V0.4.8 Worker/frontend and new foundation are both present in a private source tree, but foundation workflows are still an isolated synthetic preview rather than one deployed owner-authenticated application.
5. **Real operations:** Real owner/nonowner Cloudflare Access, scoped authorization and revocation, authentic isolated production D1 export/restore, current deployed-source/schema parity, guarded V0.3 rollback, actual device/PWA/push checks and polished AAA visual acceptance are **not complete**.

## Rebuild handoff

The owner's **private** rebuild candidate and rights ledger were supplied as private conversation artifacts, not public GitHub source. For repeatability, retrieve the same R3 review archive from the owner's file library, verify its SHA, use the existing review-only staging/rights validation tools, combine only the 28 missing source paths with PR #8 at its reviewed commit, preserve the five public conflicts, and run:

```sh
npm test
npm --prefix foundation test
npm run build
npm run verify:privacy
npm run test:browser
```

The last command additionally needs Chromium and Python Playwright and is offline/synthetic. Do not upload source, the private combined ZIP, real data or build outputs to public GitHub. After specific license, attribution, privacy and icon signoff, a new *public-safe* frontend source change can be reviewed on this same draft PR with full clean build and AAA gates.

**Production preservation:** No Worker, Access, DNS, live D1, Railway or other running application was modified. Preserve existing V0.3 fallback until an independently accepted cutover.

## Later read-only production and source parity check

The current Cloudflare `devon-station` deployment metadata still lists an October 28, 2026 deployed version at 100% traffic, with a D1 binding and Access settings present (binding names/types inspected only; secret values untouched). A strictly **read-only metadata query** of the currently bound D1 found five reviewed application tables and two indexes with column names matching `worker/schema.sql`. There was also a Cloudflare-managed `_cf_KV` table outside the app schema. **Do not** pass authentic Cloudflare SQL blindly into the synthetic restore helper, which rejects extra tables; treat that provider-managed schema separately during independently authorized restore acceptance. Neither live user records nor export/rollback data were read or modified.

Comparing the preserved private R4 client to the privacy-sanitized R3 client found the same 35 top-level named functions and eight differing regions: `command`, `inbox`, `infrastructure`, `works`, `writing`, `anevum`, `preferences`, and `saveCapture`. R3 remains the safe reviewed staging baseline; R4 is the separate protected reference. Verify behavior and privacy of these eight regions before declaring complete original-client parity. No private R4 code was uploaded here.
