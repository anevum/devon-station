import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {createStation} from '../worker/index.mjs';import {projectProjection} from '../worker/portfolio.mjs';
const origin='https://station.example.test',source='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',owner={subject:'owner-uid',email:'owner@example.test'};
const env={APP_ORIGIN:origin,OWNER_EMAIL:owner.email,NOTION_READ_TOKEN:'test-read-only-token',NOTION_PORTFOLIO_SOURCE_ID:source};
function db(){const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../worker/schema.sql',import.meta.url),'utf8'));return {sqlite,prepare(sql){return {bind(...args){return {first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}})}}}},close:()=>sqlite.close()};}
const item=(id,title)=>({object:'page',id,url:`https://www.notion.so/${id.replaceAll('-','')}`,properties:{Project:{type:'title',title:[{plain_text:title}]},'Project ID':{type:'rich_text',rich_text:[{plain_text:'DS-010'}]},Area:{type:'select',select:{name:'ANEVUM'}},State:{type:'status',status:{name:'Active'}},Priority:{type:'select',select:{name:'P2'}},'Owner/Entity':{type:'rich_text',rich_text:[{plain_text:'Devon / family'}]},'Next action':{type:'rich_text',rich_text:[{plain_text:'Review next scene'}]},'Source of truth':{type:'url',url:'https://www.notion.so/project'},'Start gate':{type:'rich_text',rich_text:[{plain_text:'Family schedule'}]},Repository:{type:'url',url:'https://github.com/example/example'}}});
const payload={results:[item('11111111-2222-3333-4444-555555555555','Family project')],has_more:false,next_cursor:null};
const get=()=>new Request(origin+'/api/portfolio');const post=()=>new Request(origin+'/api/portfolio/refresh',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
test('Notion projection is a strict allowlist, not raw source/clinical data',()=>{const x=item('11111111-2222-3333-4444-555555555555','Family project');x.properties['Patient records']={rich_text:[{plain_text:'never copy'}],type:'rich_text'};const projected=projectProjection(x);assert.equal(projected.name,'Family project');assert.equal(projected.next,'Review next scene');assert(!JSON.stringify(projected).includes('never copy'));assert(!JSON.stringify(projected).includes('Patient records'));});
test('read-only Notion project sync stores allowlisted metadata by owner, never writes to upstream',async()=>{
 const DB=db();let calls=0;try{const transport=async(url,options)=>{calls++;assert.equal(url,`https://api.notion.com/v1/data_sources/${source}/query`);assert.equal(options.method,'POST');assert.equal(options.headers['Notion-Version'],'2025-09-03');return new Response(JSON.stringify(payload),{status:200})};
 const app=createStation({},async()=>owner,transport),e={...env,DB};
 let r=await app.fetch(get(),e,{});assert.equal((await r.json()).projects.length,0);
 r=await app.fetch(post(),e,{});assert.equal(r.status,200);const body=await r.json();assert.equal(body.projects.length,1);assert.equal(body.notionWrites,false);assert.equal(calls,1);
 const other=createStation({},async()=>({...owner,subject:'other-owner'}),transport);assert.equal((await (await other.fetch(get(),e,{})).json()).projects.length,0);
 assert.equal((await (await app.fetch(get(),e,{})).json()).projects[0].name,'Family project');
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) c FROM station_portfolio_cache').get().c,1);
 }finally{DB.close();}
});
test('unconfigured Notion token and invalid response do not populate or erase cached projects',async()=>{
 const DB=db();try{const mock=async()=>new Response(JSON.stringify(payload),{status:200});const app=createStation({},async()=>owner,mock),e={...env,DB};
 assert.equal((await app.fetch(post(),{...e,NOTION_READ_TOKEN:undefined},{})).status,503);
 assert.equal((await app.fetch(post(),e,{})).status,200);
 const bad=createStation({},async()=>owner,async()=>new Response('Internal error',{status:503}));assert.equal((await bad.fetch(post(),e,{})).status,502);
 assert.equal((await (await app.fetch(get(),e,{})).json()).projects.length,1);
 }finally{DB.close();}
});
