/** Test-only synthetic Worker. Do not import in RB01 or a deployed route. */
import {createNewsroomHandler} from '../worker/newsroom.mjs';
import {createNewsroomConversationHandler} from '../worker/newsroom-conversations.mjs';
const publication=createNewsroomHandler(),discussion=createNewsroomConversationHandler();
export default {fetch(request,env,ctx){
 const url=new URL(request.url);
 return url.pathname.startsWith('/api/newsroom/conversations/')
  ?discussion.fetch(request,env,ctx):publication.fetch(request,env,ctx);
}};
