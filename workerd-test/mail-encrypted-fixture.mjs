// Local synthetic-only Worker fixture. Never deployed and never opens a socket.
import {mailPayloadCipherFromEnv} from '../src/communications/mail-payload-crypto.mjs';
import {createD1DraftStore} from '../src/communications/mail-drafts.mjs';
import {createD1MailStore} from '../src/communications/mail-d1-store.mjs';
import {createD1Outbox} from '../src/communications/mail-outbox.mjs';
const scope={installationId:'personal',mailboxId:'hello',ownerSub:'synthetic-owner'};
const draftId='a0000000-0000-4000-8000-000000000001',operationId='a0000000-0000-4000-8000-000000000002';
const deliveryId='a0000000-0000-4000-8000-000000000003';
const draft={to:['synthetic-recipient@example.test'],subject:'Native confidential subject',body:'Native confidential body'};
export default {async fetch(request,env){
 try{
  const cipher=mailPayloadCipherFromEnv(env),drafts=createD1DraftStore(env.MAIL,{cipher,protectLinkedOutbox:true});
  const inbox=createD1MailStore(env.MAIL,{cipher,ownerSub:scope.ownerSub}),outbox=createD1Outbox(env.MAIL,scope,{cipher});
  if(new URL(request.url).pathname==='/seed'){
   await drafts.create(scope,draftId);await drafts.save(scope,{id:draftId,revision:1,operationId,...draft});
   await inbox.commitSnapshot({scope,expectedRevision:0,next:{cursor:{uidValidity:7,highestUid:1},records:[{
    ...scope,key:'personal/hello/7/1',uidValidity:7,uid:1,from:'synthetic-author@example.test',replyTo:'private-reply-target@example.test',subject:draft.subject,text:draft.body,timestamp:'2026-01-01T00:00:00Z',flags:[]
   }]}});
   await outbox.offerLinkedDraft(deliveryId,{draftId,draftRevision:2,payload:{from:'hello@devonakins.com',draft,date:'2026-01-01T00:00:00Z'}});
  }
  const saved=await drafts.read(scope,draftId),snapshot=await inbox.readSnapshot(scope),delivery=await outbox.read(deliveryId);
  if(snapshot.records[0]?.replyTo!=='private-reply-target@example.test'||saved?.body!==draft.body||snapshot.records[0]?.text!==draft.body||delivery?.payload.draft.body!==draft.body)throw Error('synthetic read mismatch');
  return Response.json({recovered:true,revision:saved.revision,inbox:snapshot.records.length,state:delivery.state});
 }catch{return Response.json({error:'encrypted_mail_unavailable'},{status:503});}
}};
