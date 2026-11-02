/**
 * Strict, dependency-free, portable single-event envelope for DevonStation.
 *
 * This is a data boundary, not a scheduling engine, iCalendar parser,
 * recurrence expander, authorization check, or invitation handler.
 * Unsupported event features fail closed rather than being lost.
 */
const FIELDS = new Set([
  'version', 'id', 'calendarId', 'uid', 'title', 'kind', 'start',
  'endExclusive', 'timeZone', 'status', 'notes',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATUSES = new Set(['confirmed', 'tentative', 'cancelled']);

function requireText(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new TypeError(label + ' must be nonempty safe text of at most ' + limit + ' characters');
  }
  return value;
}

function requireId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new TypeError(label + ' must be a portable stable identifier');
  }
  return value;
}

function requireZone(value) {
  requireText(value, 'timeZone', 100);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
  } catch {
    throw new TypeError('timeZone must be a valid IANA time zone');
  }
  return value;
}

function requireDate(value, kind, label) {
  const pattern = kind === 'all-day' ? DAY : UTC;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(label + ' must be a canonical ' + (kind === 'all-day' ? 'YYYY-MM-DD date' : 'UTC timestamp with milliseconds'));
  }
  const iso = kind === 'all-day' ? value + 'T00:00:00.000Z' : value;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== iso) {
    throw new RangeError(label + ' must be a real calendar date');
  }
  return value;
}

/**
 * Validate one non-recurring event and return a normalized, newly allocated value.
 * A trusted backend MUST independently authorize calendarId and owner identity.
 */
export function validatePortableCalendarEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('event must be a record');
  }
  for (const field of Object.keys(input)) {
    if (!FIELDS.has(field)) {
      throw new TypeError('unsupported event field: ' + field);
    }
  }
  if (input.version !== 1) {
    throw new RangeError('unsupported portable event version');
  }
  const id = requireId(input.id, 'id');
  const calendarId = requireId(input.calendarId, 'calendarId');
  const uid = requireId(input.uid, 'uid');
  const title = requireText(input.title, 'title', 160);
  const kind = input.kind;
  if (kind !== 'all-day' && kind !== 'timed') {
    throw new TypeError('kind must be all-day or timed');
  }
  const timeZone = requireZone(input.timeZone);
  const start = requireDate(input.start, kind, 'start');
  const endExclusive = requireDate(input.endExclusive, kind, 'endExclusive');
  if (start >= endExclusive) {
    throw new RangeError('endExclusive must be later than start');
  }
  const status = input.status === undefined ? 'confirmed' : input.status;
  if (!STATUSES.has(status)) {
    throw new TypeError('unsupported event status');
  }
  let notes;
  if (input.notes !== undefined) {
    if (typeof input.notes !== 'string' || input.notes.length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.notes)) {
      throw new TypeError('notes must be at most 5000 safe characters');
    }
    notes = input.notes;
  }
  const result = { version: 1, id, calendarId, uid, title, kind, start, endExclusive, timeZone, status };
  if (notes !== undefined) result.notes = notes;
  return result;
}

export function serializePortableCalendarEvent(input) {
  return JSON.stringify(validatePortableCalendarEvent(input));
}

export function parsePortableCalendarEvent(text) {
  if (typeof text !== 'string' || text.length > 16000) {
    throw new TypeError('portable event must be a bounded JSON string');
  }
  return validatePortableCalendarEvent(JSON.parse(text));
}
