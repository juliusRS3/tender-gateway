/* Tender Gateway service worker - makes the site installable and fast.
   App shell is cached; API calls and tender data always go to the network. */
const CACHE = 'tg-v14';
const SHELL = ['/', '/index.html', '/app.js?v=14', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;         // let cross-origin (fonts) pass through
  if (url.pathname.startsWith('/api/')) return;        // never cache API or data
  // App shell: always try the network first so updates show at once; use the cache only when offline.
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('/')))
  );
});
