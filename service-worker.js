const prefix = "meteo-local-";
const cacheName = prefix + "1.24";
const shell = ["./","index.html","runtime-config.js?v=1.24","app.js?v=1.24","style.css?v=1.24","compact-forecast.css?v=1.24","forecast-core.js?v=1.24","daily-rows.js?v=1.24","compact-forecast.js?v=1.24","card-periods.js?v=1.24","precipitation-24h.js?v=1.24","pictogrammes/calque-traces-pluie.svg","nowcast/engine.js?v=1.24","nowcast/map.js?v=1.24","manifest.webmanifest"].map(p => new URL(p, self.registration.scope).href);
self.addEventListener('install', event => event.waitUntil(caches.open(cacheName)
  .then(c => c.addAll(shell.map(url => new Request(url, { cache: 'reload' }))))
  .then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(prefix) && k !== cacheName).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url), scope = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname) || url.pathname.includes('/api/')) return;
  event.respondWith(fetch(event.request).then(async response => {
    if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || (event.request.mode === 'navigate' ? caches.match(new URL('index.html', scope).href) : Response.error()))));
});
