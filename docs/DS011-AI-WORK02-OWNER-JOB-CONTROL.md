# DS011 AI Work 02 — Owner job-control vertical slice

Status: IMPLEMENTED, source-only review. No merge, upload, schema application, provider call or public activity authorized or performed by this change.

## Exact dependencies and contract reconciliation

- Recovered application: DevonStation PR #44, `be6644f58297dedfcd1c1d60ec2aef17e64b0f35`. `main` is the recovery/release tooling baseline, not the integrated app. This branch is stacked on #44 and includes #46's runner history. Do not replace or release the mail stack with this branch accidentally.
- Runner: PR #46, `986067d4820e3a9fa895e568c8f300bd28878d43`. It owns private provider submission and decoding; it is not an authenticated job service. This slice adds mixed-session rejection, an awaited private checkpoint hook, and safe async optional observers. Those hooks alone are not durable execution or exactly-once submission.
- Public website: PR #53 is merged. Concurrent adapter PR #56 is also merged at reviewed head `9ee7e6c217136632731995cff63f0c51e083c0e9`. No source from superseded singleton PR #52 is used.
- The #46 `{version:1,state}` callback is NOT the #56 event input. #56 takes an authenticated asynchronous raw provider event stream for one submitted root turn, then calls `/api/activity/tasks/start` and `/signal` with independent task credentials. Never forward private events through the browser or treat an owner's saved plan as source evidence. Neither adapter is wired to publication here.
- Official API contract reviewed on 2026-11-07: [session creation](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/agents/subresources/sessions/methods/create), [sessions, continuation and cancellation](https://developers.openai.com/api/docs/guides/agents-api/sessions). Stream completion is not independent evidence that tools/tests passed. Actual provider/account acceptance remains untested.

## Working owner path

Open the recovered application at `/#aiwork`. Select an explicitly granted project and sandbox permission plan, enter a private task and proposed cap, then save it. Review the saved task; approve the plan, reject it, or cancel it before execution. Closed plans can seed a linked fresh follow-up plan. Reload recovers saved jobs and decision history. Independent cards occupy Review, Ready (locked), and Closed lanes.

**Approve plan only** is deliberately distinct from authorizing API billing. `billingAuthorized` remains false, and no task can become running/completed through this API. `POST /execute` always refuses. Output/evidence sections state that no agent has run. Provider session continuation/cancellation, code diffs and real execution remain the next slice; a follow-up plan does not resume a provider session.

## Private storage and authority

The existing Access verifier, owner email check, same-origin JSON writes and private/no-store responses guard every new route. A separately pinned `AI_WORK_OWNER_SUB` additionally rejects a different authenticated subject with the same email. No role/email header bypass is introduced.

Reviewed configuration for a later isolated acceptance setup (not created here):

| Setting | Meaning |
|---|---|
| `AI_WORK_ENABLED` | Must equal `true`; default disabled |
| `AI_WORK_OWNER_SUB` | Existing verified owner's Access subject |
| `AI_WORK_PROJECTS_JSON` | Explicit subset of fixed `devon-station`, `devonakins-com`, `mizvo`, `rhen`, `merit` identities; no organizational/client projects |
| `AI_WORK_KEY_ID` / `AI_WORK_KEYS_JSON` | Dedicated AES-256-GCM keyring; separate from mail keys and never returned to the browser |
| `DB` | Existing private station D1 binding; migration is separate |

`0010-ai-work-jobs.sql` adds one isolated table/index. It is never applied by an HTTP request, build or release script. It has no dependency on the pending mail archive migration 0009. No mail tables or configuration are changed.

Private task, permission plan, cap and history are encrypted in one atomic row. Authenticated context binds owner, job ID, project, revision and state. Plaintext columns contain only fixed project identity, lifecycle/revision and timestamps. Metadata listing does not decrypt task text. Each change uses a revision compare-and-swap. Browser-generated UUIDs make repeated identical submissions idempotent; changed content under the same ID is rejected. Cursor pagination bounds each metadata read to 51 rows. Inputs, output placeholders and histories are bounded by the finite state machine. Missing keys, altered ciphertext, swapped job metadata and stale decisions fail closed.

No task text is placed in localStorage/sessionStorage, service-worker cache, public callbacks or GitHub. User-supplied task text is escaped as text. Project revocation suppresses listing/detail and future decisions; background revalidation clears private detail on lost authorization. The browser cannot set job state, spend authority, credentials or public sharing. Private encryption protects database exports; it does not protect against a compromised authorized Worker with keys.

## Verification and release boundaries

Commands (all provider fixtures are synthetic):

```sh
npm run build
npm test
npm --prefix foundation test
npm run verify:privacy
npm run test:runtime:dom
node --test workerd-test/ai-work-runtime.test.mjs
npm test --prefix workerd-test
DS_CHROME=/path/to/chrome-headless-shell node tools/runtime-ai-work-browser.cjs
DS_CHROME=/path/to/chrome-headless-shell npm run test:runtime:browser
```

The browser suite covers 1440, 390 and 320px, save/approve/reload/cancel/follow-up, text injection, browser-storage leakage, signed nonowner denial, revocation, overflow and WCAG A/AA axe checks. Native workerd/D1 checks use the real JWT verifier, separate signed subjects, AES-GCM, concurrent decisions, persisted database restart and corruption refusal. No fixture result claims real Cloudflare owner access, physical iPhone/Safari, provider eligibility or paid inference.

The review-only package inventory includes the new module. The existing privileged mail uploader remains byte-for-byte unchanged and rejects the expanded 45-module inventory. Source CI explicitly proves that refusal with `verify-ai-work-release-boundary.mjs`. The manual protected workflow, approved mail candidate/tooling pins, Access settings, secrets, traffic and rollback versions are unchanged. Review-only artifact preparation is not release approval.

## Next shippable increment

Add a durable private dispatcher with pre-submission idempotency, an atomic job claim and separate explicit per-job billing authorization. Persist session/turn identity before consuming output; reconcile interrupted/ambiguous submissions via authenticated provider readback, never blind replay. Implement provider-confirmed cancellation and continuation within the unchanged session cap, cost readback and independently sourced execution evidence. Only then connect #56 to authenticated root events with project/source binding, expiry, private-mode suppression, source revocation and separate public consent. Keep API calls and public reporting disabled until their actual approvals and acceptance checks.
