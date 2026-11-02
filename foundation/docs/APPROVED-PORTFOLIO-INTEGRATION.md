# DS011-RB01 — protected portfolio cache to foundation project workspace

**Status:** Implemented only in the combined **draft review branch**, not a released application, real-data preview, or a Cloudflare deployment. The only existing local UI is still labeled as a synthetic preview.

## Problem resolved

Previously, the recovered V0.4.8 Worker exposed a bounded, owner-only, **read-only** Notion portfolio cache at `GET /api/portfolio`, while the new foundation accepted a different project projection contract. The two pieces could be tested in isolation but could not feed the same project workspace. A server-side adapter at `foundation/interop/approved-portfolio.mjs` now converts **explicitly approved** cache entries to the foundation contract.

The adapter is not a Notion connector or a new application. It does not make upstream requests, write to Notion, mutate D1, or accept raw browser-supplied grants. The recovery Worker retains its existing authentication code; authorization must occur before the adapter receives a cached portfolio.

## One-way data flow

1. The existing recovered Worker authenticates the current owner and reads the owner's `station_portfolio_cache` row in D1.
2. Trusted server configuration supplies the verified foundation identity (`principalId`, `role`, `scopeKind`, `scopeId`) and an **explicit, per-identity grant** of `{principalId,scopeKind,scopeId,projectId,area}`.
3. The adapter refuses non-owner identity, scope mismatches, mixed-scope grants, malformed/duplicate IDs, unexpected cache modes, schema or area drift, and unsafe Notion source URLs.
4. It copies only the approved project's ID, title, verified scope, cache timestamp, and strict Notion source URL. Fields such as owner description, next action, gate, status, source text, private metadata, repository notes and all non-granted projects stay out of the projection.
5. The existing `createFoundation` validation runs before the data is handed to the local synthetic workspace. All new proposals and decisions remain **local synthetic actions** and cannot silently trigger Notion edits or external operations.

**Business and family boundary:** A project categorized as Shinewell, ANEVUM, Devon Works, Writing or Family & Home is *not* automatically admitted into any workspace based on its label. The source row's area must match the independently supplied explicit grant. Separate legal entity/scoped grants, real verified identities, and privacy approval are needed before any production data use.

**Current limit:** The adapter expects a portfolio response from a trusted, already-authenticated Worker call. It does not cryptographically bind the Worker cache's owner subject to the separate foundation identity. A deployment must establish that server-controlled relationship and live grant revocation; injecting project IDs and grants from the browser would be insecure. No production traffic or real records are used.

## Reproducible acceptance

From the combined branch, with Node 22 or later:

```sh
node --test foundation/tests/approved-portfolio.test.mjs
npm --prefix foundation test
npm test
```

The new tests construct a fabricated D1 portfolio cache, request it through the real recovered Worker HTTP handler with a fabricated trusted owner identity, apply one explicit project grant, validate that unrelated business/creative records are excluded, seed the **existing loopback-only synthetic preview** from the approved projection, and submit one local synthetic proposal without changing the original cached row. Additional cases test empty caches, absent grants, cross-scope and wrong-owner grants, duplicate records, unexpected modes, malformed timestamps, changed area, unsafe source links, and owner cache isolation.

The local demo's optional `approvedSyntheticProjects` argument exists only for trusted test-process injection. No HTTP endpoint, production environment variable, browser role header, or real identity selector can supply this argument. The default local preview remains unchanged. Do not use the fixture injection with real household, business or clinical data.

## Still blocked

This work is a **single verified application data-flow slice**, not the missing recovered frontend build. The private V0.4.8 R3 source archive is not accessible in this execution environment and remains unlicensed with unresolved third-party and PWA art provenance. Other release gates remain authentic isolated production D1 export/restore, named owner/nonowner Cloudflare Access sessions, current source/deployment parity, complete licensed frontend build, physical-device AAA/PWA acceptance and authorized guarded V0.3 rollback. The branch stays draft and no production cutover is implied.
