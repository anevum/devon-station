/**
 * Source-only RFC 5545 VEVENT preview. No storage, network, authorization,
 * side effects, recurrence expansion, or automatic migration approval.
 * Reject malformed calendars and disclose every unsupported event feature.
 */
const MAX_BYTES = 256 * 1024;
const MAX_EVENTS = 500;
const MAX_LINES = 8000;
const MAX_LINE = 16384;
const SUPPORTED_EVENT = new Set(['UID', 'SUMMARY', 'DESCRIPTION', 'DTSTART', 'DTEND', 'DTSTAMP', 'STATUS', 'SEQUENCE']);
const BASE_CALENDAR = new Set(['VERSION', 'PRODID', 'CALSCALE', 'X-WR-CALNAME', 'X-WR-CALDESC']);
const DATE = /^(\d{4})(\d{2})(\d{2})$/;
const DATETIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
const TYPE = /^[A-Z0-9-]+$/;

function fail(message) { throw new TypeError(`invalid iCalendar: ${message}`); }
function parts(text, separator) {
  const result = []; let segment = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    if (c === separator && !quoted) { result.push(segment); segment = ''; }
    else segment += c;
  }
  if (quoted) fail('unclosed parameter quote');
  result.push(segment);
  return result;
}
function unfold(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('oversized input');
  if (/\u0000|\r(?!\n)/.test(text)) fail('control characters');
  const physical = text.split(/\r?\n/);
  if (physical.length > MAX_LINES) fail('too many lines');
  const output = [];
  for (const line of physical) {
    if (line.length > MAX_LINE || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) fail('invalid line');
    if (/^[ \t]/.test(line)) {
      if (!output.length) fail('orphan continuation');
      output[output.length - 1] += line.slice(1);
      if (output[output.length - 1].length > MAX_LINE) fail('overlong unfolded line');
    } else if (line.length) output.push(line);
  }
  return output;
}
function property(line) {
  const colon = parts(line, ':');
  if (colon.length < 2) fail('property without value separator');
  const before = colon.shift();
  const tokens = parts(before, ';');
  const name = tokens.shift().toUpperCase();
  if (!TYPE.test(name)) fail('invalid property name');
  const params = {};
  for (const token of tokens) {
    const at = token.indexOf('=');
    if (at <= 0) fail('invalid parameter');
    const key = token.slice(0, at).toUpperCase();
    if (!TYPE.test(key) || Object.hasOwn(params, key)) fail('invalid or repeated parameter');
    const raw = token.slice(at + 1);
    if (!raw) fail('empty parameter');
    params[key] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  }
  return { name, params, value: colon.join(':') };
}
function textValue(raw) {
  // Unknown backslash escapes cannot be normalized without losing source meaning.
  if (/\\(?![nN,;\\])/.test(raw)) fail('unsupported text escape');
  return raw.replace(/\\([nN,;\\])/g, (_, c) => c === 'n' || c === 'N' ? '\n' : c);
}
function parseDateToken(raw) {
  const date = DATE.exec(raw), dateTime = DATETIME.exec(raw);
  if (!date && !dateTime) throw new RangeError('invalid source date-time token');
  const tuple = date || dateTime;
  const year = Number(tuple[1]), month = Number(tuple[2]), day = Number(tuple[3]);
  // The bounded migration preview deliberately defers historical pre-1900 events.
  if (year < 1900 || year > 2100) throw new RangeError('date outside supported preview range');
  const hour = dateTime ? Number(tuple[4]) : 0;
  const minute = dateTime ? Number(tuple[5]) : 0;
  const second = dateTime ? Number(tuple[6]) : 0;
  const instant = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(instant);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
    throw new RangeError('nonexistent date-time');
  }
  return { dateOnly: Boolean(date), utc: Boolean(dateTime && tuple[7] === 'Z'), instant,
    date: `${tuple[1]}-${tuple[2]}-${tuple[3]}`, hour, minute, second };
}
const pad = n => String(n).padStart(2, '0');
function wallString(parsed) { return `${parsed.date} ${pad(parsed.hour)}:${pad(parsed.minute)}:${pad(parsed.second)}`; }
function toZonedParts(timestamp, fmt) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(timestamp)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function resolveWallTime(parsed, zone) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }); } catch { return { issue: 'unknown-timezone' }; }
  const goal = wallString(parsed), matches = [];
  // Match every possible UTC offset at 15-minute granularity (-14h..+14h).
  // This is intentionally limited to contemporary records; the parser flags
  // unusual historical second-level offsets for manual review.
  for (let quarter = -56; quarter <= 56; quarter++) {
    const candidate = parsed.instant + quarter * 15 * 60000;
    if (toZonedParts(candidate, fmt) === goal) matches.push(candidate);
  }
  if (matches.length !== 1) return { issue: matches.length ? 'ambiguous-wall-time' : 'nonexistent-wall-time' };
  return { iso: new Date(matches[0]).toISOString() };
}
function dateOf(item, issues, field) {
  if (!item) return null;
  const paramKeys = Object.keys(item.params);
  if (paramKeys.some(key => !['VALUE', 'TZID'].includes(key))) issues.add(`${field}:unsupported-parameter`);
  let parsed;
  try { parsed = parseDateToken(item.value); } catch { issues.add(`${field}:invalid-date`); return null; }
  if (parsed.dateOnly) {
    if (item.params.VALUE !== 'DATE' || item.params.TZID) issues.add(`${field}:invalid-date-parameters`);
    return { kind: 'all-day', value: parsed.date };
  }
  if (item.params.VALUE && item.params.VALUE !== 'DATE-TIME') issues.add(`${field}:unsupported-value`);
  if (parsed.utc) {
    if (item.params.TZID) issues.add(`${field}:conflicting-tzid`);
    return { kind: 'timed', value: new Date(parsed.instant).toISOString(), zone: 'Etc/UTC' };
  }
  if (!item.params.TZID) { issues.add(`${field}:floating-time`); return { kind: 'timed', value: null }; }
  const result = resolveWallTime(parsed, item.params.TZID);
  if (result.issue) issues.add(`${field}:${result.issue}`);
  return { kind: 'timed', value: result.iso || null, zone: item.params.TZID };
}
function single(entries, name, issues) {
  const values = entries.filter(p => p.name === name);
  if (values.length > 1) issues.add(`${name}:duplicate`);
  return values[0] || null;
}
function eventPreview(raw, index, defaultTimeZone, calendarIssues, embeddedZones) {
  const issues = new Set(calendarIssues);
  for (const p of raw.properties) {
    if (!SUPPORTED_EVENT.has(p.name)) issues.add(`unsupported:${p.name}`);
    if (!['DTSTART', 'DTEND'].includes(p.name) && Object.keys(p.params).length) issues.add(`${p.name}:unsupported-parameter`);
  }
  if (raw.alarms.length) issues.add('unsupported:VALARM');
  const uid = single(raw.properties, 'UID', issues)?.value || '';
  if (!uid.trim() || uid.length > 512 || /[\u0000-\u001f]/.test(uid)) issues.add('UID:missing-or-invalid');
  const summaryProp = single(raw.properties, 'SUMMARY', issues);
  let summary = '(untitled event)';
  if (summaryProp) {
    try { summary = textValue(summaryProp.value); } catch { issues.add('SUMMARY:invalid-escape'); }
  } else issues.add('SUMMARY:missing');
  const description = single(raw.properties, 'DESCRIPTION', issues);
  if (description) try { textValue(description.value); } catch { issues.add('DESCRIPTION:invalid-escape'); }
  const begin = dateOf(single(raw.properties, 'DTSTART', issues), issues, 'DTSTART');
  const end = dateOf(single(raw.properties, 'DTEND', issues), issues, 'DTEND');
  if (!begin) issues.add('DTSTART:missing-or-invalid');
  if (!end) issues.add('DTEND:missing-or-implicit');
  if (begin && end && begin.kind !== end.kind) issues.add('DTEND:mismatched-kind');
  if (begin && end && begin.value && end.value && begin.value >= end.value) issues.add('DTEND:nonpositive-range');
  const sourceZone = begin?.zone || defaultTimeZone || null;
  if (begin?.kind === 'all-day' && !defaultTimeZone) issues.add('all-day:unassigned-calendar-timezone');
  if (sourceZone && embeddedZones.has(sourceZone)) issues.add('timezone:embedded-rules-unverified');
  const sequenceItem = single(raw.properties, 'SEQUENCE', issues);
  let sequence = 0;
  if (sequenceItem) {
    if (!/^(0|[1-9][0-9]{0,7})$/.test(sequenceItem.value)) issues.add('SEQUENCE:invalid');
    else sequence = Number(sequenceItem.value);
  }
  const statusItem = single(raw.properties, 'STATUS', issues);
  const status = statusItem?.value || 'CONFIRMED';
  if (!['CONFIRMED', 'TENTATIVE', 'CANCELLED'].includes(status)) issues.add('STATUS:unsupported');
  if (status === 'CANCELLED') issues.add('STATUS:cancellation-requires-review');
  const recurrence = single(raw.properties, 'RECURRENCE-ID', issues)?.value || null;
  if (recurrence) issues.add('recurrence:exception-requires-review');
  if (raw.properties.some(p => ['RRULE','RDATE','EXDATE','EXRULE'].includes(p.name))) issues.add('recurrence:rule-requires-review');
  return {
    index, uid, sequence, recurrenceId: recurrence, title: summary,
    status, kind: begin?.kind || null, start: begin?.value || null,
    endExclusive: end?.value || null, timeZone: sourceZone,
    // Retain all original event properties in memory so unsupported material
    // is visible to a future explicit reviewer; never persist raw input here.
    sourceProperties: raw.properties, sourceAlarms: raw.alarms,
    issues: [...issues].sort(), disposition: 'needs-review',
  };
}

/**
 * Analyze untrusted, local ICS text. This does not import or persist anything.
 * All rows require owner approval even when disposition is 'candidate'.
 */
export function previewCalendarIcs(text, { defaultTimeZone = null } = {}) {
  if (defaultTimeZone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: defaultTimeZone }); }
    catch { throw new TypeError('invalid default calendar time zone'); }
  }
  const lines = unfold(text), stack = [], rawEvents = [], embeddedZones = new Set();
  const calendarProps = [], calendarIssues = new Set(), sourceTimeZones = [];
  let event = null, timeZoneId = null, timeZone = null;
  for (const line of lines) {
    const p = property(line);
    if (p.name === 'BEGIN') {
      if (Object.keys(p.params).length) fail('parameters on component marker');
      const parent = stack.at(-1);
      if (p.value === 'VCALENDAR' && stack.length === 0) {
        if (rawEvents.length || calendarProps.length) fail('duplicate root');
      } else if (p.value === 'VEVENT' && parent === 'VCALENDAR') {
        if (rawEvents.length >= MAX_EVENTS) fail('too many events');
        event = { properties: [], alarms: [] };
      } else if (p.value === 'VTIMEZONE' && parent === 'VCALENDAR') {
        timeZoneId = null; timeZone = { properties: [], observances: [] };
      } else if (['STANDARD', 'DAYLIGHT'].includes(p.value) && parent === 'VTIMEZONE') {
        timeZone.observances.push({ kind: p.value, properties: [] });
      }
      else if (p.value === 'VALARM' && parent === 'VEVENT') event.alarms.push([]);
      else fail(`unsupported component ${p.value}`);
      stack.push(p.value);
      continue;
    }
    if (p.name === 'END') {
      if (Object.keys(p.params).length) fail('parameters on component marker');
      if (!stack.length || stack.at(-1) !== p.value) fail('unbalanced components');
      if (p.value === 'VEVENT') { rawEvents.push(event); event = null; }
      if (p.value === 'VTIMEZONE') {
        if (timeZoneId) embeddedZones.add(timeZoneId);
        sourceTimeZones.push(timeZone); timeZone = null;
      }
      stack.pop();
      continue;
    }
    const current = stack.at(-1);
    if (current === 'VCALENDAR') calendarProps.push(p);
    else if (current === 'VEVENT') event.properties.push(p);
    else if (current === 'VALARM') event.alarms.at(-1).push(p);
    else if (current === 'VTIMEZONE') {
      timeZone.properties.push(p);
      if (p.name === 'TZID') timeZoneId = p.value;
    } else if (current === 'STANDARD' || current === 'DAYLIGHT') {
      timeZone.observances.at(-1).properties.push(p);
    }
    else if (!current) fail('property outside calendar');
  }
  if (stack.length || !calendarProps.length || !rawEvents.length) fail('incomplete or empty calendar');
  const version = calendarProps.filter(p => p.name === 'VERSION');
  if (version.length !== 1 || version[0].value !== '2.0') fail('unsupported VERSION');
  for (const p of calendarProps) if (!BASE_CALENDAR.has(p.name)) calendarIssues.add(`calendar:unsupported:${p.name}`);
  if (calendarProps.some(p => p.name === 'METHOD')) calendarIssues.add('calendar:method-requires-review');
  if (calendarProps.some(p => p.name === 'CALSCALE' && p.value !== 'GREGORIAN')) calendarIssues.add('calendar:unsupported-scale');
  const previews = rawEvents.map((item, i) => eventPreview(item, i, defaultTimeZone, calendarIssues, embeddedZones));
  const identities = new Map(), bases = new Set(previews.filter(e => !e.recurrenceId).map(e => e.uid));
  for (const item of previews) {
    const key = JSON.stringify([item.uid, item.recurrenceId]);
    if (!identities.has(key)) identities.set(key, []);
    identities.get(key).push(item);
    if (item.recurrenceId && !bases.has(item.uid)) item.issues.push('recurrence:orphan-exception');
  }
  for (const group of identities.values()) {
    if (group.length > 1) for (const item of group) item.issues.push('UID:duplicate-source-identity');
  }
  for (const item of previews) {
    item.issues = [...new Set(item.issues)].sort();
    item.disposition = item.issues.length ? 'needs-review' : 'candidate';
  }
  return { format: 'devonstation-ics-preview-v1', inputEvents: rawEvents.length,
    candidates: previews.filter(e => e.disposition === 'candidate').length,
    needsReview: previews.filter(e => e.disposition === 'needs-review').length,
    events: previews, sourceCalendarProperties: calendarProps,
    sourceTimeZones, imported: 0 };
}
