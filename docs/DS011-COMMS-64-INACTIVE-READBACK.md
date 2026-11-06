# DS011-COMMS-64 — Inactive acceptance version readback

Date: November 6, 2026. Source-only readback tooling; **no migration, traffic activation, SMTP send or production release**.

## Purpose

PR #36's immutable approved application was uploaded to the isolated acceptance Worker as version 15, then deliberately left inactive. This helper checks that exact version's provenance, compatibility, bindings, owner policy and database isolation against two unchanged serving-deployment anchors. It is designed to **fail closed on drift**, never automatically approve activation.

The script `tools/comms-acceptance-readback.mjs` exports `readbackInactiveAcceptance({request,accountId})`. Supply a read-only Cloudflare request adapter returning the unwrapped API `result` (not the Cloudflare envelope). The helper itself calls the reviewed `preflightAcceptance` from `tools/comms-acceptance-upload.mjs`. Its adapter allows exactly eight GET endpoint shapes: two Worker settings, two deployment lists, the acceptance subdomain, the owner Access app and its policies, and a single exact approved version. There is **no POST, multipart form, database query, secret-value read, SMTP command, or rollout operation**.

Synthetic regression command on the reviewed branch:

```sh
node --check tools/comms-acceptance-readback.mjs
node --test tests/comms-acceptance-readback.test.mjs
node --test tests/comms-acceptance-upload.test.mjs
```

The existing source-review workflow now runs the focused synthetic readback tests on changes to either new file; it does not run against the live provider and does not receive release credentials.

## Immutable reference points

| Target | Exact reference |
| --- | --- |
| Uploaded *inactive* acceptance version | `523569b4-38d9-4cab-acbd-e84dd22a59aa` (version 15) |
| Approved source commit | `bba373f35f3cc913447e72fcdfff589cd6f3a073` (PR #36) |
| Serving acceptance deployment | `99577640-1f02-446f-8d38-88f723f51f82`, older version `c31f8bd4-283d-457c-9779-87605927eec4` at 100% |
| Serving production deployment | `890cc9d9-533b-4b9a-b326-26a7c4f88402`, legacy version `ce64277b-124b-4177-825a-8b51d997152b` at 100%, prior candidate `1ba61404-f7f6-4b0b-8b55-6f9f52819e70` at 0% |

The tool refuses changed active deployment IDs, changed percentages or version IDs, a version-15 traffic entry even at 0%, and deviations in reviewed annotations, runtime, required bindings, disabled sending, Access policy, preview URLs or distinct D1 identities. It reads active deployments a second time after inspecting the uploaded version to detect activation during the check.

The return object contains only stable version/deployment IDs, status booleans and an evidence-scope marker; it never emits mailbox data, owner email, key material, database contents or secret values. Production and acceptance flags `MAIL_SEND_ENABLED` and `MAIL_SENDER_VERIFIED` must remain false.

## Proof boundaries

A green synthetic test demonstrates only the verifier's behavior against fixtures. A successful read-only provider result proves the observed metadata **at the time of the reads**, not that the Worker code is authenticated and usable by an owner on a physical iPhone, that keys are independently recoverable, or that a real SMTP message was delivered. It does not validate the exact deployed module bytes by itself; the prior approved artifact and receipt provide that separate evidence.

If a mismatch appears, **stop and investigate**. Do not automatically upload a replacement version, amend baselines to the current deployment, bypass GitHub environment approval, run migration 0009 or increase acceptance traffic. Review the source and Cloudflare environment with the owner. After valid future authorization, create a fresh verified checkpoint and specifically update the pins rather than weakening these guards.

The live user-path rollout still requires independent recovery evidence, a separately approved acceptance-only migration, authentic owner/nonowner Access sessions, an explicit controlled sending test, recipient-side and provider-Sent evidence, and Safari/installed-PWA acceptance. Production remains no-go until those gates are satisfied.
