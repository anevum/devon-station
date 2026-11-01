/** Versioned governance receipts around the existing foundation snapshot. */
import {createHash,randomUUID} from 'node:crypto';
import {createFoundation,restoreFoundation,verifyImport} from '../foundation/src/foundation.mjs';
export const journalDigest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const projectAuthority=projects=>projects.map(({freshness,source:{observedAt,...source},...rest})=>({...rest,source})).sort((a,b)=>a.projectId.localeCompare(b.projectId));
export const sameAuthority=(a,b)=>journalDigest(projectAuthority(a))===journalDigest(projectAuthority(b));
const identifier=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const fail=()=>{throw Error('invalid_workspace_journal');};
const MAX=5*1024*1024;
export function openJournal(identity,serialized,projects){
 if(serialized==null)return {store:createFoundation({identity,projects}),events:[]};
 if(typeof serialized!=='string'||Buffer.byteLength(serialized)>MAX)fail();
 const value=JSON.parse(serialized);
 // Backwards-compatible read of the previous runtime's raw foundation export.
 if(value.format==='devonstation-synthetic')return {store:restoreFoundation({identity,serialized}),events:[]};
 if(!exact(value,['format','version','foundation','events'])||value.format!=='devonstation-scoped-journal'||value.version!==1||!Array.isArray(value.events)||value.events.length>256)fail();
 let previous=null,lastTime='',ids=new Set(),operations=new Set();
 for(const event of value.events){
  if(!exact(event,['eventId','operationId','kind','createdAt','requestDigest','priorJournalDigest','foundationDigest','previousEventDigest','eventDigest'])||!identifier(event.operationId)||!['restore','reconcile'].includes(event.kind)||!identifier(event.eventId)||ids.has(event.eventId)||operations.has(event.operationId)||!hash(event.requestDigest)||!hash(event.priorJournalDigest)||!hash(event.foundationDigest)||event.previousEventDigest!==previous||!hash(event.eventDigest)||typeof event.createdAt!=='string'||!Number.isFinite(Date.parse(event.createdAt))||new Date(event.createdAt).toISOString()!==event.createdAt||event.createdAt<lastTime)fail();
  const {eventDigest,...content}=event;if(journalDigest(content)!==eventDigest)fail();
  previous=eventDigest;lastTime=event.createdAt;ids.add(event.eventId);operations.add(event.operationId);
 }
 const store=restoreFoundation({identity,serialized:value.foundation});
 const actions=verifyImport(value.foundation,{scopeKind:identity.scopeKind,scopeId:identity.scopeId});
 if(actions.operations.some(op=>operations.has(op.operationId)))fail();
 return {store,events:structuredClone(value.events)};
}
export function serializeJournal(identity,journal){
 const serialized=JSON.stringify({format:'devonstation-scoped-journal',version:1,foundation:journal.store.export(identity),events:journal.events});
 if(Buffer.byteLength(serialized)>MAX)fail();return serialized;
}
export function appendJournalEvent(identity,journal,{operationId,kind,requestDigest,priorJournalDigest}){
 if(!identifier(operationId)||journal.events.length>=256)fail();
 const data=verifyImport(journal.store.export(identity),{scopeKind:identity.scopeKind,scopeId:identity.scopeId});
 if(journal.events.some(e=>e.operationId===operationId)||data.operations.some(e=>e.operationId===operationId))fail();
 const now=new Date().toISOString();if((journal.events.at(-1)?.createdAt??'')>now)fail();
 const content={eventId:randomUUID(),operationId,kind,createdAt:now,requestDigest,priorJournalDigest,foundationDigest:journalDigest(journal.store.export(identity)),previousEventDigest:journal.events.at(-1)?.eventDigest??null};
 const event={...content,eventDigest:journalDigest(content)};journal.events.push(event);return event;
}
/** Replace only approved metadata. Every existing action and receipt must survive. */
export function reprojectJournal(identity,journal,projects){
 const envelope=JSON.parse(journal.store.export(identity));
 const validated=createFoundation({identity,projects}).projects(identity);
 if(envelope.data.actions.some(a=>!validated.some(p=>p.projectId===a.projectId)))throw Error('workspace_history_requires_retained_project');
 envelope.data.projects=validated;envelope.checksum=journalDigest(envelope.data);
 return {store:restoreFoundation({identity,serialized:JSON.stringify(envelope)}),events:structuredClone(journal.events)};
}
