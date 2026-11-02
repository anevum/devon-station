import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {emptyState} from '../worker/state.mjs';
import {rehearseSyntheticD1Sql,SYNTHETIC_EXPORT_MARKER} from '../tools/synthetic-d1-sql-restore.mjs';

const schema=readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8');
const legacy=schema.split('-- V1.0 additive, owner-scoped private state.')[0];
const hash=x=>createHash('sha256').update(x).digest('hex');
const literal=x=>"'"+String(x).replaceAll("'","''")+"'";
const statement=(table,columns,values)=>'INSERT INTO '+table+' ('+columns.join(',')+') VALUES ('+values.map(v=>v===null?'NULL':typeof v==='number'?v:literal(v)).join(',')+');';
const basePush=[
  statement('push_devices',['owner_sub','device_id','endpoint_hash','endpoint','created_at','updated_at','active'],['synthetic-sub-a','device-a','hash-a','https://web.push.apple.com/synthetic-a',100,100,1]),
  statement('push_devices',['owner_sub','device_id','endpoint_hash','endpoint','created_at','updated_at','active'],['synthetic-sub-b','device-b','hash-b','https://web.push.apple.com/synthetic-b',100,100,1]),
  statement('push_delivery_log',['id','owner_sub','device_id','kind','status','service_status','created_at'],['synthetic-delivery-a','synthetic-sub-a','device-a','manual-test','accepted',201,101])
];
const fakeState=label=>{
  const v=emptyState();
  v.drafts=[{id:'local:synthetic-'+label,title:'Synthetic check '+label,area:'Devon Works',project:null,destination:null,state:'Draft',createdAt:'2026-10-30T12:00:00.000Z'}];
  return JSON.stringify(v);
};
const firstA=fakeState('initial'),latestA=fakeState('revised'),firstB=fakeState('other');
const operations=[
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
];
const currentRows=[
  statement('station_documents',['owner_sub','revision','schema_version','payload','updated_at','last_operation'],['synthetic-sub-a',2,1,latestA,123,operations[1]]),
  statement('station_documents',['owner_sub','revision','schema_version','payload','updated_at','last_operation'],['synthetic-sub-b',1,1,firstB,100,operations[2]]),
  statement('station_write_audit',['owner_sub','operation_id','revision','action','content_sha256','created_at'],['synthetic-sub-a',operations[0],1,'Synthetic update',hash(firstA),110]),
  statement('station_write_audit',['owner_sub','operation_id','revision','action','content_sha256','created_at'],['synthetic-sub-a',operations[1],2,'Synthetic update',hash(latestA),123]),
  statement('station_write_audit',['owner_sub','operation_id','revision','action','content_sha256','created_at'],['synthetic-sub-b',operations[2],1,'Synthetic update',hash(firstB),100]),
  statement('station_portfolio_cache',['owner_sub','source_id','fetch_time','payload'],['synthetic-sub-a','00000000-0000-4000-8000-000000000001',234,'[]'])
];
const syntheticSql=(kind='current',extra=[])=>SYNTHETIC_EXPORT_MARKER+(kind==='legacy'?legacy:schema)+'\n'+[...basePush,...(kind==='legacy'?[]:currentRows),...extra].join('\n')+'\n';
const denied=fn=>assert.throws(fn,error=>error?.message==='synthetic_d1_rehearsal_rejected');

test('offline D1-shaped current SQL dump preserves every reviewed table and audit',()=>{
  const result=rehearseSyntheticD1Sql(syntheticSql());
  assert.equal(result.status,'SYNTHETIC_REHEARSAL_ONLY');
  assert.equal(result.schema,'reviewed-current');
  assert.equal(result.additiveMigrationApplications,2);
  assert.equal(result.ownerAuditContinuityChecked,true);
  assert.equal(result.pushRowsPreserved,true);
  assert.deepEqual(result.rowCounts,{
    push_devices:2,push_delivery_log:1,station_documents:2,
    station_write_audit:3,station_portfolio_cache:1
  });
  assert.equal(result.realProductionD1RestoreVerified,false);
  assert.equal(result.productionCutoverAuthorized,false);
  assert(!JSON.stringify(result).includes('Synthetic check'));
  assert(!JSON.stringify(result).includes('https://web.push.apple.com/'));
});

test('rehearses migration of a legacy push-only SQL export without inventing private state',()=>{
  const result=rehearseSyntheticD1Sql(syntheticSql('legacy'));
  assert.equal(result.schema,'reviewed-legacy-plus-additive-migration');
  assert.deepEqual(result.rowCounts,{
    push_devices:2,push_delivery_log:1,station_documents:0,
    station_write_audit:0,station_portfolio_cache:0
  });
});

test('rejects tampered state payload even when SQLite remains physically valid',()=>{
  const altered=syntheticSql().replace(literal(latestA),literal(fakeState('tampered')));
  denied(()=>rehearseSyntheticD1Sql(altered));
});

test('rejects missing and discontinuous owner audit history',()=>{
  const missing=currentRows.filter(line=>!line.includes(literal(operations[0])));
  const sql=SYNTHETIC_EXPORT_MARKER+schema+'\n'+[...basePush,...missing].join('\n');
  denied(()=>rehearseSyntheticD1Sql(sql));
  const orphan=statement('station_write_audit',['owner_sub','operation_id','revision','action','content_sha256','created_at'],
    ['orphan-sub','cccccccc-cccc-4ccc-8ccc-ccccccccccc1',1,'Synthetic',hash(latestA),125]);
  denied(()=>rehearseSyntheticD1Sql(syntheticSql('current',[orphan])));
});

test('rejects absent indexes, unexpected schema drift and malformed SQL',()=>{
  const withoutIndex=syntheticSql().replace('CREATE INDEX IF NOT EXISTS station_audit_owner_time ON station_write_audit(owner_sub,created_at);','');
  denied(()=>rehearseSyntheticD1Sql(withoutIndex));
  denied(()=>rehearseSyntheticD1Sql(syntheticSql('current',['CREATE INDEX invented_index ON station_documents (revision);'])));
  denied(()=>rehearseSyntheticD1Sql(syntheticSql('current',['INSERT INTO nonexistent VALUES (1);'])));
});

test('rejects absent marker, forbidden SQL, and oversized input before attempting restoration',()=>{
  const sql=syntheticSql();
  denied(()=>rehearseSyntheticD1Sql(sql.slice(SYNTHETIC_EXPORT_MARKER.length)));
  denied(()=>rehearseSyntheticD1Sql(SYNTHETIC_EXPORT_MARKER+'ATTACH DATABASE "other.sqlite" AS other; '+sql));
  denied(()=>rehearseSyntheticD1Sql(sql+'\nVACUUM INTO "unsafe.sqlite";'));
  denied(()=>rehearseSyntheticD1Sql(sql+' '.repeat(600000)));
});

test('fails safely without echoing raw synthetic state if import fails',()=>{
  const raw=syntheticSql().replace('CREATE TABLE IF NOT EXISTS push_devices','CREATE TABL INVALID push_devices');
  try{rehearseSyntheticD1Sql(raw);assert.fail('expected rejection');}
  catch(error){assert.equal(error.message,'synthetic_d1_rehearsal_rejected');assert(!JSON.stringify(error).includes('Synthetic check'));}
});
