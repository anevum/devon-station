# DS011-RB01 — private source-rights evidence inventory (October 31, 2026)

**Status:** Tooling prepared in the existing recovery draft PR #1. **Rights and publication are NOT cleared.** Do not upload the private R3 source, source-rights evidence, archived workspace data, or PWA graphics to public GitHub.

## Review scope and current facts

- Local-only staged candidate: `DevonStation_V048_Local_Integration_Review_R3_2026-10-31.zip`, previously recorded SHA-256: `d4f9f4d395755b8df6217c6849f4917a24e3dda839c2a3da7793d3350e2a65da`.
- The private candidate stages **49 allowlisted paths**, including the app shell, Worker, templates, tests, and build scripts. Existing staging logic preserves the pinned hardened Access verifier and excludes three unverified icon files.
- The original staged application package still declares **UNLICENSED**; source authorship, contribution permissions, third-party code/library notices, and license choice remain unverified. Neither possession of an archive nor a green build confirms redistribution rights.
- The three excluded assets are `pwa/icons/apple-touch-icon.png`, `pwa/icons/icon-192.png`, and `pwa/icons/icon-512.png`. Do not restore these or add references without original artwork/provenance evidence or a rights-cleared replacement.
- A verified synthetic test of the inventory tool is not a review of the private R3 archive. This workspace does not establish that the archive is present or that its bytes have been independently reviewed today.

## Local private review workflow (no network access)

1. Verify the R3 archive SHA-256 separately against the recorded hash **before** extracting it. Use a private working directory; do not store the archive, output, owner notes or review ledger in a public repository.
2. With the already-staged R3 source directory and a separate private output location, run:

   ```sh
   node tools/private-rights-ledger.mjs /private/staged-r3 /private/rights-review.json
   ```

3. The tool checks that the staged directory contains exactly the 49 reviewed source paths and its manifest, verifies each staged file against the SHA-256 in that manifest, enforces the hardened Access verifier Git blob and exclusion of PWA icons, and writes a new `0600` owner-only JSON ledger **outside** the source tree. Existing outputs are not overwritten.
4. Every source path remains explicitly `UNREVIEWED` for authorship and `REVIEW_REQUIRED` for third-party rights. Copyright, SPDX and external import indicators are advisory and record only path plus indicator label, never source lines. Review original authorship, past contributions, vendored code, generated artifacts, fonts, icons, dependencies and required notices manually. Record any rights grants in a private owner-controlled review location, not in the public Git repository.
5. Select and expressly approve an OSI-approved distribution license based on ownership and third-party obligations. Clear or replace each PWA asset separately. Only then authorize a **specific** public source import after an independent privacy review.

## Limitations

The tool checks the consistency of staged bytes with the **provided** manifest. It cannot prove the manifest's authenticity, copyright ownership, third-party compliance, absence of private text that scanning fails to identify, or independent identity of the original R3 archive. Hashing the source archive against the recorded SHA is still required. It neither changes licensing, authorizes publication, merges PRs, alters Cloudflare Access, nor restores D1.

The existing public source remains draft-only. Authentic isolated D1 restore, live named owner/nonowner Access acceptance, AAA physical-device/PWA tests, current production parity and guarded V0.3 rollback remain separate release blockers.

## Reproducible tests

```sh
node --test tests/private-rights-ledger.test.mjs
npm test
```

Tests use fabricated source files and the already-public reviewed verifier only. All files in the private staging output remain outside CI, test fixtures, Git history and public release artifacts.
