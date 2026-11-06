/** Offline mail-copy verification only. No restore, migration, provider call or send. */
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,readFileSync,existsSync,constants} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMailPayloadCipher} from '../src/communications/mail-payload-crypto.mjs';
import {createD1MailStore} from '../src/communications/mail-d1-store.mjs';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
import {createD1Outbox} from '../src/communications/mail-outbox.mjs';
const fail=()=>{throw Error('offline_mail_recovery_refused');};
const tables=['comms_ro_mailboxes','comms_ro_messages','comms_mail_drafts','comms_outbox'];
const archive='comms_sent_archive';
const hash=x=>createHash('sha256').update(x).digest('hex');
const ddl=sql=>JSON.stringify(sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\[(?:[^\]])*\]|`(?:``|[^`])*`|[a-z_][a-z_0-9$]*|\d+|[^\s]/gi)
 ?.map(token=>/^[a-z_]/i.test(token)?token.toLowerCase():token));
function schema(db){
 return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name IN (?,?,?,?,?) ORDER BY type,name")
  .all(...tables,archive).map(x=>[x.type,x.name,x.tbl_name,ddl(x.sql)]));
}
function expectedSchema(includeArchive){
 const db=new DatabaseSync(':memory:');
 try{
  for(const file of ['0004-comms-ro-mail.sql','0005-comms-drafts.sql','0006-comms-outbox.sql',
   '0007-comms-draft-outbox-lineage.sql','0008-comms-one-delivery-per-draft.sql',
   ...(includeArchive?['0009-comms-sent-archive.sql']:[])])
   db.exec(readFileSync(new URL('../worker/migrations/'+file,import.meta.url),'utf8'));
  return schema(db);
 }finally{db.close();}
}
const approvedSchemas=[expectedSchema(false),expectedSchema(true)];
function snapshot(path){
 const absolute=resolve(path);let fd;
 try{
  fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
  const stat=fstatSync(fd);
  if(!stat.isFile()||stat.size<512||stat.size>64*1024*1024||
   ['-wal','-shm','-journal'].some(s=>existsSync(absolute+s)))fail();
  const bytes=readFileSync(fd);
  if(bytes.length!==stat.size||bytes.subarray(0,16).toString('binary')!=='SQLite format 3\0'||bytes[18]!==1||bytes[19]!==1)fail();
  return {path:absolute,dev:stat.dev,ino:stat.ino,digest:hash(bytes)};
 }finally{if(fd!==undefined)closeSync(fd);}
}
function open(path){
 const db=new DatabaseSync(path,{readOnly:true,enableDoubleQuotedStringLiterals:false});
 try{db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');return db;}
 catch(error){db.close();throw error;}
}
function rowProof(db,table){
 // Only the fixed reviewed table names below reach this query.
 const statement=db.prepare('SELECT * FROM "'+table+'"');
 statement.setReadBigInts(true);statement.setReturnArrays(true);
 const rows=[];
 for(const row of statement.iterate()){
  if(rows.length>=100000)fail();
  rows.push(hash(JSON.stringify(row.map(x=>x===null?['null']:x instanceof Uint8Array?
   ['blob',Buffer.from(x).toString('hex')]:[typeof x,String(x)]))));
 }
 return {count:rows.length,digest:hash(JSON.stringify(rows.sort()))};
}
function binding(db){
 const prepare=sql=>{
  if(!/^SELECT\b/i.test(sql.trim()))fail();
  const bind=(...args)=>({async first(){return db.prepare(sql).get(...args)??null;},
   async all(){return {success:true,results:db.prepare(sql).all(...args)};}});
  return {...bind(),bind};
 };
 return {prepare,batch(){fail();}};
}
/** Compare two quiescent, separately authorized SQLite copies, then use actual
 * application readers to decrypt every retained mail payload in the restored copy.
 * Only counts/booleans leave this function. Source equality is not provenance,
 * key custody, external backup availability, HTTP auth or production acceptance.
 */
export async function verifyMailRecovery(sourcePath,restoredPath,{cipher,ownerSub}={}){
 let source,restored;
 try{
  if(!cipher?.open||typeof ownerSub!=='string'||!ownerSub||ownerSub.length>256||/[\x00-\x1f\x7f]/.test(ownerSub))fail();
  const left=snapshot(sourcePath),right=snapshot(restoredPath);
  if(left.path===right.path||(left.dev===right.dev&&left.ino===right.ino))fail();
  source=open(left.path);restored=open(right.path);
  for(const db of [source,restored]){
   const check=db.prepare('PRAGMA integrity_check').all();
   if(check.length!==1||check[0].integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)fail();
  }
  const structure=schema(source),schemaIndex=approvedSchemas.indexOf(structure);
  if(schemaIndex<0||schema(restored)!==structure)fail();
  const selected=[...tables,...(schemaIndex===1?[archive]:[])],counts={};
  for(const table of selected){
   const a=rowProof(source,table),b=rowProof(restored,table);
   if(a.count!==b.count||a.digest!==b.digest)fail();counts[table]=a.count;
  }
  const db=binding(restored),inbox=createD1MailStore(db,{cipher,ownerSub}),drafts=createD1DraftStore(db,{cipher});
  const scope=row=>({installationId:row.installation_id,mailboxId:row.mailbox_id,ownerSub:row.owner_sub});
  for(const row of restored.prepare('SELECT installation_id,mailbox_id FROM comms_ro_mailboxes').iterate())
   await inbox.readSnapshot(scope(row));
  for(const row of restored.prepare('SELECT installation_id,mailbox_id,owner_sub,draft_id FROM comms_mail_drafts').iterate())
   if(!await drafts.read(scope(row),row.draft_id))fail();
  let unavailableTerminalPayloads=0;
  for(const row of restored.prepare('SELECT installation_id,mailbox_id,owner_sub,delivery_id FROM comms_outbox').iterate()){
   const outbox=createD1Outbox(db,scope(row),{cipher}),record=await outbox.read(row.delivery_id);
   if(!record)fail();
   if(record.payload===null){
    if(record.state==='accepted'){
     if(schemaIndex!==1||!await outbox.readArchived(row.delivery_id))fail();
    }else unavailableTerminalPayloads++;
   }
  }
  if(schemaIndex===1)for(const row of restored.prepare('SELECT installation_id,mailbox_id,owner_sub,delivery_id FROM comms_sent_archive').iterate())
   if(!await createD1Outbox(db,scope(row),{cipher}).readArchived(row.delivery_id))fail();
  // Verify both path identity and bytes again; callers must keep copies quiescent.
  for(const prior of [left,right]){
   const now=snapshot(prior.path);
   if(now.dev!==prior.dev||now.ino!==prior.ino||now.digest!==prior.digest)fail();
  }
  return Object.freeze({status:'OFFLINE_MAIL_COPY_AND_DECRYPTION_VERIFIED',rowCounts:counts,
   archivePresent:schemaIndex===1,unavailableTerminalPayloads,
   providerMetadataCompared:false,networkUsed:false,realKeyCustodyVerified:false,releaseAuthorized:false});
 }catch{fail();}finally{for(const db of [source,restored])try{db?.close();}catch{}}
}
// The private key file is separate owner-held recovery material. Never put its
// values in command arguments, environment variables, Git, logs or output.
export function readRecoveryKeys(path){
 let fd,bytes;
 try{
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);
  if(!stat.isFile()||stat.size<1||stat.size>4096||(stat.mode&0o077)!==0||
   (typeof process.getuid==='function'&&stat.uid!==process.getuid()))fail();
  bytes=readFileSync(fd);if(bytes.length!==stat.size)fail();
  const config=JSON.parse(bytes.toString('utf8'));
  return {cipher:createMailPayloadCipher(config),ownerSub:config.ownerSub};
 }catch{fail();}finally{bytes?.fill(0);if(fd!==undefined)closeSync(fd);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const [source,target,keyFile,...extra]=process.argv.slice(2);
  if(!source||!target||!keyFile||extra.length)fail();
  console.log(JSON.stringify(await verifyMailRecovery(source,target,readRecoveryKeys(keyFile))));
 }catch{console.error('offline_mail_recovery_refused');process.exitCode=1;}
}
