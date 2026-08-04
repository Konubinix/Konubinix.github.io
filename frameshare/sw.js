const SHELL = 'frameshare-53284d3';
const KEEP = ['', 'index.html', 'app.js?53284d3', 'style.css?53284d3',
              'manifest.json', 'icon.svg'];
self.addEventListener('install', e => e.waitUntil(
    caches.open(SHELL).then(c => c.addAll(KEEP)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil((async () => {
    for(const k of await caches.keys()) if(k !== SHELL) await caches.delete(k);
    await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if(e.request.method !== 'GET' || url.origin !== location.origin) return;
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
