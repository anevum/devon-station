import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
 PRESENCE_CHANNELS, PRESENCE_STORAGE_KEY, presenceBlank, presenceDraft, presenceReady, presenceMarkPublished,
 presencePostURL, presenceSnapshot, presenceAddSnapshot, presenceTrend, presenceRestore, presenceGoalProgress, PRESENCE_GOAL_MILESTONES
} from '../src/presence-core.mjs';

const t='2026-11-02T17:00:00.000Z';
const base={title:'Our latest original work',format:'carousel',channels:['facebook','instagram'],captions:{
 facebook:'A quiet afternoon building something original.',
 instagram:'Original sketches and work in progress.',
 threads:''
},privacyReviewed:false};

test('the new personal studio has no fabricated metrics or Meta connection',()=>{
 const blank=presenceBlank();
 assert.deepEqual(blank,{version:1,drafts:[],snapshots:[]});
 assert.deepEqual(PRESENCE_CHANNELS,['facebook','instagram','threads']);
 assert.match(PRESENCE_STORAGE_KEY,/presence/);
});
test('drafts preserve distinct platform captions, sanitize content and validate channel selection',()=>{
 const draft=presenceDraft(base,null,t,'ps-12345678');
 assert.equal(draft.stage,'draft');
 assert.equal(draft.privacyReviewed,false);
 assert.equal(draft.captions.instagram,base.captions.instagram);
 assert.equal(draft.captions.facebook,base.captions.facebook);
 assert.throws(()=>presenceDraft({...base,title:'A'},null,t,'ps-12345679'),/title/);
 assert.throws(()=>presenceDraft({...base,title:'patient medical record'},null,t,'ps-12345679'),/Do not store/);
 assert.throws(()=>presenceDraft({...base,channels:[]},null,t,'ps-12345679'),/platform/);
 assert.throws(()=>presenceDraft({...base,channels:['facebook','malicious']},null,t,'ps-12345679'),/valid/);
 assert.throws(()=>presenceDraft({...base,captions:{...base.captions,threads:'sk-'+'x'.repeat(27)}},null,t,'ps-12345679'),/Do not store/);
});
test('manual handoff requires explicit review and nonempty captions; no external publication',()=>{
 const draft=presenceDraft(base,null,t,'ps-12345678');
 assert.throws(()=>presenceReady(draft,t),/Review privacy/);
 const readied=presenceReady({...draft,privacyReviewed:true},t);
 assert.equal(readied.stage,'ready');
 assert.deepEqual(readied.published,{});
 assert.throws(()=>presenceMarkPublished(draft,'facebook','https://facebook.com/someone/posts/123',t),/privacy-review/);
 assert.throws(()=>presenceReady({...readied,captions:{...readied.captions,instagram:''}},t),/caption/);
});
test('publication receipts are user-entered, per-platform, and cannot repeat or be silently edited',()=>{
 const draft=presenceReady({...presenceDraft(base,null,t,'ps-12345678'),privacyReviewed:true},t);
 const fb=presenceMarkPublished(draft,'facebook','https://www.facebook.com/someone/posts/123?x=1#fragment',t);
 assert.equal(fb.stage,'ready');
 assert.equal(fb.published.facebook.source,'owner-entered');
 assert(!fb.published.facebook.url.includes('#fragment'));
 assert.throws(()=>presenceMarkPublished(fb,'facebook','https://facebook.com/x/posts/2',t),/already/);
 assert.throws(()=>presenceDraft(base,fb,t),/cannot be edited/);
 const done=presenceMarkPublished(fb,'instagram','https://www.instagram.com/p/POST123/',t);
 assert.equal(done.stage,'published');
 assert.throws(()=>presenceDraft(base,done,t),/cannot be edited/);
 assert.throws(()=>presenceMarkPublished(done,'threads','https://threads.net/@devon/post/3',t),/not selected/);
});
test('post URL validation refuses cross-platform or insecure spoofing',()=>{
 assert.throws(()=>presencePostURL('instagram','https://instagram.com.evil.test/p/example'),/Link/);
 assert.throws(()=>presencePostURL('facebook','http://www.facebook.com/posts/3'),/Link/);
 assert.throws(()=>presencePostURL('instagram','https://user:pass@instagram.com/p/1'),/Link/);
 assert.throws(()=>presencePostURL('instagram','https://www.instagram.com/'),/Link/);
 assert.equal(presencePostURL('threads','https://www.threads.net/@user/post/abc'),'https://www.threads.net/@user/post/abc');
});
test('a snapshot keeps zero distinct from unavailable; strict windows, dates and counts',()=>{
 const snapshot=presenceSnapshot({platform:'facebook',observedOn:'2026-11-02',periodDays:30,followers:'34',views:'0',engagements:''});
 assert.deepEqual(snapshot,{platform:'facebook',observedOn:'2026-11-02',periodDays:30,followers:34,views:0,engagements:null,source:'manual-native-dashboard'});
 assert.throws(()=>presenceSnapshot({platform:'instagram',observedOn:'2026-02-30',periodDays:30,followers:1}),/observation date/);
 assert.throws(()=>presenceSnapshot({platform:'instagram',observedOn:'2026-11-02',periodDays:14,followers:1}),/window/);
 assert.throws(()=>presenceSnapshot({platform:'instagram',observedOn:'2026-11-02',periodDays:30,followers:-1}),/whole/);
});
test('snapshots deduplicate per platform date and window, and measure actual net growth',()=>{
 const a=presenceSnapshot({platform:'instagram',observedOn:'2026-11-01',periodDays:30,followers:1});
 const b=presenceSnapshot({platform:'instagram',observedOn:'2026-11-02',periodDays:30,followers:7,views:50});
 const state=presenceAddSnapshot(presenceAddSnapshot([],a),b);
 assert.equal(state.length,2);
 assert.equal(presenceTrend(state,'instagram').net,6);
 assert.equal(presenceTrend(state,'facebook').net,null);
 assert.throws(()=>presenceAddSnapshot(state,b),/already/);
});
test('import sanitizes source data and never copies injected secrets or unknown keys',()=>{
 const good=presenceReady({...presenceDraft(base,null,t,'ps-12345678'),privacyReviewed:true},t);
 const bad={...good,id:'ps-12345679',title:'patient clinical identifier'};
 const restored=presenceRestore({version:1,drafts:[good,bad],snapshots:[
  {platform:'instagram',observedOn:'2026-11-02',periodDays:30,followers:1,views:null},
  {platform:'instagram',observedOn:'2026-11-02',periodDays:30,followers:1,views:null}
 ],notionToken:'fake-secret',unknown:'ignored'});
 assert.equal(restored.drafts.length,1);
 assert.equal(restored.snapshots.length,1);
 assert(!JSON.stringify(restored).includes('notionToken'));
 assert(!JSON.stringify(restored).includes('fake-secret'));
 assert.deepEqual(presenceRestore({version:2,drafts:[],snapshots:[]}),presenceBlank());
});
test('source wiring preserves client-side-only mode and avoids introducing Meta credentials or scraping',()=>{
 const builder=readFileSync(new URL('../tools/build-hosted-shell.mjs',import.meta.url),'utf8');
 const nav=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../src/presence-ui.js',import.meta.url),'utf8');
 assert(builder.includes('src/presence-core.mjs'));
 assert(builder.includes('src/presence-ui.js'));
 assert(builder.includes('src/presence.css'));
 assert(nav.includes('presence:presenceStudio'));
 assert(!/fetch\s*\(|(https?:\/\/)?graph\.facebook\.com|api\.threads\.net|access_token/.test(ui));
 assert(ui.includes('localStorage.setItem(PRESENCE_STORAGE_KEY'));
 assert(ui.includes('No API connection'));
});

test('working milestones remain proposed and do not fabricate follower baselines',()=>{
 assert.equal(PRESENCE_GOAL_MILESTONES.length,5);
 const unknown=presenceGoalProgress([], 'facebook');
 assert.equal(unknown.followers,null);
 assert.equal(unknown.next.followers,250);
 assert.equal(unknown.nextProgress,null);
 assert.equal(presenceGoalProgress([], 'threads'),null);
 const first=presenceSnapshot({platform:'facebook',observedOn:'2026-11-02',periodDays:30,followers:34});
 const progress=presenceGoalProgress([first],'facebook');
 assert.equal(progress.next.followers,250);
 assert.equal(progress.nextProgress,13.6);
 assert.equal(progress.stretch,1000000);
 assert.equal(progress.observedOn,'2026-11-02');
 const reached=presenceGoalProgress([{...first,followers:250}],'facebook');
 assert.equal(reached.next.followers,1000);
 const finished=presenceGoalProgress([{...first,followers:10000}],'facebook');
 assert.equal(finished.next,null);
 assert.equal(finished.nextProgress,100);
});
