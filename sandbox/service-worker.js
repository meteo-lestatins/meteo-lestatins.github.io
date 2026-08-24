const cacheName = "meteo-sandbox-b20260824024615493";
const shell = ["/sandbox/about.html", "/sandbox/architecture.svg", "/sandbox/echelle-kilometrique.css?v=9", "/sandbox/echelle-kilometrique.js?v=14", "/sandbox/runtime-config.js?v=3.077", "/sandbox/changelog.html", "/sandbox/", "/sandbox/index.html", "/sandbox/style.css?v=152", "/sandbox/app.js?v=205", "/sandbox/analytics.js?v=1", "/sandbox/manifest.webmanifest", "/sandbox/vendor/meteo-france-vigilance-sprites.png", "/sandbox/contact/", "/sandbox/contact/index.html", "/sandbox/contact/contact.css?v=4", "/sandbox/contact/contact.js?v=1", "/sandbox/news/", "/sandbox/news/index.html", "/sandbox/news/news.css?v=2", "/sandbox/news/markdown.js?v=1", "/sandbox/news/news.js?v=3"];
const publicRoots = new Set(["", "index.html", "style.css", "app.js", "analytics.js", "manifest.webmanifest", "runtime-config.js", "about.html", "architecture.svg", "echelle-kilometrique.css", "echelle-kilometrique.js", "changelog", "changelog.html", "contact", "data", "news", "evenements", "evenements.html", "nowcasting-replay.html", "vendor"]);

function publicCacheTarget(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.origin !== location.origin || !url.pathname.startsWith(scopePath)) return false;
  const relativePath = url.pathname.slice(scopePath.length).replace(/^\/+/, "");
  const root = relativePath.split("/sandbox/", 1)[0];
  return publicRoots.has(root);
}

self.addEventListener("install", event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!publicCacheTarget(url)) return;
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
