const CACHE_NAME = "growup-pilot-pwa-v27";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/favicon.ico?v=20260630-favicon-refresh",
  "/favicon.svg?v=20260630-favicon-refresh",
  "/favicon.png?v=20260630-favicon-refresh",
  "/favicon-16x16.png?v=20260630-favicon-refresh",
  "/favicon-32x32.png?v=20260630-favicon-refresh",
  "/apple-touch-icon.png?v=20260630-favicon-refresh",
  "/styles.css?v=20260630-ui-refresh",
  "/app.js?v=20260630-ui-refresh",
  "/import-worker.js",
  "/xlsx.full.min.js",
  "/manifest.webmanifest?v=20260630-favicon-refresh",
  "/icons/apple-touch-icon.png?v=20260630-favicon-refresh",
  "/icons/icon-192.png?v=20260630-favicon-refresh",
  "/icons/icon-512.png?v=20260630-favicon-refresh",
  "/icons/maskable-icon-192.png?v=20260630-favicon-refresh",
  "/icons/maskable-icon-512.png?v=20260630-favicon-refresh"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
