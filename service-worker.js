/* Retires the previous Budget Planner web worker; no Firebase or push code. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 const scope=self.registration.scope;
 for(const key of await caches.keys())if(key.startsWith('socialcreator-budget-cache-'))await caches.delete(key);
 for(const notification of await self.registration.getNotifications())notification.close();
 await self.clients.claim();
 await self.registration.unregister();
 for(const client of await self.clients.matchAll({type:'window'}))if(client.url.startsWith(scope))await client.navigate(client.url);
})()));
