const cacheName = "meteo-sandbox-b20260821162926532";
const shell = ["/sandbox/about.html", "/sandbox/architecture.svg", "/sandbox/echelle-kilometrique.css?v=8", "/sandbox/echelle-kilometrique.js?v=13", "/sandbox/runtime-config.js?v=3.020", "/sandbox/changelog.html", "/sandbox/", "/sandbox/index.html", "/sandbox/style.css?v=145", "/sandbox/app.js?v=195", "/sandbox/analytics.js?v=1", "/sandbox/manifest.webmanifest", "/sandbox/contact/", "/sandbox/contact/index.html", "/sandbox/contact/contact.css?v=4", "/sandbox/contact/contact.js?v=1", "/sandbox/news/", "/sandbox/news/index.html", "/sandbox/news/news.css?v=2", "/sandbox/news/markdown.js?v=1", "/sandbox/news/news.js?v=3", "/sandbox/evenements.html", "/sandbox/evenements/2026-08-04-grele-les-tatins.html", "/sandbox/evenements/evenements.css?v=2", "/sandbox/evenements/event-player.js?v=3", "/sandbox/evenements/data/2026-08-04-grele-les-tatins.json", "/sandbox/evenements/data/2026-08-04-grele-les-tatins-radar.json", "/sandbox/vendor/leaflet/leaflet.css", "/sandbox/vendor/leaflet/leaflet.js"];
self.addEventListener("install", event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (
    url.origin !== location.origin ||
    url.pathname.startsWith("/sandbox/api/") ||
    url.pathname === "/sandbox/usage-guard" ||
    url.pathname.startsWith("/sandbox/usage-guard/")
  ) return;
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
