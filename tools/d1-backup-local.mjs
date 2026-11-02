/** Owner-operated offline recovery command; no network or database execution. */
import {open,constants} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {encryptD1Backup,decryptD1Backup} from './d1-backup-envelope.mjs';
import {readPrivatePassphrase} from './private-passphrase.mjs';
const refused=()=>{throw Error('local_d1_backup_refused');};
export async function runLocalD1Backup({mode,source,destination,kind},{prompt=readPrivatePassphrase}={}){
  let input,output,bytes,plain,passphrase,confirmation;
  try{
    if(!['encrypt','decrypt'].includes(mode)||typeof source!=='string'||typeof destination!=='string'||
      resolve(source)===resolve(destination)||(mode==='encrypt'?!['sqlite','d1-sql'].includes(kind):kind!==undefined))refused();
    input=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await input.stat(),max=mode==='encrypt'?64*1024*1024:Math.ceil(64*1024*1024*4/3)+4096;
    if(!stat.isFile()||!stat.size||stat.size>max)refused();
    bytes=await input.readFile();if(bytes.length>max||bytes.length!==stat.size)refused();
    passphrase=await prompt('Recovery passphrase: ');
    if(mode==='encrypt'){
      confirmation=await prompt('Repeat recovery passphrase: ');
      if(passphrase!==confirmation)throw Error('recovery_passphrases_do_not_match');
      plain=Buffer.from(JSON.stringify(await encryptD1Backup(bytes,passphrase,{kind})));
    }else{
      const result=await decryptD1Backup(JSON.parse(bytes.toString('utf8')),passphrase);plain=result.bytes;
    }
    // Existing files (including hard links/symlinks) are never overwritten.
    output=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await output.writeFile(plain);await output.sync();
    return {status:mode==='encrypt'?'ENCRYPTED_FILE_CREATED':'PLAINTEXT_FILE_CREATED',networkUsed:false};
  }catch(error){
    if(['private_terminal_required','passphrase_entry_cancelled','invalid_recovery_passphrase','recovery_passphrases_do_not_match'].includes(error?.message))throw Error(error.message);
    refused();
  }finally{
    passphrase=confirmation=undefined;bytes?.fill(0);plain?.fill(0);
    for(const handle of [input,output])try{await handle?.close();}catch{}
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const [mode,source,destination,kind,...extra]=process.argv.slice(2);
    if(extra.length)refused();
    const result=await runLocalD1Backup({mode,source,destination,kind});
    console.log(result.status);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
