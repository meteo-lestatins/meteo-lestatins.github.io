const cacheName = "meteo-main-v3-125-r1";
const shell = ["/about.html", "/architecture.svg", "/echelle-kilometrique.css?v=12", "/echelle-kilometrique.js?v=15", "/runtime-config.js?v=3.125", "/changelog.html", "/", "/index.html", "/style.css?v=158", "/app.js?v=218", "/analytics.js?v=1", "/manifest.webmanifest", "/vendor/vigilance-icons/phenomenon-1.png", "/vendor/vigilance-icons/phenomenon-2.png", "/vendor/vigilance-icons/phenomenon-3.png", "/vendor/vigilance-icons/phenomenon-4.png", "/vendor/vigilance-icons/phenomenon-5.png", "/vendor/vigilance-icons/phenomenon-6.png", "/vendor/vigilance-icons/phenomenon-7.png", "/vendor/vigilance-icons/phenomenon-8.png", "/vendor/vigilance-icons/phenomenon-9.png", "/contact/", "/contact/index.html", "/contact/contact.css?v=4", "/contact/contact.js?v=1", "/news/", "/news/index.html", "/news/news.css?v=2", "/news/markdown.js?v=1", "/news/news.js?v=3"];
const publicRoots = new Set(["", "index.html", "style.css", "app.js", "analytics.js", "manifest.webmanifest", "runtime-config.js", "about.html", "architecture.svg", "echelle-kilometrique.css", "echelle-kilometrique.js", "changelog", "changelog.html", "contact", "data", "news", "evenements", "evenements.html", "nowcasting-replay.html", "vendor"]);

function publicCacheTarget(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  if (url.origin !== location.origin || !url.pathname.startsWith(scopePath)) return false;
  const relativePath = url.pathname.slice(scopePath.length).replace(/^\/+/, "");
  const root = relativePath.split("/", 1)[0];
  return publicRoots.has(root);
}

self.addEventListener("install", event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!publicCacheTarget(url)) return;
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
