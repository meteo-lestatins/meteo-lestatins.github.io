const cacheName = "meteo-france-v63";
const shell = ["/runtime-config.js", "/", "/index.html", "/style.css", "/app.js", "/manifest.webmanifest"];
self.addEventListener("install", event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => { if (event.request.method === "GET" && new URL(event.request.url).origin === location.origin && !new URL(event.request.url).pathname.startsWith("/api/")) event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });
