/** Read-only, bounded Notion project portfolio projection. Notion remains authoritative. */
const bad=(code,status=502)=>{const e=new Error(code);e.publicCode=code;e.status=status;throw e;};
const sourceId=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)?s:null;
const textValue=(property,max=500)=>{
 if(!property||!['title','rich_text'].includes(property.type))return '';
 const list=property[property.type];return Array.isArray(list)?list.map(x=>x.plain_text||x.text?.content||'').join('').slice(0,max):'';
};
const optionValue=(property)=>property?.[property?.type]?.name??'';
const safeURL=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.href.length<2048?u.href:null}catch{return null}};
const areaValues=new Set(['Family & Home','Shinewell','Devon Works','Writing','ANEVUM','Incubator']);
const statusValues=new Set(['Captured','Parked','Ready','Active','Blocked','Completed']);
const priorityValues=new Set(['P1','P2','P3']);
export function projectProjection(row){
 const props=row?.properties??{},name=textValue(props.Project,180);
 if(row?.object!=='page'||!row.id||!name)return null;
 const area=optionValue(props.Area),status=optionValue(props.State),priority=optionValue(props.Priority);
 const id=textValue(props['Project ID'],80)||row.id;
 if(!/^[a-zA-Z0-9-]{6,80}$/.test(id))return null;
 return {id,name,area:areaValues.has(area)?area:'Incubator',status:statusValues.has(status)?status:'Captured',priority:priorityValues.has(priority)?priority:'P3',owner:textValue(props['Owner/Entity'],160)||'Unassigned',next:textValue(props['Next action'],500)||'Review this project in Notion',gate:textValue(props['Start gate'],350)||'Confirm authority in source system',source:safeURL(props['Source of truth']?.url)||safeURL(row.url),record:safeURL(row.url),repo:safeURL(props.Repository?.url)||'',stage:'Source metadata',dependencies:'Notion retains authority',hosting:'Not imported',evidence:'Read-only Notion metadata cache'};
}
export async function getCachedPortfolio(db,subject,configured=false){
 const row=await db.prepare('SELECT source_id,fetch_time,payload FROM station_portfolio_cache WHERE owner_sub=?').bind(subject).first();
 return {configured,source:'Notion project portfolio',mode:'read_only_cache',cachedAt:row?.fetch_time??null,projects:row?JSON.parse(row.payload):[],notionWrites:false};
}
export async function refreshPortfolio(db,subject,env,transport=fetch){
 const id=sourceId(env.NOTION_PORTFOLIO_SOURCE_ID),token=env.NOTION_READ_TOKEN;
 if(!id||typeof token!=='string'||token.length<10)bad('notion_sync_unconfigured',503);
 const projects=[],seen=new Set();let cursor,cycles=0;
 do {
  if(cycles++>=3)bad('notion_result_limit');
  const body=JSON.stringify({...{page_size:50},...(cursor?{start_cursor:cursor}:{})});
  // Workers supports manual, not error. Refuse 3xx below without forwarding the token.
  const response=await transport(`https://api.notion.com/v1/data_sources/${id}/query`,{method:'POST',headers:{'Authorization':`Bearer ${token}`,'Notion-Version':'2025-09-03','Content-Type':'application/json'},body,redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(!response.ok)bad('notion_provider_error');
  const data=await response.json();
  if(!Array.isArray(data.results)||data.results.length>50)bad('notion_invalid_response');
  for(const row of data.results){const value=projectProjection(row);if(value&&!seen.has(value.id)){seen.add(value.id);projects.push(value)}}
  cursor=data.has_more?data.next_cursor:null;
  if(data.has_more&&(!cursor||typeof cursor!=='string'||cursor.length>500))bad('notion_invalid_cursor');
 }while(cursor);
 const payload=JSON.stringify(projects);
 if(payload.length>128000)bad('notion_result_limit');
 const now=Date.now();
 await db.prepare('INSERT INTO station_portfolio_cache(owner_sub,source_id,fetch_time,payload) VALUES(?,?,?,?) ON CONFLICT(owner_sub) DO UPDATE SET source_id=excluded.source_id,fetch_time=excluded.fetch_time,payload=excluded.payload').bind(subject,id,now,payload).run();
 return {configured:true,source:'Notion project portfolio',mode:'read_only_cache',cachedAt:now,projects,notionWrites:false};
}
