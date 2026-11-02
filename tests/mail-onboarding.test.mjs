import test from 'node:test';
import assert from 'node:assert/strict';
import {PURELYMAIL,validDomain,mailboxProfile,purelymailDnsPlan,auditMailDns,mailActivationGate}
  from '../src/communications/mail-onboarding.mjs';

const domain='devonakins.com';
const proof='purelymail_ownership_proof=synthetic-test-token-12345';

test('provider profile uses verified TLS transport endpoints and defaults to send-disabled',()=>{
  const p=mailboxProfile({domain});
  assert.equal(p.address,'hello@devonakins.com');
  assert.equal(p.incoming.host,'imap.purelymail.com');
  assert.equal(p.incoming.port,993);
  assert.equal(p.outgoing.host,'smtp.purelymail.com');
  assert.equal(p.outgoing.port,465);
  assert.equal(p.incoming.tls,true);
  assert.equal(p.outgoing.tls,true);
  assert.equal(p.sendsDisabledUntilVerified,true);
  assert.equal(p.needsUserScopedAppPassword,true);
  assert.equal(JSON.stringify(p).includes('password:'),false);
  assert.equal(PURELYMAIL.smtpStartTlsPort,587);
});

test('reusable domain and address normalization',()=>{
  assert.equal(mailboxProfile({domain:'client-example.org',localPart:'support'}).address,'support@client-example.org');
  for(const bad of ['','localhost','.com','ex..ample.org','mail.example.org\n','-evil.org',
    'example.com; rm -rf /','a'.repeat(64)+'.com']){
    assert.equal(validDomain(bad),false,`must reject: ${JSON.stringify(bad)}`);
  }
  for(const localPart of ['me@example.com','../owner','invalid\naddress','UPPER','foo..bar']) {
    assert.throws(()=>mailboxProfile({domain,localPart}),/Invalid/);
  }
});

test('template includes MX SPF DKIM and DMARC, but account-specific proof blocks readiness',()=>{
  const plan=purelymailDnsPlan(domain);
  assert.equal(plan.records.length,6);
  assert.equal(plan.awaitingAccountSpecificOwnershipProof,true);
  assert.deepEqual(plan.records.filter(x=>x.type==='MX').map(x=>[x.content,x.priority]),[['mailserver.purelymail.com',50]]);
  assert.equal(plan.records.filter(x=>x.type==='CNAME').length,4);
  assert.equal(plan.records.every(x=>x.type!=='CNAME'||x.proxied===false),true);
  assert.equal(auditMailDns(plan,[]).ready,false);
});

test('reject ownership proof absent or fabricated in bad format',()=>{
  for(const input of ['x','purelymail_ownership_proof=','purelymail_ownership_proof=test\r\nTXT',
    'purelymail_ownership_proof=123']) assert.throws(()=>purelymailDnsPlan(domain,input),/ownership proof/);
});

test('Cloudflare DNS preflight treats web AAAA as unrelated and never suggests deletion',()=>{
  const plan=purelymailDnsPlan(domain,proof);
  const web={name:domain,type:'AAAA',content:'100::',proxied:true};
  const audit=auditMailDns(plan,[web]);
  assert.equal(audit.missing.length,7);
  assert.equal(audit.conflicts.length,0);
  assert.equal(audit.ready,false);
  assert.equal(audit.ownershipProofRequired,false);
});

test('exact DNS matching is tolerant of trailing dots and quoted TXT, but requires unproxied DKIM',()=>{
  const plan=purelymailDnsPlan(domain,proof);
  const existing=plan.records.map(r=>({...r,content:r.type==='TXT'?`"${r.content}"`:`${r.content}.`,
    name:`${r.name}.`,proxied:r.type==='CNAME'?false:undefined}));
  const audit=auditMailDns(plan,existing);
  assert.equal(audit.ready,true);
  assert.equal(audit.missing.length,0);
  assert.equal(audit.matched.length,7);
});

test('different MX and SPF create explicit blockers, never silent overwrite',()=>{
  const plan=purelymailDnsPlan(domain,proof);
  const existing=[...plan.records,{type:'MX',name:domain,content:'mx.legacy.test',priority:10},
    {type:'TXT',name:domain,content:'v=spf1 include:other.test -all'}];
  const audit=auditMailDns(plan,existing);
  assert.deepEqual(audit.conflicts.map(x=>x.reason).sort(),['another_spf_policy','other_mail_receiver']);
  assert.equal(audit.ready,false);
});

test('DKIM proxy mistake and DMARC TXT name collision block activation',()=>{
  const plan=purelymailDnsPlan(domain,proof);
  const existing=plan.records.map(r=>({...r}));
  existing.find(x=>x.name.startsWith('purelymail1')).proxied=true;
  existing.push({type:'TXT',name:`_dmarc.${domain}`,content:'v=DMARC1; p=none'});
  const audit=auditMailDns(plan,existing);
  assert(audit.conflicts.some(x=>x.reason==='different_or_proxied_cname'));
  assert(audit.conflicts.some(x=>x.reason==='cname_name_collision'));
  assert.equal(audit.ready,false);
});

test('complete DNS still cannot activate without mailbox, secrets, and verified receipt/send',()=>{
  const plan=purelymailDnsPlan(domain,proof);
  const dnsAudit=auditMailDns(plan,plan.records);
  assert.equal(dnsAudit.ready,true);
  const a=mailActivationGate({dnsAudit,providerDomainVerified:true});
  assert.equal(a.ready,false);
  assert.deepEqual(a.missing,['mailbox','secretCustody','inbound','outbound']);
  const b=mailActivationGate({dnsAudit,providerDomainVerified:true,mailboxCreated:true,
    appPasswordStoredServerSide:true,inboundTestVerified:true,outboundTestVerified:true});
  assert.equal(b.ready,true);
});

test('invalid DNS inputs fail closed',()=>{
  assert.throws(()=>auditMailDns({},[]),/Invalid/);
  assert.throws(()=>auditMailDns(purelymailDnsPlan(domain),null),/Invalid/);
  assert.equal(mailActivationGate().ready,false);
});
