# DS011 AI Work 03 — Durable execution control

Source-only increment stacked on PR #47 at `9654c56d22bcd92be007835aa32d01ec2b65c3ec`. No paid inference, runtime provisioning, production release, public source pairing or schema application is part of this delivery.

## Implemented

The existing private Work Console now understands separate encrypted execution records. It can display recorded runtime state, private output, root-turn evidence, session identity, authorized caps and best-effort provider consumption. An owner cancellation records a request against the current execution revision. It cannot label active work cancelled until the private service confirms the pinned provider turn. Original job plans and approval history remain intact.

`tools/ai-work/execution-controller.mjs` coordinates the existing Agents runner with `worker/ai-work-execution.mjs`, a portable D1 ledger. `execution-provider.mjs` implements fixed-origin provider submission, session/turn readback and cancellation. None is automatically dispatched from an HTTP request. `/execute` still always refuses, and public broadcasting remains off.

## State and authority

A trusted private service must explicitly enable its ledger dispatch capability, supply a provider, supply a scope check and implement a trusted spending-approval reader. There are no default approvals. The provider independently defaults to paid execution disabled. No API key, authority record or approval reader is accepted from browser/task input.

1. Read an approved plan and compute SHA-256 over its job ID, revision, project, permission plan, task and proposed cap.
2. Validate a separate nonexpired owner/job/digest-bound spending receipt, with a cap no greater than the proposal. Saving or approving the plan does not provide that receipt.
3. Reserve one encrypted execution per owner/job, with immutable submission/cancellation IDs and plan/approval identity. Reservation checks the plan is still ready.
4. Compare-and-swap `authorized` to `submitting` and revalidate authority/scope before transport. Only one caller can claim submission. Record identity before the provider call. No lease expiry or retry creates another session.
5. Persist provider session and root-turn identity before consuming private output. Reject a mixed session or root-turn stream. Buffer output in bounded chunks, store up to 64 KiB of UTF-8, and mark interrupted/truncated output as incomplete.
6. Retrieve the saved session and root turn independently before confirming a lifecycle outcome. Exact identities, root ownership and approved provider cap must agree. A completed turn is not proof that code, tests or external effects succeeded. `taskResultsVerified` remains false.

An ambiguous submission without a recovered identity stays quarantined and is never blindly replayed. A known session/turn can be reconciled without submitting more input. Cancellation acceptance alone is not cancellation confirmation; a concurrently completed turn remains completed. Readback errors and conflicting outcomes require review. Best-effort cost consumption may change and is never presented as a final invoice.

The input submission header carries a persisted idempotency key as defense in depth. The controller never depends on an unverified provider retention window or exactly-once guarantee: it does not retry an uncertain create request.

## Storage and rollout

Migration `0011-ai-work-executions.sql` creates one isolated table in the existing private station DB after 0010. It does not depend on mail migration 0009 and is never run automatically. Private tasks, provider identities, approval/submission IDs, output, cost readback and evidence are encrypted with the existing dedicated AI Work keyring; owner/job/revision/phase bind the envelope. No mail keys or tables change.

`AI_WORK_LEDGER_ENABLED=true` is a separate reviewed opt-in for the read/cancel API after the schema exists. It does not enable billing or dispatch. Until then the #47 planning interface continues to work without querying the new table. The private dispatcher must not be attached until this ledger flag/schema and authenticated cancellation path are accepted. Keep it disabled in actual environments during source review.

The owning plan's authenticated project/revision/state are checked before execution detail or cancellation returns private data. Project revocation suppresses private API access. A plan cancellation and execution reservation are mutually guarded by SQL conditions. Active cancellation requires the current execution revision and cannot be confused with the old pending-plan cancellation.

Private status polls every 10 seconds while visible; changed lanes and unfocused execution detail refresh without replacing the compose editor or a focused review. No public heartbeat is generated.

The console escapes output as text and keeps it out of localStorage/sessionStorage. Metadata lists include only fixed lifecycle/revision fields; detailed records remain owner-only. There is no raw event/error forwarding, public reporter, API credential in a sandbox, external account connection or repository permission expansion.

## Verification

All controller/provider tests use explicit isolated fixtures; no real OpenAI endpoint is contacted. Cases include absent/forged/expired authority, cap changes, project revocation, persistence failure before transport, competing dispatchers, uncertain submission without retries, known-session recovery, independent readback, cancellation races, corrupted ciphertext/metadata, cross-owner denial, output injection/limits, oversized/redirection/provider errors, and HTTP authority injection.

Native workerd tests exercise real signed JWT verification, D1, WebCrypto, execution-record recovery after restart, cancellation revisions and corruption refusal. Browser tests at 1440/390/320px exercise the existing planning journey plus private runtime output, a cancellation request, synthetic provider-confirmed cancellation, session inspection, privacy and WCAG A/AA checks. These are synthetic acceptance, not a live provider or physical iPhone claim.

Browser verification also found an existing shell-builder hazard: JavaScript containing a literal dollar-quote sequence was interpreted as a replacement directive by `String.replace`. The builder now inserts the code through a callback, preserving source literally. The packaging test compiles the embedded script and asserts preservation of the affected currency expression.

Useful commands:

```sh
npm test
node --test tests/ai-work-*.test.mjs
npm run build
npm run verify:privacy
npm run test:runtime:dom
npm test --prefix workerd-test
DS_CHROME=/path/to/chrome-headless-shell node tools/runtime-ai-work-browser.cjs
DS_CHROME=/path/to/chrome-headless-shell npm run test:runtime:browser
node tools/prepare-rb01-review.mjs
node tools/verify-ai-work-release-boundary.mjs
```

The 46-module review package remains intentionally incompatible with the unchanged privileged 44-module mail uploader. Protected manual release workflows, mail source, Access policies, credentials and rollback versions remain unchanged. No main merge or upload is authorized by this review.

## Remaining acceptance and next increment

Implement the authenticated owner spending-review/receipt workflow and attach the private dispatcher to a reviewed durable runtime. Add same-session continuation with per-input persisted idempotency and the unchanged session cap, and recover saved output items when an interrupted stream is incomplete. No queued/session inference may start until the owner separately authorizes its exact API budget and credentials.

Then verify actual provider acceptance, cancellation, readback, cost behavior and recovery on the intended runtime. Only afterwards pair genuine root events with the existing concurrent V4 adapter under source/project identity, TTL/revocation/private mode and separate public consent. Spotify and separately sourced GPT metrics are untouched.

Official contracts checked on November 7, 2026: [sessions and cancellation](https://developers.openai.com/api/docs/guides/agents-api/sessions), [retrieve session](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/retrieve), [retrieve root turn](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/subresources/turns/methods/retrieve). These document API shape, not this account's eligibility or actual acceptance.
