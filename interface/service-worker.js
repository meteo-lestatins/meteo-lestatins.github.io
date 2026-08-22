const cacheName = "meteo-interface-b20260822104352058";
const shell = ["/interface/runtime-config.js?v=3.027", "/interface/changelog.html", "/interface/", "/interface/index.html", "/interface/style.css?v=114", "/interface/app.js?v=175", "/interface/analytics.js?v=1", "/interface/manifest.webmanifest", "/interface/contact/", "/interface/contact/index.html", "/interface/contact/contact.css?v=4", "/interface/contact/contact.js?v=1", "/interface/news/", "/interface/news/index.html", "/interface/news/news.css?v=2", "/interface/news/markdown.js?v=1", "/interface/news/news.js?v=3", "/interface/evenements.html", "/interface/evenements/2026-08-04-grele-les-tatins.html", "/interface/evenements/evenements.css?v=2", "/interface/evenements/event-player.js?v=3", "/interface/evenements/data/2026-08-04-grele-les-tatins.json", "/interface/evenements/data/2026-08-04-grele-les-tatins-radar.json", "/interface/vendor/leaflet/leaflet.css", "/interface/vendor/leaflet/leaflet.js"];
const publicRoots = new Set(["", "index.html", "style.css", "app.js", "analytics.js", "manifest.webmanifest", "runtime-config.js", "about.html", "architecture.svg", "echelle-kilometrique.css", "echelle-kilometrique.js", "changelog", "changelog.html", "contact", "news", "evenements", "evenements.html", "nowcasting-replay.html", "vendor"]);

function publicCacheTarget(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.origin !== location.origin || !url.pathname.startsWith(scopePath)) return false;
  const relativePath = url.pathname.slice(scopePath.length).replace(/^\/+/, "");
  const root = relativePath.split("/interface/", 1)[0];
  return publicRoots.has(root);
}

self.addEventListener("install", event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!publicCacheTarget(url)) return;
  if (event.request.mode === "navigate" || url.pathname.endsWith("/interface/changelog") || url.pathname.endsWith("/interface/changelog.html")) {
    const network = fetch(event.request).then(async response => {
      if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
      return response;
    });
    event.respondWith(network.catch(() => caches.match(event.request).then(response => response || caches.match("/interface/index.html"))));
    return;
  }
  const update = fetch(event.request).then(async response => {
    if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
    return response;
  });
  event.waitUntil(update.catch(() => {}));
  event.respondWith(caches.match(event.request).then(cached => cached || update));
});
