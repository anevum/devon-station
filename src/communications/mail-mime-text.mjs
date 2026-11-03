// COMMS-08: bounded single-part text/plain MIME decoding, with no I/O or side effects.
// Raw input MUST be bytes from a trusted, size-limited IMAP literal framing layer.
// This is intentionally not a general-purpose MIME/attachment parser.
const MAX_WIRE_BYTES = 65536;
const MAX_HEADER_BYTES = 16384;
const MAX_HEADER_LINES = 128;
const MAX_DECODED_BYTES = 16384;
const MAX_SUBJECT = 512;
const MAX_BODY = 4096;
const CHARSETS = new Map([
  ['utf-8', 'utf-8'], ['us-ascii', 'us-ascii'], ['iso-8859-1', 'iso-8859-1']
]);
const EMAIL = /^[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]{0,63}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const SINGLE_HEADERS = new Set(['from', 'subject', 'mime-version', 'content-type',
  'content-transfer-encoding', 'content-disposition']);

export class MimeTextError extends Error {
  constructor(code) { super(code); this.name = 'MimeTextError'; this.code = code; }
}
function fail(code) { throw new MimeTextError(code); }
function bytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_WIRE_BYTES)
    fail('mime_invalid_input');
  return value;
}
function ascii(value, code) {
  if (value.some(x => x > 127)) fail(code);
  return Array.from(value, x => String.fromCharCode(x)).join('');
}
function findDelimiter(data) {
  for (let i = 0; i < data.length - 3 && i < MAX_HEADER_BYTES; i++) {
    if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10)
      return i;
  }
  fail('mime_invalid_headers');
}
function headersFrom(data) {
  const pos = findDelimiter(data);
  const header = ascii(data.subarray(0, pos), 'mime_invalid_headers');
  if (header.length > MAX_HEADER_BYTES || /\r(?!\n)|(?<!\r)\n/.test(header)) fail('mime_invalid_headers');
  const lines = header.split('\r\n');
  if (lines.length > MAX_HEADER_LINES) fail('mime_limits');
  const fields = new Map();
  let current = null;
  for (const line of lines) {
    if (line.length > 998 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line))
      fail('mime_invalid_headers');
    if (/^[ \t]/.test(line)) {
      if (!current) fail('mime_invalid_headers');
      if (SINGLE_HEADERS.has(current)) fields.set(current, fields.get(current) + ' ' + line.trim());
      continue;
    }
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (!match) fail('mime_invalid_headers');
    current = match[1].toLowerCase();
    if (SINGLE_HEADERS.has(current) && fields.has(current)) fail('mime_invalid_headers');
    // Other fields (e.g. repeated Received) are ignored by this decoder.
    if (SINGLE_HEADERS.has(current)) fields.set(current, match[2].trim());
  }
  if (!fields.has('from') || !fields.has('subject') ||
      (fields.has('mime-version') && fields.get('mime-version') !== '1.0'))
    fail('mime_invalid_headers');
  return { fields, body: data.subarray(pos + 4) };
}
function charsetValue(raw) {
  const cs = String(raw).toLowerCase();
  if (!CHARSETS.has(cs)) fail('mime_unsupported_charset');
  return CHARSETS.get(cs);
}
function decodeBytes(data, charset) {
  if (data.byteLength > MAX_DECODED_BYTES) fail('mime_limits');
  if (charset === 'us-ascii' && data.some(x => x > 127)) fail('mime_invalid_encoding');
  try { return new TextDecoder(charset, {fatal: true}).decode(data); }
  catch { fail('mime_invalid_encoding'); }
}
function strictBase64(input) {
  const inputStr = ascii(input, 'mime_invalid_encoding').replace(/\r\n/g, '');
  if (/\r|\n/.test(inputStr) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(inputStr))
    fail('mime_invalid_encoding');
  if ((inputStr.length / 4) * 3 > MAX_DECODED_BYTES + 2) fail('mime_limits');
  try { return Uint8Array.from(atob(inputStr), char => char.charCodeAt(0)); }
  catch { fail('mime_invalid_encoding'); }
}
function quotedPrintable(data, headerWord = false) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte > 127) fail('mime_invalid_encoding');
    if (headerWord && byte === 95) { result.push(32); continue; }
    if (byte !== 61) { result.push(byte); continue; }
    if (!headerWord && data[i + 1] === 13 && data[i + 2] === 10) { i += 2; continue; }
    const hi = String.fromCharCode(data[i + 1] ?? 0), lo = String.fromCharCode(data[i + 2] ?? 0);
    if (!/^[A-Fa-f0-9]$/.test(hi) || !/^[A-Fa-f0-9]$/.test(lo)) fail('mime_invalid_encoding');
    result.push(parseInt(hi + lo, 16)); i += 2;
    if (result.length > MAX_DECODED_BYTES) fail('mime_limits');
  }
  return Uint8Array.from(result);
}
function encodedSubject(input) {
  // RFC 2047 adjacent encoded words ignore separating linear whitespace.
  const adjacent = input.replace(/(\?=)[ \t]+(?==\?)/g, '$1');
  let touched = false;
  const text = adjacent.replace(/=\?([A-Za-z0-9-]+)\?([BbQq])\?([^?]*)\?=/g, (_match, cs, mode, payload) => {
    touched = true;
    const encoded = Uint8Array.from(payload, x => x.charCodeAt(0));
    return decodeBytes(mode.toLowerCase() === 'b' ? strictBase64(encoded) : quotedPrintable(encoded, true), charsetValue(cs));
  });
  if (/=\?/.test(text) || /\?=/.test(text) || (touched && /[\r\n]/.test(text))) fail('mime_invalid_subject');
  if (text.length > MAX_SUBJECT || /[\x00-\x1f\x7f\u0080-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text))
    fail('mime_invalid_subject');
  return text;
}
function fromAddress(raw) {
  const candidate = raw.includes('<') ? /^(?:[^<>,]{1,200})?<([^<>]+)>$/.exec(raw)?.[1] : raw;
  if (!candidate || candidate.length > 254 || candidate !== candidate.toLowerCase() ||
      !EMAIL.test(candidate) || candidate.includes('..')) fail('mime_invalid_from');
  return candidate;
}
function contentType(fields) {
  const raw = fields.get('content-type') ?? 'text/plain; charset=us-ascii';
  // Intentional restrictive subset; no multipart, HTML, charset guessing or filename parameters.
  const matched = /^text\/plain(?:\s*;\s*charset=(?:"([A-Za-z0-9-]+)"|([A-Za-z0-9-]+)))?\s*$/i.exec(raw);
  if (!matched) fail('mime_unsupported_content');
  const disposition = fields.get('content-disposition');
  if (disposition !== undefined && disposition.toLowerCase() !== 'inline') fail('mime_unsupported_content');
  return charsetValue(matched[1] ?? matched[2] ?? 'us-ascii');
}

/** Decode exactly one bounded MIME text/plain entity to inert UI text.
 * Do not insert returned strings into HTML, execute them or authorize any action from them.
 * Timestamp/UID must come from a separate trusted IMAP envelope, never these headers.
 */
export function decodeSinglePartPlainTextMime(raw) {
  const {fields, body} = headersFrom(bytes(raw));
  const charset = contentType(fields);
  const encoding = (fields.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  let decoded;
  if (encoding === 'base64') decoded = strictBase64(body);
  else if (encoding === 'quoted-printable') decoded = quotedPrintable(body);
  else if (encoding === '7bit') {
    if (body.some(x => x > 127)) fail('mime_invalid_encoding');
    decoded = body;
  } else if (encoding === '8bit') decoded = body;
  else fail('mime_unsupported_content');
  let text = decodeBytes(decoded, charset).replace(/\r\n/g, '\n');
  if (/\r|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text))
    fail('mime_invalid_encoding');
  if (text.length > MAX_BODY) fail('mime_limits');
  return Object.freeze({from: fromAddress(fields.get('from')), subject: encodedSubject(fields.get('subject')), text});
}
