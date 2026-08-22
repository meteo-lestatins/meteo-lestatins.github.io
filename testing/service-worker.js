const cacheName = "meteo-testing-b20260822170332984";
const shell = ["/testing/runtime-config.js?v=3.037", "/testing/changelog.html", "/testing/", "/testing/index.html", "/testing/style.css?v=123", "/testing/app.js?v=184", "/testing/analytics.js?v=1", "/testing/manifest.webmanifest", "/testing/data/temperature-normals.json", "/testing/contact/", "/testing/contact/index.html", "/testing/contact/contact.css?v=4", "/testing/contact/contact.js?v=1", "/testing/news/", "/testing/news/index.html", "/testing/news/news.css?v=2", "/testing/news/markdown.js?v=1", "/testing/news/news.js?v=3", "/testing/evenements.html", "/testing/evenements/2026-08-04-grele-les-tatins.html", "/testing/evenements/evenements.css?v=2", "/testing/evenements/event-player.js?v=3", "/testing/evenements/data/2026-08-04-grele-les-tatins.json", "/testing/evenements/data/2026-08-04-grele-les-tatins-radar.json", "/testing/vendor/leaflet/leaflet.css", "/testing/vendor/leaflet/leaflet.js"];
const publicRoots = new Set(["", "index.html", "style.css", "app.js", "analytics.js", "manifest.webmanifest", "runtime-config.js", "about.html", "architecture.svg", "echelle-kilometrique.css", "echelle-kilometrique.js", "changelog", "changelog.html", "contact", "data", "news", "evenements", "evenements.html", "nowcasting-replay.html", "vendor"]);

function publicCacheTarget(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.origin !== location.origin || !url.pathname.startsWith(scopePath)) return false;
  const relativePath = url.pathname.slice(scopePath.length).replace(/^\/+/, "");
  const root = relativePath.split("/testing/", 1)[0];
  return publicRoots.has(root);
}

self.addEventListener("install", event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!publicCacheTarget(url)) return;
  if (event.request.mode === "navigate" || url.pathname.endsWith("/testing/changelog") || url.pathname.endsWith("/testing/changelog.html")) {
    const network = fetch(event.request).then(async response => {
      if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
      return response;
    });
    event.respondWith(network.catch(() => caches.match(event.request).then(response => response || caches.match("/testing/index.html"))));
    return;
  }
  const update = fetch(event.request).then(async response => {
    if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
    return response;
  });
  event.waitUntil(update.catch(() => {}));
  event.respondWith(caches.match(event.request).then(cached => cached || update));
});
