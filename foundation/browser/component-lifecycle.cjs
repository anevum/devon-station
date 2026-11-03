// Lifecycle helpers for isolated component QA only; never used by the application Worker.
async function closeComponentServer(server,dispose){
 const results=await Promise.allSettled([
  new Promise((resolve,reject)=>{
   server.close(error=>error?reject(error):resolve());
   // Browser disconnects can leave an unfinished HTTP response alive indefinitely.
   // QA has finished using this private local listener, so terminate its remaining sockets.
   server.closeAllConnections();
  }),
  Promise.resolve().then(dispose)
 ]);
 const failures=results.filter(result=>result.status==='rejected').map(result=>result.reason);
 if(failures.length)throw new AggregateError(failures,'component_cleanup_failed');
}
function deadline(milliseconds,onTimeout){
 const timer=setTimeout(onTimeout,milliseconds);timer.unref();
 return ()=>clearTimeout(timer);
}
module.exports={closeComponentServer,deadline};
