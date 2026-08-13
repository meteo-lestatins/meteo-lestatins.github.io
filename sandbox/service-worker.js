const cacheName = "meteo-sandbox-v22";
const shell = ["/sandbox/runtime-config.js?v=2.061", "/sandbox/changelog.html", "/sandbox/", "/sandbox/index.html", "/sandbox/style.css?v=107", "/sandbox/app.js?v=137", "/sandbox/manifest.webmanifest", "/sandbox/vendor/leaflet/leaflet.css", "/sandbox/vendor/leaflet/leaflet.js"];
self.addEventListener("install", event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/sandbox/api/")) return;
  if (event.request.mode === "navigate" || url.pathname.endsWith("/sandbox/changelog") || url.pathname.endsWith("/sandbox/changelog.html")) {
    const network = fetch(event.request).then(async response => {
      if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
      return response;
    });
    event.respondWith(network.catch(() => caches.match(event.request).then(response => response || caches.match("/sandbox/index.html"))));
    return;
  }
  const update = fetch(event.request).then(async response => {
    if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
    return response;
  });
  event.waitUntil(update.catch(() => {}));
  event.respondWith(caches.match(event.request).then(cached => cached || update));
});
