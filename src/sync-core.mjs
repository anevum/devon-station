/**
 * Devon Station: deterministic, non-destructive three-way reconciliation.
 *
 * The authenticated D1 state remains the canonical private copy. A client remembers
 * the most recently acknowledged snapshot so edits made on different devices can
 * be reconciled without erasing either side's changes. Conflicting edits are
 * intentionally not guessed at and require explicit owner review.
 */
const SYNC_LIMITS={drafts:200,feedback:100};
const SYNC_PREF_KEYS=['theme','accent','density','motion','contrast'];
const SYNC_DEFAULTS={theme:'obsidian',accent:'cyan',density:'compact',motion:'system',contrast:'normal'};
export function syncEqual(a,b){return JSON.stringify(a)===JSON.stringify(b);}
export function syncEmptyState(){return {version:1,prefs:{...SYNC_DEFAULTS},drafts:[],feedback:[],outcomes:[],history:[]};}

function mergeById(base,device,remote,kind,conflicts){
 const b=new Map(base.map(x=>[x.id,x]));
 const d=new Map(device.map(x=>[x.id,x]));
 const r=new Map(remote.map(x=>[x.id,x]));
 const ids=new Set([...r.keys(),...d.keys(),...b.keys()]);
 const selected=new Map();
 for(const id of ids){
  const old=b.get(id),local=d.get(id),server=r.get(id);
  let chosen;
  if(syncEqual(local,server))chosen=server;
  else if(syncEqual(local,old))chosen=server;
  else if(syncEqual(server,old))chosen=local;
  else{conflicts.push(`${kind}:${id}`);continue;}
  if(chosen!==undefined)selected.set(id,chosen);
 }
 if(selected.size>SYNC_LIMITS[kind])conflicts.push(`${kind}:limit`);
 // Keep remote ordering for existing rows; place device-only rows after those.
 return [...r.keys(),...d.keys()].filter((id,i,all)=>selected.has(id)&&all.indexOf(id)===i).map(id=>selected.get(id));
}
function choose(old,local,server,field,conflicts){
 if(syncEqual(local,server))return server;
 if(syncEqual(local,old))return server;
 if(syncEqual(server,old))return local;
 conflicts.push(field);return server;
}
function joinHistory(local,remote){
 const unique=new Map();
 // This is a bounded activity preview, not the durable server write audit.
 for(const item of [...remote,...local]){
  if(item&&typeof item.action==='string'&&typeof item.at==='string')unique.set(item.action+'\0'+item.at,item);
 }
 return [...unique.values()].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,30);
}
/** Returns conflicts without including private contents in diagnostic labels. */
export function reconcileOwnerStates(baseline,device,remote){
 const b=baseline??syncEmptyState(),conflicts=[];
 for(const s of [b,device,remote]){
  if(!s||s.version!==1||!Array.isArray(s.drafts)||!Array.isArray(s.feedback)||
    !Array.isArray(s.history)||!Array.isArray(s.outcomes)||!s.prefs)throw Error('invalid_sync_state');
 }
 const prefs={};
 for(const key of SYNC_PREF_KEYS)prefs[key]=choose(b.prefs[key],device.prefs[key],remote.prefs[key],`prefs:${key}`,conflicts);
 const state={version:1,prefs,
  drafts:mergeById(b.drafts,device.drafts,remote.drafts,'drafts',conflicts),
  feedback:mergeById(b.feedback,device.feedback,remote.feedback,'feedback',conflicts),
  outcomes:choose(b.outcomes,device.outcomes,remote.outcomes,'outcomes',conflicts),
  history:joinHistory(device.history,remote.history)};
 return {safe:conflicts.length===0,conflicts,state:conflicts.length?null:state,provisional:conflicts.length?state:null};
}

/** A clean confirmed local snapshot can adopt newer cloud revisions without an import. */
export function shouldAdoptRemote(device,confirmed){
 return confirmed!==null&&confirmed?.state?.version===1&&syncEqual(device,confirmed.state);
}

/** Only trustworthy, bounded cached owner states are accepted as a merge base. */
export function readConfirmedSnapshot(raw){
 if(!raw||typeof raw!=='object'||raw.version!==1||!Number.isSafeInteger(raw.revision)||raw.revision<0||
  !raw.state||raw.state.version!==1||!Array.isArray(raw.state.drafts)||!Array.isArray(raw.state.feedback)||
  !Array.isArray(raw.state.history)||!Array.isArray(raw.state.outcomes)||!raw.state.prefs||
  JSON.stringify(raw).length>200000)return null;
 return raw;
}

/** Never use another tab's shared confirmation as this tab's merge baseline. */
export function trustedLegacyTabBaseline(device,sharedRecord){
 const record=readConfirmedSnapshot(sharedRecord);
 return record&&syncEqual(device,record.state)?record:null;
}

/**
 * Apply deliberate owner choices to *only* the unresolved branches of a three-way
 * merge. This does not write to the server. Caller MUST re-check the cloud
 * revision and unchanged device snapshot before posting the result.
 *
 * Decisions are a map from opaque conflict labels to 'device' or 'cloud'.
 * The strings never carry note contents; limit failures are never overrideable.
 */
export function resolveOwnerConflicts(baseline,device,remote,decisions){
 const review=reconcileOwnerStates(baseline,device,remote);
 if(review.safe){if(decisions&&Object.keys(decisions).length)throw Error('unexpected_conflict_decision');return review.state;}
 if(!decisions||typeof decisions!=='object'||Array.isArray(decisions))throw Error('missing_conflict_decisions');
 const required=new Set(review.conflicts);
 if([...required].some(x=>x.endsWith(':limit')))throw Error('sync_capacity_exceeded');
 const choices=Object.keys(decisions);
 if(choices.length!==required.size||choices.some(k=>!required.has(k)||!['device','cloud'].includes(decisions[k])))throw Error('incomplete_conflict_decisions');
 const result=structuredClone(review.provisional);
 for(const key of required){
  const source=decisions[key]==='device'?device:remote;
  if(key.startsWith('prefs:')){
   const pref=key.slice('prefs:'.length);
   if(!SYNC_PREF_KEYS.includes(pref))throw Error('unknown_conflict');
   result.prefs[pref]=source.prefs[pref];
  }else if(key==='outcomes')result.outcomes=structuredClone(source.outcomes);
  else if(key.startsWith('drafts:')||key.startsWith('feedback:')){
   const kind=key.startsWith('drafts:')?'drafts':'feedback';
   const id=key.slice(kind.length+1),chosen=source[kind].find(x=>x.id===id);
   result[kind]=result[kind].filter(x=>x.id!==id);
   if(chosen)result[kind].push(structuredClone(chosen));
  }else throw Error('unknown_conflict');
 }
 for(const kind of ['drafts','feedback']){
  const order=[...remote[kind],...device[kind]].map(x=>x.id);
  const positions=new Map(order.map((id,i)=>[id,order.indexOf(id)]));
  result[kind].sort((a,b)=>(positions.get(a.id)??999999)-(positions.get(b.id)??999999));
  if(result[kind].length>SYNC_LIMITS[kind])throw Error('sync_capacity_exceeded');
 }
 return result;
}
