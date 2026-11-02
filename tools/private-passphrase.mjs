/** Hidden input on an owner-controlled terminal. Never accepts pipes or env secrets. */
import {StringDecoder} from 'node:string_decoder';
export function readPrivatePassphrase(label='Recovery passphrase: ',{input=process.stdin,output=process.stderr,signals=process}={}){
  if(!input.isTTY||!output.isTTY||input.isRaw||typeof input.setRawMode!=='function')
    return Promise.reject(Error('private_terminal_required'));
  return new Promise((resolve,reject)=>{
    let value='',done=false;const decoder=new StringDecoder('utf8');
    const paused=input.readableFlowing!==true;
    function finish(error){
      if(done)return;done=true;
      input.removeListener('data',data);input.removeListener('error',abort);input.removeListener('end',abort);input.removeListener('close',abort);
      signals.removeListener('SIGINT',abort);signals.removeListener('SIGTERM',abort);
      try{input.setRawMode(false);}catch{error=Error('private_terminal_required');}
      if(paused)input.pause();
      const result=value;value='';
      try{output.write('\n');}catch{error=Error('private_terminal_required');}
      if(error)reject(error);else resolve(result);
    }
    function abort(){finish(Error('passphrase_entry_cancelled'));}
    function data(chunk){
      const text=decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      if(text.includes('\ufffd')){abort();return;}
      for(let i=0;i<text.length;i++){
        const c=text[i];
        if(c==='\r'||c==='\n'){
          // Reject multiple lines/paste suffixes instead of passing them to a shell.
          if(text.slice(i).replace(/\r?\n|\r/g,'')!==''){abort();return;}
          if(value.length<14||!value.trim()){finish(Error('invalid_recovery_passphrase'));return;}
          finish();return;
        }
        if(c==='\u0003'||c==='\u0004'||c==='\u001b'){abort();return;}
        if(c==='\u007f'||c==='\b'){value=Array.from(value).slice(0,-1).join('');continue;}
        if(/[\u0000-\u001f]/.test(c)){abort();return;}
        value+=c;if(value.length>256){finish(Error('invalid_recovery_passphrase'));return;}
      }
    }
    try{
      input.setRawMode(true);
      input.on('data',data);input.once('error',abort);input.once('end',abort);input.once('close',abort);
      signals.once('SIGINT',abort);signals.once('SIGTERM',abort);
      output.write(label);input.resume();
    }catch{finish(Error('private_terminal_required'));}
  });
}
