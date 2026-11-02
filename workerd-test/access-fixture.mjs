// Synthetic-only entry exercising the real default auth and JWKS fetch in workerd.
// No injected verifier, production credentials, persistence or external operations.
import {createStation} from '../worker/index.mjs';
const assets={
 '/index.html':{type:'text/html',encoding:'utf8',body:'SYNTHETIC_PRIVATE_SHELL'},
 '/manifest.webmanifest':{type:'application/manifest+json',encoding:'utf8',body:'SYNTHETIC_PRIVATE_MANIFEST'},
 '/sw.js':{type:'text/javascript',encoding:'utf8',body:'// synthetic public worker'}
};
export default createStation(assets);
