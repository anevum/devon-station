# DevonStation

DevonStation is an independent, personal operations workspace project. The target repository is intended to hold **public-safe application source**, tests, setup documentation, and release history—not private operational records.

## Source status

**Recovered source verified privately; public release remains blocked.** The original V0.4.8 R3 frontend was found in the owner's file library, its recorded SHA-256 was verified, and a private combined source tree built with the existing recovered Worker and foundation code. That private candidate passed 89 recovered-server tests, 35 foundation tests, hosted build, privacy checks and six offline Chromium suites (synthetic fixtures only). The public draft still excludes this frontend, which remains `UNLICENSED` with unverified third-party rights and PWA icons. **Do not publish the private archive or interpret an offline build as a production cutover.**

[October 31 verified rebuild-readiness handoff](docs/RB01-PRIVATE-REBUILD-READINESS-2026-10-31.md) · [Combined integration PR #8](https://github.com/anevum/devon-station/pull/8)

## Import criteria

1. Locate the authoritative current source and deployed revision, including authentication, storage, and backup dependencies.
2. Prepare a reviewed export that excludes credentials, databases, personal notes, account tokens, snapshots, and private workspace data. Review Git history as well as the working tree before any public push.
3. Preserve relevant source lineage and third-party attribution. Verify licensing rights before publishing recovered code.
4. Run standalone builds, tests, security checks, and mobile/browser verification.
5. Confirm production ownership, backups, rollback, and access boundaries before switching deployments. Never enable two competing deployers.

Development continues on the existing source until a verified cutover. Do not replace the working application with a newly generated skeleton.

Project index: [anevum/anevum](https://github.com/anevum/anevum) · Organization handoff: [GitHub reorganization](https://github.com/anevum/anevum/blob/main/handoffs/ANEVUM.OPS.PACKAGE.2026-10-30.002.md)
