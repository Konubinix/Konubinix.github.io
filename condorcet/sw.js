const CACHE = 'condorcet-v1';
const ASSETS = ['./', './index.html', './bundle.js'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    if(e.request.mode === 'navigate'){
        e.respondWith(
            fetch(e.request)
                .then(r => caches.open(CACHE).then(c => { c.put(e.request, r.clone()); return r; }))
                .catch(() => caches.match(e.request))
        );
    } else {
        e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    }
});
