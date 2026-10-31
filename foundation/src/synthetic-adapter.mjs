import { verify, KeyObject } from 'node:crypto';
import { createFoundation, restoreFoundation } from './foundation.mjs';

const fail = () => { throw new Error('denied or invalid request'); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const fields = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj,k));
const decode = part => {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) fail();
  const bytes=Buffer.from(part,'base64url'); if(bytes.toString('base64url')!==part) fail(); return bytes;
};
const validIdentity = x => fields(x,['principalId','role','scopeKind','scopeId']) && identifier(x.principalId) && x.role==='owner' && ['personal','business','creative'].includes(x.scopeKind) && identifier(x.scopeId);

// Test-only adapter. All configuration, grants, seed projections and the public key
// must be provided by a trusted caller. A signed bearer assertion is not a session.
export function openSyntheticAdapter({ db, publicKey, issuer, audience, grants, seeds, clock = () => Date.now() }) {
  if (!(publicKey instanceof KeyObject) || publicKey.type!=='public' || publicKey.asymmetricKeyType!=='ed25519' || !identifier(issuer) || !identifier(audience) || !Array.isArray(grants) || !Array.isArray(seeds) || grants.length>100 || seeds.length>100) fail();
  const allowed=grants.map(x=>{if(!validIdentity(x)) fail();return structuredClone(x);});
  const granted = x => allowed.some(g=>Object.keys(g).every(k=>g[k]===x[k]));
  const assertIdentity = token => {
    if(typeof token!=='string' || token.length>4096) fail();
    const parts=token.split('.'); if(parts.length!==2) fail();
    const payload=decode(parts[0]), signature=decode(parts[1]);
    if(payload.length>2048 || signature.length!==64 || !verify(null,payload,publicKey,signature)) fail();
    let value;try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payload)); } catch { fail(); }
    if(!fields(value,['iss','aud','sub','scopeKind','scopeId','iat','exp']) || value.iss!==issuer || value.aud!==audience || !identifier(value.sub) || !identifier(value.scopeId) || !['personal','business','creative'].includes(value.scopeKind) || !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp) || value.exp<=value.iat || value.exp-value.iat>300) fail();
    const now=Math.floor(clock()/1000); if(!Number.isSafeInteger(now) || value.iat>now || value.exp<=now) fail();
    const identity={principalId:value.sub,role:'owner',scopeKind:value.scopeKind,scopeId:value.scopeId}; if(!granted(identity)) fail(); return identity;
  };
  db.exec(`CREATE TABLE IF NOT EXISTS synthetic_scope_state (
    scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, principal_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 0), snapshot TEXT NOT NULL,
    PRIMARY KEY(scope_kind,scope_id)
  )`);
  const get=db.prepare('SELECT principal_id,generation,snapshot FROM synthetic_scope_state WHERE scope_kind=? AND scope_id=?');
  const insert=db.prepare('INSERT OR IGNORE INTO synthetic_scope_state(scope_kind,scope_id,principal_id,generation,snapshot) VALUES(?,?,?,0,?)');
  const update=db.prepare('UPDATE synthetic_scope_state SET generation=generation+1,snapshot=? WHERE scope_kind=? AND scope_id=? AND principal_id=? AND generation=?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const seed of seeds) {
      if(!fields(seed,['identity','projects']) || !validIdentity(seed.identity) || !granted(seed.identity)) fail();
      const {identity,projects}=seed;
      const fresh=createFoundation({identity,projects}); insert.run(identity.scopeKind,identity.scopeId,identity.principalId,fresh.export(identity));
      const row=get.get(identity.scopeKind,identity.scopeId);if(row.principal_id!==identity.principalId) fail();
      restoreFoundation({identity,serialized:row.snapshot});
    }
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  function load(identity) {
    const row=get.get(identity.scopeKind,identity.scopeId);if(!row || row.principal_id!==identity.principalId) fail();
    return {row,store:restoreFoundation({identity,serialized:row.snapshot})};
  }
  return Object.freeze({
    read(token) {
      const identity=assertIdentity(token);const {row,store}=load(identity);
      return {generation:row.generation,projects:store.projects(identity),actions:store.actions(identity),receipts:store.receipts(identity)};
    },
    mutate(token,expectedGeneration,kind,input) {
      const identity=assertIdentity(token);if(!Number.isSafeInteger(expectedGeneration) || expectedGeneration<0 || !['propose','decide'].includes(kind)) fail();
      db.exec('BEGIN IMMEDIATE');
      try {
        const {row,store}=load(identity); const receipt=store[kind](identity,input); const next=store.export(identity);
        // Identical retries do not mutate state and are safe even after generation advances.
        if(next===row.snapshot) { db.exec('COMMIT'); return {generation:row.generation,receipt}; }
        if(row.generation!==expectedGeneration) fail();
        if(update.run(next,identity.scopeKind,identity.scopeId,identity.principalId,row.generation).changes!==1) fail();
        db.exec('COMMIT');return {generation:row.generation+1,receipt};
      } catch(error) { db.exec('ROLLBACK'); throw error; }
    }
  });
}
