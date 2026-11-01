// Test-only Worker. Uses generated JWTs and an ephemeral local D1 binding.
import {createStation} from '../worker/index.mjs';
import {verifyAccessJWT} from '../worker/access.mjs';
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(url.pathname==='/fixture/init'&&request.method==='POST'){
  for(const statement of env.FIXTURE_SCHEMA.split(';').map(x=>x.trim()).filter(Boolean))await env.DB.prepare(statement).run();
  await env.DB.prepare('INSERT INTO station_portfolio_cache(owner_sub,source_id,fetch_time,payload) VALUES(?,?,?,?)').bind('test-subject','synthetic',1793448000000,JSON.stringify([{id:'project-a',name:'Synthetic project',area:'Devon Works',record:'https://www.notion.so/synthetic'}])).run();
  return new Response('initialized');
 }
 if(url.pathname==='/fixture/rename'&&request.method==='POST'){await env.DB.prepare('UPDATE station_portfolio_cache SET payload=? WHERE owner_sub=?').bind(JSON.stringify([{id:'project-a',name:'Updated synthetic project',area:'Devon Works',record:'https://www.notion.so/synthetic'}]),'test-subject').run();return new Response('updated');}
 const auth=req=>verifyAccessJWT(req.headers.get('Cf-Access-Jwt-Assertion'),{issuer:'https://synthetic.cloudflareaccess.com',audience:'synthetic-audience',jwksUrl:'https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs'},async()=>({keys:[env.FIXTURE_JWK]}));
 return createStation({'/index.html':{type:'text/html',body:'Synthetic protected shell'}},auth,()=>{throw Error('External transport forbidden');}).fetch(request,env,ctx);
}};
