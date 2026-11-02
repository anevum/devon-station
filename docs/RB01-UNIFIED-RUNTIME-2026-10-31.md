# RB01 unified project and decision runtime

Current follow-on: [encrypted journal recovery and source review](RB01-JOURNAL-RECOVERY-2026-10-31.md) are implemented in draft. The earlier backup/rebase limitations below describe the initial runtime checkpoint.

Status: development candidate only. No merge, deployment or real-data intake.

This change connects the existing recovered Worker to the existing foundation's project, proposal, decision, retry and receipt contracts. It does not replace the recovered application or change its hardened Access verifier. A new original UI component is available for mounting inside that application; the rights-gated recovered shell and its private integration edits remain excluded from public history.

## HTTP and persistence contract

- `GET /api/workspaces`: only scopes explicitly granted to the already authenticated Access subject.
- `GET /api/workspace?scopeKind=personal&scopeId=example`: approved source-linked project projections, actions, receipts and generation.
- `POST /api/workspace/propose` and `/api/workspace/decide`, with the same scope query: `{expectedGeneration,input}`. Inputs follow the existing foundation contract. Browser-selected identities, project metadata and grants are never accepted.
- Every endpoint remains behind the recovered owner authentication and same-origin JSON mutation checks. The scope bridge receives only the identity already verified by that boundary.
- `WORKSPACE_GRANTS` and `WORKSPACE_PROJECT_GRANTS` are trusted server-owned configuration arrays, never HTTP input. Missing grants deny access. An empty cached portfolio provides no actionable projects. Project metadata comes from the recovered owner-specific portfolio cache and its existing strict allowlist adapter; this module never fetches or writes Notion.
- `worker/migrations/0003-scoped-workspace.sql` is additive and **not automatically applied**. The independently authorized target needs that table before enabling the feature. No remote migration or provider setting was changed.
- `station_workspace_state` keys every journal by Access subject, scope kind and scope ID, with principal ownership verification. One SQL compare-and-swap atomically stores the foundation snapshot, action/decision receipts and retry ledger. Decisions remain records; there is no external dispatcher.
- Old identical operation retries return their recorded receipt without adding history. Reused identifiers, stale generations, racing writes, corrupt snapshots and changed authority fail closed. Metadata refresh time alone may advance; project title/source/ownership/grant changes require explicit reconciliation. No automatic rebase exists yet.

The foundation uses `node:crypto`; a future Cloudflare build requires tested Node compatibility configuration, or an explicitly reviewed portable crypto adapter. The private build includes the foundation import graph, but has not been executed in workerd/Cloudflare. Existing production configuration remains untouched.

## Interface and recovery limits

`src/workspace-ui.js` and `src/workspace.css` provide the new original component. The private recovered application mounts it through its existing navigation, theme, command view and build pipeline. It supports source links, project filtering, proposal entry, explicit review, approve/reject, receipt history, error/reload states, disabled pending controls, keyboard focus, 44px control sizing, responsive layouts and existing safe-area/reduced-motion conventions. These are implementation details, not a claim of rendered AAA acceptance.

The runtime journal reopens across an isolated database restart. Its integrity digests detect accidental corruption, not an attacker able to rewrite the database and recompute hashes. Storage is not encrypted by this adapter. The existing recovered encrypted device-note backup remains separate; the follow-on adds its own encrypted scoped journal export and reviewed empty-target restore. Portable encrypted workspace backup/restore and deliberate source/grant reconciliation are now implemented in the follow-on; never treat the prior note-backup tests as coverage for this new table.

## Evidence and boundaries

Run `npm test`, `npm --prefix foundation test`, and `git diff --check` on this public tree. New synthetic tests exercise real Worker routing, signed fabricated Access JWTs, source projection, approve/reject, durable receipts, idempotency, scoped SQLite restart, subject/business isolation, revocation, concurrency, failed writes, sensitive-input denial and repeatable additive migration.

The private combined tree additionally passes the recovered application test/build/privacy checks and a DOM integration against its actual hosted HTML and Worker, using only fabricated records and generated signing keys. The DOM check covers source links, both decisions, receipt history, original capture, restart and denial after revocation. DOM accessibility excludes rendered layout and color contrast.

Actual Chromium launch in this session was blocked by the execution environment's socket policy. The six recovered browser suites and new responsive browser suite therefore remain **unverified for these edits**. No physical iPhone, PWA/push, real Access owner/nonowner session, Cloudflare D1 export/restore, production-source parity or live rollback was accepted. Full frontend publication still requires verified authorship/third-party rights, an explicit approved OSI license and cleared PWA artwork. Existing drafts remain unmerged and production unchanged.

Next bounded job: independently verify workerd compatibility, then perform actual integrated browser/contrast/touch checks in a permitted environment. The encrypted recovery/source-review follow-on is implemented in draft. Resolve source/asset rights before importing the recovered frontend publicly. Retain all production cutover gates.
