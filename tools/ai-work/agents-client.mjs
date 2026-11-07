/**
 * DevonStation owner-only Agents API execution core.
 * API credentials never enter a browser, repository, telemetry payload, or sandbox.
 * Requires an explicitly approved per-session spending limit in USD cents.
 */
const ENDPOINT = 'https://api.openai.com/v1/agents/sessions';
const BETA = 'agents=v1';
const MODEL = 'gpt-6-astra';
const MAX_TASK_BYTES = 8192;
const MAX_SSE_EVENT_BYTES = 1048576;
const MAX_PRIVATE_OUTPUT = 65536;
const PUBLIC_STATES = new Set(['running', 'waiting', 'completed', 'failed', 'cancelled']);

export class AgentWorkError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AgentWorkError';
    this.code = code;
  }
}

export function validateAgentJob({ task, model = MODEL, spendLimitCents, apiKey }) {
  if (typeof task !== 'string' || !task.trim() ||
      Buffer.byteLength(task, 'utf8') > MAX_TASK_BYTES) throw new AgentWorkError('invalid_task');
  if (model !== MODEL) throw new AgentWorkError('unsupported_model');
  if (!Number.isSafeInteger(spendLimitCents) || spendLimitCents < 1 ||
      spendLimitCents > 10000) throw new AgentWorkError('invalid_spend_cap');
  if (typeof apiKey !== 'string' || !apiKey.startsWith('sk-') || apiKey.length < 10)
    throw new AgentWorkError('api_key_required');
  return { task: task.trim(), model, spendLimitCents };
}

export function createAgentSessionBody(validated) {
  return {
    agent: {
      model: validated.model,
      instructions: [
        'You are a private development assistant operating only in the session sandbox.',
        'Investigate, build and test reversible work. State exactly what was verified.',
        'Never claim a production merge, deployment, purchase or external action without evidence.',
        'Do not ask for, retrieve, or publish credentials, private clinical or family information.',
        'Do not perform external publication, financial transactions or destructive operations.',
        'Return an accurate task summary and remaining gates.',
      ].join(' '),
    },
    environment: { type: 'openai_hosted' },
    input: validated.task,
    spend_control: { limit: validated.spendLimitCents },
    stream: true,
  };
}

/** Streaming SSE decoder with hard per-event byte caps; never echoes provider bytes on errors. */
export async function* decodeAgentSse(body) {
  if (!body || typeof body.getReader !== 'function') throw new AgentWorkError('missing_stream');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (Buffer.byteLength(frame, 'utf8') > MAX_SSE_EVENT_BYTES)
          throw new AgentWorkError('oversize_stream_event');
        const pieces = frame.split(/\r?\n/).filter(line => line.startsWith('data:'));
        if (!pieces.length) continue;
        const data = pieces.map(line => line.slice(5).trimStart()).join('\n');
        if (data === '[DONE]') return;
        let payload;
        try { payload = JSON.parse(data); } catch { throw new AgentWorkError('invalid_stream_event'); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
          throw new AgentWorkError('invalid_stream_event');
        yield payload;
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_EVENT_BYTES)
        throw new AgentWorkError('oversize_stream_event');
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw new AgentWorkError('incomplete_stream_event');
  } catch (error) {
    if (error instanceof AgentWorkError) throw error;
    throw new AgentWorkError('stream_disconnected');
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    reader.releaseLock();
  }
}

function rootTurn(event) {
  // A completed child turn must never complete the parent job.
  return event?.turn?.subagent_id === null;
}

/**
 * Starts ONE metered, sandboxed agent job. No retries on ambiguous network failures.
 * onPublicStatus receives a fixed status object ONLY; no task text or output.
 * onPrivateText is the owner-private output channel, never the Live Signal channel.
 */
export async function runAgentJob(options, {
  fetchImpl = fetch,
  onPublicStatus = () => {},
  onPrivateText = () => {},
  onPrivateEvent = async () => {},
  signal,
} = {}) {
  const validated = validateAgentJob(options);
  const publicStatuses = [];
  const emit = async (state) => {
    if (!PUBLIC_STATES.has(state) || publicStatuses.at(-1) === state) return;
    publicStatuses.push(state);
    try { await onPublicStatus(Object.freeze({ version: 1, state })); }
    catch { /* a telemetry failure must not derail the private job */ }
  };
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + options.apiKey,
        'OpenAI-Beta': BETA,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(createAgentSessionBody(validated)),
      redirect: 'error',
      signal,
    });
  } catch {
    // Request may have reached provider. No automatic retry or inferred failure.
    throw new AgentWorkError('session_submit_unverified');
  }
  if (!response?.ok) throw new AgentWorkError('provider_http_' + Number(response?.status || 0));
  if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') || ''))
    throw new AgentWorkError('unexpected_provider_response');

  let status = 'unverified';
  let sessionId = null;
  let eventCount = 0;
  let outputText = '';
  let truncated = false;
  await emit('running');
  try {
    for await (const event of decodeAgentSse(response.body)) {
      eventCount++;
      const ids=[event?.session_id,event?.session?.id].filter(value=>value!==undefined);
      for(const id of ids){
        if(typeof id!=='string'||!/^sess_[a-zA-Z0-9_-]{1,128}$/.test(id)||
           (sessionId!==null&&sessionId!==id))throw new AgentWorkError('session_identity_unverified');
        sessionId=id;
      }
      // Critical private persistence hook. A failed checkpoint cannot become success.
      // Raw authenticated events must never be wired to a public browser endpoint.
      await onPrivateEvent(event,{sessionId,eventCount});
      if (event.type === 'agent.session.turn.output_text.delta' && typeof event.delta === 'string') {
        if (outputText.length < MAX_PRIVATE_OUTPUT) {
          const part = event.delta.slice(0, MAX_PRIVATE_OUTPUT - outputText.length);
          outputText += part;
          if (part.length < event.delta.length) truncated = true;
          try { await onPrivateText(part); } catch { /* output sink is optional */ }
        } else truncated = true;
      }
      if (event.type === 'agent.session.requires_action') {
        await emit('waiting');
        status = 'waiting';
      } else if (event.type === 'agent.session.turn.in_progress' && rootTurn(event)) {
        await emit('running');
        status = 'unverified';
      } else if (event.type === 'agent.session.turn.completed' && rootTurn(event)) {
        if(!sessionId)throw new AgentWorkError('session_identity_unverified');
        await emit('completed');
        status = 'completed';
        break;
      } else if (event.type === 'agent.session.turn.failed' && rootTurn(event)) {
        await emit('failed');
        status = 'failed';
        break;
      } else if (event.type === 'agent.session.turn.cancelled' && rootTurn(event)) {
        await emit('cancelled');
        status = 'cancelled';
        break;
      } else if (event.type === 'agent.session.failed' ||
                 event.type === 'agent.session.environment.failed') {
        await emit('failed');
        status = 'failed';
        break;
      } else if (event.type === 'error') {
        // An SSE transport error is not verified proof of a failed model turn.
        status = 'unverified';
        break;
      }
    }
  } catch {
    status = 'unverified';
  }
  return Object.freeze({
    status, sessionId, eventCount, outputText, truncated,
    spendLimitCents: validated.spendLimitCents,
    usage: null, // Best-effort actual usage requires later session readback.
  });
}
