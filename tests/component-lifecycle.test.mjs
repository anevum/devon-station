import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {closeComponentServer,deadline} from '../foundation/browser/component-lifecycle.cjs';

test('component shutdown resolves an unfinished HTTP response that ordinary close leaves open',async()=>{
 let entered;const requestStarted=new Promise(resolve=>{entered=resolve;});
 const server=createServer(()=>entered());
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const socket=connect(server.address().port,'127.0.0.1');socket.on('error',()=>{});
 try{
  await once(socket,'connect');socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');await requestStarted;
  let ordinaryClosed=false;const ordinaryClose=new Promise(resolve=>server.close(()=>{ordinaryClosed=true;resolve();}));
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(ordinaryClosed,false);
  let disposed=0;
  // A second close reports ERR_SERVER_NOT_RUNNING after all connections are terminated;
  // use a separate listener below to verify the normal helper path directly.
  server.closeAllConnections();await ordinaryClose;
  assert.equal(ordinaryClosed,true);
  let secondEntered;const secondRequest=new Promise(resolve=>{secondEntered=resolve;});
  const second=createServer(()=>secondEntered());await new Promise(resolve=>second.listen(0,'127.0.0.1',resolve));
  const active=connect(second.address().port,'127.0.0.1');active.on('error',()=>{});
  try{
   await once(active,'connect');active.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
   await secondRequest;
   await closeComponentServer(second,async()=>{disposed++;});assert.equal(disposed,1);assert.equal(second.listening,false);
  }finally{active.destroy();second.closeAllConnections();}
 }finally{socket.destroy();server.closeAllConnections();}
});
test('disposal failure is surfaced while the local server still closes',async()=>{
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const failure=Error('synthetic_dispose_failure');
 await assert.rejects(closeComponentServer(server,async()=>{throw failure;}),error=>
  error instanceof AggregateError&&error.errors.includes(failure));
 assert.equal(server.listening,false);
});
test('component watchdog fails a stuck child process and cancellation prevents false timeout',async()=>{
 let fired=false;const cancel=deadline(10,()=>{fired=true;});cancel();
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(fired,false);
 const child=spawn(process.execPath,['-e',"const {deadline}=require('./foundation/browser/component-lifecycle.cjs');deadline(20,()=>{process.stderr.write('synthetic QA deadline');process.exit(1)});setInterval(()=>{},1000)"]);
 let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 try{const [code]=await once(child,'exit');assert.equal(code,1);assert.match(stderr,/synthetic QA deadline/);}
 finally{child.kill();}
});
