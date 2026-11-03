/** Private, read-only finance source projection. Never fetches payment/order endpoints. */
const MERCURY_URL='https://api.mercury.com/api/v1/accounts?limit=1000&order=asc';
const ALPACA_PAPER='https://paper-api.alpaca.markets';
const MAX_BYTES=1250000;
const MERCURY_PAGE_LIMIT=100;
const MERCURY_MAX_PAGES=10;
const MERCURY_MAX_ACCOUNTS=1000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const knownStatus=new Set(['active','pending','deleted','archived']);
const problem=(code,status=502)=>{const error=new Error(code);error.publicCode=code;error.status=status;throw error;};
const safeLabel=(value,max=100)=>{
 if(typeof value!=='string'||value.length>max||!value.trim()||/[\x00-\x1f\x7f]/.test(value))problem('finance_invalid_provider_payload');
 return value.trim();
};
const sourceStatus=(status)=>({status,readOnly:true});

/** Cents encoded as strings: never round floats or lose financial precision. */
export function cents(value){
 if(typeof value!=='number'&&typeof value!=='string')problem('finance_invalid_amount');
 const text=String(value);
 if(!/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,2})?$/.test(text))problem('finance_invalid_amount');
 const negative=text.startsWith('-');
 const [whole,part='']=text.replace('-','').split('.');
 const amount=BigInt(whole)*100n+BigInt(part.padEnd(2,'0')||'0');
 return (negative?-amount:amount).toString();
}

async function boundedJSON(response,expectArray=false){
 if(!response||typeof response.status!=='number'||response.status<200||response.status>=300)problem('finance_provider_unavailable');
 if(response.redirected||response.type==='opaqueredirect')problem('finance_provider_unavailable');
 const reader=response.body?.getReader();
 if(!reader)problem('finance_invalid_provider_payload');
 let bytes=0;const chunks=[];
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   bytes+=value.byteLength;
   if(bytes>MAX_BYTES){await reader.cancel();problem('finance_provider_oversized');}
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 const combined=new Uint8Array(bytes);let offset=0;
 for(const chunk of chunks){combined.set(chunk,offset);offset+=chunk.byteLength;}
 try{
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(combined));
  if(!data||typeof data!=='object'||Array.isArray(data)!==expectArray)problem('finance_invalid_provider_payload');
  return data;
 }catch{problem('finance_invalid_provider_payload');}
}

async function providerGET(url,headers,transport,expectArray=false){
 const response=await transport(url,{
  method:'GET',headers:{Accept:'application/json',...headers},
  redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(8000),
 });
 return boundedJSON(response,expectArray);
}

function readMercuryPage(data){
 if(!data||!Array.isArray(data.accounts)||data.accounts.length>MERCURY_PAGE_LIMIT||
    !data.page||typeof data.page!=='object'||Array.isArray(data.page))
  problem('finance_incomplete_accounts');
 const nextPage=data.page.nextPage??null;
 if(nextPage!==null&&(!UUID.test(nextPage)||data.accounts.length===0))
  problem('finance_incomplete_accounts');
 const seen=new Set(),accounts=[];
 for(const raw of data.accounts){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!UUID.test(raw.id)||seen.has(raw.id))
   problem('finance_invalid_provider_payload');
  seen.add(raw.id);
  const type=safeLabel(raw.type,30).toLowerCase();
  if(!['mercury','external','recipient'].includes(type))problem('finance_invalid_provider_payload');
  if(type!=='mercury')continue;
  const status=safeLabel(raw.status,30).toLowerCase();
  if(!knownStatus.has(status))problem('finance_invalid_provider_payload');
  accounts.push({
   label:safeLabel(raw.name,100),kind:safeLabel(raw.kind,40),status,
   availableCents:cents(raw.availableBalance),currentCents:cents(raw.currentBalance),
  });
 }
 return {accounts,nextPage,rawIds:[...seen]};
}

/** Single-page projection refuses to represent a partial provider result as complete. */
export function mercuryProjection(data){
 const page=readMercuryPage(data);
 if(page.nextPage!==null)problem('finance_incomplete_accounts');
 return {status:'available',readOnly:true,accounts:page.accounts};
}

/** Follow documented cursor pagination and fail closed on any missing page. */
async function fetchAllMercuryAccounts(token,transport){
 const accounts=[],seenIds=new Set(),seenCursors=new Set();
 let cursor=null;
 for(let i=0;i<MERCURY_MAX_PAGES;i++){
  const url=MERCURY_URL.replace('limit=1000','limit='+MERCURY_PAGE_LIMIT)+
    (cursor?'&start_after='+encodeURIComponent(cursor):'');
  const raw=await providerGET(url,{Authorization:'Bearer '+token},transport);
  const page=readMercuryPage(raw);
  for(const id of page.rawIds){
   if(seenIds.has(id))problem('finance_incomplete_accounts');
   seenIds.add(id);
  }
  accounts.push(...page.accounts);
  if(seenIds.size>MERCURY_MAX_ACCOUNTS)problem('finance_incomplete_accounts');
  if(page.nextPage===null)return {status:'available',readOnly:true,accounts};
  if(seenCursors.has(page.nextPage))problem('finance_incomplete_accounts');
  seenCursors.add(page.nextPage);
  cursor=page.nextPage;
 }
 problem('finance_incomplete_accounts');
}
export function alpacaPaperProjection(account,positions){
 if(!account||typeof account!=='object'||Array.isArray(account)||!Array.isArray(positions)||positions.length>500)
  problem('finance_invalid_provider_payload');
 if(!['ACTIVE','INACTIVE','SUBMITTED','ACTION_REQUIRED','APPROVAL_PENDING','REJECTED','CLOSED'].includes(String(account.status||'').toUpperCase()))
  problem('finance_invalid_provider_payload');
 for(const position of positions){
  if(!position||typeof position!=='object'||Array.isArray(position)||typeof position.symbol!=='string'||
     !/^[A-Z0-9.\/-]{1,25}$/.test(position.symbol))problem('finance_invalid_provider_payload');
 }
 return {
  status:'available',readOnly:true,mode:'paper',
  accountStatus:String(account.status).toLowerCase(),
  equityCents:cents(account.equity),cashCents:cents(account.cash),buyingPowerCents:cents(account.buying_power),
  positionsCount:positions.length,
  tpd:{status:'unavailable_pending_reconciliation',valuePct:null},
 };
}

/** No credentials or source account identifiers are copied to this response. */
export async function financialSummary(env,user,transport=fetch){
 if(!user||typeof user.subject!=='string'||!env.FINANCE_OWNER_SUBJECT||
    user.subject!==env.FINANCE_OWNER_SUBJECT)problem('finance_owner_not_authorized',403);
 if(env.FINANCE_READ_MODE!=='read_only')problem('finance_not_configured',503);
 const mercuryToken=env.MERCURY_FINANCE_READ_TOKEN;
 const alpacaKey=env.ALPACA_FINANCE_PAPER_KEY,alpacaSecret=env.ALPACA_FINANCE_PAPER_SECRET;
 const mercury=typeof mercuryToken==='string'&&mercuryToken.trim()
  ?fetchAllMercuryAccounts(mercuryToken,transport).catch(()=>sourceStatus('unavailable'))
  :Promise.resolve(sourceStatus('not_configured'));
 const alpaca=env.ALPACA_FINANCE_MODE==='live'
  ?Promise.resolve(sourceStatus('live_access_not_authorized'))
  :env.ALPACA_FINANCE_MODE==='paper'&&typeof alpacaKey==='string'&&alpacaKey.trim()&&typeof alpacaSecret==='string'&&alpacaSecret.trim()
   ?Promise.all([
    providerGET(ALPACA_PAPER+'/v2/account',{'APCA-API-KEY-ID':alpacaKey,'APCA-API-SECRET-KEY':alpacaSecret},transport),
    providerGET(ALPACA_PAPER+'/v2/positions',{'APCA-API-KEY-ID':alpacaKey,'APCA-API-SECRET-KEY':alpacaSecret},transport,true),
   ]).then(([account,positions])=>alpacaPaperProjection(account,positions))
     .catch(()=>sourceStatus('unavailable'))
   :Promise.resolve(sourceStatus('not_configured'));
 const [mercuryData,alpacaData]=await Promise.all([mercury,alpaca]);
 return {
  schema:'devonstation-financial-readonly-v1',mode:'read_only',
  fetchedAt:new Date().toISOString(),
  sources:{mercury:mercuryData,alpaca:alpacaData},
  capabilities:{moneyMovement:false,orderSubmission:false,liveTrading:false,unverifiedTPD:false},
  combinedNetWorthCents:null,
 };
}
