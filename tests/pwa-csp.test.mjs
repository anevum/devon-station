import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const directives = policy => new Map(policy.split(';').map(item => item.trim()).filter(Boolean).map(item => {
  const [name, ...tokens] = item.split(/\s+/);
  return [name, tokens];
}));
const workerSources = policy => {
  const values = directives(policy);
  return values.get('worker-src') ?? values.get('child-src') ?? values.get('script-src') ?? values.get('default-src') ?? [];
};

test('page CSP independently permits same-origin service workers', () => {
  const html = source('src/index.html');
  const policy = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
  assert.ok(policy, 'missing enforced HTML meta CSP');
  assert.deepEqual(workerSources(policy), ["'self'"], 'HTML CSP must not inherit inline-only script restrictions');
  const values = directives(policy);
  assert.deepEqual(values.get('default-src'), ["'none'"], 'keep deny-by-default');
  assert.deepEqual(values.get('script-src'), ["'unsafe-inline'"], 'do not widen script execution');
  assert.deepEqual(values.get('connect-src'), ["'none'"], 'source template must retain original deny-by-default API behavior');
  assert.match(source('worker/index.mjs'), /worker-src 'self'/, 'HTTP CSP must separately permit same-origin workers');
});

test('PWA registers only the same-origin service worker under the existing root scope', () => {
  assert.match(source('src/pwa.js'), /serviceWorker\.register\('\/sw\.js',\{scope:'\/'/, 'PWA script or scope changed');
  assert.match(source('tools/build-hosted-shell.mjs'), /\.replace\('\/\* STATION_CODE \*\/'/, 'unexpected hosted HTML build');
});

test('legacy inline-only script-src does not authorize a service worker', () => {
  const legacy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";
  assert.deepEqual(workerSources(legacy), ["'unsafe-inline'"]);
  assert.deepEqual(workerSources(legacy + "; worker-src 'self'"), ["'self'"]);
});
