/** Offline comparison of approved, quiescent SQLite copies. No export or restore. */
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstatSync,existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const schema=readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8');
const journal=readFileSync(new URL('../worker/migrations/0003-scoped-workspace.sql',import.meta.url),'utf8');
const tables=['push_devices','push_delivery_log','station_documents','station_write_audit','station_portfolio_cache'];
const journalTable='station_workspace_state';
const internalDDL='CREATE TABLE _cf_KV (key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const refuse=()=>{throw Error('d1_restore_comparison_refused');};
// Preserve quoted text and token boundaries; ignore only DDL whitespace/case
// outside quoted tokens. Production DDL formatting differs from repo formatting.
const ddl=sql=>JSON.stringify(sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\[(?:[^\]])*\]|`(?:``|[^`])*`|[a-z_][a-z_0-9$]*|\d+|[^\s]/gi)
  ?.map(token=>/^[a-z_]/i.test(token)?token.toLowerCase():token));
function structure(db){
  const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const internal=objects.find(row=>row.type==='table'&&row.name==='_cf_KV');
  if(internal && (internal.type!=='table'||ddl(internal.sql)!==ddl(internalDDL)))refuse();
  // Cloudflare-managed metadata is explicitly outside application recovery.
  // Its values must not be copied, compared, or treated as portable app state.
  return JSON.stringify(objects.filter(row=>!(row.type==='table'&&row.name==='_cf_KV')).map(row=>
    [row.type,row.name,row.tbl_name,ddl(row.sql)]));
}
function expected(includeJournal){
  const db=new DatabaseSync(':memory:');
  try{db.exec(schema+(includeJournal?'\n'+journal:''));return structure(db);}
  finally{db.close();}
}
const reviewed=[expected(false),expected(true)];
function file(path){
  const absolute=resolve(path),stat=lstatSync(absolute);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<512||stat.size>64*1024*1024)refuse();
  if(['-wal','-shm','-journal'].some(suffix=>existsSync(absolute+suffix)))refuse();
  const bytes=readFileSync(absolute);
  if(bytes.subarray(0,16).toString('binary')!=='SQLite format 3\0'||bytes[18]!==1||bytes[19]!==1)refuse();
  return {path:absolute,stat,digest:hash(bytes)};
}
function open(path){
  const db=new DatabaseSync(path,{readOnly:true,enableDoubleQuotedStringLiterals:false});
  try{db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');return db;}
  catch(error){db.close();throw error;}
}
function integrity(db){
  const rows=db.prepare('PRAGMA integrity_check').all();
  if(rows.length!==1||rows[0].integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)refuse();
}
function rows(db,table){
  // Reviewed identifiers only. Hash typed complete rows, sort the multiset to
  // ignore physical insertion order, and retain duplicates. No row leaves here.
  const statement=db.prepare('SELECT * FROM "'+table+'"');
  statement.setReadBigInts(true);statement.setReturnArrays(true);
  const digests=[];
  for(const row of statement.iterate()){
    if(digests.length>=1000000)refuse();
    const typed=row.map(value=>value===null?['null']:value instanceof Uint8Array?
      ['blob',Buffer.from(value).toString('hex')]:[typeof value,String(value)]);
    digests.push(hash(JSON.stringify(typed)));
  }
  return {count:digests.length,digest:hash(JSON.stringify(digests.sort()))};
}

/**
 * Inputs must be separately authorized offline copies, never live DB files or
 * untrusted SQL. This proves equality of reviewed application tables only.
 * It cannot attest source provenance, Cloudflare restore, identity/grants,
 * encryption, audit semantics, physical-device behavior or release approval.
 */
export function verifyD1Restore(sourcePath,restoredPath,{mode='exact'}={}){
  let source,restored;
  try{
    if(!['exact','additive-empty-journal'].includes(mode))refuse();
    const left=file(sourcePath),right=file(restoredPath);
    if(left.path===right.path||(left.stat.dev===right.stat.dev&&left.stat.ino===right.stat.ino))refuse();
    source=open(left.path);restored=open(right.path);
    const before=structure(source),after=structure(restored);
    const includesJournal=before===reviewed[1];
    if(!reviewed.includes(before))refuse();
    if(mode==='exact' ? before!==after : before!==reviewed[0]||after!==reviewed[1])refuse();
    integrity(source);integrity(restored);
    const counts={};
    for(const table of [...tables,...(includesJournal?[journalTable]:[])]){
      const a=rows(source,table),b=rows(restored,table);
      if(a.count!==b.count||a.digest!==b.digest)refuse();
      counts[table]=a.count;
    }
    if(mode==='additive-empty-journal'&&rows(restored,journalTable).count!==0)refuse();
    // Detect external file mutation during this check. Both handles stay in
    // read transactions; no migration or SQLite write is executed by this tool.
    if(file(left.path).digest!==left.digest||file(right.path).digest!==right.digest)refuse();
    return Object.freeze({status:'OFFLINE_APPLICATION_COPY_MATCH',mode,rowCounts:counts,
      emptyAdditiveJournalVerified:mode==='additive-empty-journal',
      providerMetadataCompared:false,cloudflareRestoreVerified:false,productionCutoverAuthorized:false});
  }catch{refuse();}
  finally{for(const db of [source,restored]){try{db?.close();}catch{ /* Never disclose a native SQLite error. */ }}}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const [source,target,mode='exact',...extra]=process.argv.slice(2);
    if(!source||!target||extra.length)refuse();
    console.log(JSON.stringify(verifyD1Restore(source,target,{mode})));
  }catch{console.error('d1_restore_comparison_refused');process.exitCode=1;}
}
