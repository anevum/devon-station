# Local source-review staging (R3) — October 31, 2026

**Scope:** Original, dependency-free tooling for a private, reversible source-integration review. Not a release or a publication license.

The sanitized R2 archive is still UNLICENSED. Its PNG icon provenance is unresolved, and its `worker/access.mjs` is older than the hardened recovery PR verifier. The staging tool reads only an explicit source allowlist; it rejects unknown paths, symlinks, private identifiers, unexpected blockers, and a verifier that does not match the pinned Git blob. It preserves the rights questions rather than silently treating the source as publishable.

Usage from a separate local review checkout:

```sh
node tools/stage-source-review.mjs <clean-R2-source-directory> <verified-Access-file> <new-output-directory>
```

The output is a LOCAL-only source tree with the reviewed verifier, no unapproved PNG icons, an empty manifest `icons` array, and a manifest of original/staged hashes. It deliberately retains `UNLICENSED`; do not publish this tree to GitHub until source and third-party rights plus an open-source license are explicitly approved. The tool never overwrites an existing output directory, does not modify the original source, and does not touch live services.

**Observed local result:** 49 source files staged. Node 22 application tests 54/54, six synthetic Chromium browser suites, hosted shell build (three assets, six Worker modules), and source/build privacy checks passed. The resulting privately held review ZIP (not committed to GitHub) has SHA-256 `d4f9f4d395755b8df6217c6849f4917a24e3dda839c2a3da7793d3350e2a65da`, including its review-only manifest. Six additional original synthetic staging-tool tests passed locally and must pass in exact-head PR CI before this GitHub change is considered verified.

**Remaining gates:** Authorship/third-party source rights, chosen OSI license, replacement/approval of PWA icons, authenticated owner/nonowner Access acceptance, isolated authentic D1 restore, physical iPhone/PWA/push acceptance, source/deployment parity, and guarded V0.3 rollback. A passing test suite is not a production release authorization.
