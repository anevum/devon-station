# DS011 AI Work 01 — Private agent execution core

**Decision:** LOCKED architecture, 2026-11-07. **Delivery:** SOURCE IMPLEMENTED; synthetic/local verification only. No production console, automatic publishing, or real authenticated provider session.

## Ownership and boundaries

- **DevonStation** owns private AI execution, authenticated human approval, private task output, spending limits, job identities and tool permissions. This change is source-only and independent of the pending Communications stack.
- **DevonAkins.com** remains a separate public read-only presentation of explicitly consented, independently sourced presence. Its V4 reporter is already deployed with public sharing disabled by default. The current concurrent agent adapter is draft site PR #56; older site PR #52 addresses a superseded singleton reporter.
- **AI usage source:** This runner uses the **metered OpenAI Agents API**, not ChatGPT Work credits or ChatGPT subscription login. There is no presumption of personal ChatGPT conversations, memory or profile usage access.

## First executable slice

`tools/ai-work/agents-client.mjs` creates an OpenAI-hosted sandbox session using the official `OpenAI-Beta: agents=v1` API, `gpt-6-astra`, SSE, and a required provider-level per-session `spend_control.limit` in **USD cents**. `tools/ai-work/run.mjs` is a CLI with task input from stdin (not process arguments). Without an explicit `--execute --spend-cents=NN`, it does not call the provider.

It can execute an isolated coding/research task and return an owner-private text stream. It is **not yet** a GitHub/Cloudflare code editor, PR manager, or DevonStation PWA. Those require separately scoped, authenticated integrations and approval gates. No external MCP tools or user repositories are granted to its sandbox by this version.

The event decoder distinguishes root turn completion, failure and cancellation from subagent events. Requiring input is not success; `idle`, SSE `error`, malformed stream and disconnected streams do not imply success. No automatic retries after an ambiguous request. A completed turn is still not proof its tests or tool calls passed.

`onPublicStatus` only receives `{version: 1, state}` with one of running, waiting, completed, failed, cancelled. The private text channel is independent. **No production publication or reporter connection is wired in this slice.** Future integration must validate source identity, chosen allowlisted public project, owner pairing, TTL and privacy flags before producing a public event.

## Test without API charges

```
node --check tools/ai-work/agents-client.mjs
node --check tools/ai-work/run.mjs
node --test tests/ai-work-agents.test.mjs
node tools/ai-work/run.mjs
```

The last command should print that no model call was made.

## Optional real-session acceptance (separate approval for API billing)

Obtain a project API key with `api.agents.read`, `api.agents.write`, and `api.responses.write`; keep it outside the repository. Review OpenAI API model, sandbox and usage pricing. In an owner-controlled terminal, place the key in the private environment and supply a bounded prompt through stdin. For example, with a **separately approved** $0.50 cap:

```
node tools/ai-work/run.mjs --execute --spend-cents=50 < ./private-task.txt
```

Never put the key or private task contents in CLI arguments, GitHub Actions logs or the public website. A stream or local process interruption does **not** cancel the provider session; inspect and explicitly cancel it via the supported API before starting another paid job. Actual usage readback and persisted private session recovery are follow-up requirements.

## Acceptance and next vertical slice

1. Independent review and hosted source-only CI of this PR: Node 22, syntax, 13 synthetic tests, no model charges, credential and public-data scanning.
2. Verify one genuine provider root turn, waiting and cancellation, session result readback, and key handling from an authenticated private owner runtime. Do not schedule or run chargeable acceptance without approval.
3. Integrate a private, owner-only DevonStation task route and mobile console UI into the **actual recovered app**, preserving existing Access, source, migration and Communications release gates.
4. After source review, adapt the private job event stream to concurrent Live Signal V4 using the newer website adapter in PR #56. Prove revocation, private mode, expiration, and absence of raw output before considering public opt-in.

**Never** merge the pre-V4 singleton reporting code in site PR #52 as if it were the final concurrent adapter. Do not alter the existing personal site, clinical/customer information, user scopes or production secrets as part of this first source review.