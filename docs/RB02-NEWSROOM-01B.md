# DS011-RB02-01B — version-anchored discussion (source-only)

**Owner:** DevonStation / Workspace Core. **Dependency:** unmerged RB02-01A PR #10 and unmerged RB01 PR #8. **State:** synthetic source/test candidate, **not hosted** and **not authorized for actual identities or clinical content**. Source license: AGPL-3.0-only under the owning repository.

## One bounded capability

The independent `createNewsroomConversationHandler` in `worker/newsroom-conversations.mjs` implements one authenticated persistent discussion anchored to an exact published `revisionId` and `blockId`. The immutable block content and version digest are read from the published edition store; neither client may edit the quote or switch it to a corrected revision. A correction creates a new revision with a distinct thread, while the original thread remains readable to authorized members.

- `GET /api/newsroom/conversations/:revisionId/:blockId` — server-verified active member of the deployment's one nonclinical organization, including read-only readers. Returns anchor/version/source quote and up to the first 100 messages, plus `truncated` when more exist. No client-chosen `orgId` is ever trusted. Pagination and user-facing chat UI are not implemented yet; do **not** use this unpaginated first slice for a growing real deployment.
- `POST /api/newsroom/conversations/:revisionId/:blockId/messages` — a verified active `commenter`, `publisher`, or `owner` only, with exact same-origin JSON and payload `{ "operationId": "8+ character unique id", "text": "single reply" }`. Max 1600 characters, reject control characters other than line-feed and noncanonical/extra JSON fields. The HTTP body is streamed and capped at 4096 bytes. All initial content must be wholly synthetic and nonclinical.
- Successful initial post returns HTTP 201; exact replay for the same signed actor/operation/payload returns 200 with `duplicate:true`, without writing a second message. Reusing an operation ID on a different anchor or with changed text returns 409. Distinct actual members have separate idempotency scopes.
- Comments do not grant authority, execute work, imply acknowledgment, create DMs or transmit notifications.

## Data preservation and security

`worker/migrations/0005-newsroom-conversations.sql` is an additive, **unapplied** migration requiring 0004. It adds only `nr_thread_messages`, an anchor/time index and three immutability/active-member triggers. It has composite foreign keys back to the exact immutable source block and current organization membership. Messages contain signed-subject references and immutable bodies, but the current D1 design is **not application-layer encrypted**; hosting for real healthcare or third-party information is out of scope. There is no auto-delete/redaction, moderation, rate limiting, attachment, read receipt, direct-message capability, user invite or search index.

The old RB01 owner-only Worker routes, Access policy, source journal, existing database bindings and actual Cloudflare resources remain untouched. No new dependency or billing infrastructure is required to review the code. The handler is **not mounted** by the shipped runtime or by 01A; a separately approved synthetic-only Worker integration is still necessary before hosted testing.

## Verification and release gates

Local synthetic SQLite transaction tests verify distinct identities, read/write roles, invalid JWT audience and forged role denial, inactive membership, direct SQL trigger enforcement, archive correction anchors, idempotency, request bounds and cross-origin behavior. The existing repository's CI must run at the exact committed head and, if possible, pinned native workerd/D1 tests should additionally exercise the new handler.

Do not merge or deploy this stacked draft before the independently accepted RB01/01A release prerequisites. Real hosted tests additionally require explicit approval for a **separate nonclinical synthetic Cloudflare Worker/Access app/D1**, authorized actual test identities and a readback/rollback plan. After those checks, add a properly accessible discussion panel, scrolling/pagination, moderation and export/restore of conversations as separate bounded follow-ups. Do not treat a draft comment as a business decision.
