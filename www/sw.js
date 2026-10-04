// Offline support: cache the game files; live requests (/api/...) always go to the network.
const CACHE = "what2do-v2"; // bump on every release that changes the game
const FILES = [
  "./", "index.html", "manifest.webmanifest", "fonts/fonts.css",
  "fonts/Baloo2-500.woff2", "fonts/Baloo2-700.woff2", "fonts/Baloo2-800.woff2",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "img/tmdb.svg"
];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Network first so updates show up; fall back to the cache when offline.
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});
