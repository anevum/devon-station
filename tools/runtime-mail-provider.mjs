// Deterministic, in-memory protocol fixture. There is no real network transport.
export function syntheticMailProvider(){
 const evidence={imapConnections:0,smtpConnections:0,dataWrites:0};
 const incoming=new TextEncoder().encode('From: Synthetic Author <synthetic-author@example.test>\r\nSubject: Browser incoming fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSafe incoming browser message. <img src="https://tracker.invalid/pixel">');
 return {evidence,connect(address,options){
  if(options.secureTransport!=='on'||!['imap.purelymail.com','smtp.purelymail.com'].includes(address.hostname))throw Error('unexpected fixture socket');
  const imap=address.hostname==='imap.purelymail.com';
  if(address.port!==(imap?993:465))throw Error('unexpected fixture port');
  evidence[imap?'imapConnections':'smtpConnections']++;
  let controller,closed=false;const reply=text=>controller.enqueue(typeof text==='string'?new TextEncoder().encode(text):text);
  return {opened:Promise.resolve(),readable:new ReadableStream({start(c){controller=c;reply(imap?'* OK synthetic ready\r\n':'220 synthetic ready\r\n');}}),
   writable:new WritableStream({write(bytes){const line=new TextDecoder().decode(bytes),tag=line.slice(0,5);
    if(imap){
     if(line.includes(' LOGIN '))reply(tag+' OK authenticated\r\n');
     else if(line.includes('EXAMINE'))reply('* OK [UIDVALIDITY 7] [UIDNEXT 2] selected\r\n'+tag+' OK done\r\n');
     else if(line.includes('UID SEARCH'))reply('* SEARCH 1\r\n'+tag+' OK done\r\n');
     else if(line.includes('UID FETCH')){reply('* 1 FETCH (UID 1 FLAGS () INTERNALDATE "02-Nov-2026 12:00:00 -0500" BODY[] {'+incoming.length+'}\r\n');reply(incoming);reply(')\r\n'+tag+' OK done\r\n');}
     else throw Error('unexpected IMAP command');
    }else{
     if(line.startsWith('From:')){evidence.dataWrites++;reply('250 synthetic accepted\r\n');}
     else if(line.startsWith('EHLO'))reply('250-AUTH PLAIN\r\n250 synthetic ready\r\n');
     else if(line.startsWith('AUTH'))reply('235 synthetic authenticated\r\n');
     else if(line.startsWith('DATA'))reply('354 synthetic continue\r\n');
     else if(!line.startsWith('QUIT'))reply('250 synthetic ok\r\n');
    }
   }}),async close(){if(!closed){closed=true;controller.close();}}};
 }};
}
