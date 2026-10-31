// A mapping layer only: the trusted verifyAssertion callback must perform full
// provider signature, issuer, audience and time validation on every call.
const deny = () => { throw new Error('access denied'); };
const identifier = value => typeof value==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const subjectValid = value => typeof value==='string' && value.length>0 && value.length<=128 && value.trim()===value && !/[\u0000-\u001f\u007f]/.test(value);
const exact = (value,keys) => value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));

export function createAccessScopeBridge({verifyAssertion,grants}) {
  if(typeof verifyAssertion!=='function' || !Array.isArray(grants) || grants.length>100) deny();
  const seen=new Set();
  const allowed=grants.map(grant=>{
    if(!exact(grant,['subject','principalId','scopeKind','scopeId','role']) || !subjectValid(grant.subject) || !identifier(grant.principalId) || !identifier(grant.scopeId) || !['personal','business','creative'].includes(grant.scopeKind) || grant.role!=='owner') deny();
    const key=JSON.stringify([grant.subject,grant.scopeKind,grant.scopeId]);if(seen.has(key))deny();seen.add(key);return structuredClone(grant);
  });
  return Object.freeze({
    async authorize(assertion,scope) {
      if(typeof assertion!=='string' || assertion.length<1 || assertion.length>12000 || !exact(scope,['scopeKind','scopeId']) || !['personal','business','creative'].includes(scope.scopeKind) || !identifier(scope.scopeId)) deny();
      let verified;try { verified=await verifyAssertion(assertion); } catch { deny(); }
      if(!verified || !subjectValid(verified.subject)) deny();
      const grant=allowed.find(g=>g.subject===verified.subject && g.scopeKind===scope.scopeKind && g.scopeId===scope.scopeId);
      if(!grant)deny();
      return {principalId:grant.principalId,role:grant.role,scopeKind:grant.scopeKind,scopeId:grant.scopeId};
    }
  });
}
