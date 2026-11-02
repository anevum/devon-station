// Reusable, source-only mail onboarding. No network, credentials, or DNS mutation.
// Vendor values: https://purelymail.com/docs/domainDocs
export const PURELYMAIL = Object.freeze({
  provider: 'purelymail',
  incoming: Object.freeze({protocol: 'imap', host: 'imap.purelymail.com', port: 993, tls: true}),
  outgoing: Object.freeze({protocol: 'smtp', host: 'smtp.purelymail.com', port: 465, tls: true}),
  smtpStartTlsPort: 587,
});

export function validDomain(domain) {
  if (typeof domain !== 'string' || domain !== domain.trim() || domain.length > 253) return false;
  const parts = domain.toLowerCase().split('.');
  return parts.length >= 2 && parts.every(p => p.length > 0 && p.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p)) && /[a-z]/.test(parts.at(-1));
}

export function mailboxProfile({domain, localPart = 'hello', provider = PURELYMAIL} = {}) {
  if (!validDomain(domain)) throw new TypeError('Invalid mail domain');
  if (typeof localPart !== 'string' || !/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/.test(localPart) ||
      localPart.includes('..')) throw new TypeError('Invalid mailbox local part');
  const address = `${localPart}@${domain.toLowerCase()}`;
  return Object.freeze({address, provider: provider.provider, incoming: provider.incoming,
    outgoing: provider.outgoing, needsUserScopedAppPassword: true,
    sendsDisabledUntilVerified: true});
}

export function purelymailDnsPlan(domain, ownershipProof = null) {
  if (!validDomain(domain)) throw new TypeError('Invalid mail domain');
  const root = domain.toLowerCase();
  if (ownershipProof !== null && (typeof ownershipProof !== 'string' ||
      !/^purelymail_ownership_proof=[A-Za-z0-9_.-]{8,512}$/.test(ownershipProof))) {
    throw new TypeError('Use the account-specific ownership proof TXT value from Purelymail');
  }
  const records = [
    {type: 'MX', name: root, content: 'mailserver.purelymail.com', priority: 50},
    {type: 'TXT', name: root, content: 'v=spf1 include:_spf.purelymail.com ~all'},
    ...[1, 2, 3].map(i => ({type: 'CNAME', name: `purelymail${i}._domainkey.${root}`,
      content: `key${i}.dkimroot.purelymail.com`, proxied: false})),
    {type: 'CNAME', name: `_dmarc.${root}`, content: 'dmarcroot.purelymail.com', proxied: false},
  ];
  if (ownershipProof) records.splice(2, 0, {type: 'TXT', name: root, content: ownershipProof});
  return Object.freeze({domain: root, provider: 'purelymail',
    awaitingAccountSpecificOwnershipProof: !ownershipProof,
    records: Object.freeze(records.map(item => Object.freeze({...item}))),
  });
}

const normalizeContent = value => String(value ?? '').replace(/^"|"$/g, '').trim().replace(/\.$/, '').toLowerCase();
const normalizeName = value => String(value ?? '').trim().replace(/\.$/, '').toLowerCase();

export function auditMailDns(plan, existingRecords) {
  if (!plan || !validDomain(plan.domain) || !Array.isArray(plan.records) || !Array.isArray(existingRecords)) {
    throw new TypeError('Invalid DNS audit inputs');
  }
  const existing = existingRecords.map(r => ({...r, type: String(r.type ?? '').toUpperCase(), name: normalizeName(r.name)}));
  const missing = [], conflicts = [], matched = [];
  for (const desired of plan.records) {
    const sameNameType = existing.filter(r => r.name === normalizeName(desired.name) && r.type === desired.type);
    const target = sameNameType.find(r => normalizeContent(r.content) === normalizeContent(desired.content) &&
      (desired.type !== 'MX' || Number(r.priority) === desired.priority) &&
      (desired.type !== 'CNAME' || r.proxied === false));
    if (target) matched.push({type: desired.type, name: desired.name});
    else missing.push({...desired});
    for (const other of sameNameType) {
      if (desired.type === 'MX' && (normalizeContent(other.content) !== normalizeContent(desired.content) || Number(other.priority) !== desired.priority)) {
        conflicts.push({type: 'MX', name: desired.name, reason: 'other_mail_receiver'});
      } else if (desired.type === 'TXT' && desired.content.startsWith('v=spf1') &&
          /^v=spf1\b/i.test(normalizeContent(other.content)) && normalizeContent(other.content) !== normalizeContent(desired.content)) {
        conflicts.push({type: 'TXT', name: desired.name, reason: 'another_spf_policy'});
      } else if (desired.type === 'CNAME' && (normalizeContent(other.content) !== normalizeContent(desired.content) || other.proxied !== false)) {
        conflicts.push({type: 'CNAME', name: desired.name, reason: 'different_or_proxied_cname'});
      }
    }
    if (desired.type === 'CNAME') {
      for (const other of existing.filter(r => r.name === normalizeName(desired.name) && r.type !== 'CNAME')) {
        conflicts.push({type: other.type, name: desired.name, reason: 'cname_name_collision'});
      }
    }
  }
  // Any MX at the chosen root that differs from Purelymail is conflicting even when the planned one is present.
  for (const other of existing.filter(r => r.name === plan.domain && r.type === 'MX' &&
    normalizeContent(r.content) !== 'mailserver.purelymail.com')) {
    if (!conflicts.some(c => c.name === other.name && c.reason === 'other_mail_receiver')) {
      conflicts.push({type: 'MX', name: other.name, reason: 'other_mail_receiver'});
    }
  }
  return Object.freeze({domain: plan.domain, matched, missing, conflicts,
    ownershipProofRequired: !!plan.awaitingAccountSpecificOwnershipProof,
    ready: !plan.awaitingAccountSpecificOwnershipProof && missing.length === 0 && conflicts.length === 0});
}

export function mailActivationGate({dnsAudit, providerDomainVerified = false, mailboxCreated = false,
  appPasswordStoredServerSide = false, inboundTestVerified = false, outboundTestVerified = false} = {}) {
  const checks = {
    dns: dnsAudit?.ready === true,
    providerDomain: providerDomainVerified === true,
    mailbox: mailboxCreated === true,
    secretCustody: appPasswordStoredServerSide === true,
    inbound: inboundTestVerified === true,
    outbound: outboundTestVerified === true,
  };
  return Object.freeze({ready: Object.values(checks).every(Boolean), checks,
    missing: Object.entries(checks).filter(([, value]) => !value).map(([name]) => name)});
}
