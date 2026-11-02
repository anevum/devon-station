import { parentPort, workerData } from 'node:worker_threads';
import { createPublicKey } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSyntheticAdapter } from '../../src/synthetic-adapter.mjs';

const { path, publicKeyPem, owner, token, proposal, gateBuffer, now }=workerData;
const gate=new Int32Array(gateBuffer);
const db=new DatabaseSync(path);
try {
  db.exec('PRAGMA busy_timeout=5000');
  const adapter=openSyntheticAdapter({db,publicKey:createPublicKey(publicKeyPem),issuer:'synthetic-issuer',audience:'synthetic-app',grants:[owner],seeds:[],clock:()=>now*1000});
  Atomics.add(gate,0,1);parentPort.postMessage({type:'ready'});
  if(Atomics.wait(gate,1,0,10000)==='timed-out') throw new Error('test gate timed out');
  try { parentPort.postMessage({type:'result',ok:true,value:adapter.mutate(token,0,'propose',proposal)}); }
  catch(error) { parentPort.postMessage({type:'result',ok:false,error:error.message}); }
} catch(error) { parentPort.postMessage({type:'fatal',error:error.message}); }
finally { db.close(); }
