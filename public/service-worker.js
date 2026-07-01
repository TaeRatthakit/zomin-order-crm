const CACHE_NAME = "growup-pilot-pwa-v31";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/favicon.ico?v=20260701-growup-logo-transparent",
  "/favicon.png?v=20260701-growup-logo-transparent",
  "/favicon-16x16.png?v=20260701-growup-logo-transparent",
  "/favicon-32x32.png?v=20260701-growup-logo-transparent",
  "/apple-touch-icon.png?v=20260701-growup-logo-transparent",
  "/styles.css?v=20260701-growup-logo-transparent",
  "/app.js?v=20260701-growup-logo-transparent",
  "/import-worker.js",
  "/xlsx.full.min.js",
  "/manifest.webmanifest?v=20260701-growup-logo-transparent",
  "/icons/logo.png?v=20260701-growup-logo-transparent",
  "/icons/apple-touch-icon.png?v=20260701-growup-logo-transparent",
  "/icons/icon-192.png?v=20260701-growup-logo-transparent",
  "/icons/icon-512.png?v=20260701-growup-logo-transparent",
  "/icons/maskable-icon-192.png?v=20260701-growup-logo-transparent",
  "/icons/maskable-icon-512.png?v=20260701-growup-logo-transparent"
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
