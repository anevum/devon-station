import test from 'node:test';
import assert from 'node:assert/strict';
import {createStation} from '../worker/index.mjs';
const origin='https://station.example.test';
const app=createStation({},async()=>({subject:'synthetic-owner',email:'owner@example.test'}));
const env={APP_ORIGIN:origin,OWNER_EMAIL:'owner@example.test',DB:{}};
function request(payload,headers={}){
 return new Request(origin+'/api/state',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:payload});
}
test('overlarge state payloads fail at the bounded streaming reader rather than allocating unlimited JSON',async()=>{
 const value='{"blob":"'+'a'.repeat(140000)+'"}';
 const result=await app.fetch(request(value),env,{});
 assert.equal(result.status,413);
 assert.equal((await result.json()).error,'request_too_large');
});
test('invalid UTF-8, JSON arrays and malformed state JSON fail closed before any database call',async()=>{
 const malformed=new Uint8Array([0x7b,0x22,0x66,0x22,0x3a,0xc3,0x28,0x7d]);
 for(const payload of [malformed,'[]','{"bad":true','null']){
  const result=await app.fetch(request(payload),env,{});
  assert.equal(result.status,400);
 }
});
