# DevonStation

DevonStation is an independent, personal operations workspace project. The target repository is intended to hold **public-safe application source**, tests, setup documentation, and release history—not private operational records.

## Source status

**Recovery pending.** The existing development archive includes private operational snapshots and must **not** be published wholesale. This repository does not yet contain a verified standalone application. A README is not evidence that the deployed service has been migrated here.

[Draft recovery PR #1](https://github.com/anevum/devon-station/pull/1) preserves selected server components and synthetic tests. The UI and complete release tooling are not recovered there; privacy, licensing, and recovery checks remain open. The draft is not a deployment candidate.

## Import criteria

1. Locate the authoritative current source and deployed revision, including authentication, storage, and backup dependencies.
2. Prepare a reviewed export that excludes credentials, databases, personal notes, account tokens, snapshots, and private workspace data. Review Git history as well as the working tree before any public push.
3. Preserve relevant source lineage and third-party attribution. Verify licensing rights before publishing recovered code.
4. Run standalone builds, tests, security checks, and mobile/browser verification.
5. Confirm production ownership, backups, rollback, and access boundaries before switching deployments. Never enable two competing deployers.

Development continues on the existing source until a verified cutover. Do not replace the working application with a newly generated skeleton.

Project index: [anevum/anevum](https://github.com/anevum/anevum) · Organization handoff: [GitHub reorganization](https://github.com/anevum/anevum/blob/main/handoffs/ANEVUM.OPS.PACKAGE.2026-10-30.002.md)
