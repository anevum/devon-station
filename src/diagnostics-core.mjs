/** Privacy-preserving, content-free device health report for support and release checks. */
const MODES=new Set(['connecting','live','import-required','blocked','reviewing','importing','local-only','unknown']);
const count=value=>Array.isArray(value)?Math.min(value.length,100000):0;
export function createClientDiagnostics({local={},cloud=null,storageAvailable=false,journalPresent=false,generatedAt=new Date().toISOString(),version='0.4.8'}={}){
 const mode=MODES.has(cloud?.mode)?cloud.mode:'unknown';
 const revision=Number.isSafeInteger(cloud?.revision)&&cloud.revision>=0?cloud.revision:null;
 return {
  kind:'devon-station-device-diagnostics',schemaVersion:1,
  generatedAt:typeof generatedAt==='string'&&/^\d{4}-\d\d-\d\dT/.test(generatedAt)?generatedAt:'unknown',
  appVersion:/^0\.4\.8$/.test(version)?version:'unknown',
  device:{localStorageWritesWorking:storageAvailable===true,tabRecoveryJournalPresent:journalPresent===true,
   draftCount:count(local?.drafts),feedbackCount:count(local?.feedback),focusMarkCount:count(local?.outcomes),activityCount:count(local?.history)},
  privateSync:{status:mode,revision,unconfirmedChanges:cloud?.pending===true,externalTabChangeObserved:cloud?.externalChange===true},
  security:{containsDraftText:false,containsAccountIdentifiers:false,containsCredentials:false,containsNotionRecords:false},
  note:'Counts and connection state only. This report is not a backup and does not establish production acceptance.'
 };
}
