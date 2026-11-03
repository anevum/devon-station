import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareOutgoingPlainText} from '../src/communications/mail-outbound-wire.mjs';

const id='123e4567-e89b-42d3-a456-426614174000';
const date=new Date('2026-11-03T12:00:00.000Z');
const from='hello@devonakins.com';
const context={installationId:'personal',principalId:'owner'};
const registry=(approved=true)=>({mailboxes:[{id:'hello',installationId:'personal',mode:'imap',sendVerified:approved}],
 identities:[{address:from,mailboxId:'hello',installationId:'personal',sendVerified:approved}],
 grants:[{installationId:'personal',principalId:'owner',mailboxId:'hello',capabilities:approved?['send']:['draft']} ]});
const draft={from,to:['a@example.com','b@example.net'],subject:'Working update',body:'One line\nSecond line'};
const pack=(overrides={})=>prepareOutgoingPlainText({registry:registry(),context,mailboxId:'hello',from,draft,deliveryId:id,date,...overrides});
const rejects=(overrides,code)=>assert.throws(()=>pack(overrides),e=>e?.code===code);

test('trusted verified sender yields deterministic MIME with correct SMTP envelope, headers and CRLF',()=>{
 const m=pack();
 assert.equal(m.messageId,'<'+id+'@devonakins.com>');
 assert.equal(m.envelopeFrom,from);
 assert.deepEqual(m.envelopeTo,['a@example.com','b@example.net']);
 assert(m.wire.startsWith('From: '+from+'\r\nTo: a@example.com, b@example.net\r\nSubject: Working update\r\n'));
 assert.match(m.wire,/Date: Tue, 03 Nov 2026 12:00:00 \+0000\r\n/);
 assert.match(m.wire,/Message-ID: <123e4567-e89b-42d3-a456-426614174000@devonakins.com>\r\n/);
 assert(!/(^|\r\n)Bcc:/i.test(m.wire));
 assert(!/(?<!\r)\n/.test(m.wire));
 const body=m.wire.split('\r\n\r\n')[1].trim();
 assert.equal(Buffer.from(body,'base64').toString('utf8'),'One line\r\nSecond line');
 assert.equal(pack().wire,m.wire);
 assert(Object.isFrozen(m));assert(Object.isFrozen(m.envelopeTo));
});

test('Unicode subject uses bounded RFC2047 encoded words and body uses bounded base64 lines',()=>{
 const special='Résumé — 中文 🪐'.repeat(18);
 const m=pack({draft:{...draft,subject:special,body:'🔐 Confidential\n'.repeat(1000)}});
 const subject=m.wire.split('\r\n').filter(x=>x.startsWith('Subject: ')||x.startsWith(' =?'));
 assert(subject.length>2);
 for(const [i,line] of subject.entries())assert(line.length<=78,'header word line '+i+' length '+line.length);
 const words=subject.join('').match(/=\?UTF-8\?B\?([^?]+)\?=/g);
 assert(words?.length>2);
 assert.equal(words.map(w=>Buffer.from(w.slice(10,-2),'base64').toString('utf8')).join(''),special);
 const bodyLines=m.wire.split('\r\n\r\n')[1].trim().split('\r\n');
 assert(bodyLines.every(x=>x.length<=76));
 assert.equal(Buffer.from(bodyLines.join(''),'base64').toString('utf8'),'🔐 Confidential\r\n'.repeat(1000));
});

test('identity, installation and provider send gates must all be verified',()=>{
 rejects({registry:registry(false)},'mail_outbound_sender_unverified');
 rejects({context:{installationId:'other',principalId:'owner'}},'mail_outbound_sender_unverified');
 rejects({from:'admin@example.net'},'mail_outbound_sender_unverified');
 rejects({draft:{...draft,from:'admin@example.net'}},'mail_outbound_unsupported_content');
});

test('untrusted attachments, HTML, CC and BCC cannot silently disappear from a send',()=>{
 for(const key of ['attachments','html','cc','bcc'])rejects({draft:{...draft,[key]:[]}},'mail_outbound_unsupported_content');
});

test('recipients, delivery identifiers and dates fail closed',()=>{
 rejects({draft:{...draft,to:[]}},'mail_outbound_recipient_required');
 rejects({draft:{...draft,to:['invalid-address']}},'mail_outbound_invalid_draft');
 rejects({draft:{...draft,to:['a@example.com','A@example.com']}},'mail_outbound_invalid_draft');
 rejects({draft:{...draft,subject:'ok\r\nBcc:intruder@example.com'}},'mail_outbound_invalid_draft');
 rejects({draft:{...draft,body:'ok\rInjected'}},'mail_outbound_invalid_body');
 rejects({deliveryId:'<evil@attacker.test>'},'mail_outbound_invalid_delivery_id');
 rejects({date:new Date('bad')},'mail_outbound_invalid_date');
});

test('do not silently replace malformed unicode before delivery',()=>{
 rejects({draft:{...draft,subject:'Bad\ud800'}},'mail_outbound_invalid_unicode');
 rejects({draft:{...draft,body:'Bad\ud800'}},'mail_outbound_invalid_unicode');
});

test('long recipient list folds rather than creating an oversized To header',()=>{
 const recipients=Array.from({length:20},(_,i)=>'someone'+i+'@example.com');
 const m=pack({draft:{...draft,to:recipients}});
 assert.deepEqual(m.envelopeTo,recipients);
 const to=m.wire.split('\r\n').filter(x=>x.startsWith('To: ')||x.startsWith(' '));
 assert(to.length>1);
 assert(to.every(x=>x.length<=78));
});
