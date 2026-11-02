/* Presence Studio — manual-first, owner-scoped local data contract.
 * No network access, Meta tokens, automated publication, or implicit cloud sync.
 * This public source must contain synthetic fixtures only.
 */
export const PRESENCE_CHANNELS = Object.freeze(['facebook', 'instagram', 'threads']);
export const PRESENCE_STORAGE_KEY = 'devon-station:presence:v1';
export const PRESENCE_MAX_DRAFTS = 60;
export const PRESENCE_MAX_SNAPSHOTS = 240;
const PRESENCE_SENSITIVE = /\b(?:patient|diagnosis|medical record|social security number|ssn|password|bank account|credit card number)\b|(?:sk-|ghp_|github_pat_|xox[baprs]-)[a-zA-Z0-9_-]{10,}/i;
const PRESENCE_DOMAINS = {
 facebook: new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch']),
 instagram: new Set(['instagram.com', 'www.instagram.com']),
 threads: new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'])
};
export function presenceBlank() { return { version: 1, drafts: [], snapshots: [] }; }
export function presenceId() {
 return 'ps-' + (typeof globalThis.crypto?.randomUUID === 'function'
  ? globalThis.crypto.randomUUID()
  : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
}
function presenceString(value, max, name, min = 0) {
 const text = String(value ?? '').trim();
 if (text.length < min || text.length > max) throw Error(name + ' must contain ' + min + '–' + max + ' characters.');
 if (PRESENCE_SENSITIVE.test(text)) throw Error('Do not store passwords, clinical material or financial identifiers in Presence Studio.');
 return text;
}
function presenceChannels(value) {
 if (!Array.isArray(value)) throw Error('Choose at least one platform.');
 const channels = [...new Set(value)];
 if (!channels.length || channels.some(x => !PRESENCE_CHANNELS.includes(x))) throw Error('Choose valid publishing platforms.');
 return channels;
}
export function presenceDraft(input, previous = null, at = new Date().toISOString(), id = presenceId()) {
 if (previous?.stage === 'published' || Object.keys(previous?.published || {}).length) throw Error('A partially or fully published record cannot be edited. Create a new idea instead.');
 const channels = presenceChannels(input?.channels);
 const captions = {};
 for (const platform of PRESENCE_CHANNELS) captions[platform] = presenceString(input?.captions?.[platform], platform === 'threads' ? 500 : 2200, platform + ' caption');
 const title = presenceString(input?.title, 140, 'Idea title', 3);
 if (!/^ps-[A-Za-z0-9-]{8,90}$/.test(id) || !Number.isFinite(Date.parse(at))) throw Error('Invalid draft identity.');
 return {
  id, title, channels, captions,
  format: ['photo','carousel','reel','video','text'].includes(input?.format) ? input.format : 'text',
  privacyReviewed: input?.privacyReviewed === true,
  stage: 'draft', createdAt: previous?.createdAt ?? at, updatedAt: at, published: {}
 };
}
export function presenceReady(draft, at = new Date().toISOString()) {
 if (!draft?.privacyReviewed) throw Error('Review privacy and permission to share before preparing a handoff.');
 if (draft.channels.some(channel => !draft.captions[channel])) throw Error('Write a caption for every chosen platform before preparing a handoff.');
 if (!Number.isFinite(Date.parse(at))) throw Error('Invalid review timestamp.');
 if (draft.stage === 'published') throw Error('This record is already published.');
 return { ...draft, stage: 'ready', updatedAt: at };
}
export function presencePostURL(platform, url) {
 if (!PRESENCE_CHANNELS.includes(platform)) throw Error('Unknown platform.');
 let parsed;
 try { parsed = new URL(String(url ?? '')); } catch { throw Error('Enter the full HTTPS post URL.'); }
 if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !PRESENCE_DOMAINS[platform].has(parsed.hostname) || parsed.pathname === '/') throw Error('Link must point to a post on the selected platform.');
 const path = parsed.pathname;
 const facebookPost = parsed.hostname === 'fb.watch'
  ? /^\/[A-Za-z0-9_-]{3,}\/?$/.test(path)
  : /\/posts\/|\/reel\/|\/share\/(?:p|r|v)\/|\/videos\/|\/photos\/|\/permalink\.php$|\/photo\.php$|\/watch\/$/.test(path);
 const instagramPost = /^\/(?:p|reel|reels|stories)\/[A-Za-z0-9_-]{3,}(?:\/|$)/.test(path);
 const threadsPost = /^\/@[^/]+\/post\/[A-Za-z0-9_-]{3,}(?:\/|$)/.test(path);
 if (!(platform === 'facebook' ? facebookPost : platform === 'instagram' ? instagramPost : threadsPost)) throw Error('Link must identify a post, not an account or home page.');
 for (const key of [...parsed.searchParams.keys()]) {
  const normalized = key.toLowerCase();
  if (/^(?:access_token|auth_token|token|password|secret|api_key|session)$/.test(normalized)) throw Error('Remove private access parameters from the URL.');
  if (normalized === 'fbclid' || normalized === 'igshid' || normalized.startsWith('utm_')) parsed.searchParams.delete(key);
 }
 parsed.hash = ''; return parsed.href;
}
export function presenceMarkPublished(draft, platform, url, at = new Date().toISOString()) {
 if (!draft || !draft.channels.includes(platform)) throw Error('This platform is not selected.');
 if (!draft.privacyReviewed || !['ready','published'].includes(draft.stage)) throw Error('Prepare and privacy-review the draft before marking publication.');
 if (draft.published?.[platform]) throw Error('This platform already has a confirmed post URL.');
 const published = { ...draft.published, [platform]: { url: presencePostURL(platform, url), confirmedAt: at, source: 'owner-entered' } };
 if (!Number.isFinite(Date.parse(at))) throw Error('Invalid publication timestamp.');
 return { ...draft, published, stage: Object.keys(published).length === draft.channels.length ? 'published' : 'ready', updatedAt: at };
}
function wholeNumber(value, label, optional = false) {
 if (value === '' || value === null || value === undefined) {
  if (optional) return null;
  throw Error(label + ' is required; missing is not zero.');
 }
 const n = Number(value);
 if (!Number.isSafeInteger(n) || n < 0 || n > 2000000000) throw Error(label + ' must be a nonnegative whole number.');
 return n;
}
function presenceDate(input) {
 const value = String(input || '');
 if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw Error('Use an actual observation date in YYYY-MM-DD form.');
 const day = Date.parse(value + 'T00:00:00Z');
 if (day > Date.now() + 86400000) throw Error('Observation cannot be in the future.');
 return value;
}
export function presenceSnapshot(input) {
 const platform = String(input?.platform || '');
 if (!PRESENCE_CHANNELS.includes(platform)) throw Error('Select a valid platform.');
 const observedOn = presenceDate(input?.observedOn);
 const periodDays = Number(input?.periodDays);
 if (![7, 28, 30, 90].includes(periodDays)) throw Error('Choose a supported reporting window.');
 return {
  platform, observedOn, periodDays,
  followers: wholeNumber(input?.followers, 'Followers'),
  views: wholeNumber(input?.views, 'Views', true),
  engagements: wholeNumber(input?.engagements, 'Engagements', true),
  source: 'manual-native-dashboard'
 };
}
export function presenceAddSnapshot(items, snapshot) {
 if (items.some(x => x.platform === snapshot.platform && x.observedOn === snapshot.observedOn && x.periodDays === snapshot.periodDays)) throw Error('This platform, date and window already have a snapshot.');
 return [...items, snapshot].sort((a,b) => b.observedOn.localeCompare(a.observedOn)).slice(0,PRESENCE_MAX_SNAPSHOTS);
}
export function presenceTrend(items, platform) {
 const records = items.filter(x => x.platform === platform).sort((a,b) => b.observedOn.localeCompare(a.observedOn) || a.periodDays-b.periodDays);
 const latest = records[0] ?? null;
 const previous = latest ? records.find(x => x.observedOn !== latest.observedOn) ?? null : null;
 return { latest, previous, net: latest && previous ? latest.followers - previous.followers : null };
}

export const PRESENCE_GOAL_MILESTONES = Object.freeze([
 Object.freeze({ followers:250, deadline:'2026-12-31' }),
 Object.freeze({ followers:1000, deadline:'2027-03-31' }),
 Object.freeze({ followers:3000, deadline:'2027-06-30' }),
 Object.freeze({ followers:6000, deadline:'2027-09-30' }),
 Object.freeze({ followers:10000, deadline:'2027-12-31' })
]);
export function presenceGoalProgress(items, platform) {
 if (platform !== 'facebook' && platform !== 'instagram') return null;
 const latest = presenceTrend(items, platform).latest;
 const followers = latest ? latest.followers : null;
 const next = followers === null ? PRESENCE_GOAL_MILESTONES[0] :
  PRESENCE_GOAL_MILESTONES.find(m => followers < m.followers) ?? null;
 return {
  platform, followers, observedOn:latest?.observedOn ?? null, next,
  nextProgress:followers === null ? null :
   next ? Math.min(100, Math.round(followers / next.followers * 1000) / 10) : 100,
  stretch:1000000
 };
}
/* Reject foreign and malformed fields on restore. A corrupt tab must not
 * silently fabricate zero metrics or import tokens from arbitrary JSON. */
export function presenceRestore(raw) {
 if (!raw || raw.version !== 1 || !Array.isArray(raw.drafts) || !Array.isArray(raw.snapshots)) return presenceBlank();
 const clean = presenceBlank();
 for (const value of raw.drafts.slice(0, PRESENCE_MAX_DRAFTS)) {
  try {
   const draft = presenceDraft(value, null, value.createdAt, value.id);
   if (value.stage === 'ready' || value.stage === 'published') {
    if (!draft.privacyReviewed || draft.channels.some(c => !draft.captions[c])) continue;
    draft.stage = 'ready';
   }
   for (const platform of PRESENCE_CHANNELS) {
    const old = value.published?.[platform];
    if (!old || !draft.channels.includes(platform) || draft.stage !== 'ready') continue;
    const confirmedAt = String(old.confirmedAt ?? '');
    if (!Number.isFinite(Date.parse(confirmedAt))) continue;
    draft.published[platform] = { url: presencePostURL(platform, old.url), confirmedAt, source: 'owner-entered' };
   }
   if (Object.keys(draft.published).length === draft.channels.length) draft.stage = 'published';
   if (!clean.drafts.some(x => x.id === draft.id)) clean.drafts.push(draft);
  } catch { /* Invalid records are not trusted or rendered. */ }
 }
 for (const record of raw.snapshots.slice(0, PRESENCE_MAX_SNAPSHOTS)) {
  try {
   const s = presenceSnapshot(record);
   if (!clean.snapshots.some(x => x.platform===s.platform && x.observedOn===s.observedOn && x.periodDays===s.periodDays)) clean.snapshots.push(s);
  } catch {}
 }
 return clean;
}
