import test from 'node:test';
import assert from 'node:assert/strict';
import {
 ACCEPTANCE_MAIL_DB_ID,MIGRATION_READINESS_SQL,
 assessAcceptanceMigrationReadiness,preflightAcceptanceMigration0009
} from '../tools/comms-migration-readiness.mjs';

const ledger=()=>[4,5,6,7,8].map((n,i)=>({
 name:'worker/migrations/000'+n+'-'+[
  'comms-ro-mail','comms-drafts','comms-outbox','comms-draft-outbox-lineage',
  'comms-one-delivery-per-draft'
 ][i]+'.sql'
}));
const table='CREATE TABLE comms_outbox (\n installation_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, owner_sub TEXT NOT NULL,\n delivery_id TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),\n state TEXT NOT NULL CHECK(state IN (\'queued\',\'claimed\',\'accepted\',\'rejected\',\'failed\',\'uncertain\')),\n claim_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, draft_id TEXT, draft_revision INTEGER\n CHECK (draft_revision IS NULL OR (draft_revision BETWEEN 1 AND 1000000000)),\n PRIMARY KEY(installation_id,mailbox_id,owner_sub,delivery_id)\n)';
const objects=()=>[
 {type:'index',name:'comms_outbox_saved_draft_once',sql:'CREATE UNIQUE INDEX comms_outbox_saved_draft_once\n ON comms_outbox(installation_id,mailbox_id,owner_sub,draft_id)\n WHERE draft_id IS NOT NULL'},
 {type:'index',name:'comms_outbox_saved_draft_revision',sql:'CREATE UNIQUE INDEX comms_outbox_saved_draft_revision\n ON comms_outbox(installation_id,mailbox_id,owner_sub,draft_id,draft_revision)\n WHERE draft_id IS NOT NULL AND draft_revision IS NOT NULL'},
 {type:'table',name:'comms_outbox',sql:table}
];
const columns=()=>[
 ['installation_id','TEXT',1],['mailbox_id','TEXT',1],['owner_sub','TEXT',1],
 ['delivery_id','TEXT',1],['payload_json','TEXT',1],['state','TEXT',1],
 ['claim_id','TEXT',0],['created_at','TEXT',1],['updated_at','TEXT',1],
 ['draft_id','TEXT',0],['draft_revision','INTEGER',0]
].map(([name,type,notnull],cid)=>({cid,name,type,notnull,dflt_value:null,pk:cid<4?cid+1:0}));
const counts=()=>[{total:1,accepted:1,accepted_linked:1,eligible:1,unresolved:0}];
function fixture(){return {ledger:ledger(),objects:objects(),columns:columns(),counts:counts()};}
function harness(change=()=>{}){
 const data=fixture(),calls=[];
 const query=async(db,sql)=>{
  calls.push({db,sql});
  assert.equal(db,ACCEPTANCE_MAIL_DB_ID,'must never touch production or backup database');
  assert(Object.values(MIGRATION_READINESS_SQL).includes(sql),'SQL is fixed and reviewed');
  const type=Object.keys(MIGRATION_READINESS_SQL).find(k=>MIGRATION_READINESS_SQL[k]===sql);
  const rows=structuredClone(data[type]);change(type,rows,calls);
  return rows;
 };
 return {query,calls};
}

test('exact migration 0004-0008, prerequisites, one encrypted accepted row and zero unresolved pass without writes',async()=>{
 const h=harness();
 const result=await preflightAcceptanceMigration0009({query:h.query});
 assert.equal(result.status,'ACCEPTANCE_0009_METADATA_PREFLIGHT_PASS');
 assert.equal(result.expectedBackfillRecords,1);
 assert.equal(result.migration0009Applied,false);
 assert.equal(result.dataWrites,0);
 assert.equal(result.migrationApproved,false);
 assert.equal(result.databaseId,ACCEPTANCE_MAIL_DB_ID);
 assert.equal(h.calls.length,Object.keys(MIGRATION_READINESS_SQL).length);
 assert(h.calls.every(({db,sql})=>db===ACCEPTANCE_MAIL_DB_ID&&Object.values(MIGRATION_READINESS_SQL).includes(sql)));
 assert(!JSON.stringify(result).includes('owner_sub'));
 assert(!JSON.stringify(result).includes('payload_json'));
});

test('ledger refuses a missing prerequisite, duplicate row or already-applied archive migration',()=>{
 for(const mutate of [
  x=>x.ledger.shift(),
  x=>x.ledger.push({...x.ledger[0]}),
  x=>x.ledger.push({name:'worker/migrations/0009-comms-sent-archive.sql'}),
  x=>x.ledger.push({name:'worker/migrations/0010-unreviewed.sql'}),
  x=>x.ledger.reverse(),
  x=>x.ledger.push({name:42})
 ]){const x=fixture();mutate(x);assert.throws(()=>assessAcceptanceMigrationReadiness(x),/refused: migration ledger/);}
});

test('outbox schema fails closed on unexpected archive table, trigger, index drift or conflicting table constraints',()=>{
 for(const mutate of [
  x=>x.objects.push({type:'table',name:'comms_sent_archive',sql:'CREATE TABLE comms_sent_archive(a TEXT)'}),
  x=>x.objects.push({type:'trigger',name:'comms_archive_accepted_outbox',sql:'CREATE TRIGGER ...'}),
  x=>x.objects.pop(),
  x=>{x.objects.find(z=>z.name==='comms_outbox_saved_draft_once').sql='CREATE INDEX comms_outbox_saved_draft_once ON comms_outbox(draft_id)';},
  x=>{x.objects.find(z=>z.name==='comms_outbox').sql='CREATE TABLE comms_outbox (delivery_id TEXT)';},
  x=>{x.objects.find(z=>z.name==='comms_outbox').sql=table.replace('BETWEEN 1 AND 1000000000','BETWEEN 1 AND 500000000');},
  x=>{x.objects.find(z=>z.name==='comms_outbox').sql=table.replace('CHECK(json_valid(payload_json))','CHECK(length(payload_json)>0)');},
  x=>{x.columns.pop();},
  x=>{x.columns[4].notnull=0;}
 ]){const x=fixture();mutate(x);assert.throws(()=>assessAcceptanceMigrationReadiness(x),/refused:/);}
});

test('counts refuse added data, unlinked accepted mail, unresolved outbox and invalid numeric values',()=>{
 for(const mutate of [
  x=>{x.counts[0].total=2;},
  x=>{x.counts[0].accepted_linked=0;},
  x=>{x.counts[0].eligible=0;},
  x=>{x.counts[0].unresolved=1;},
  x=>{x.counts[0].total='1';},
  x=>{x.counts[0].eligible=Number.MAX_SAFE_INTEGER+1;},
  x=>{x.counts.push(x.counts[0]);}
 ]){const x=fixture();mutate(x);assert.throws(()=>assessAcceptanceMigrationReadiness(x),/refused:/);}
});

test('database adapter errors are bounded without leaking provider messages',async()=>{
 const x=fixture();
 await assert.rejects(preflightAcceptanceMigration0009({query:async(db,sql)=>{
  if(sql===MIGRATION_READINESS_SQL.counts)throw Error('PRIVATE_PAYLOAD_MARKER');
  return x[Object.keys(MIGRATION_READINESS_SQL).find(key=>MIGRATION_READINESS_SQL[key]===sql)];
 }}),e=>e.message.includes('query unavailable')&&!e.message.includes('PRIVATE_PAYLOAD_MARKER'));
 await assert.rejects(preflightAcceptanceMigration0009({query:async()=>[{name:'PRIVATE_PAYLOAD_MARKER'},...Array(101).fill({})]}),/bounded rows/);
 await assert.rejects(preflightAcceptanceMigration0009(),/adapter/);
});

test('SQL inventory uses SELECT/PRAGMA only, excludes body exports and dynamic table modifications',()=>{
 for(const sql of Object.values(MIGRATION_READINESS_SQL)){
  assert.match(sql.trim(),/^(?:SELECT|PRAGMA)\b/i);
  assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|REPLACE|ATTACH|DETACH|VACUUM|EXPORT)\b/i);
  assert.doesNotMatch(sql,/SELECT\s+\*|SELECT\s+payload_json|SELECT\s+body_text|SELECT\s+subject/i);
 }
});
