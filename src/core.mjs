export const AREAS=['Family & Home','Shinewell','Devon Works','Writing','ANEVUM','Incubator'];
export const SECTIONS=['command','workspace','inbox','portfolio','works','infrastructure','writing','anevum','reviews','settings'];
export const PIPELINE=['Capture','Classify','Scope','Prioritize','Design','Build','Test','Review','Release','Maintain','Archive'];
export const DEFAULTS={theme:'obsidian',accent:'cyan',density:'compact',motion:'system',contrast:'normal'};
export function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function safeURL(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
export function settings(raw){const r={...DEFAULTS};for(const [key,opts] of Object.entries({theme:['obsidian','slate'],accent:['cyan','teal','violet'],density:['compact','comfortable'],motion:['system','reduced'],contrast:['normal','high']}))if(opts.includes(raw?.[key]))r[key]=raw[key];return r;}
export function filtered(items,{query='',area='All',status='All',type='All',priority='All'}={}){const q=query.trim().toLowerCase();return items.filter(x=>(area==='All'||x.area===area)&&(status==='All'||x.status===status)&&(type==='All'||x.type===type)&&(priority==='All'||x.priority===priority)&&(!q||[x.name,x.next,x.owner,x.source,...(x.dependencies instanceof Array?x.dependencies:[x.dependencies]),...(x.routes??[])].join(' ').toLowerCase().includes(q)));}
export function localDraftId(){return 'local:'+(typeof globalThis.crypto?.randomUUID==='function'?globalThis.crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));}
export function captureDraft(input,projects,now=new Date().toISOString(),id=localDraftId()){
 const title=String(input?.title??'').trim();if(title.length<2||title.length>500)throw Error('Write a title between 2 and 500 characters.');
 if(/\b(patient|diagnosis|medical record|social security number|ssn|password|bank account|credit card number)\b|(?:sk-|ghp_|github_pat_|xox[baprs]-)[a-zA-Z0-9_-]{10,}/i.test(title))throw Error('Keep clinical details, credentials and financial identifiers out of this console.');
 const area=AREAS.includes(input.area)?input.area:'Devon Works';const project=projects.find(p=>p.id===input.project&&p.area===area);
 return {id,title,area,project:project?.id??null,destination:project?.source??null,state:'Draft',createdAt:now};
}
export function addDraft(items,draft){const duplicate=items.find(x=>x.title.toLowerCase()===draft.title.toLowerCase()&&x.area===draft.area&&x.project===draft.project&&x.state!=='Archived');return {items:duplicate?items:[draft,...items].slice(0,200),duplicate:!!duplicate};}
export function updateDraft(items,id,input,projects){const original=items.find(x=>x.id===id);if(!original)throw Error('This local draft no longer exists.');const draft=captureDraft(input,projects,original.createdAt,id);const duplicate=addDraft(items.filter(x=>x.id!==id),draft).duplicate;if(duplicate)throw Error('Another local draft already contains that idea.');return items.map(x=>x.id===id?{...draft,updatedAt:new Date().toISOString()}:x);}
export const FEEDBACK_TYPES=['Design','Behavior','Feature','Bug'];
export function createFeedback(input,now=new Date().toISOString(),id=localDraftId()){const note=String(input?.note??'').trim();if(note.length<3||note.length>1200)throw Error('Write feedback between 3 and 1,200 characters.');if(/\b(?:patient|diagnosis|medical record|social security number|ssn|password|bank account|credit card number)\b|(?:sk-|ghp_|github_pat_|xox[baprs]-)[a-zA-Z0-9_-]{10,}/i.test(note))throw Error('Keep credentials out of feedback.');return {id,section:SECTIONS.includes(input.section)?input.section:'global',category:FEEDBACK_TYPES.includes(input.category)?input.category:'Design',note,state:'Open',createdAt:now};}
export function feedbackText(items){return items.map(x=>`[${x.category} · ${x.section} · ${x.state}] ${x.note}`).join('\n\n');}
// Focus marks are user-owned and must not be silently deleted merely because
// a read-only Notion project listing is empty, partial, or temporarily stale.
export function restoreLocal(raw,projects){if(raw?.version!==1)return {prefs:{...DEFAULTS},drafts:[],feedback:[],outcomes:[],history:[]};const drafts=[];for(const x of (Array.isArray(raw.drafts)?raw.drafts:[]).slice(0,200)){try{if(!/^local:[a-zA-Z0-9-]+$/.test(x.id)||!['Draft','Routed locally','Archived'].includes(x.state))continue;const d=captureDraft(x,projects,x.createdAt,x.id);d.state=x.state;if(typeof x.updatedAt==='string'&&Number.isFinite(Date.parse(x.updatedAt)))d.updatedAt=x.updatedAt;drafts.push(d);}catch{}}const feedback=[];for(const x of (Array.isArray(raw.feedback)?raw.feedback:[]).slice(0,100)){try{if(!/^local:[a-zA-Z0-9-]+$/.test(x.id)||!['Open','Archived'].includes(x.state))continue;const f=createFeedback(x,x.createdAt,x.id);f.state=x.state;feedback.push(f);}catch{}}
 return {prefs:settings(raw.prefs),drafts,feedback,outcomes:Array.isArray(raw.outcomes)?[...new Set(raw.outcomes.filter(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(x)))].slice(0,3):[],history:Array.isArray(raw.history)?raw.history.filter(x=>typeof x?.action==='string'&&typeof x?.at==='string').slice(0,30):[]};}
/** Tab-scoped pending changes are advisory until sanitized by restoreLocal. */
export function readTabRecoveryJournal(journal){
 if(!journal||typeof journal!=='object'||journal.version!==1||!journal.state||journal.state.version!==1)return null;
 if(!Array.isArray(journal.state.drafts)||!Array.isArray(journal.state.feedback)||
    !Array.isArray(journal.state.outcomes)||!Array.isArray(journal.state.history)||
    !journal.state.prefs||typeof journal.state.prefs!=='object')return null;
 try{if(JSON.stringify(journal).length>200000)return null}catch{return null}
 return journal.state;
}
export function validateProject(p){const missing=['id','name','owner','area','next','gate','source'].filter(k=>!p?.[k]);if(missing.length)throw Error('Missing project fields: '+missing.join(', '));if(!AREAS.includes(p.area))throw Error('Unknown project area');if(!safeURL(p.source))throw Error('Source must be an HTTPS URL without credentials');if(p.repo&&!/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(p.repo))throw Error('Repository must identify one GitHub repository');return true;}
