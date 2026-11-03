// COMMS-09: IMAP4rev1 TLS transport for the existing restricted read-only provider.
// Called only from an authenticated Worker handler with server-owned credentials and socket factory.
import {PURELYMAIL} from './mail-onboarding.mjs';
const enc = new TextEncoder();
const LIMIT = 256 * 1024;
const MAX_LINE = 8192;
const MAX_REPLY = 10 * (LIMIT + MAX_LINE) + 32768;
const UID = n => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff;
const reject = code => {throw Object.assign(new Error(code), {code});};
const ascii = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value);
const quote = value => '"' + value.replace(/[\\"]/g, '\\$&') + '"';

function parseInternalDate(line) {
  const match = /\bINTERNALDATE "([0-9]{1,2})-([A-Za-z]{3})-([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([+-])([0-9]{2})([0-9]{2})"/i.exec(line);
  if (!match) reject('imap_invalid_fetch');
  const [, day, month, year, hour, min, sec, sign, tzHour, tzMin] = match;
  const monthIndex = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(month.toLowerCase());
  const parts = [Number(year), monthIndex, Number(day), Number(hour), Number(min), Number(sec)];
  if (monthIndex < 0 || parts[0] < 1970 || parts[0] > 9999 || parts[3] > 23 || parts[4] > 59 || parts[5] > 59 || +tzHour > 23 || +tzMin > 59) reject('imap_invalid_fetch');
  const local = new Date(Date.UTC(...parts));
  if (local.getUTCFullYear() !== parts[0] || local.getUTCMonth() !== parts[1] || local.getUTCDate() !== parts[2]) reject('imap_invalid_fetch');
  const offset = (+tzHour * 60 + +tzMin) * (sign === '+' ? 1 : -1);
  return new Date(local.valueOf() - offset * 60000).toISOString();
}

// FETCH attributes may occur on either side of the one bounded message literal.
// Parse the complete frame, rather than searching for field names inside quoted values.
async function parseFetch(line, bytes, decodeMime) {
  const frame = /^\* [1-9][0-9]* FETCH \((.*)\)$/i.exec(line);
  if (!frame || line.length > MAX_LINE) reject('imap_invalid_fetch');
  let rest = frame[1];
  const fields = new Map();
  while (rest) {
    const field = /^(UID [0-9]+|FLAGS \([^(){}"\[\]\x00-\x20]*(?: [^(){}"\[\]\x00-\x20]+)*\)|INTERNALDATE "[^"\r\n]+"|BODY(?:\.PEEK)?\[\] \{[0-9]+\})/i.exec(rest);
    if (!field) reject('imap_invalid_fetch');
    const key = /^[a-z]+/i.exec(field[1])[0].toUpperCase();
    if (fields.has(key)) reject('imap_invalid_fetch');
    fields.set(key,field[1]);
    rest = rest.slice(field[1].length);
    if (rest && !rest.startsWith(' ')) reject('imap_invalid_fetch');
    if (rest) {rest = rest.slice(1); if (!rest) reject('imap_invalid_fetch');}
  }
  if (fields.size !== 4 || !['UID','FLAGS','INTERNALDATE','BODY'].every(key=>fields.has(key)))
    reject('imap_invalid_fetch');
  const uid = Number(fields.get('UID').slice(4));
  if (!UID(uid) || Number(/\{([0-9]+)\}$/.exec(fields.get('BODY'))[1]) !== bytes.byteLength)
    reject('imap_invalid_fetch');
  const flagValues = fields.get('FLAGS').slice(7,-1).split(' ');
  const flags = [];
  for (const [wire, name] of [['\\Seen','seen'], ['\\Answered','answered'], ['\\Flagged','flagged'], ['\\Draft','draft']]) {
    if (flagValues.some(x => x.toLowerCase() === wire.toLowerCase())) flags.push(name);
  }
  const timestamp = parseInternalDate(fields.get('INTERNALDATE'));
  const decoded = await decodeMime(bytes);
  if (!decoded || typeof decoded !== 'object' || !ascii(decoded.from, 254) ||
      typeof decoded.subject !== 'string' || typeof decoded.text !== 'string') reject('imap_invalid_mime');
  return {uid,from:decoded.from,subject:decoded.subject,text:decoded.text,timestamp,flags};
}

function validateCommand(command) {
  if (command === 'EXAMINE "INBOX"') return 'examine';
  const search = /^UID SEARCH UID ([1-9][0-9]*):([1-9][0-9]*)$/.exec(command);
  if (search && UID(Number(search[1])) && UID(Number(search[2])) &&
      Number(search[2]) >= Number(search[1]) && Number(search[2])-Number(search[1]) < 256) return 'search';
  if (/^UID FETCH [1-9][0-9]*(?:,[1-9][0-9]*)* \(UID FLAGS INTERNALDATE BODY\.PEEK\[\]\)$/.test(command) &&
      command.length <= 350 && command.slice(10,command.indexOf(' (')).split(',').every(n=>UID(Number(n)))) return 'fetch';
  reject('imap_command_forbidden');
}

export function createPurelymailImapConnector({connect, credentials, decodeMime} = {}) {
  if (typeof connect !== 'function' || typeof credentials !== 'function' || typeof decodeMime !== 'function') reject('imap_connector_unavailable');
  return Object.freeze({
    async open({host, port, servername, tlsRequired, rejectUnauthorized, username, signal} = {}) {
      if (host !== PURELYMAIL.incoming.host || servername !== host || port !== 993 ||
          tlsRequired !== true || rejectUnauthorized !== true || !ascii(username, 254) || !/^[a-z0-9._+-]+@[a-z0-9.-]+$/.test(username) || signal?.aborted) reject('imap_tls_policy_required');
      const password = await credentials(username);
      if (!ascii(password, 1024)) reject('imap_credentials_unavailable');
      let socket, reader, writer, buffer = new Uint8Array(0), closed = false, tag = 0;
      const cleanup = async () => {
        if (closed) return;
        closed = true;
        try {await socket?.close?.();} catch {}
        try {reader?.releaseLock?.();} catch {}
        try {writer?.releaseLock?.();} catch {}
      };
      const abort = () => {void cleanup();};
      signal?.addEventListener('abort', abort, {once:true});
      const fail = code => {void cleanup(); reject(code);};
      try {
        if (signal?.aborted) reject('imap_session_cancelled');
        // The Workers native TLS stack validates the peer; no plaintext or insecure fallback.
        socket = connect({hostname:host,port}, {secureTransport:'on'});
        if (!socket || !socket.opened || !socket.readable || !socket.writable || typeof socket.close !== 'function') reject('imap_socket_unavailable');
        await socket.opened;
        if (closed || signal?.aborted) reject('imap_session_cancelled');
        reader = socket.readable.getReader();
        writer = socket.writable.getWriter();
        async function fill() {
          if (closed || signal?.aborted) reject('imap_session_cancelled');
          const {done,value} = await reader.read();
          if (done || !(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_REPLY) reject('imap_stream_closed');
          if (buffer.byteLength + value.byteLength > MAX_REPLY) reject('imap_response_limit');
          const merged = new Uint8Array(buffer.byteLength + value.byteLength);
          merged.set(buffer);merged.set(value,buffer.byteLength);buffer=merged;
        }
        async function line() {
          while (true) {
            for (let i=0;i<buffer.length;i++) {
              if (buffer[i]===10 && (i===0 || buffer[i-1]!==13)) reject('imap_invalid_framing');
              if (buffer[i]===13 && i+1<buffer.length && buffer[i+1]!==10) reject('imap_invalid_framing');
              if (buffer[i]===13 && i+1<buffer.length) {
                if (i>MAX_LINE) reject('imap_response_limit');
                const raw=buffer.slice(0,i);buffer=buffer.slice(i+2);
                if (raw.some(b=>b===0 || b>127 || (b<32 && b!==9))) reject('imap_invalid_framing');
                return new TextDecoder().decode(raw);
              }
            }
            if (buffer.length>MAX_LINE) reject('imap_response_limit');
            await fill();
          }
        }
        async function literal(n) {
          if (!Number.isSafeInteger(n) || n<0 || n>LIMIT) reject('imap_literal_limit');
          while (buffer.byteLength<n) await fill();
          const raw=buffer.slice(0,n);buffer=buffer.slice(n);
          return raw;
        }
        const greeting = await line();
        if (!/^\* OK(?:\s|$)/i.test(greeting)) reject('imap_greeting_failed');
        async function exchangeRaw(command, kind) {
          if (closed || signal?.aborted) reject('imap_session_cancelled');
          if (++tag>9999) reject('imap_command_limit');
          const id='A'+String(tag).padStart(4,'0');
          await writer.write(enc.encode(id+' '+command+'\r\n'));
          const lines=[], messages=[], maxMessages=10;
          let received=0;
          while (true) {
            const response=await line();
            received+=response.length+2;
            if (received>MAX_REPLY) reject('imap_response_limit');
            if (/^\* BYE(?:\s|$)/i.test(response) || /^\+/.test(response)) reject('imap_unexpected_response');
            if (response.startsWith(id+' ')) {
              if (!new RegExp('^'+id+' OK(?:\\s|$)','i').test(response)) reject('imap_command_failed');
              if (kind==='examine') return lines.join('\r\n');
              if (kind==='search') {
                const found=lines.filter(x=>/^\* SEARCH(?:\s|$)/i.test(x));
                if (found.length!==1) reject('imap_invalid_search');
                return found[0];
              }
              if (kind==='fetch') return {messages};
              return null;
            }
            if (response.startsWith('A') && /^A[0-9]{4} /.test(response)) reject('imap_tag_mismatch');
            const length=/\{([0-9]+)\}$/.exec(response);
            if (length) {
              if (kind!=='fetch' || messages.length>=maxMessages) reject('imap_unexpected_literal');
              const size=Number(length[1]);
              if (!Number.isSafeInteger(size) || size>LIMIT) reject('imap_literal_limit');
              const raw=await literal(size);received+=size;
              const suffix=await line();received+=suffix.length+2;
              if (received>MAX_REPLY) reject('imap_response_limit');
              messages.push(await parseFetch(response+suffix,raw,decodeMime));
            } else if (kind==='fetch') {
              if (!/^\* [0-9]+ EXISTS$/i.test(response)) reject('imap_invalid_fetch');
            } else {
              lines.push(response);
            }
          }
        }
        await exchangeRaw('LOGIN '+quote(username)+' '+quote(password),'login');
        return Object.freeze({
          async exchange(command, {signal:stepSignal}={}) {
            if (stepSignal?.aborted || signal?.aborted || closed) fail('imap_session_cancelled');
            const kind=validateCommand(command);
            try {return await exchangeRaw(command,kind);}
            catch (error) {
              signal?.removeEventListener('abort',abort);
              await cleanup();
              throw error;
            }
          },
          async close(){signal?.removeEventListener('abort',abort);await cleanup();}
        });
      } catch {
        signal?.removeEventListener('abort',abort);
        await cleanup();
        reject('imap_transport_failed');
      }
    }
  });
}
