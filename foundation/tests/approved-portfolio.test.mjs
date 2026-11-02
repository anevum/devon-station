import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createStation} from '../../worker/index.mjs';
import {createFoundation} from '../src/foundation.mjs';
import {approvedProjectsForIdentity} from '../interop/approved-portfolio.mjs';
import {startDemo} from '../demo/server.mjs';

const origin='https://station-test.example.test';
const ownerSub='synthetic-provider-owner';
const ownerEmail='owner@example.test';
const identity={principalId:'demo-owner',role:'owner',scopeKind:'personal',scopeId:'demo-scope'};
const approved={principalId:'demo-owner',scopeKind:'personal',scopeId:'demo-scope',projectId:'DS-011',area:'Devon Works'};
const record='https://app.notion.com/p/'+'a'.repeat(32);
const cachedAt=Date.parse('2026-10-31T18:00:00.000Z');
const project=(id,area,name,overrides={})=>({
  id,area,name,record,next:'Fabricated restricted work detail; must not cross bridge',
  owner:'Synthetic private owner',gate:'Synthetic private gate',status:'Active',
  repo:'https://github.com/synthetic/private',source:'https://example.test/private',
  ...overrides
});
const payload=(projects=[project('DS-011','Devon Works','Synthetic DevonStation'),project('CB-011','Shinewell','Synthetic Business Only'),project('AN-011','ANEVUM','Synthetic Creative Only')],overrides={})=>({
  source:'Notion project portfolio',configured:true,mode:'read_only_cache',
  cachedAt,notionWrites:false,projects,...overrides
});
const derive=(portfolio=payload(),overrides={})=>approvedProjectsForIdentity({
  identity,portfolio,projectGrants:[approved],...overrides
});
function storage(t) {
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8'));
  t.after(()=>db.close());
  return {
    sqlite:db,
    DB:{prepare(sql){return {bind(...values){return {
      first:async()=>db.prepare(sql).get(...values)??null
    }}}}}
  };
}

test('owner-scoped recovered Worker cache reaches the existing foundation project contract and local UI',async t=>{
  const {sqlite,DB}=storage(t);
  const raw=payload();
  sqlite.prepare('INSERT INTO station_portfolio_cache(owner_sub,source_id,fetch_time,payload) VALUES (?,?,?,?)')
    .run(ownerSub,'00000000-0000-4000-8000-000000000001',cachedAt,JSON.stringify(raw.projects));
  const station=createStation({},async()=>({subject:ownerSub,email:ownerEmail}),async()=>{
    throw Error('No network calls from a cached portfolio read');
  });
  const env={APP_ORIGIN:origin,OWNER_EMAIL:ownerEmail,DB};
  const response=await station.fetch(new Request(origin+'/api/portfolio'),env,{});
  assert.equal(response.status,200);
  const source=await response.json();
  assert.equal(source.projects.length,3);
  const view=derive(source);
  assert.equal(view.mode,'read_only_cache');
  assert.equal(view.notionWrites,false);
  assert.equal(view.projects.length,1);
  assert.deepEqual(view.projects[0],{
    projectId:'DS-011',scopeKind:'personal',scopeId:'demo-scope',
    title:'Synthetic DevonStation',freshness:'cached',
    source:{sourceSystem:'notion',sourceType:'project',sourceId:'DS-011',
      sourceUrl:record,observedAt:'2026-10-31T18:00:00.000Z'}
  });
  for(const excluded of ['Synthetic Business Only','Synthetic Creative Only',
    'Fabricated restricted work detail','Synthetic private owner','Synthetic private gate']) {
    assert(!JSON.stringify(view).includes(excluded),'unapproved metadata must not be copied');
  }
  const workspace=createFoundation({identity,projects:view.projects});
  workspace.propose(identity,{
    operationId:'op-synthetic-1',recordId:'record-synthetic-1',projectId:'DS-011',
    summary:'Review the synthetic foundation',expectedRevision:0
  });
  assert.equal(workspace.actions(identity).length,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM station_portfolio_cache').get().count,1,
    'local decisions must not modify the authoritative Notion cache');

  // Same existing local preview, with injected fabricated cache projections.
  const demo=await startDemo({approvedSyntheticProjects:view.projects});
  t.after(()=>demo.close());
  const page=await fetch(demo.origin),html=await page.text();
  assert.equal(page.status,200);
  assert.match(html,/Preview with synthetic data/);
  const token=html.match(/name="demo-token" content="([a-f0-9]{64})"/)?.[1];
  assert(token);
  const headers={'x-demo-token':token};
  const state=await (await fetch(demo.origin+'/api/state',{headers})).json();
  assert.equal(state.projects.length,1);
  assert.equal(state.projects[0].projectId,'DS-011');
  assert.equal(state.actions.length,0);
  const mutation=await fetch(demo.origin+'/api/proposals',{
    method:'POST',headers:{...headers,origin:demo.origin,'content-type':'application/json'},
    body:JSON.stringify({projectId:'DS-011',summary:'A local synthetic follow-up',
      generation:state.generation,operationId:'op-portfolio-1',recordId:'record-portfolio-1'})
  });
  assert.equal(mutation.status,200);
  const after=await (await fetch(demo.origin+'/api/state',{headers})).json();
  assert.equal(after.actions.length,1);
  assert.equal(after.actions[0].status,'proposed');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM station_write_audit').get().count,0);
});

test('no cache or explicit zero grants reveals no projects',()=>{
  const empty=derive(payload([],{cachedAt:null}));
  assert.equal(empty.status,'not_cached');
  assert.deepEqual(empty.projects,[]);
  assert.deepEqual(derive(payload(),{projectGrants:[]}).projects,[]);
});

test('denies untrusted or cross-scope project grants instead of inferring business permissions',()=>{
  const wrongOwner={...approved,principalId:'other'};
  const wrongScope={...approved,scopeKind:'business'};
  const wrongScopeId={...approved,scopeId:'other'};
  const changedArea={...approved,area:'Shinewell'};
  for(const grant of [wrongOwner,wrongScope,wrongScopeId,changedArea]){
    assert.throws(()=>derive(payload(),{projectGrants:[grant]}));
  }
  assert.throws(()=>derive(payload(),{identity:{...identity,role:'viewer'}}));
  assert.throws(()=>derive(payload(),{identity:{...identity,scopeId:'other'}}));
  assert.throws(()=>derive(payload(),{projectGrants:[approved,approved]}));
  assert.throws(()=>derive(payload(),{projectGrants:[{...approved,role:'owner'}]}));
});

test('rejects untrusted cache modes, duplicate project records and malformed timestamps',()=>{
  assert.throws(()=>derive(payload([],{notionWrites:true})));
  assert.throws(()=>derive(payload([],{mode:'write_through'})));
  assert.throws(()=>derive(payload([project('DS-011','Devon Works','One'),
    project('DS-011','Devon Works','Two')])));
  assert.throws(()=>derive(payload([],{cachedAt:8640000000000001})));
  assert.throws(()=>derive(payload([],{cachedAt:null,projects:[project('DS-011','Devon Works','One')]})));
});

test('rejects changed source area and unsafe source references for a granted project',()=>{
  assert.throws(()=>derive(payload([project('DS-011','Shinewell','Synthetic DevonStation')])));
  for(const url of [
    'http://app.notion.com/p/example','https://app.notion.com.evil.test/p/x',
    'https://person@app.notion.com/p/x','https://app.notion.com/p/x?secret=true',
    'https://app.notion.com/p/x#confidential','https://github.com/anevum/devon-station'
  ]) assert.throws(()=>derive(payload([project('DS-011','Devon Works','Synthetic DevonStation',{record:url})])));
  assert.throws(()=>derive(payload([project('DS-011','Devon Works','password=private')])));

  // Foundation keeps its exact-host rule even for an otherwise valid projection.
  const valid=derive();
  assert.equal(valid.projects[0].source.sourceUrl,record);
  assert.throws(()=>createFoundation({identity,projects:[{
    ...valid.projects[0],source:{...valid.projects[0].source,
      sourceUrl:'https://app.notion.com.evil.test/p/foo'}
  }]}));
});

test('unapproved records are never copied into another owner-scoped cache',async t=>{
  const {sqlite,DB}=storage(t);
  sqlite.prepare('INSERT INTO station_portfolio_cache(owner_sub,source_id,fetch_time,payload) VALUES (?,?,?,?)')
    .run(ownerSub,'00000000-0000-4000-8000-000000000001',cachedAt,JSON.stringify(payload().projects));
  const otherStation=createStation({},async()=>({subject:'different-synthetic-provider',email:ownerEmail}));
  const response=await otherStation.fetch(new Request(origin+'/api/portfolio'),
    {APP_ORIGIN:origin,OWNER_EMAIL:ownerEmail,DB},{});
  assert.equal(response.status,200);
  const other=await response.json();
  assert.equal(other.projects.length,0);
  assert.equal(derive(other).projects.length,0);
});
