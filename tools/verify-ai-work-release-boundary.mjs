// Source-review guard only. The protected mail uploader and its approval pins stay unchanged.
import {readFileSync} from 'node:fs';
import {verifyReviewCandidate} from './comms-acceptance-upload.mjs';
const manifest=JSON.parse(readFileSync(new URL('../release-review/manifest.json',import.meta.url),'utf8'));
const candidateBytes=readFileSync(new URL('../release-review/candidate.modules.json',import.meta.url));
const candidate=JSON.parse(candidateBytes);
if(!Object.hasOwn(candidate,'worker/ai-work-api.mjs')){
 verifyReviewCandidate({manifest,candidateBytes,expectedSha:manifest.sourceCommit});
}else{
 let refused=false;
 try{verifyReviewCandidate({manifest,candidateBytes,expectedSha:manifest.sourceCommit});}
 catch(error){if(error.message==='DS011 acceptance refused: module inventory differs from reviewed build')refused=true;else throw error;}
 if(!refused)throw Error('Mail-only upload guard unexpectedly accepted the AI Work candidate');
 console.log('PASS: AI Work review bundle is refused by the unchanged mail-only acceptance uploader. No upload authorized.');
}
