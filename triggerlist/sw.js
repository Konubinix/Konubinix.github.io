// [[id:4f21ee3e-33b2-40ec-aae8-d45eb8fb38cf][How it all fits together:15]]
const CACHE = 'triggerlist-<<build-hash()>>';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
    caches.keys()
        .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
        .then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
    if(e.request.method !== 'GET') return;
    if(!['document', 'script'].includes(e.request.destination)) return;
    e.respondWith(
        fetch(e.request)
            .then((res) => {
                if(res.ok){
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(e.request, copy));
                }
                return res;
            })
            .catch(() => caches.match(e.request))
    );
});
// How it all fits together:15 ends here
