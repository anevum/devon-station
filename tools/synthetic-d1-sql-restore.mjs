/**
 * DS011-RB01: offline rehearsal of a D1-shaped SQL export using fabricated
 * records ONLY. Not an authenticated production D1 restore, SQL sandbox,
 * privacy scanner, or permission to handle real owner/client records.
 *
 * Accepts a test-generated SQL string, reconstructs it in a fresh ephemeral
 * SQLite database, compares source schema and rows, and repeats the reviewed
 * additive migration. No Cloudflare credentials or file paths are accepted.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {validateOwnerState} from '../worker/state.mjs';

export const SYNTHETIC_EXPORT_MARKER='-- DS011-SYNTHETIC-D1-SQL-EXPORT v1\n';
const schema=readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8');
const additive=readFileSync(new URL('../worker/migrations/0002-owner-state.sql',import.meta.url),'utf8');
const legacy=schema.split('-- V1.0 additive, owner-scoped private state.')[0];
const tables=['push_devices','push_delivery_log','station_documents','station_write_audit','station_portfolio_cache'];
const legacyTables=tables.slice(0,2);
const sha=data=>createHash('sha256').update(data).digest('hex');
const fail=()=>{throw new Error('synthetic_d1_rehearsal_rejected');};
const sorted=x=>JSON.stringify(x);
const tableRows=(db,table)=>db.prepare('SELECT * FROM "'+table+'" ORDER BY 1,2').all();
const hasTable=(db,table)=>!!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table);

function normalizedSchema(db) {
  const rows=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return rows.map(row=>({
    type:row.type,name:row.name,table:row.tbl_name,
    // Intentionally strict. Any unexpected SQL DDL, trigger, index or
    // schema-format change requires a deliberate compatibility review.
    ddl:typeof row.sql==='string'?row.sql.replace(/\s+/g,' ').trim():null
  }));
}
function expectedSchema(kind) {
  const db=new DatabaseSync(':memory:');
  try{db.exec(kind==='legacy'?legacy:schema);return normalizedSchema(db);}
  finally{db.close();}
}
const expectedLegacy=expectedSchema('legacy');
const expectedCurrent=expectedSchema('current');

function checkIntegrity(db) {
  if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok' ||
     db.prepare('PRAGMA foreign_key_check').all().length)fail();
}
function checkOwnerAudit(db) {
  const docs=db.prepare('SELECT owner_sub,revision,schema_version,payload,last_operation FROM station_documents ORDER BY owner_sub').all();
  for(const d of docs) {
    if(typeof d.owner_sub!=='string'||!d.owner_sub.trim()||d.owner_sub.length>128 ||
       !Number.isSafeInteger(d.revision)||d.revision<1||d.schema_version!==1)fail();
    let value;
    try{value=JSON.parse(d.payload);validateOwnerState(value);}
    catch{fail();}
    const logs=db.prepare('SELECT operation_id,revision,content_sha256 FROM station_write_audit WHERE owner_sub=? ORDER BY revision').all(d.owner_sub);
    if(logs.length!==d.revision)fail();
    for(let i=0;i<logs.length;i++) {
      if(logs[i].revision!==i+1 || typeof logs[i].operation_id!=='string' ||
         !/^[0-9a-f-]{36}$/i.test(logs[i].operation_id) ||
         !/^[0-9a-f]{64}$/.test(logs[i].content_sha256))fail();
    }
    const latest=logs.at(-1);
    if(latest.operation_id!==d.last_operation||latest.content_sha256!==sha(d.payload))fail();
  }
  const orphan=db.prepare('SELECT 1 FROM station_write_audit AS a LEFT JOIN station_documents AS d ON a.owner_sub=d.owner_sub WHERE d.owner_sub IS NULL LIMIT 1').get();
  if(orphan)fail();
  return docs.length;
}

/**
 * Rehearse one deterministic, fabricated SQL dump. A marker is necessary but
 * never sufficient proof of synthetic provenance; callers must not feed real
 * exports, copied personal records or untrusted SQL to this function.
 */
export function rehearseSyntheticD1Sql(sql) {
  if(typeof sql!=='string'||!sql.startsWith(SYNTHETIC_EXPORT_MARKER)||
     Buffer.byteLength(sql)>512*1024||Buffer.byteLength(sql)<SYNTHETIC_EXPORT_MARKER.length+50)fail();
  // This input is controlled by local tests, not a general SQL sandbox.
  // Deny obvious filesystem and schema-tampering operations in fixtures.
  if(/\b(?:ATTACH|DETACH|VACUUM|load_extension|writable_schema|CREATE\s+(?:VIRTUAL\s+)?TRIGGER|DROP\s+(?:TABLE|INDEX)|ALTER\s+TABLE)\b/i.test(sql))fail();

  const db=new DatabaseSync(':memory:');
  try{
    try{db.exec(sql.slice(SYNTHETIC_EXPORT_MARKER.length));}catch{fail();}
    checkIntegrity(db);
    const beforeSchema=normalizedSchema(db);
    const isCurrent=sorted(beforeSchema)===sorted(expectedCurrent);
    const isLegacy=sorted(beforeSchema)===sorted(expectedLegacy);
    if(!isCurrent&&!isLegacy)fail();
    const beforeTables=isLegacy?legacyTables:tables;
    const before=Object.fromEntries(beforeTables.map(table=>[table,tableRows(db,table)]));
    const ownerCount=isLegacy?0:checkOwnerAudit(db);
    // Rehearsal applies reviewed migration to this in-memory copy only.
    for(let attempt=0;attempt<2;attempt++){
      try{db.exec('BEGIN IMMEDIATE;'+additive+'\nCOMMIT;');}
      catch{try{db.exec('ROLLBACK');}catch{}fail();}
      checkIntegrity(db);
      if(sorted(normalizedSchema(db))!==sorted(expectedCurrent))fail();
      for(const table of beforeTables)if(sorted(tableRows(db,table))!==sorted(before[table]))fail();
      if(checkOwnerAudit(db)!==ownerCount)fail();
    }
    const counts=Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT COUNT(*) AS n FROM "'+table+'"').get().n]));
    return Object.freeze({
      status:'SYNTHETIC_REHEARSAL_ONLY',
      independentlyRestoredIntoMemory:true,
      schema:isLegacy?'reviewed-legacy-plus-additive-migration':'reviewed-current',
      additiveMigrationApplications:2,
      ownerAuditContinuityChecked:true,
      pushRowsPreserved:true,
      dataIsSyntheticByOperatorAssertionOnly:true,
      realProductionD1RestoreVerified:false,
      sourcePublicationAuthorized:false,
      productionCutoverAuthorized:false,
      rowCounts:counts
    });
  }finally{db.close();}
}
