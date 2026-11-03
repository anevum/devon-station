import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeSinglePartPlainTextMime, MimeTextError} from '../src/communications/mail-mime-text.mjs';
import {createReadOnlyImapProvider} from '../src/communications/mail-imap-readonly.mjs';

const encode = s => new TextEncoder().encode(s);
const build = (body='Hello', headers=[]) => encode([
  'From: Example Sender <author@example.org>',
  'Subject: Hello',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  ...headers,
  '', body
].join('\r\n'));
const reject = code => error => error instanceof MimeTextError && error.code === code;
const exchange = (subject, body, opts = {}) => build(body, [
  ...Object.entries(opts).map(([key, val]) => `${key}: ${val}`)
]);

test('ordinary RFC5322-style message produces inert frozen plain-text fields', () => {
  const result = decodeSinglePartPlainTextMime(build('A <script>alert(1)</script>\r\nB'));
  assert.deepEqual(result, {from:'author@example.org', subject:'Hello',
    text:'A <script>alert(1)</script>\nB'});
  assert(Object.isFrozen(result));
  assert.equal(Object.hasOwn(result, 'raw'), false);
});
test('RFC 2047 UTF-8 encoded-word B subject', () => {
  const input = encode('From: author@example.org\r\nSubject: =?UTF-8?B?8J+YgCB0ZXN0?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOk');
  assert.equal(decodeSinglePartPlainTextMime(input).subject, '😀 test');
});
test('RFC 2047 adjacent Q encoded-words suppress separator whitespace', () => {
  const input = encode('From: author@example.org\r\nSubject: =?utf-8?Q?Hello_?= \r\n\t=?utf-8?Q?world?=\r\n\r\nOk');
  assert.equal(decodeSinglePartPlainTextMime(input).subject, 'Hello world');
});
test('base64 UTF-8 transfer decoded without lossy replacement', () => {
  const raw = encode('From: author@example.org\r\nSubject: Base64\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+btoa(unescape(encodeURIComponent('Café 😀'))));
  assert.equal(decodeSinglePartPlainTextMime(raw).text, 'Café 😀');
});
test('quoted-printable charset and soft-break decoding', () => {
  const raw = encode('From: author@example.org\r\nSubject: QP\r\nContent-Type: text/plain; charset="iso-8859-1"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nOl=E1=20mu=\r\nndo');
  assert.equal(decodeSinglePartPlainTextMime(raw).text, 'Olá mundo');
});
test('UTF-8 8bit transfer and folded ignored Received header are valid', () => {
  const raw = encode('Received: by a.mail.test\r\n\twith TLS\r\nFrom: author@example.org\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nGrüße');
  assert.equal(decodeSinglePartPlainTextMime(raw).text, 'Grüße');
});
test('7bit default is valid for pure ASCII and absent Content-Type', () => {
  assert.equal(decodeSinglePartPlainTextMime(encode('From: author@example.org\r\nSubject: Hi\r\n\r\nOK')).text, 'OK');
});
test('reject strings as raw transport data and oversize input', () => {
  assert.throws(()=>decodeSinglePartPlainTextMime('From: a@b.c'), reject('mime_invalid_input'));
  assert.throws(()=>decodeSinglePartPlainTextMime(new Uint8Array(65537)), reject('mime_invalid_input'));
});
test('reject headerless, LF-only and mixed line break headers', () => {
  for (const raw of ['From: author@example.org\r\nSubject: Hi',
    'From: author@example.org\nSubject: Hi\n\nHi',
    'From: author@example.org\r\nSubject: Hi\n\r\nHi'])
    assert.throws(()=>decodeSinglePartPlainTextMime(encode(raw)), reject('mime_invalid_headers'));
});
test('reject duplicate required headers including CTE', () => {
  for (const header of ['From: another@example.org', 'Subject: Injected',
    'Content-Type: text/html', 'MIME-Version: 1.0'])
    assert.throws(()=>decodeSinglePartPlainTextMime(build('Hi', [header])), reject('mime_invalid_headers'));
});
test('reject duplicate content-transfer-encoding headers', () => {
  assert.throws(() => decodeSinglePartPlainTextMime(build('Hi', [
    'Content-Transfer-Encoding: 7bit', 'Content-Transfer-Encoding: base64'
  ])), reject('mime_invalid_headers'));
});
test('reject bad MIME version, invalid unfolded header and high ASCII headers', () => {
  assert.throws(()=>decodeSinglePartPlainTextMime(build('Hello', ['MIME-Version: 2.0'])), reject('mime_invalid_headers'));
  assert.throws(()=>decodeSinglePartPlainTextMime(encode(' From: a@b.example\r\nSubject: Hi\r\n\r\nHello')), reject('mime_invalid_headers'));
  assert.throws(()=>decodeSinglePartPlainTextMime(encode('From: author@example.org\r\nSubject: Café\r\n\r\nHi')), reject('mime_invalid_headers'));
});
test('reject oversized and excessively long header lines', () => {
  assert.throws(()=>decodeSinglePartPlainTextMime(build('Hi', ['X-Long: '+'A'.repeat(1000)])), reject('mime_invalid_headers'));
  const many = Array.from({length:129}, (_, i) => `X-${i}: OK`).join('\r\n');
  assert.throws(()=>decodeSinglePartPlainTextMime(encode(`From: author@example.org\r\nSubject: A\r\n${many}\r\n\r\nHi`)), reject('mime_limits'));
});
test('HTML and multipart content are always unsupported, not silently coerced', () => {
  for (const contentType of ['text/html; charset=utf-8','multipart/alternative; boundary="x"',
    'application/pdf', 'text/plain; charset=utf-8; name="bill.pdf"',
    'text/plain; charset=utf-8; format=flowed'])
    assert.throws(()=>decodeSinglePartPlainTextMime(build('<b>Hi</b>', [`Content-Type: ${contentType}`])), reject('mime_invalid_headers'));
});
test('reject all forms of attachment or suspicious disposition', () => {
  for (const disposition of ['attachment', 'inline; filename="invoice.pdf"', 'form-data'])
    assert.throws(()=>decodeSinglePartPlainTextMime(build('Hi', [`Content-Disposition: ${disposition}`])), reject('mime_unsupported_content'));
});
test('reject unknown charset and unsupported CTE', () => {
  const raw = encode('From: author@example.org\r\nSubject: Hi\r\nContent-Type: text/plain; charset=koi8-r\r\n\r\nHi');
  assert.throws(()=>decodeSinglePartPlainTextMime(raw), reject('mime_unsupported_charset'));
  for (const cte of ['binary', 'x-uuencode', 'gzip'])
    assert.throws(()=>decodeSinglePartPlainTextMime(build('A', [`Content-Transfer-Encoding: ${cte}`])), reject('mime_unsupported_content'));
});
test('invalid base64, invalid quoted-printable and bad UTF8 fail closed', () => {
  for (const data of ['***', 'AAAA=', 'A'])
    assert.throws(()=>decodeSinglePartPlainTextMime(build(data, ['Content-Transfer-Encoding: base64'])), reject('mime_invalid_encoding'));
  assert.throws(()=>decodeSinglePartPlainTextMime(build('abc=QX', ['Content-Transfer-Encoding: quoted-printable'])), reject('mime_invalid_encoding'));
  const malformed = encode('From: author@example.org\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/w==');
  assert.throws(()=>decodeSinglePartPlainTextMime(malformed), reject('mime_invalid_encoding'));
});
test('overflow of decoded text and subject is rejected, not truncated', () => {
  assert.throws(()=>decodeSinglePartPlainTextMime(build('A'.repeat(4097))), reject('mime_limits'));
  const large = encode('From: author@example.org\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'+btoa('A'.repeat(16400)));
  assert.throws(()=>decodeSinglePartPlainTextMime(large), reject('mime_limits'));
  const longSubject = encode('From: author@example.org\r\nSubject: '+ 'A'.repeat(513)+'\r\n\r\nHi');
  assert.throws(()=>decodeSinglePartPlainTextMime(longSubject), reject('mime_invalid_subject'));
});
test('bidirectional controls, null and bare CR are rejected', () => {
  assert.throws(()=>decodeSinglePartPlainTextMime(build('hello\u202Egoodbye')), reject('mime_invalid_encoding'));
  assert.throws(()=>decodeSinglePartPlainTextMime(build('a\u0000b')), reject('mime_invalid_encoding'));
  assert.throws(()=>decodeSinglePartPlainTextMime(build('a\rb')), reject('mime_invalid_encoding'));
  const bad = encode('From: author@example.org\r\nSubject: =?UTF-8?B?4oCu?=\r\n\r\nHi');
  assert.throws(()=>decodeSinglePartPlainTextMime(bad), reject('mime_invalid_subject'));
});
test('reject forged or malformed From and malformed encoded subject', () => {
  const raw = values => encode(`From: ${values}\r\nSubject: Hi\r\n\r\nText`);
  for (const value of ['a@example.org, b@example.org', 'Boss <a@example.org>, Other <b@example.org>',
    'Boss <a@example.org> <b@example.org>', 'Author <AUTHOR@example.org>',
    'Author <a@example.org\r\nBcc:evil@example.org>'])
    assert.throws(()=>decodeSinglePartPlainTextMime(raw(value)), err=> err instanceof MimeTextError);
  assert.throws(()=>decodeSinglePartPlainTextMime(encode('From: author@example.org\r\nSubject: =?utf-8?X?bad?=\r\n\r\nHi')), reject('mime_invalid_subject'));
});
test('sanitized MIME fields can feed the already-restricted IMAP provider without write commands', async () => {
  const content = encode('From: Author <author@example.org>\r\nSubject: =?UTF-8?Q?Hi_there?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello');
  const commands = [];
  const connector = {async open(){return {async exchange(command){
    commands.push(command);
    if (command.startsWith('EXAMINE')) return '* OK [UIDVALIDITY 7]';
    if (command.startsWith('UID SEARCH')) return '* SEARCH 1';
    if (command.startsWith('UID FETCH')) return {messages:[{
      uid:1,...decodeSinglePartPlainTextMime(content),timestamp:'2026-11-02T20:00:00Z',flags:[]}]};
    throw Error('unexpected IMAP command');
  }, async close(){}}}};
  const provider = createReadOnlyImapProvider({connector});
  const session = await provider.openReadOnly({mailbox:{provider:'purelymail',mode:'imap',address:'hello@devonakins.com'},readOnly:true,peek:true});
  try {const result = await session.fetchBatch({readOnly:true,peek:true});
    assert.equal(result.messages[0].subject,'Hi there');
    assert.equal(result.messages[0].from,'author@example.org');
    assert.equal(result.messages[0].text,'hello');
    assert.equal(result.uidValidity,7);
    assert(commands.every(x => !/\b(?:SELECT|STORE|EXPUNGE|APPEND)\b/.test(x)));
  } finally {await session.close();}
});
