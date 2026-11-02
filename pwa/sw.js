/* Generic visible notifications only. No private pages, APIs or snapshots cached. */
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>event.waitUntil(self.registration.showNotification('Devon Station',{body:'An update is ready. Open your private station to review it.',icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:'devon-station',data:{url:'/'}})));
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const target=new URL('/',self.location.origin).href;const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});for(const client of clients){if(new URL(client.url).origin===self.location.origin){await client.navigate(target);return client.focus()}}return self.clients.openWindow(target)})());});
