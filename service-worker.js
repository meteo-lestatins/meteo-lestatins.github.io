const cacheName = "meteo-main-v2-118-r1";
const shell = ["/about.html", "/architecture.svg", "/echelle-kilometrique.css?v=8", "/echelle-kilometrique.js?v=13", "/runtime-config.js?v=2.118", "/changelog.html", "/", "/index.html", "/style.css?v=134", "/app.js?v=174", "/manifest.webmanifest", "/evenements.html", "/evenements/2026-08-04-grele-les-tatins.html", "/evenements/evenements.css?v=2", "/evenements/event-player.js?v=3", "/evenements/data/2026-08-04-grele-les-tatins.json", "/evenements/data/2026-08-04-grele-les-tatins-radar.json", "/vendor/leaflet/leaflet.css", "/vendor/leaflet/leaflet.js"];
self.addEventListener("install", event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (
    url.origin !== location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/usage-guard" ||
    url.pathname.startsWith("/usage-guard/")
  ) return;
  if (event.request.mode === "navigate" || url.pathname.endsWith("/changelog") || url.pathname.endsWith("/changelog.html")) {
    const network = fetch(event.request).then(async response => {
      if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
      return response;
    });
    event.respondWith(network.catch(() => caches.match(event.request).then(response => response || caches.match("/index.html"))));
    return;
  }
  const update = fetch(event.request).then(async response => {
    if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
    return response;
  });
  event.waitUntil(update.catch(() => {}));
  event.respondWith(caches.match(event.request).then(cached => cached || update));
});
