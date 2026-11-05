import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeSafeMime} from '../src/communications/mail-mime-safe.mjs';

const bytes=text=>new TextEncoder().encode(text);
const headers=(body,more='')=>'From: "Regular Person" <author@example.org>\r\nSubject: Inert note\r\n'+more+'\r\n'+body;
test('single-part plain text stays inert and bounded',async()=>{
 const result=await decodeSafeMime(bytes(headers('Hello world.\r\nThis is a note.','Content-Type: text/plain; charset=utf-8\r\n')));
 assert.deepEqual(result,{from:'author@example.org',subject:'Inert note',text:'Hello world.\nThis is a note.\n'});
 assert.equal(Object.hasOwn(result,'html'),false);
 assert.equal(Object.hasOwn(result,'attachments'),false);
 assert.equal(Object.hasOwn(result,'raw'),false);
});
test('multipart alternative chooses plain text and ignores embedded remote tracking HTML',async()=>{
 const raw=headers('--boundary123\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello =C3=A9veryone\r\n--boundary123\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<img src="https://tracker.example/track"><script>steal()</script><b>HTML</b>\r\n--boundary123--\r\n',
  'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="boundary123"\r\n');
 const result=await decodeSafeMime(bytes(raw));
 assert.equal(result.from,'author@example.org');
 assert.match(result.text,/Hello \u00e9veryone/);
 assert.doesNotMatch(result.text,/tracker\.example|steal\(\)|<img/);
});
test('HTML-only messages convert into safe text without scripts or remote loading',async()=>{
 const raw=headers('<html><body><h1>Welcome</h1><script>SECRET()</script><style>.a{color:red}</style><p>Real <b>content</b>.</p><img src="https://tracker.example/pixel"></body></html>',
  'MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n');
 const out=await decodeSafeMime(bytes(raw));
 assert.match(out.text,/Real/);
 assert.doesNotMatch(out.text,/SECRET|tracker\.example|<script|<img/);
});
test('base64 encoded attachment never enters D1 projection, only explicit unavailable message',async()=>{
 const body=['--X',
  'Content-Type: text/plain; charset=utf-8','','Here is a document.','--X',
  'Content-Type: application/pdf; name="test.pdf"',
  'Content-Disposition: attachment; filename="test.pdf"',
  'Content-Transfer-Encoding: base64','','JVBERi0xLjQK','--X--',''].join('\r\n');
 const raw=headers(body,'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="X"\r\n');
 const parsed=await decodeSafeMime(bytes(raw));
 assert.match(parsed.text,/Here is a document/);
 assert.match(parsed.text,/Attachment content is not available/);
 assert.doesNotMatch(parsed.text,/JVBER|test\.pdf/);
 assert.equal(Object.keys(parsed).sort().join(','),'from,subject,text');
});
test('RFC 2047 subject is decoded into safe Unicode',async()=>{
 const raw='From: author@example.org\r\nSubject: =?UTF-8?Q?Caf=C3=A9?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMessage';
 const out=await decodeSafeMime(bytes(raw));
 assert.equal(out.subject,'Café');
});
test('normal MIME with missing subject remains readable but no forged sender is synthesized',async()=>{
 const raw='From: author@example.org\r\nContent-Type: text/plain\r\n\r\nHi';
 const out=await decodeSafeMime(bytes(raw));
 assert.equal(out.subject,'');assert.equal(out.text,'Hi\n');
 await assert.rejects(decodeSafeMime(bytes('Subject: Missing from\r\n\r\nHi')),{code:'mime_invalid_from'});
});
test('control/bidi characters in hostile content are rendered as replacement characters',async()=>{
 const raw=headers('Sample \u202eforced\u202c reply.\r\n');
 const out=await decodeSafeMime(bytes(raw));
 assert.doesNotMatch(out.text,/[\u202e\u202c]/);
 assert.match(out.text,/\ufffd/);
});
test('long valid body becomes an explicitly shortened bounded preview while exact-boundary text is retained',async()=>{
 const exact=await decodeSafeMime(bytes(headers('A'.repeat(4095))));
 assert.equal(exact.text,'A'.repeat(4095)+'\n');
 const long=await decodeSafeMime(bytes(headers('A'.repeat(4200))));
 assert.equal(long.text.length,4096);assert.match(long.text,/^A+/);
 assert.match(long.text,/\[Message shortened\. The full message remains with your email provider\.\]$/);
 assert.deepEqual(Object.keys(long).sort(),['from','subject','text']);
});
test('shortened Unicode/HTML body stays inert and retains the attachment-unavailable notice within the bound',async()=>{
 const marker='\n\n[Message shortened. The full message remains with your email provider.]';
 const budget=4096-marker.length;
 const unicode=await decodeSafeMime(bytes(headers('X'.repeat(budget-1)+'😀'+'Y'.repeat(500))));
 assert.equal(unicode.text.length,4095);assert.equal(unicode.text.slice(0,budget-1),'X'.repeat(budget-1));
 assert.doesNotMatch(unicode.text,/[\uD800-\uDFFF]/);
 const body=['--X','Content-Type: text/html; charset=utf-8','','<p>'+('safe '.repeat(1100))+'</p><script>PRIVATE_SCRIPT()</script><img src="https://tracker.invalid/">',
  '--X','Content-Type: application/pdf','Content-Disposition: attachment; filename="PRIVATE.pdf"','Content-Transfer-Encoding: base64','','JVBERi0xLjQK','--X--',''].join('\r\n');
 const mixed=await decodeSafeMime(bytes(headers(body,'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="X"\r\n')));
 assert(mixed.text.length<=4096);assert.match(mixed.text,/Message shortened/);assert.match(mixed.text,/Attachment content is not available/);
 assert.doesNotMatch(mixed.text,/PRIVATE|tracker.invalid|<script|<img|JVBER/);
});
test('raw wire budget is checked before MIME parsing',async()=>{
 await assert.rejects(decodeSafeMime(bytes(headers('x'.repeat(256*1024)))),{code:'mime_wire_limit'});
 await assert.rejects(decodeSafeMime(new Uint8Array(0)),{code:'mime_wire_limit'});
 await assert.rejects(decodeSafeMime('not a byte array'),{code:'mime_wire_limit'});
});
test('excessive MIME multipart nesting fails without creating HTML or attachment fields',async()=>{
 let content='Content-Type: text/plain\r\n\r\nHello';
 for(let depth=0;depth<19;depth++){
  content='Content-Type: multipart/mixed; boundary="b'+depth+'"\r\n\r\n--b'+depth+'\r\n'+content+'\r\n--b'+depth+'--\r\n';
 }
 await assert.rejects(decodeSafeMime(bytes('From: author@example.org\r\nSubject: deep\r\n'+content)),{code:'mime_parse_failed'});
});
