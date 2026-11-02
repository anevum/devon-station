import test from 'node:test';
import assert from 'node:assert/strict';
import {
 PRESENCE_CHANNELS, PRESENCE_MAX_DRAFTS, PRESENCE_MAX_SNAPSHOTS, PRESENCE_GOAL_MILESTONES,
 presenceBlank, presenceDraft, presenceReady, presenceMarkPublished, presencePostURL,
 presenceSnapshot, presenceAddSnapshot, presenceTrend, presenceGoalProgress, presenceRestore
} from '../src/presence-core.mjs';

const at='2026-11-02T17:00:00Z';
const good=(channels=['facebook','instagram','threads'])=>({
 title:'An original family adventure',channels,format:'carousel',
 captions:{facebook:'A good day.',instagram:'Some favorite moments.',threads:'What was your favorite moment?'},
 privacyReviewed:true
});
const make=(channels)=>presenceDraft(good(channels),null,at,'ps-12345678-1234-4123-8123-123456789012');
const metric=(platform,observedOn,followers,window=30,views=null,engagements=null)=>({platform,observedOn,periodDays:window,followers,views,engagements});
test('manual-only records: exact three-platform contract, no auto-publish on save or ready',()=>{
 assert.deepEqual([...PRESENCE_CHANNELS],['facebook','instagram','threads']);
 const draft=make();
 assert.equal(draft.stage,'draft');assert.deepEqual(draft.published,{});assert.equal(draft.format,'carousel');
 const ready=presenceReady(draft,at);
 assert.equal(ready.stage,'ready');assert.deepEqual(ready.published,{});
 assert.equal(draft.stage,'draft','original object preserved');
 assert.equal(draft.captions.threads,'What was your favorite moment?');
 assert.deepEqual(presenceBlank(),{version:1,drafts:[],snapshots:[]});
});
test('privacy gate is explicit and a chosen channel must have its own caption',()=>{
 const draft=presenceDraft({...good(['instagram']),privacyReviewed:false},null,at,'ps-12345678');
 assert.equal(draft.privacyReviewed,false);
 assert.throws(()=>presenceReady(draft),/privacy/i);
 const noCaption=presenceDraft({...good(['threads']),captions:{threads:''}},null,at,'ps-12345678');
 assert.throws(()=>presenceReady(noCaption),/caption/i);
 assert.throws(()=>presenceDraft({...good(),channels:[]}),/platform/i);
 assert.throws(()=>presenceDraft({...good(),channels:['youtube']}),/platform/i);
 assert.throws(()=>presenceDraft({...good(),title:'a'}),/title/i);
 assert.throws(()=>presenceDraft({...good(),title:'password: hidden'}),/credentials|password/i);
 assert.throws(()=>presenceDraft({...good(),captions:{...good().captions,threads:'x'.repeat(501)}}),/500/);
});
test('recording publication requires approved handoff and distinct owner-entered post URLs',()=>{
 const ready=presenceReady(make(['facebook','instagram']));
 assert.throws(()=>presenceMarkPublished(make(['facebook']), 'facebook','https://www.facebook.com/test/posts/321'),/Prepare/);
 assert.throws(()=>presenceMarkPublished(ready, 'threads','https://www.threads.com/@test/post/ABC123'),/not selected/);
 const first=presenceMarkPublished(ready,'facebook','https://www.facebook.com/test/posts/321',at);
 assert.equal(first.stage,'ready');assert.equal(first.published.facebook.source,'owner-entered');
 assert(!first.published.instagram);
 assert.throws(()=>presenceDraft(good(),first),/published record/i);
 assert.throws(()=>presenceMarkPublished(first,'facebook','https://www.facebook.com/test/posts/999'),/already/);
 const final=presenceMarkPublished(first,'instagram','https://www.instagram.com/p/ABC123/',at);
 assert.equal(final.stage,'published');
 assert.equal(final.published.instagram.url,'https://www.instagram.com/p/ABC123/');
 assert.throws(()=>presenceDraft(good(),final),/published record/i);
});
test('validate real per-platform post path and strip tracking parameters, never profile or token URLs',()=>{
 assert.equal(presencePostURL('facebook','https://www.facebook.com/share/p/abc123/?fbclid=tracking'),'https://www.facebook.com/share/p/abc123/');
 assert.equal(presencePostURL('facebook','https://fb.watch/abc123/'),'https://fb.watch/abc123/');
 assert.equal(presencePostURL('instagram','https://www.instagram.com/reel/XYZ90/?utm_source=test'),'https://www.instagram.com/reel/XYZ90/');
 assert.equal(presencePostURL('threads','https://www.threads.net/@writer/post/ABC123'),'https://www.threads.net/@writer/post/ABC123');
 for(const [platform,url] of [
  ['instagram','https://www.instagram.com/someone/'],
  ['facebook','https://www.facebook.com/someone'],
  ['threads','https://www.threads.com/@writer'],
  ['instagram','http://www.instagram.com/p/ABC123'],
  ['instagram','https://instagram.com.evil.test/p/ABC123'],
  ['threads','https://www.threads.net/@writer/post/ABC123?access_token=secret'],
  ['facebook','https://www.facebook.com/login'],
  ['instagram','https://viewer:password@www.instagram.com/p/ABC123']
 ]) assert.throws(()=>presencePostURL(platform,url),/Link|private|post/i,platform+' '+url);
});
test('missing source metrics stay null; required followers never become fabricated zero',()=>{
 const snapshot=presenceSnapshot(metric('facebook','2026-11-02',34));
 assert.equal(snapshot.followers,34);assert.equal(snapshot.views,null);assert.equal(snapshot.engagements,null);
 assert.equal(snapshot.source,'manual-native-dashboard');
 assert.equal(presenceSnapshot(metric('threads','2026-11-02',0,7,0,0)).views,0);
 for(const missing of ['',null,undefined]) assert.throws(()=>presenceSnapshot(metric('facebook','2026-11-02',missing)),/required|followers/i);
 assert.throws(()=>presenceSnapshot(metric('facebook','2026-11-02',1.5)),/whole number/i);
 assert.throws(()=>presenceSnapshot(metric('facebook','2026-02-30',34)),/actual observation date/i);
 assert.throws(()=>presenceSnapshot(metric('facebook','2038-01-01',34)),/future/);
 assert.throws(()=>presenceSnapshot(metric('other','2026-11-02',34)),/platform/i);
});
test('snapshots are source/window-specific, idempotent and compare only different dates',()=>{
 let snapshots=presenceAddSnapshot([],presenceSnapshot(metric('instagram','2026-10-26',1)));
 assert.throws(()=>presenceAddSnapshot(snapshots,presenceSnapshot(metric('instagram','2026-10-26',1))),/already/);
 snapshots=presenceAddSnapshot(snapshots,presenceSnapshot(metric('instagram','2026-11-02',1,7)));
 let trend=presenceTrend(snapshots,'instagram');assert.equal(trend.net,null);
 snapshots=presenceAddSnapshot(snapshots,presenceSnapshot(metric('instagram','2026-11-02',44,7,1400,100)));
 trend=presenceTrend(snapshots,'instagram');assert.equal(trend.net,43);
 assert.equal(trend.latest.views,1400);
 assert.equal(presenceTrend(snapshots,'facebook').latest,null);
});
test('stretch and working milestones remain separate and never imply current measurements',()=>{
 assert.equal(PRESENCE_GOAL_MILESTONES.length,5);
 assert.equal(presenceGoalProgress([], 'instagram').followers,null);
 assert.equal(presenceGoalProgress([], 'facebook').stretch,1000000);
 const snapshots=[presenceSnapshot(metric('facebook','2026-11-02',34))];
 const goal=presenceGoalProgress(snapshots,'facebook');
 assert.equal(goal.next.followers,250);assert.equal(goal.observedOn,'2026-11-02');
 assert(goal.nextProgress>13&&goal.nextProgress<14);
 assert.equal(presenceGoalProgress(snapshots,'threads'),null);
});
test('restore strips unexpected keys, hostile content, duplicates and invalid publication URLs',()=>{
 const draft=make(['instagram']);
 const published=presenceMarkPublished(presenceReady(draft), 'instagram','https://instagram.com/p/ABC123/',at);
 const history=[presenceSnapshot(metric('facebook','2026-11-02',34))];
 const raw={version:1,drafts:[published,{...published,id:'ps-22334455',title:'password: hidden'},{...published}],snapshots:[history[0],history[0],{...history[0],platform:'invalid'}],access_token:'should-not-keep'};
 const restored=presenceRestore(raw);
 assert.equal(restored.drafts.length,1);assert.equal(restored.snapshots.length,1);
 assert.equal(restored.drafts[0].stage,'published');
 assert.equal(restored.drafts[0].published.instagram.source,'owner-entered');
 assert.equal(Object.hasOwn(restored,'access_token'),false);
 const broken=presenceRestore({version:1,drafts:[{...published,published:{instagram:{url:'https://evil.test/p/x',confirmedAt:at}}}],snapshots:[]});
 assert.equal(broken.drafts.length,0);
 assert.deepEqual(presenceRestore({version:2,drafts:[],snapshots:[]}),presenceBlank());
});
test('contract remains bounded for browser storage',()=>{
 assert.equal(PRESENCE_MAX_DRAFTS,60);assert.equal(PRESENCE_MAX_SNAPSHOTS,240);
 const data=presenceRestore({version:1,drafts:Array.from({length:90},(_,i)=>({...make(),id:'ps-'+String(i).padStart(8,'0')})),snapshots:[]});
 assert.equal(data.drafts.length,60);
});