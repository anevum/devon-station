// Test-only Worker: fabricated source, token and ephemeral local D1 only.
import {refreshPortfolio,getCachedPortfolio} from '../worker/portfolio.mjs';
export default {async fetch(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/init'){
  await env.DB.prepare('CREATE TABLE station_portfolio_cache(owner_sub TEXT PRIMARY KEY, source_id TEXT NOT NULL, fetch_time INTEGER NOT NULL, payload TEXT NOT NULL)').run();
  return new Response('initialized');
 }
 try{
  const result=path==='/refresh'?await refreshPortfolio(env.DB,'synthetic-owner',env):await getCachedPortfolio(env.DB,'synthetic-owner',true);
  return Response.json(result);
 }catch(error){return Response.json({error:error.publicCode??'request_failed'},{status:error.status??500})}
}};
