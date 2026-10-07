const CACHE='spendwise-v12';
const ASSETS=['./','./index.html','./api-client.js?v=12','./manifest.json','./give-money.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('spendwise-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
  if(new URL(e.request.url).pathname.startsWith('/api/'))return;
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(response=>{
    if(response.ok)caches.open(CACHE).then(cache=>cache.put(e.request,response.clone()));
    return response;
  }).catch(error=>{
    if(e.request.mode==='navigate')return caches.match('./index.html');
    throw error;
  })));
});
