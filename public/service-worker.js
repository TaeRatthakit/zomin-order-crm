const CACHE_NAME = "growup-pilot-pwa-v123-customer-business-light-v1";
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/favicon.ico?v=20260717-mobile-icon-v1",
  "/favicon.png?v=20260717-mobile-icon-v1",
  "/favicon-16x16.png?v=20260717-mobile-icon-v1",
  "/favicon-32x32.png?v=20260717-mobile-icon-v1",
  "/favicon-48x48.png?v=20260717-mobile-icon-v1",
  "/styles.css?v=20260722-customer-business-light-v1",
  "/app.js?v=20260722-customer-business-light-v1",
  "/desktop-dashboard-hero.webp?v=20260706-webp-v1",
  "/desktop-dashboard-hero-light.jpg?v=20260719-home-light-clean-v2",
  "/desktop-onboarding-rocket.webp?v=20260706-webp-v1",
  "/mobile-home-hero.png?v=20260703-mobile-hero-clean",
  "/mobile-home-hero-light-v4.webp?v=20260720-mobile-light-single-frame-v1",
  "/mobile-home-avatar.png",
  "/import-worker.js",
  "/xlsx.full.min.js",
  "/manifest.webmanifest?v=20260718-installed-app-icon-v2",
  "/icons/logo.png?v=20260718-website-logo-transparent-v1",
  "/icons/login-logo-192.png?v=20260718-website-logo-transparent-v1",
  "/icons/growup-apple-touch-icon-180-20260718-installed-app-v2.png?v=20260718-installed-app-icon-v2",
  "/icons/growup-pwa-icon-any-192-20260718-installed-app-v2.png?v=20260718-installed-app-icon-v2",
  "/icons/growup-pwa-icon-any-512-20260718-installed-app-v2.png?v=20260718-installed-app-icon-v2",
  "/icons/growup-pwa-icon-maskable-192-20260718-installed-app-v2.png?v=20260718-installed-app-icon-v2",
  "/icons/growup-pwa-icon-maskable-512-20260718-installed-app-v2.png?v=20260718-installed-app-icon-v2"
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
