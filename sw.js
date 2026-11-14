/* Tender Gateway service worker - makes the site installable and still work offline,
   while always showing the latest version when online.
   Strategy: network-first for pages and scripts (fresh on every online load),
   fall back to the cached copy only when offline. API calls are never cached. */
const CACHE = 'tg-v2';
const SHELL = ['/', '/index.html', '/app.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // let cross-origin (fonts) pass through
  if (url.pathname.startsWith('/api/')) return;  // never cache API or data
  // Network-first: use the live version when online, cache only as offline fallback.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});
