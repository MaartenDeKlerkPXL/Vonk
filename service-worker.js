/* =========================================================
   Vonk — service worker
   Kernbestanden cache-first zodat de app offline opent.
   De databron gaat via network-first met cache als terugval,
   zodat Fase 2 (live feed) verse data krijgt maar offline
   de laatst geladen data blijft werken.
   ========================================================= */

const VERSION = 'vonk-v2';
const SHELL_CACHE = VERSION + '-shell';
const DATA_CACHE = VERSION + '-data';

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Fase 2: zet hier het pad van de live feed naast (of in plaats van) het dummy-bestand.
const DATA_PATHS = ['/data/dummy-data.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
      // de databron alvast meenemen zodat de eerste offline start ook werkt
      caches.open(DATA_CACHE)
        .then((cache) => cache.addAll(DATA_PATHS.map((p) => '.' + p)))
        .catch((err) => console.warn('[vonk-sw] databron niet vooraf gecachet:', err))
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Databron: network-first, val terug op de cache als er geen net is.
  if (sameOrigin && DATA_PATHS.some((path) => url.pathname.endsWith(path))) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(DATA_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || new Response(
          JSON.stringify({ error: 'offline' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )))
    );
    return;
  }

  // Navigaties: netwerk proberen, anders de gecachete shell tonen.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Externe bestanden (bijvoorbeeld foto's): netwerk, cache als terugval.
  if (!sameOrigin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Eigen bestanden: cache-first.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response && response.status === 200) {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }))
  );
});
