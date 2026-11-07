#!/usr/bin/env node
/** Private local launcher. Intentional two-step spending gate; no browser-side API key. */
import { runAgentJob, AgentWorkError } from './agents-client.mjs';

function usage() {
  return 'Usage: node tools/ai-work/run.mjs --execute --spend-cents=NN < private-task.txt\n' +
    'Uses OPENAI_API_KEY (metered Agents API), NOT ChatGPT Work credits.\n' +
    'Without --execute, no provider call is made. Prompt is stdin-only.\n';
}

export async function main(args = process.argv.slice(2), {
  env = process.env, stdin = process.stdin, out = process.stdout,
  err = process.stderr, run = runAgentJob,
} = {}) {
  if (args.includes('--help')) { out.write(usage()); return 0; }
  const execute = args.includes('--execute');
  const caps = args.filter(arg => /^--spend-cents=\d+$/.test(arg));
  if (caps.length > 1 || args.some(arg => arg !== '--execute' && !/^--spend-cents=\d+$/.test(arg))) {
    err.write('invalid_cli_arguments\n' + usage()); return 2;
  }
  if (!execute) {
    out.write('No model call made. Add --execute and --spend-cents=NN after reviewing API billing.\n');
    return 0;
  }
  if (caps.length !== 1) { err.write('explicit_spend_cap_required\n'); return 2; }
  let task = '';
  for await (const chunk of stdin) {
    task += chunk;
    if (Buffer.byteLength(task, 'utf8') > 8192) {
      err.write('invalid_task\n'); return 2;
    }
  }
  try {
    const result = await run({
      task, model: 'gpt-6-astra', apiKey: env.OPENAI_API_KEY,
      spendLimitCents: Number(caps[0].split('=')[1]),
    }, {
      onPrivateText: text => out.write(text),
      // Public reporting is deliberately NOT wired in this source-only milestone.
    });
    out.write('\nSTATUS ' + result.status + '\n');
    if (result.status === 'unverified') err.write('Inspect the saved session before retrying.\n');
    return result.status === 'completed' ? 0 : 1;
  } catch (error) {
    err.write((error instanceof AgentWorkError ? error.code : 'agent_run_unavailable') + '\n');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  process.exitCode = await main();
}
