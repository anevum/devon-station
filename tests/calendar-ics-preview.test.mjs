import test from 'node:test';
import assert from 'node:assert/strict';
import { previewCalendarIcs } from '../src/calendar-ics-preview.mjs';

const wrap = (events, extra = '') => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//synthetic//EN', extra,
  events, 'END:VCALENDAR', '',
].filter(x => x !== '').join('\r\n');
const event = (props) => ['BEGIN:VEVENT', 'UID:synth@example.test', 'SUMMARY:Synthetic meeting',
  'DTSTART:20261102T150000Z', 'DTEND:20261102T160000Z', props, 'END:VEVENT'
].filter(Boolean).join('\r\n');
const row = (ics, options = {}) => previewCalendarIcs(ics, options).events[0];

test('candidate UTC event previews without importing or mutating it', () => {
  const ics = wrap(event('DTSTAMP:20261101T150000Z'));
  const preview = previewCalendarIcs(ics);
  assert.equal(preview.inputEvents, 1);
  assert.equal(preview.imported, 0);
  assert.equal(preview.candidates, 1);
  assert.equal(preview.needsReview, 0);
  assert.equal(preview.events[0].start, '2026-11-02T15:00:00.000Z');
  assert.equal(preview.events[0].endExclusive, '2026-11-02T16:00:00.000Z');
  assert.equal(preview.events[0].timeZone, 'Etc/UTC');
});
test('all-day event maintains exclusive local dates and calendar zone', () => {
  const ics = wrap(event('').replace('DTSTART:20261102T150000Z', 'DTSTART;VALUE=DATE:20261031')
    .replace('DTEND:20261102T160000Z', 'DTEND;VALUE=DATE:20261103'));
  const p = row(ics, { defaultTimeZone: 'America/New_York' });
  assert.equal(p.disposition, 'candidate');
  assert.equal(p.kind, 'all-day');
  assert.equal(p.start, '2026-10-31');
  assert.equal(p.endExclusive, '2026-11-03');
});
test('folded lines and RFC 5545 escaped text are unfolded without corruption', () => {
  const ics = wrap(event('')
    .replace('SUMMARY:Synthetic meeting', 'SUMMARY:Synthetic\\, folded\\nmeeting\r\n  continued'));
  const p = row(ics);
  assert.equal(p.title, 'Synthetic, folded\nmeeting continued');
});
test('IANA local noon converts correctly on both sides of DST', () => {
  const local = (date, end) => wrap(event('')
    .replace('DTSTART:20261102T150000Z', `DTSTART;TZID=America/New_York:${date}`)
    .replace('DTEND:20261102T160000Z', `DTEND;TZID=America/New_York:${end}`));
  assert.equal(row(local('20260115T120000', '20260115T130000')).start, '2026-01-15T17:00:00.000Z');
  assert.equal(row(local('20260715T120000', '20260715T130000')).start, '2026-07-15T16:00:00.000Z');
});
test('DST fall-back overlap is not assigned an arbitrary instant', () => {
  const ics = wrap(event('')
    .replace('DTSTART:20261102T150000Z', 'DTSTART;TZID=America/New_York:20261101T013000')
    .replace('DTEND:20261102T160000Z', 'DTEND;TZID=America/New_York:20261101T023000'));
  const p = row(ics);
  assert.equal(p.disposition, 'needs-review');
  assert.ok(p.issues.includes('DTSTART:ambiguous-wall-time'));
  assert.equal(p.start, null);
});
test('DST spring-forward gap is flagged rather than normalized', () => {
  const ics = wrap(event('')
    .replace('DTSTART:20261102T150000Z', 'DTSTART;TZID=America/New_York:20260308T023000')
    .replace('DTEND:20261102T160000Z', 'DTEND;TZID=America/New_York:20260308T033000'));
  const p = row(ics);
  assert.ok(p.issues.includes('DTSTART:nonexistent-wall-time'));
  assert.equal(p.disposition, 'needs-review');
});
test('floating times require explicit human review', () => {
  const ics = wrap(event('').replace('DTSTART:20261102T150000Z', 'DTSTART:20261102T150000'));
  assert.ok(row(ics).issues.includes('DTSTART:floating-time'));
});
test('recurring weekly series is preserved and blocked from automatic import', () => {
  const p = row(wrap(event('RRULE:FREQ=WEEKLY;BYDAY=MO,WE')));
  assert.equal(p.disposition, 'needs-review');
  assert.ok(p.issues.includes('recurrence:rule-requires-review'));
  assert.equal(p.sourceProperties.find(x => x.name === 'RRULE').value, 'FREQ=WEEKLY;BYDAY=MO,WE');
});
test('recurrence cancellation and orphan override are flagged', () => {
  const ics = wrap(event('RECURRENCE-ID:20261109T150000Z\r\nSTATUS:CANCELLED'));
  const p = row(ics);
  assert.ok(p.issues.includes('recurrence:exception-requires-review'));
  assert.ok(p.issues.includes('recurrence:orphan-exception'));
  assert.ok(p.issues.includes('STATUS:cancellation-requires-review'));
});
test('duplicate source UID and occurrence identities block both candidates', () => {
  const p = previewCalendarIcs(wrap([event(''), event('')].join('\r\n')));
  assert.equal(p.needsReview, 2);
  assert.ok(p.events.every(x => x.issues.includes('UID:duplicate-source-identity')));
});
test('event attendee, location, attachment, and alarm are not silently dropped', () => {
  const ics = wrap(event('ATTENDEE:mailto:person@example.test\r\nLOCATION:Private room\r\nATTACH:https://example.test/file.pdf\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nEND:VALARM'));
  const p = row(ics);
  for (const name of ['ATTENDEE', 'LOCATION', 'ATTACH', 'VALARM']) {
    assert.ok(p.issues.includes(`unsupported:${name}`));
  }
  assert.equal(p.sourceAlarms.length, 1);
  assert.equal(p.sourceAlarms[0].find(x => x.name === 'TRIGGER').value, '-PT10M');
});
test('METHOD:CANCEL is explicitly held for approval', () => {
  assert.ok(row(wrap(event(''), 'METHOD:CANCEL')).issues.includes('calendar:method-requires-review'));
});
test('custom embedded timezone rules cannot silently override IANA rules', () => {
  const tz = ['BEGIN:VTIMEZONE', 'TZID:America/New_York', 'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
  const ics = wrap(event('').replace('DTSTART:20261102T150000Z', 'DTSTART;TZID=America/New_York:20261102T100000').replace('DTEND:20261102T160000Z', 'DTEND;TZID=America/New_York:20261102T110000'), tz);
  assert.ok(row(ics).issues.includes('timezone:embedded-rules-unverified'));
});
test('rejects malformed or hostile ICS input without any side effects', () => {
  for (const ics of [
    'BEGIN:VCALENDAR\nVERSION:1.0\nEND:VCALENDAR\n',
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VTODO\nEND:VTODO\nEND:VCALENDAR\n',
    ' BEGIN:VCALENDAR', 'x'.repeat(256 * 1024 + 1),
    'BEGIN:VCALENDAR\rVERSION:2.0',
    wrap(event('')).replace('END:VEVENT', 'END:VTODO'),
  ]) assert.throws(() => previewCalendarIcs(ics), /invalid iCalendar/);
});
test('missing event end, invalid dates and unknown properties fail to candidate', () => {
  const withoutEnd = wrap(event('').replace('DTEND:20261102T160000Z', ''));
  assert.ok(row(withoutEnd).issues.includes('DTEND:missing-or-implicit'));
  const feb = wrap(event('').replace('20261102T150000Z', '20260230T150000Z'));
  assert.ok(row(feb).issues.includes('DTSTART:invalid-date'));
  assert.ok(row(wrap(event('X-SECRET:opaque'))).issues.includes('unsupported:X-SECRET'));
});
test('zero-duration interval, unknown zone, invalid default and duplicate field fail closed', () => {
  const zero = wrap(event('').replace('DTEND:20261102T160000Z', 'DTEND:20261102T150000Z'));
  assert.ok(row(zero).issues.includes('DTEND:nonpositive-range'));
  const zone = wrap(event('').replace('DTSTART:20261102T150000Z', 'DTSTART;TZID=Mars/Olympus:20261102T100000'));
  assert.ok(row(zone).issues.includes('DTSTART:unknown-timezone'));
  assert.throws(() => previewCalendarIcs(wrap(event('')), { defaultTimeZone: 'Mars/Olympus' }), /invalid default/);
  const duplicate = row(wrap(event('SUMMARY:Another title')));
  assert.ok(duplicate.issues.includes('SUMMARY:duplicate'));
});

test('calendar-wide non-Gregorian scale is not silently accepted', () => {
  const p = row(wrap(event(''), 'CALSCALE:JULIAN'));
  assert.ok(p.issues.includes('calendar:unsupported-scale'));
});
test('large, complex files or missing component markers fail closed', () => {
  const bulk = Array.from({ length: 501 }, () => event('')).join('\r\n');
  assert.throws(() => previewCalendarIcs(wrap(bulk)), /too many events|oversized input/);
  assert.throws(() => previewCalendarIcs(wrap(event('')).replace('END:VCALENDAR', '')), /incomplete/);
  assert.throws(() => previewCalendarIcs('BEGIN;X=1:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'), /parameters on component/);
});
test('recurrence exceptions with source base and duplicate occurrence identity are still held', () => {
  const base = event('RRULE:FREQ=WEEKLY;COUNT=3');
  const exception = event('RECURRENCE-ID:20261109T150000Z');
  const previews = previewCalendarIcs(wrap([base, exception, exception].join('\r\n'))).events;
  assert.ok(previews[1].issues.includes('UID:duplicate-source-identity'));
  assert.ok(!previews[1].issues.includes('recurrence:orphan-exception'));
});
test('quoted parameter with colon remains attached to unrecognized property', () => {
  const p = row(wrap(event('ATTENDEE;CN="Alex: Sample":mailto:person@example.test')));
  assert.equal(p.sourceProperties.find(x => x.name === 'ATTENDEE').params.CN, 'Alex: Sample');
  assert.ok(p.issues.includes('unsupported:ATTENDEE'));
});

test('unhandled standard-property parameters force review', () => {
  const p = row(wrap(event('').replace('SUMMARY:Synthetic meeting', 'SUMMARY;LANGUAGE=en:Synthetic meeting')));
  assert.ok(p.issues.includes('SUMMARY:unsupported-parameter'));
});
