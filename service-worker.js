/* =========================================================
   Vonk — service worker
   Kernbestanden cache-first zodat de app offline opent.
   De databron gaat via network-first met cache als terugval,
   zodat Fase 2 (live feed) verse data krijgt maar offline
   de laatst geladen data blijft werken.
   ========================================================= */

const VERSION = 'vonk-v6';
const SHELL_CACHE = VERSION + '-shell';
const DATA_CACHE = VERSION + '-data';

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './sync.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Alles wat als "de feed" telt: het live endpoint eerst, daarna de lokale
// terugvalbestanden. Deze paden gaan network-first met de cache als vangnet,
// zodat de app offline de laatst geladen feed toont.
// Paden die nooit cache-first mogen: dynamische antwoorden die per verzoek
// kunnen verschillen. (Supabase draait op een eigen domein en valt al onder
// de cross-origin-tak, maar een self-hosted opstelling kan same-origin zijn.)
const NEVER_CACHE_FIRST = ['/.netlify/functions/', '/rest/v1/', '/api/'];

const DATA_PATHS = [
  '/.netlify/functions/get-feed',
  '/data/feed.json',
  '/data/dummy-data.json',
  // De Supabase-configuratie wordt per deploy gegenereerd; hem cache-first
  // serveren zou een gewijzigde sleutel dagenlang stil kunnen blokkeren.
  '/public/supabase-config.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
      // Het dummy-bestand alvast meenemen zodat ook de allereerste offline
      // start iets te tonen heeft. Het live endpoint komt in de cache zodra
      // het voor het eerst is opgehaald.
      caches.open(DATA_CACHE)
        .then((cache) => cache.add('./data/dummy-data.json'))
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

  // Alles wat dynamisch is blijft van het netwerk komen, ook al staat het op
  // dezelfde origin: functions en database-verkeer mogen nooit uit de cache
  // beantwoord worden, anders krijgt de app een bevroren antwoord terug.
  if (sameOrigin && NEVER_CACHE_FIRST.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
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
