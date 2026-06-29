/* Bomb Arena service worker — caches the app shell so it installs + works
 * offline (menus). Network-first for same-origin GETs so the latest build is
 * served when online; falls back to cache when offline. Socket.io traffic and
 * cross-origin requests are left to the network. */
const CACHE = 'bomb-arena-v3-2';
const SHELL = ['./', 'index.html', 'style.css', 'client.js', 'shared.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;     // network
  if (u.pathname.startsWith('/socket.io')) return;                            // realtime: network only
  e.respondWith(
    fetch(e.request)
      .then((r) => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)).catch(() => {}); return r; })
      .catch(() => caches.match(e.request).then(m => m || caches.match('index.html')))
  );
});
