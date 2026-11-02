/** Synthetic-only Workerd routing composition; NOT loaded by the production Worker. */
import {createNewsroomHandler} from '../worker/newsroom.mjs';
import {createNewsroomConversationHandler} from '../worker/newsroom-conversations.mjs';
import {createNewsroomReaderHandler} from '../worker/newsroom-reader.mjs';
const edition=createNewsroomHandler(),conversation=createNewsroomConversationHandler(),reader=createNewsroomReaderHandler();
export default {fetch(request,env,ctx){
 const path=new URL(request.url).pathname;
 if(path.startsWith('/newsroom/reader/'))return reader.fetch(request,env,ctx);
 if(path.startsWith('/api/newsroom/conversations/'))return conversation.fetch(request,env,ctx);
 return edition.fetch(request,env,ctx);
}};
