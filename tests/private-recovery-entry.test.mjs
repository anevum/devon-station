import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync,statSync,existsSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {readPrivatePassphrase} from '../tools/private-passphrase.mjs';
import {runLocalD1Backup} from '../tools/d1-backup-local.mjs';
const pass='Synthetic secret for terminal entry';
function terminal(){
  const input=new PassThrough(),output=new PassThrough(),signals=new EventEmitter(),modes=[];
  input.isTTY=output.isTTY=true;input.isRaw=false;input.setRawMode=raw=>{input.isRaw=raw;modes.push(raw);};
  input.pause();let text='';output.on('data',chunk=>text+=chunk);
  return {input,output,signals,modes,text:()=>text};
}
test('private entry never echoes secrets, handles split UTF8/backspace and restores terminal state',async()=>{
  const t=terminal(),pending=readPrivatePassphrase('Recovery passphrase: ',t);
  const bytes=Buffer.from('Synthetic Δ passphraseX');
  for(const byte of bytes)t.input.write(Buffer.from([byte]));t.input.write('\x7f\r');
  assert.equal(await pending,'Synthetic Δ passphrase');
  assert.equal(t.text(),'Recovery passphrase: \n');assert.deepEqual(t.modes,[true,false]);
  assert.equal(t.input.isPaused(),true);assert.equal(t.input.listenerCount('data'),0);assert.equal(t.signals.listenerCount('SIGINT'),0);
});
test('cancellation, interruption, stream closure, unsafe paste and length errors clean up',async()=>{
  for(const action of [t=>t.input.write('\x03'),t=>t.input.write('\x04'),t=>t.signals.emit('SIGINT'),t=>t.signals.emit('SIGTERM'),t=>t.input.emit('end'),t=>t.input.emit('error',Error('Synthetic secret error')),t=>t.input.write(pass+'\rcommand'),t=>t.input.write('x'.repeat(257)),t=>t.input.write('short\r')]){
    const t=terminal(),pending=readPrivatePassphrase('Recovery passphrase: ',t);action(t);
    await assert.rejects(pending,/passphrase_entry_cancelled|invalid_recovery_passphrase/);
    assert.deepEqual(t.modes,[true,false]);assert.equal(t.input.listenerCount('data'),0);assert.equal(t.signals.listenerCount('SIGTERM'),0);
    assert.equal(t.text(),'Recovery passphrase: \n');
  }
  const t=terminal();t.input.isTTY=false;await assert.rejects(readPrivatePassphrase(undefined,t),/private_terminal_required/);assert.equal(t.text(),'');
});
test('offline command round trip uses private files, preserves source and refuses overwrite/symlinks',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'ds-private-entry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=join(dir,'synthetic.sql'),archive=join(dir,'encrypted.json'),target=join(dir,'restored.sql');
  const bytes=Buffer.from('-- Synthetic only\nSELECT 1;\n');writeFileSync(source,bytes);
  const prompt=async()=>pass;
  assert.equal((await runLocalD1Backup({mode:'encrypt',source,destination:archive,kind:'d1-sql'},{prompt})).status,'ENCRYPTED_FILE_CREATED');
  assert.equal(statSync(archive).mode&0o777,0o600);assert(!readFileSync(archive,'utf8').includes(pass));
  await runLocalD1Backup({mode:'decrypt',source:archive,destination:target},{prompt});assert.deepEqual(readFileSync(target),bytes);assert.deepEqual(readFileSync(source),bytes);
  assert.equal(statSync(target).mode&0o777,0o600);
  await assert.rejects(runLocalD1Backup({mode:'decrypt',source:archive,destination:target},{prompt}),/local_d1_backup_refused/);assert.deepEqual(readFileSync(target),bytes);
  const link=join(dir,'link');symlinkSync(source,link);await assert.rejects(runLocalD1Backup({mode:'encrypt',source:link,destination:join(dir,'unused'),kind:'d1-sql'},{prompt}),/local_d1_backup_refused/);
  let n=0;await assert.rejects(runLocalD1Backup({mode:'encrypt',source,destination:join(dir,'mismatch'),kind:'d1-sql'},{prompt:async()=>n++?pass+'different':pass}),/recovery_passphrases_do_not_match/);assert(!existsSync(join(dir,'mismatch')));
  await assert.rejects(runLocalD1Backup({mode:'decrypt',source:archive,destination:join(dir,'wrong')},{prompt:async()=>pass+'wrong'}),/local_d1_backup_refused/);assert(!existsSync(join(dir,'wrong')));
});
test('CLI refuses piped passphrase input and extra secret arguments without disclosing them',t=>{
  const dir=mkdtempSync(join(tmpdir(),'ds-entry-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=join(dir,'synthetic.sql'),target=join(dir,'result.json');writeFileSync(source,'Synthetic input');
  const cli=new URL('../tools/d1-backup-local.mjs',import.meta.url).pathname;
  const run=args=>spawnSync(process.execPath,[cli,...args],{input:pass+'\n',encoding:'utf8'});
  const denied=run(['encrypt',source,target,'d1-sql']);assert.equal(denied.status,1);assert.equal(denied.stderr,'private_terminal_required\n');assert.equal(denied.stdout,'');assert(!existsSync(target));
  const extra=run(['encrypt',source,target,'d1-sql',pass]);assert.equal(extra.stderr,'local_d1_backup_refused\n');assert(!extra.stderr.includes(pass));
});
