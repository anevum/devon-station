// DS011-COMMS-65: strict, data-minimizing, read-only preflight for a separately
// approved acceptance-only migration 0009. D1 uses POST for SELECT queries;
// this module supplies no data-write SQL, migration execution or credentials.
export const ACCEPTANCE_MAIL_DB_ID='efb86ffd-f422-43af-88e5-7f93af91eda2';

// Independently SHA-256-checked against exact source bytes of the approved
// PR #36 commit. Names alone cannot detect a tampered/incorrect migration ledger.
const expectedMigrations=Object.freeze([
 ['worker/migrations/0004-comms-ro-mail.sql','025a0397c98b90a4566e777e3851c58cb91478f84af02389459bf9bd59486e48'],
 ['worker/migrations/0005-comms-drafts.sql','f418547e7aa89978a2fd3815ee98492f1489a3476e39f627eb0e8a90afcc3e7d'],
 ['worker/migrations/0006-comms-outbox.sql','e13a0b179343592b8592373634dcb54c4147a663497da7b7292f538be73b0864'],
 ['worker/migrations/0007-comms-draft-outbox-lineage.sql','a4953d41ee4d1a93974ccd08c2e058fe3a2a32db745d52840778ac2cdeae17c1'],
 ['worker/migrations/0008-comms-one-delivery-per-draft.sql','adbf26a703aad288ace491864f2107e215a349c665bbe5968a327d7ff55baeb9']
].map(([name,sha256])=>Object.freeze({name,sha256})));

export const MIGRATION_READINESS_SQL=Object.freeze({
 ledger:'SELECT name, sha256 FROM station_schema_migrations ORDER BY name',
 objects:"SELECT type, name, sql FROM sqlite_master WHERE name IN ('comms_outbox','comms_outbox_saved_draft_revision','comms_outbox_saved_draft_once') OR name LIKE 'comms_sent_archive%' OR name LIKE 'comms_archive_%' ORDER BY name",
 columns:'PRAGMA table_info(comms_outbox)',
 counts:`SELECT COUNT(*) AS total,
 COALESCE(SUM(CASE WHEN state='accepted' THEN 1 ELSE 0 END),0) AS accepted,
 COALESCE(SUM(CASE WHEN state='accepted' AND draft_id IS NOT NULL AND draft_revision IS NOT NULL THEN 1 ELSE 0 END),0) AS accepted_linked,
 COALESCE(SUM(CASE WHEN state='accepted' AND draft_id IS NOT NULL AND draft_revision IS NOT NULL AND payload_json!='null' AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.v')=1 AND json_extract(payload_json,'$.alg')='A256GCM' ELSE 0 END THEN 1 ELSE 0 END),0) AS eligible,
 COALESCE(SUM(CASE WHEN state IN ('queued','claimed','uncertain') THEN 1 ELSE 0 END),0) AS unresolved
 FROM comms_outbox`
});

const refuse=reason=>{throw Error('DS011 migration preflight refused: '+reason);};
const sqlKey=s=>s.toLowerCase().replace(/\bif not exists\b/g,'').replace(/\s*([(),])\s*/g,'$1').replace(/\s+/g,' ').trim();
const indexDefinitions=Object.freeze({
 comms_outbox_saved_draft_revision:
  'CREATE UNIQUE INDEX comms_outbox_saved_draft_revision ON comms_outbox(installation_id,mailbox_id,owner_sub,draft_id,draft_revision) WHERE draft_id IS NOT NULL AND draft_revision IS NOT NULL',
 comms_outbox_saved_draft_once:
  'CREATE UNIQUE INDEX comms_outbox_saved_draft_once ON comms_outbox(installation_id,mailbox_id,owner_sub,draft_id) WHERE draft_id IS NOT NULL'
});
// Exact reviewed schema after migrations 0006/0007. A new constraint, column,
// or unexpected redefinition requires a human-reviewed baseline update.
const expectedOutboxTable=`CREATE TABLE comms_outbox (
 installation_id TEXT NOT NULL, mailbox_id TEXT NOT NULL, owner_sub TEXT NOT NULL,
 delivery_id TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 state TEXT NOT NULL CHECK(state IN ('queued','claimed','accepted','rejected','failed','uncertain')),
 claim_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, draft_id TEXT, draft_revision INTEGER
 CHECK (draft_revision IS NULL OR (draft_revision BETWEEN 1 AND 1000000000)),
 PRIMARY KEY(installation_id,mailbox_id,owner_sub,delivery_id)
)`;
const outboxColumns=Object.freeze([
 ['installation_id','TEXT',1],['mailbox_id','TEXT',1],['owner_sub','TEXT',1],
 ['delivery_id','TEXT',1],['payload_json','TEXT',1],['state','TEXT',1],
 ['claim_id','TEXT',0],['created_at','TEXT',1],['updated_at','TEXT',1],
 ['draft_id','TEXT',0],['draft_revision','INTEGER',0]
]);
const safeRows=value=>{
 if(!Array.isArray(value)||value.length>100||value.some(row=>!row||typeof row!=='object'||Array.isArray(row)))
  refuse('database query did not return bounded rows');
 return value;
};

export function assessAcceptanceMigrationReadiness({ledger,objects,columns,counts}){
 const migrations=safeRows(ledger);
 if(migrations.length!==expectedMigrations.length||
    migrations.some((row,i)=>row.name!==expectedMigrations[i].name||
      row.sha256!==expectedMigrations[i].sha256))
  refuse('migration ledger name or source checksum differs from reviewed prerequisites');
 const schema=safeRows(objects);
 if(schema.length!==3||schema.some(x=>!Object.hasOwn(indexDefinitions,x.name)&&x.name!=='comms_outbox')||
    new Set(schema.map(x=>x.name)).size!==3)
  refuse('archive objects exist, or required outbox schema is incomplete');
 const table=schema.find(x=>x.name==='comms_outbox');
 const definition=typeof table?.sql==='string'?sqlKey(table.sql):'';
 if(table?.type!=='table'||definition!==sqlKey(expectedOutboxTable))
  refuse('outbox table constraints differ from reviewed prerequisites');
 for(const [name,expected] of Object.entries(indexDefinitions)){
  const object=schema.find(x=>x.name===name);
  if(object?.type!=='index'||typeof object.sql!=='string'||sqlKey(object.sql)!==sqlKey(expected))
   refuse('saved-draft uniqueness index differs from reviewed prerequisites');
 }
 const actualColumns=safeRows(columns);
 if(actualColumns.length!==outboxColumns.length||
    outboxColumns.some(([name,type,required],i)=>actualColumns[i]?.name!==name||
      actualColumns[i]?.type?.toUpperCase()!==type||actualColumns[i]?.notnull!==required))
  refuse('outbox column contract differs from reviewed prerequisites');
 const c=safeRows(counts);
 if(c.length!==1)refuse('aggregate count result was not unique');
 const data=c[0];
 for(const field of ['total','accepted','accepted_linked','eligible','unresolved'])
  if(!Number.isSafeInteger(data[field])||data[field]<0)refuse('invalid aggregate count '+field);
 if(data.total!==1||data.accepted!==1||data.accepted_linked!==1||
    data.eligible!==1||data.unresolved!==0)
  refuse('reviewed acceptance-mail state changed or cannot backfill safely');
 return Object.freeze({
  status:'ACCEPTANCE_0009_METADATA_PREFLIGHT_PASS',
  databaseId:ACCEPTANCE_MAIL_DB_ID,
  migration0009Applied:false,
  requiredMigrationsPresent:true,
  archiveObjectsAbsent:true,
  outboxConstraintsVerified:true,
  expectedBackfillRecords:data.eligible,
  unresolvedOutboxRecords:data.unresolved,
  dataWrites:0,
  migrationApproved:false,
  proofScope:'READ_ONLY_METADATA_AND_AGGREGATES_AT_CHECK_TIME'
 });
}

export async function preflightAcceptanceMigration0009({query}={}){
 if(typeof query!=='function')refuse('read-only D1 query adapter is missing');
 // D1's SQL API is not one read transaction across these requests. Check all
 // four metadata/count views twice to detect drift visible between passes.
 // The comparison is deliberately fail-closed. It does NOT confer atomicity:
 // writes after the final read, or replacements with identical aggregate
 // results, still require a fresh pre-migration gate.
 const readPass=async()=>{
  const rowsByQuery={};
  const readback={};
  // Only constant SQL in this fixed allowlist is sent, always to the pinned
  // acceptance MAIL_DB. No message body, recipient or ciphertext is selected.
  for(const [name,sql] of Object.entries(MIGRATION_READINESS_SQL)){
   let rows;
   try{rows=await query(ACCEPTANCE_MAIL_DB_ID,sql);}
   catch{refuse('metadata or aggregate query unavailable');}
   rowsByQuery[name]=safeRows(rows);
   // Freeze an immediate snapshot: adapters may reuse/mutate returned objects.
   // Never surface a snapshot, SQL, or provider exception in an error.
   readback[name]=JSON.stringify(rowsByQuery[name]);
  }
  return {rowsByQuery,readback};
 };
 const initial=await readPass();
 const assessment=assessAcceptanceMigrationReadiness(initial.rowsByQuery);
 const rechecked=await readPass();
 assessAcceptanceMigrationReadiness(rechecked.rowsByQuery);
 for(const name of Object.keys(MIGRATION_READINESS_SQL))
  if(initial.readback[name]!==rechecked.readback[name])
   refuse('acceptance metadata or aggregate counts changed during verification');
 return Object.freeze({
  ...assessment,readPasses:2,
  proofScope:'TWO_PASS_READ_ONLY_METADATA_AND_AGGREGATES_NOT_ATOMIC'
 });
}
