// Offline, synthetic source-to-source interoperation. Never provide live tokens.
// Run explicitly with RECOVERED_ACCESS_MODULE pointing at a separate, pinned
// checkout of recovery PR #1. It is deliberately excluded from npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccessScopeBridge } from '../src/access-scope-bridge.mjs';

const verifierPath = process.env.RECOVERED_ACCESS_MODULE;
if (!verifierPath) {
  throw new Error('RECOVERED_ACCESS_MODULE must point to the separately checked-out recovered verifier');
}
const { verifyAccessJWT } = await import(pathToFileURL(resolve(verifierPath)).href);

const config = Object.freeze({
  issuer: 'https://ds011-synthetic.cloudflareaccess.com',
  audience: 'ds011-synthetic-only-audience',
  jwksUrl: 'https://ds011-synthetic.cloudflareaccess.com/cdn-cgi/access/certs'
});
const requestedScope = Object.freeze({ scopeKind: 'personal', scopeId: 'personal-a' });
const configuredGrant = Object.freeze({
  subject: 'provider-subject-a',
  principalId: 'owner-a',
  scopeKind: 'personal',
  scopeId: 'personal-a',
  role: 'owner'
});

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = () => Date.now() / 1000;

async function createSyntheticIssuer() {
  const keyPair = await webcrypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  }, true, ['sign', 'verify']);
  const publicKey = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
  Object.assign(publicKey, { kid: 'ds011-generated-test-key', alg: 'RS256', use: 'sig' });
  let verificationCount = 0;

  async function sign(overrides = {}) {
    const claims = {
      iss: config.issuer,
      aud: [config.audience],
      sub: configuredGrant.subject,
      exp: now() + 300,
      nbf: now() - 60,
      iat: now() - 60,
      email: 'synthetic-untrusted@example.test',
      role: 'admin',
      ...overrides
    };
    const input = encode({ alg: 'RS256', kid: publicKey.kid }) + '.' + encode(claims);
    const signature = await webcrypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      keyPair.privateKey,
      new TextEncoder().encode(input)
    );
    return input + '.' + Buffer.from(signature).toString('base64url');
  }

  async function getJWKS(url) {
    assert.equal(url, config.jwksUrl, 'JWKS endpoint must stay pinned');
    verificationCount++;
    return { keys: [publicKey] };
  }

  const bridge = createAccessScopeBridge({
    verifyAssertion: token => verifyAccessJWT(token, config, getJWKS),
    grants: [configuredGrant]
  });
  return { sign, bridge, getJWKS, getVerificationCount: () => verificationCount };
}

test('valid signed synthetic identity maps only to a server-owned personal scope', async () => {
  const issuer = await createSyntheticIssuer();
  const assertion = await issuer.sign();
  const identity = await issuer.bridge.authorize(assertion, requestedScope);
  assert.deepEqual(identity, {
    principalId: 'owner-a', role: 'owner',
    scopeKind: 'personal', scopeId: 'personal-a'
  });
  assert.equal('email' in identity, false);
  await issuer.bridge.authorize(assertion, requestedScope);
  assert.equal(issuer.getVerificationCount(), 2, 'each protected operation must verify the token');
});

test('recovery verifier rejects malformed signed time claims before scope mapping', async () => {
  const issuer = await createSyntheticIssuer();
  for (const invalid of [
    { nbf: 'yesterday' }, { nbf: null }, { nbf: [now() - 1] },
    { iat: { seconds: now() - 1 } }, { iat: null },
    { exp: 'tomorrow' }, { nbf: now() + 3600 },
    { iat: now() + 3600 }, { exp: now() - 1 }
  ]) {
    const signed = await issuer.sign(invalid);
    await assert.rejects(verifyAccessJWT(signed, config, issuer.getJWKS), /Invalid JWT claims/);
    await assert.rejects(issuer.bridge.authorize(signed, requestedScope), /access denied/);
  }
  const optionalTimeClaims = await issuer.sign({ nbf: undefined, iat: undefined });
  assert.equal((await issuer.bridge.authorize(optionalTimeClaims, requestedScope)).principalId, 'owner-a');
  const fractionalTimeClaims = await issuer.sign({
    exp: now() + 300.25, nbf: now() - 60.25, iat: now() - 60.25
  });
  assert.equal((await issuer.bridge.authorize(fractionalTimeClaims, requestedScope)).principalId, 'owner-a');
});

test('wrong audience, issuer, subject and forged payload never grant a scope', async () => {
  const issuer = await createSyntheticIssuer();
  for (const invalid of [
    { iss: 'https://other.cloudflareaccess.com' },
    { aud: ['other-app'] },
    { sub: 'provider-subject-b', role: 'owner', email: 'owner@example.test' },
    { sub: '' }
  ]) {
    await assert.rejects(issuer.bridge.authorize(await issuer.sign(invalid), requestedScope), /access denied/);
  }
  const signed = await issuer.sign();
  const [header, payload, signature] = signed.split('.');
  const tampered = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  tampered.role = 'owner';
  const forged = header + '.' + encode(tampered) + '.' + signature;
  await assert.rejects(issuer.bridge.authorize(forged, requestedScope), /access denied/);
});

test('valid signed identity cannot access another project or business', async () => {
  const issuer = await createSyntheticIssuer();
  const signed = await issuer.sign();
  for (const scope of [
    { scopeKind: 'personal', scopeId: 'personal-b' },
    { scopeKind: 'business', scopeId: 'personal-a' },
    { scopeKind: 'creative', scopeId: 'personal-a' },
    { scopeKind: 'personal', scopeId: 'personal-a', role: 'owner' }
  ]) {
    await assert.rejects(issuer.bridge.authorize(signed, scope), /access denied/);
  }
});
