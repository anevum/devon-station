import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

test('preserved V0.3 server module matches the observed production source fingerprint', () => {
  const bytes = readFileSync(new URL('../legacy/v03/worker/index.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'b2974dde4ca177420caecd810b8f008d582c93131317c6a822b5bb821c3c8c94');
});
