const CACHES = [{ name: 'vignettes-v1' }];
const ASSETS = ['./', './index.html'];
function cacheNameFor(request){
    const url = new URL(request.url);
    for(const c of CACHES){
        if(!c.pattern || c.pattern.test(url.pathname)) return c.name;
    }
    return CACHES[CACHES.length - 1].name;
}

self.addEventListener('install', e => {
    const defaultCache = CACHES[CACHES.length - 1].name;
    e.waitUntil(caches.open(defaultCache).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    const valid = new Set(CACHES.map(c => c.name));
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.filter(k => !valid.has(k)).map(k => caches.delete(k)))
    ));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    const name = cacheNameFor(e.request);
    if(e.request.mode === 'navigate'){
        e.respondWith(
            fetch(e.request)
                .then(r => caches.open(name).then(c => { c.put(e.request, r.clone()); return r; }))
                .catch(() => caches.match(e.request))
        );
    } else {
        e.respondWith(caches.open(name).then(c =>
            c.match(e.request).then(cached => {
                if(cached) return cached;
                return fetch(e.request).then(net => {
                    if(net.ok) c.put(e.request, net.clone());
                    return net;
                });
            })
        ));
    }
});
