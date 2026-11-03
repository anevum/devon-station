/** Private, read-only finance source projection. Never fetches payment/order endpoints. */
const MERCURY_URL='https://api.mercury.com/api/v1/accounts?limit=1000&order=asc';
const ALPACA_PAPER='https://paper-api.alpaca.markets';
const MAX_BYTES=1250000;
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

export function mercuryProjection(data){
 if(!Array.isArray(data?.accounts)||data.accounts.length>=1000||
    data.hasMore===true||data.has_more===true||data.hasNext===true||data.nextCursor||data.next_cursor||
    data.next||data.next_page||(Number.isInteger(data.total)&&data.total>data.accounts.length))
    problem('finance_incomplete_accounts');
 const seen=new Set(),accounts=[];
 for(const raw of data.accounts){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.id!=='string'||!raw.id.trim()||seen.has(raw.id))
   problem('finance_invalid_provider_payload');
  seen.add(raw.id);
  const status=safeLabel(raw.status,30).toLowerCase();
  if(!knownStatus.has(status))problem('finance_invalid_provider_payload');
  accounts.push({
   label:safeLabel(raw.name,100),kind:safeLabel(raw.kind,40),status,
   availableCents:cents(raw.availableBalance),currentCents:cents(raw.currentBalance),
  });
 }
 // No account number, routing number, legal name, recipient information, or raw account ID leaves this projection.
 return {status:'available',readOnly:true,accounts};
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
  ?providerGET(MERCURY_URL,{Authorization:'Bearer '+mercuryToken},transport)
    .then(mercuryProjection).catch(()=>sourceStatus('unavailable'))
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
