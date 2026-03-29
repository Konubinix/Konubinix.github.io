// [[id:16c070b8-5772-4361-bc3e-595330a61148::+BEGIN_SRC js :results verbatim :exports none :noweb yes :tangle ~/perso/org-publish/github/tally/sw.js][No heading:3]]
const CACHE = 'tally-v6';
const ASSETS = [
  './',
  './index.html',
  'https://esm.sh/alpinejs@3',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    // Network-first for pages — always get the latest HTML
    e.respondWith(
      fetch(e.request)
        .then(r => caches.open(CACHE).then(c => { c.put(e.request, r.clone()); return r; }))
        .catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first for static assets (CDN libs)
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
  }
});
// No heading:3 ends here
