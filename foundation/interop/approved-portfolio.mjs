/**
 * DS011-RB01: read-only, explicitly granted boundary between the recovered
 * Worker's Notion portfolio cache and the new project workspace contract.
 *
 * Server-side adapter only. Never accept identity, grants, or portfolio cache
 * input directly from browser requests. This does NOT verify Access tokens or
 * write back to Notion. Real-data deployment requires separate privacy review.
 */
import {createFoundation} from '../src/foundation.mjs';

const fail=()=>{throw new Error('portfolio_scope_denied_or_invalid');};
const validId=value=>typeof value==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
const areas=new Set(['Family & Home','Shinewell','Devon Works','Writing','ANEVUM','Incubator']);
const types=new Set(['personal','business','creative']);

/**
 * Explicitly approved project grants are scoped to one verified principal.
 * A grant's area must match the source record; project area never confers
 * permission on its own. Unknown or changed metadata fails closed.
 */
export function approvedProjectsForIdentity({identity,portfolio,projectGrants}) {
  if(!exact(identity,['principalId','role','scopeKind','scopeId']) ||
     !validId(identity.principalId)||!validId(identity.scopeId)||
     identity.role!=='owner'||!types.has(identity.scopeKind)||
     !Array.isArray(projectGrants)||projectGrants.length>100)fail();
  if(!portfolio||typeof portfolio!=='object'||Array.isArray(portfolio)||
     portfolio.source!=='Notion project portfolio'||
     portfolio.mode!=='read_only_cache'||portfolio.notionWrites!==false||
     !Array.isArray(portfolio.projects)||portfolio.projects.length>150)fail();
  const rows=new Map();
  for(const row of portfolio.projects){
    if(!row||typeof row!=='object'||Array.isArray(row)||!validId(row.id)||rows.has(row.id))fail();
    rows.set(row.id,row);
  }
  const empty=portfolio.cachedAt===null && portfolio.projects.length===0;
  if(!empty && (!Number.isSafeInteger(portfolio.cachedAt)||portfolio.cachedAt<0 || portfolio.cachedAt>8640000000000000))fail();
  const observedAt=empty?null:new Date(portfolio.cachedAt).toISOString();
  const approved=new Set(),projections=[];
  for(const grant of projectGrants){
    if(!exact(grant,['principalId','scopeKind','scopeId','projectId','area'])||
       grant.principalId!==identity.principalId||
       grant.scopeKind!==identity.scopeKind||
       grant.scopeId!==identity.scopeId||
       !validId(grant.projectId)||!areas.has(grant.area)||
       approved.has(grant.projectId))fail();
    approved.add(grant.projectId);
    if(empty)continue;
    const row=rows.get(grant.projectId);
    if(!row)continue; // Source deletion does not create a stale synthetic project.
    if(row.area!==grant.area || typeof row.name!=='string' ||
       typeof row.record!=='string')fail();
    // Do not copy owner, next action, gate, status, source token, client data,
    // repo metadata, or other fields from the wider owner portfolio cache.
    let u;
    try{u=new URL(row.record);}catch{fail();}
    if(u.protocol!=='https:'||!['notion.so','www.notion.so','app.notion.com'].includes(u.hostname)||
       u.username||u.password||u.port||u.search||u.hash||u.href!==row.record)fail();
    projections.push({
      projectId:grant.projectId,scopeKind:identity.scopeKind,scopeId:identity.scopeId,
      title:row.name,freshness:'cached',
      source:{sourceSystem:'notion',sourceType:'project',sourceId:row.id,
        sourceUrl:row.record,observedAt}
    });
  }
  // Reuse the exact foundation validation contract; invalid titles, unsafe
  // source URLs or scope conflicts must never reach the UI or action model.
  const checked=createFoundation({identity,projects:projections});
  return Object.freeze({
    source:'Notion project portfolio',
    mode:'read_only_cache',notionWrites:false,
    cachedAt:empty?null:portfolio.cachedAt,
    status:empty?'not_cached':'cached',
    projects:checked.projects(identity)
  });
}
