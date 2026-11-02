/* Presence Studio — owner-operated personal social desk.
 * Manual native-platform handoff only; no Meta API calls, tokens or auto-posting.
 * This data lives in device storage separately from DevonStation cloud state.
 */
let presenceState;
let presenceStorageAvailable = true;
let presenceConflict = false;
let presenceTab = 'plan';
let presenceEditId = null;
try { presenceState = presenceRestore(JSON.parse(localStorage.getItem(PRESENCE_STORAGE_KEY))); }
catch { presenceState = presenceBlank(); presenceStorageAvailable = false; }
function presenceSave() {
 try {
  localStorage.setItem(PRESENCE_STORAGE_KEY, JSON.stringify(presenceState));
  presenceStorageAvailable = true;
 } catch { presenceStorageAvailable = false; }
}
function presenceError(message) {
 const el = document.getElementById('ps-error');
 if (el) { el.textContent = String(message); el.focus({preventScroll:true}); }
}
function presenceLabel(platform) {
 return { facebook:'Facebook', instagram:'Instagram', threads:'Threads' }[platform] || platform;
}
function presenceMetric(value) { return value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US'); }
function presencePanel() {
 const parts = PRESENCE_CHANNELS.map(channel => {
  const t = presenceTrend(presenceState.snapshots, channel);
  const change = t.net === null ? 'No comparison yet' : (t.net >= 0 ? '+' : '') + t.net.toLocaleString('en-US') + ' since previous snapshot';
  return '<article class="ps-metric-card"><div class="ps-metric-label">' + esc(presenceLabel(channel)) + '</div><strong>' +
    presenceMetric(t.latest?.followers) + '</strong><div class="ps-metric-desc">Followers · ' +
    esc(t.latest ? 'Manual · ' + t.latest.observedOn : 'Not connected') +
    '</div><div class="ps-metric-change">' + esc(change) + '</div></article>';
 });
 return '<div class="ps-metrics">' + parts.join('') + '</div>';
}
function presenceEditor() {
 return '<section class="panel ps-compose" aria-labelledby="ps-composer-title"><div class="panel-head"><div><span class="eyebrow">CONTENT DESK</span><h2 id="ps-composer-title">' +
  (presenceEditId ? 'Edit this idea' : 'Create an original post') + '</h2></div><span class="ps-status">Manual publishing</span></div>' +
  '<p class="muted tiny">Your captions stay on this device. Nothing is sent to Facebook, Instagram or Threads.</p>' +
  '<form id="ps-compose"><label for="ps-title">Idea title</label><input id="ps-title" name="title" maxlength="140" minlength="3" required placeholder="What is worth sharing?">' +
  '<label for="ps-format">Format</label><select id="ps-format" name="format"><option value="text">Text</option><option value="photo">Photo</option><option value="carousel">Carousel</option><option value="reel">Reel</option><option value="video">Video</option></select>' +
  '<fieldset class="ps-destinations"><legend>Where should this appear?</legend><label><input type="checkbox" name="channels" value="facebook" checked> Facebook</label>' +
  '<label><input type="checkbox" name="channels" value="instagram" checked> Instagram</label>' +
  '<label><input type="checkbox" name="channels" value="threads"> Threads</label></fieldset>' +
  '<label for="ps-facebook">Facebook caption</label><textarea id="ps-facebook" maxlength="2200" rows="3" placeholder="Community, context, personal stories…"></textarea>' +
  '<label for="ps-instagram">Instagram caption</label><textarea id="ps-instagram" maxlength="2200" rows="3" placeholder="Visual story and original details…"></textarea>' +
  '<label for="ps-threads">Threads text</label><textarea id="ps-threads" maxlength="500" rows="2" placeholder="A thought or question for conversation…"></textarea>' +
  '<label class="ps-review"><input type="checkbox" id="ps-privacy"> I reviewed family privacy, consent, rights to media and the intended audience.</label>' +
  '<p class="tiny muted">Review is never prechecked on a new draft. Saving an idea does not authorize publishing.</p>' +
  '<p class="error ps-error" id="ps-error" role="alert" tabindex="-1"></p>' +
  '<div class="button-row"><button type="submit" class="primary">' + (presenceEditId ? 'Save changes' : 'Save local draft') + '</button>' +
  (presenceEditId ? '<button type="button" data-ps-cancel>Cancel edit</button>' : '') + '</div></form></section>';
}
function presenceDraftCard(draft) {
 const confirmed = Object.keys(draft.published || {});
 const platformInfo = draft.channels.map(channel => {
  const found = draft.published?.[channel];
  return '<span class="ps-channel ' + (found ? 'ps-done' : '') + '">' + esc(presenceLabel(channel)) + (found ? ' · Recorded' : '') + '</span>';
 }).join('');
 const handoff = draft.stage === 'ready' ? '<div class="ps-handoff"><p class="tiny muted">Publish natively, then record the resulting public post URL. Marking publication is your own confirmation, not an API receipt.</p>' +
   '<form data-ps-published="' + esc(draft.id) + '" class="ps-postform"><label>Channel <select name="platform">' +
    draft.channels.filter(c => !confirmed.includes(c)).map(c => '<option value="' + c + '">' + esc(presenceLabel(c)) + '</option>').join('') +
    '</select></label><label>Published post URL <input type="url" name="url" required placeholder="https://…"></label>' +
    '<button type="submit">Record native publication</button></form></div>' : '';
 const links = confirmed.map(channel => '<a class="source-link" target="_blank" rel="noopener noreferrer" href="' +
   esc(draft.published[channel].url) + '">' + esc(presenceLabel(channel)) + ' post ↗</a>').join('');
 return '<article class="ps-draft-card"><div class="ps-draft-head"><div><span class="ps-stage">' + esc(draft.stage) +
  '</span><h3>' + esc(draft.title) + '</h3></div><span class="tiny muted">' + esc(draft.format) + '</span></div>' +
  '<div class="ps-channels">' + platformInfo + '</div>' +
  '<p class="tiny muted">Local draft · ' + esc(draft.createdAt.slice(0,10)) + '</p>' +
  '<div class="button-row">' + (draft.stage !== 'published' ? '<button data-ps-edit="' + esc(draft.id) + '">Edit</button>' : '') +
  (draft.stage === 'draft' ? '<button data-ps-ready="' + esc(draft.id) + '">Prepare handoff</button>' : '') +
  draft.channels.map(channel => '<button data-ps-copy="' + esc(draft.id) + '" data-ps-channel="' + channel + '">Copy ' +
    esc(presenceLabel(channel)) + '</button>').join('') +
   '<button data-ps-delete="' + esc(draft.id) + '" class="text-button">Delete</button></div>' + handoff + links + '</article>';
}
function presencePlan() {
 return '<div class="ps-layout">' + presenceEditor() +
  '<section class="panel ps-queue"><div class="panel-head"><div><span class="eyebrow">EDITORIAL PIPELINE</span><h2>Drafts and handoffs</h2></div><span class="ps-status">' +
  presenceState.drafts.length + ' local</span></div><div class="info-note">Captions can be copied into the native apps. Publication is never automatic, and a recorded link is owner-entered evidence.</div>' +
  (presenceState.drafts.length ? presenceState.drafts.map(presenceDraftCard).join('') :
   '<div class="empty">Nothing in the queue yet. Capture a real moment, idea or conversation.</div>') +
  '</section></div>';
}
function presenceInsights() {
 const history = presenceState.snapshots.slice().sort((a,b) => b.observedOn.localeCompare(a.observedOn));
 return '<div class="ps-layout"><section class="panel"><div class="panel-head"><h2>Manual insights snapshot</h2><span class="ps-status">No API connection</span></div>' +
 '<p class="tiny muted">Read the numbers from your native professional dashboard. Leave unavailable values blank, not zero.</p>' +
 '<form id="ps-snapshot"><label for="ps-platform">Platform</label><select name="platform" id="ps-platform">' +
  PRESENCE_CHANNELS.map(c => '<option value="' + c + '">' + esc(presenceLabel(c)) + '</option>').join('') + '</select>' +
 '<label for="ps-date">Observation date</label><input name="observedOn" id="ps-date" type="date" required>' +
 '<label for="ps-window">Reporting window</label><select name="periodDays" id="ps-window"><option value="7">7 days</option><option value="28">28 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select>' +
 '<label for="ps-followers">Current followers</label><input type="number" name="followers" id="ps-followers" required min="0" max="2000000000" step="1">' +
 '<label for="ps-views">Views (optional)</label><input type="number" name="views" id="ps-views" min="0" max="2000000000" step="1">' +
 '<label for="ps-engagements">Engagements (optional)</label><input type="number" name="engagements" id="ps-engagements" min="0" max="2000000000" step="1">' +
 '<p class="error" id="ps-error" role="alert" tabindex="-1"></p><button type="submit" class="primary">Save observation</button></form></section>' +
 '<section class="panel ps-history"><div class="panel-head"><h2>Observed history</h2><span class="ps-status">' + history.length + ' snapshots</span></div>' +
  (history.length ? history.map(x => '<article class="ps-history-item"><strong>' + esc(presenceLabel(x.platform)) + ' · ' + esc(x.observedOn) +
  '</strong><span>' + presenceMetric(x.followers) + ' followers</span><span class="tiny muted">' + x.periodDays + '-day window · Views ' + presenceMetric(x.views) +
  ' · Engagements ' + presenceMetric(x.engagements) + '</span></article>').join('') : '<div class="empty">No observations stored. Your old screenshot values are not silently treated as live data.</div>') +
 '</section></div>';
}
function presenceStudio() {
 return heading('Presence Studio.','Your private publishing desk, audience insights and meaningful connections.', '<span class="ps-status">Source-only preview</span>') +
  '<section class="ps-intro"><span class="eyebrow">FACEBOOK / INSTAGRAM / THREADS</span><h2>Build a presence worth following.</h2><p>One original idea, three distinct conversations. Real people before metrics.</p></section>' +
  '<div class="info-note ps-safety">Owner-only concept. This screen holds <strong>device-local, unencrypted data</strong>; it does not sync through DevonStation cloud storage, schedule posts, or connect to Meta. Do not enter personal DMs, contact lists, secrets or private family details.</div>' +
  (presenceConflict ? '<div class="info-note warning">Presence data changed in another browser tab. Export this tab before reloading to avoid overwriting newer work.</div>' : '') +
  presencePanel() +
  '<div class="ps-toolbar"><div class="segments" role="group" aria-label="Presence Studio view"><button type="button" data-ps-tab="plan" aria-pressed="' + (presenceTab==='plan') + '">Plan and publish</button>' +
  '<button type="button" data-ps-tab="insights" aria-pressed="' + (presenceTab==='insights') + '">Insights</button></div>' +
  '<div class="button-row"><button data-ps-export>Export JSON</button><button data-ps-import-open>Import JSON</button>' +
  '<input type="file" id="ps-import" accept=".json,application/json" hidden aria-label="Import Presence Studio JSON"></div></div>' +
  (presenceTab === 'plan' ? presencePlan() : presenceInsights());
}
function presenceFillEditor(id) {
 const record = presenceState.drafts.find(x => x.id === id);
 if (!record || record.stage === 'published') return;
 presenceEditId = id;
 presenceTab = 'plan'; render();
 document.getElementById('ps-title').value = record.title;
 document.getElementById('ps-format').value = record.format;
 for (const box of document.querySelectorAll('#ps-compose input[name=channels]')) box.checked = record.channels.includes(box.value);
 for (const channel of PRESENCE_CHANNELS) document.getElementById('ps-' + channel).value = record.captions[channel];
 document.getElementById('ps-privacy').checked = record.privacyReviewed;
 document.getElementById('ps-title').focus();
}
function presenceUpdate(updated, message) {
 presenceState.drafts = presenceState.drafts.filter(d => d.id !== updated.id);
 presenceState.drafts.unshift(updated);
 presenceSave(); render(); notify(message);
}
document.addEventListener('click', async event => {
 const button = event.target.closest('button');
 if (!button) return;
 const d = button.dataset;
 if (d.psTab) { presenceTab = d.psTab; presenceEditId = null; render(); return; }
 if ('psCancel' in d) { presenceEditId = null; render(); return; }
 if (d.psEdit) { presenceFillEditor(d.psEdit); return; }
 if (d.psReady) {
  try { const draft = presenceState.drafts.find(x => x.id === d.psReady); presenceUpdate(presenceReady(draft), 'Prepared for manual publishing.'); }
  catch (error) { notify(error.message); } return;
 }
 if (d.psCopy) {
  const item = presenceState.drafts.find(x => x.id === d.psCopy);
  const caption = item?.captions?.[d.psChannel];
  if (!caption) { notify('No caption to copy for that channel.'); return; }
  try { await navigator.clipboard.writeText(caption); notify('Caption copied. Open the native app to publish.'); }
  catch { notify('Clipboard unavailable; select and copy the caption in the editor.'); }
  return;
 }
 if (d.psDelete) {
  if (!window.confirm('Delete this local draft and its manually entered publication links?')) return;
  presenceState.drafts = presenceState.drafts.filter(x => x.id !== d.psDelete);
  if (presenceEditId === d.psDelete) presenceEditId = null;
  presenceSave();render();notify('Local record deleted.');return;
 }
 if ('psExport' in d) {
  const payload = JSON.stringify({ version:1, ...presenceState }, null, 2);
  const blob = new Blob([payload], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');a.href = url;a.download = 'presence-studio-owner-backup.json';a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('Local JSON export prepared.');return;
 }
 if ('psImportOpen' in d) { document.getElementById('ps-import')?.click(); }
});
document.addEventListener('submit', event => {
 if (event.target.id === 'ps-compose') {
  event.preventDefault();
  const form = event.target;
  const channels = [...form.querySelectorAll('input[name=channels]:checked')].map(x => x.value);
  const old = presenceState.drafts.find(x => x.id === presenceEditId);
  try {
   const item = presenceDraft({
    title:form.querySelector('#ps-title').value,
    format:form.querySelector('#ps-format').value,channels,
    captions:Object.fromEntries(PRESENCE_CHANNELS.map(c => [c,form.querySelector('#ps-' + c).value])),
    privacyReviewed:form.querySelector('#ps-privacy').checked
   }, old);
   if (old) { item.id = old.id; item.createdAt = old.createdAt;item.published = {...old.published};}
   if (!old && presenceState.drafts.length >= PRESENCE_MAX_DRAFTS) throw Error('Export and delete an older record before creating more drafts.');
   presenceEditId = null;
   presenceUpdate(item, 'Draft saved locally; no social post was published.');
  } catch (error) { presenceError(error.message); }
 }
 if (event.target.id === 'ps-snapshot') {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.target));
  try {
   const snapshot = presenceSnapshot(data);
   presenceState.snapshots = presenceAddSnapshot(presenceState.snapshots, snapshot);
   presenceSave();render();notify('Manual observation saved locally.');
  } catch (error) { presenceError(error.message); }
 }
 if (event.target.dataset.psPublished) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const draft = presenceState.drafts.find(x => x.id === event.target.dataset.psPublished);
  try { presenceUpdate(presenceMarkPublished(draft, data.platform, data.url), 'Native post link recorded by owner.'); }
  catch (error) { notify(error.message); }
 }
});
document.addEventListener('change', async event => {
 if (event.target.id !== 'ps-import') return;
 const file = event.target.files?.[0];
 if (!file) return;
 try {
  if (file.size > 256000) throw Error('JSON file is too large for a manual import.');
  const parsed = JSON.parse(await file.text());
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.drafts) || !Array.isArray(parsed.snapshots)) throw Error('Not a Presence Studio v1 backup.');
  const incoming = presenceRestore(parsed);
  if (!window.confirm('Replace the current device-local Presence Studio data with this validated backup? Export your current copy first.')) return;
  presenceState = incoming;presenceEditId = null;presenceConflict = false;presenceSave();render();notify('Validated manual backup imported.');
 } catch (error) { notify('Import failed: ' + error.message); }
 finally { event.target.value = ''; }
});
window.addEventListener('storage', event => {
 if (event.key === PRESENCE_STORAGE_KEY || event.key === null) { presenceConflict = true; if (section === 'presence') render(); }
});
