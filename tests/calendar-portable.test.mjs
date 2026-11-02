import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePortableCalendarEvent,
  parsePortableCalendarEvent,
  serializePortableCalendarEvent,
} from '../src/calendar-portable.mjs';

const timed = {
  version: 1,
  id: 'evt_001', calendarId: 'cal_personal', uid: 'evt_001@devonstation.local',
  title: 'Synthetic appointment', kind: 'timed',
  start: '2026-11-02T15:00:00.000Z', endExclusive: '2026-11-02T16:00:00.000Z',
  timeZone: 'America/New_York', status: 'confirmed',
};
function withField(key, value) { return { ...timed, [key]: value }; }

test('accepts a strictly normalized synthetic single timed event', () => {
  const value = validatePortableCalendarEvent(timed);
  assert.deepEqual(value, timed);
  assert.notEqual(value, timed);
});
test('all-day ranges preserve local dates across a daylight-saving change', () => {
  const allDay = {
    ...timed, kind: 'all-day', start: '2026-10-31',
    endExclusive: '2026-11-03',
  };
  assert.deepEqual(validatePortableCalendarEvent(allDay), allDay);
});
test('timezone validation rejects fake IANA zones', () => {
  assert.throws(() => validatePortableCalendarEvent(withField('timeZone', 'Moon/Earth')), /IANA/);
});
test('local or offset timestamps are not silently guessed as UTC', () => {
  for (const start of ['2026-11-02T10:00:00', '2026-11-02T10:00:00-05:00', '2026-11-02T15:00:00Z']) {
    assert.throws(() => validatePortableCalendarEvent(withField('start', start)), /canonical/);
  }
});
test('nonexistent date and reversed intervals are rejected', () => {
  assert.throws(() => validatePortableCalendarEvent(withField('start', '2026-02-30T15:00:00.000Z')), /real calendar date/);
  assert.throws(() => validatePortableCalendarEvent(withField('endExclusive', timed.start)), /later than start/);
});
test('empty titles and improper record shapes fail validation', () => {
  assert.throws(() => validatePortableCalendarEvent(withField('title', '  ')), /nonempty/);
  assert.throws(() => validatePortableCalendarEvent([]), /record/);
  assert.throws(() => validatePortableCalendarEvent(null), /record/);
});
test('unknown event fields fail closed to prevent silent migration loss', () => {
  for (const key of ['recurrence', 'rrule', 'attendees', 'reminders', 'scope', 'organizer']) {
    assert.throws(() => validatePortableCalendarEvent(withField(key, [])), /unsupported event field/);
  }
});
test('rejects unsupported versions and invalid status', () => {
  assert.throws(() => validatePortableCalendarEvent(withField('version', 2)), /version/);
  assert.throws(() => validatePortableCalendarEvent(withField('status', 'secret')), /status/);
});
test('round trips single event JSON without changing identity or UTC boundaries', () => {
  const a = { ...timed, notes: 'This record contains fabricated, non-clinical content.' };
  assert.deepEqual(parsePortableCalendarEvent(serializePortableCalendarEvent(a)), a);
});
test('rejects oversized and hostile serialized input', () => {
  assert.throws(() => parsePortableCalendarEvent(' '.repeat(16001)), /bounded/);
  assert.throws(() => parsePortableCalendarEvent('{not-json}'), SyntaxError);
  assert.throws(() => validatePortableCalendarEvent(withField('notes', '\u0000')), /notes/);
});
