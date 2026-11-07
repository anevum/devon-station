import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentWorkError, validateAgentJob, createAgentSessionBody,
  decodeAgentSse, runAgentJob,
} from '../tools/ai-work/agents-client.mjs';
import { main } from '../tools/ai-work/run.mjs';

const TOKEN = 'sk-' + 'test_FAKE_SECRET_NOT_A_REAL_KEY';
const OPTIONS = { task: 'Inspect a small source file and run tests.', spendLimitCents: 35, apiKey: TOKEN };
const root = type => ({ type, session_id: 'sess_safeTest', turn: { subagent_id: null } });
const sub = type => ({ type, session_id: 'sess_safeTest', turn: { subagent_id: 'child' } });
const frame = event => 'event: message\ndata: ' + JSON.stringify(event) + '\n\n';
const mockResponse = (events, { status = 200, ct = 'text/event-stream', chunks } = {}) => {
  const data = chunks || [events.map(frame).join('')];
  const stream = new ReadableStream({
    start(controller) { for (const part of data) controller.enqueue(new TextEncoder().encode(part)); controller.close(); },
  });
  return new Response(stream, { status, headers: { 'Content-Type': ct } });
};
function mockRunner(events, params = {}) {
  const requests = [], publicStates = [], privateTexts = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return mockResponse(events, params);
  };
  return {
    requests, publicStates, privateTexts,
    run: () => runAgentJob(OPTIONS, {
      fetchImpl,
      onPublicStatus: event => publicStates.push(event),
      onPrivateText: txt => privateTexts.push(txt),
    }),
  };
}

test('requires task, supported model, API credential and explicit integer cap', () => {
  assert.equal(validateAgentJob(OPTIONS).model, 'gpt-6-astra');
  for (const field of [
    { task: '' }, { task: 'a'.repeat(9000) }, { model: 'fake-model' },
    { apiKey: 'invalid' }, { spendLimitCents: 0 }, { spendLimitCents: 10001 },
    { spendLimitCents: 1.5 }, { spendLimitCents: undefined },
  ]) assert.throws(() => validateAgentJob({ ...OPTIONS, ...field }), AgentWorkError);
});

test('request has a provider-enforced spending cap and isolated sandbox, no API key in body', () => {
  const data = createAgentSessionBody(validateAgentJob(OPTIONS));
  assert.deepEqual(data.spend_control, { limit: 35 });
  assert.deepEqual(data.environment, { type: 'openai_hosted' });
  assert.equal(data.agent.model, 'gpt-6-astra');
  assert.equal(data.stream, true);
  assert.equal(data.input, OPTIONS.task);
  assert.doesNotMatch(JSON.stringify(data), /sk-test|apiKey|secret/);
});

test('real root completion produces private text and only fixed public states', async () => {
  const privateData = 'PRIVATE_CLIENT_CONTENT';
  const f = mockRunner([
    { type: 'agent.session.created', session: { id: 'sess_safeTest' } },
    sub('agent.session.turn.completed'),
    { type: 'agent.session.turn.output_text.delta', delta: privateData },
    root('agent.session.turn.completed'),
  ]);
  const result = await f.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'sess_safeTest');
  assert.equal(result.outputText, privateData);
  assert.equal(result.usage, null);
  assert.deepEqual(f.privateTexts, [privateData]);
  assert.deepEqual(f.publicStates, [
    {version:1,state:'running'}, {version:1,state:'completed'},
  ]);
  assert.doesNotMatch(JSON.stringify(f.publicStates), /PRIVATE_CLIENT_CONTENT|sess_safeTest|Inspect/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://api.openai.com/v1/agents/sessions');
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(f.requests[0].init.headers['OpenAI-Beta'], 'agents=v1');
  assert.equal(JSON.parse(f.requests[0].init.body).spend_control.limit, 35);
});

test('root failure/cancel are distinct; completed does not imply tests passed', async () => {
  for (const [type, expected] of [
    ['agent.session.turn.failed', 'failed'],
    ['agent.session.turn.cancelled', 'cancelled'],
  ]) {
    const f = mockRunner([sub('agent.session.turn.completed'), root(type)]);
    assert.equal((await f.run()).status, expected);
    assert.deepEqual(f.publicStates.map(x=>x.state), ['running', expected]);
  }
});

test('needs-action waits; only real root resume re-enters running', async () => {
  const f = mockRunner([
    {type:'agent.session.requires_action', required_actions:[{prompt:'SECRET'}]},
    {type:'agent.session.turn.output_text.delta', delta:'private reply'},
    sub('agent.session.turn.in_progress'),
    root('agent.session.turn.in_progress'),
    root('agent.session.turn.completed'),
  ]);
  assert.equal((await f.run()).status, 'completed');
  assert.deepEqual(f.publicStates.map(x=>x.state), ['running', 'waiting', 'running', 'completed']);
  assert.doesNotMatch(JSON.stringify(f.publicStates), /SECRET|private reply/);
});

test('requires-action without completion stays waiting, not successful', async () => {
  const f = mockRunner([{type:'agent.session.requires_action', required_actions:[]}]);
  assert.equal((await f.run()).status, 'waiting');
  assert.deepEqual(f.publicStates.map(x=>x.state), ['running','waiting']);
});

test('idle or stream end without root terminal is unverified', async () => {
  for (const event of [{type:'agent.session.idle'}, sub('agent.session.turn.completed'), {type:'error', message:'SENSITIVE_TOKEN_VALUE'}]) {
    const f = mockRunner([event]);
    assert.equal((await f.run()).status, 'unverified');
    assert.deepEqual(f.publicStates, [{version:1,state:'running'}]);
  }
});

test('provider HTTP error never reveals raw error body, credentials, or retries', async () => {
  let calls = 0;
  await assert.rejects(() => runAgentJob(OPTIONS, {
    fetchImpl: async () => { calls++; return new Response('PROVIDER_SECRET', {status:403}); },
  }), err => err.code === 'provider_http_403' && !String(err).includes('PROVIDER_SECRET'));
  assert.equal(calls,1);
});

test('failed request is ambiguous; no automatic retry or public status', async () => {
  let calls=0, events=[];
  await assert.rejects(() => runAgentJob(OPTIONS, {
    fetchImpl:async()=>{calls++; throw Error('PRIVATE_URL / file');},
    onPublicStatus:x=>events.push(x),
  }), err=>err.code==='session_submit_unverified');
  assert.equal(calls,1);
  assert.deepEqual(events,[]);
});

test('untrusted provider output and a failing telemetry callback cannot disrupt a task', async () => {
  const result = await runAgentJob(OPTIONS, {
    fetchImpl: async() => mockResponse([root('agent.session.turn.completed')]),
    onPublicStatus: () => { throw Error('never leak'); },
    onPrivateText: () => { throw Error('never leak'); },
  });
  assert.equal(result.status,'completed');
});

test('SSE decoder handles UTF-8 boundaries and multi-data frames without leaking private bytes', async () => {
  const chunks = [
    'event: message\r', '\ndata: {"type":"agent.session.',
    'turn.completed","turn":{"subagent_id":null}}\r', '\n\r', '\n',
  ];
  const data = [];
  for await (const event of decodeAgentSse(mockResponse([], {chunks}).body)) data.push(event);
  assert.equal(data.length,1);
  assert.equal(data[0].turn.subagent_id,null);
});

test('rejects oversized, malformed or incomplete SSE frames with sanitized errors', async () => {
  const invalid = [
    {chunks:['data: '+ 'x'.repeat(1048577)]},
    {chunks:['data: {notjson}\n\n']},
    {chunks:['data: {"type":"hi"}']},
  ];
  for (const sample of invalid) {
    const task = async () => {
      for await (const ev of decodeAgentSse(mockResponse([],sample).body)) void ev;
    };
    await assert.rejects(task, error=> error instanceof AgentWorkError &&
      !String(error).includes('notjson'));
  }
});

test('CLI refuses a model call without explicit execution and spending cap', async () => {
  let invoked = 0;
  const captured=[];
  const out={write:msg=>captured.push(msg)};
  const err={write:msg=>captured.push(msg)};
  const run=async()=>{invoked++; return {status:'completed'};};
  assert.equal(await main([], {out,err,run}),0);
  assert.equal(await main(['--execute'], {out,err,run}),2);
  assert.equal(await main(['--execute','--spend-cents=3','--prompt=SECRET'], {out,err,run}),2);
  assert.equal(invoked,0);
});


test('mixed provider session identities cannot complete or leak output into a different private job',async()=>{
 const result=await runAgentJob(OPTIONS,{fetchImpl:async()=>mockResponse([
  {type:'agent.session.created',session:{id:'sess_first'}},
  {type:'agent.session.turn.completed',session_id:'sess_wrong',turn:{subagent_id:null}},
 ])});
 assert.equal(result.status,'unverified');assert.equal(result.sessionId,'sess_first');
});

test('awaits private session checkpoint before consuming output and refuses success if persistence fails',async()=>{
 let saved=false,outputs=0;
 const result=await runAgentJob(OPTIONS,{
  fetchImpl:async()=>mockResponse([
   {type:'agent.session.created',session:{id:'sess_first'}},
   {type:'agent.session.turn.output_text.delta',delta:'PRIVATE'},
   {type:'agent.session.turn.completed',session_id:'sess_first',turn:{subagent_id:null}},
  ]),
  onPrivateEvent:async(event,receipt)=>{
   await Promise.resolve();
   assert.equal(receipt.sessionId,'sess_first');
   if(event.type==='agent.session.created')saved=true;
   else throw Error('PRIVATE_PERSISTENCE_ERROR');
  },
  onPrivateText:()=>{outputs++;},
 });
 assert.equal(saved,true);assert.equal(outputs,0);assert.equal(result.status,'unverified');
 assert.equal(result.sessionId,'sess_first');
});

test('asynchronous optional reporter failure does not become an unhandled rejection or private task failure',async()=>{
 const result=await runAgentJob(OPTIONS,{fetchImpl:async()=>mockResponse([root('agent.session.turn.completed')]),onPublicStatus:async()=>{throw Error('unavailable');}});
 assert.equal(result.status,'completed');
});

test('provider identity binding does not invent an undocumented session prefix but rejects unsafe IDs',async()=>{
 const result=await runAgentJob(OPTIONS,{fetchImpl:async()=>mockResponse([
  {type:'agent.session.created',session:{id:'as_syntheticSession'}},
  {type:'agent.session.turn.completed',session_id:'as_syntheticSession',turn:{subagent_id:null}},
 ])});assert.equal(result.status,'completed');assert.equal(result.sessionId,'as_syntheticSession');
 const unsafe=await runAgentJob(OPTIONS,{fetchImpl:async()=>mockResponse([{type:'agent.session.created',session:{id:'../../private'}}])});
 assert.equal(unsafe.status,'unverified');assert.equal(unsafe.sessionId,null);
});
