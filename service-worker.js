const CACHE_NAME = "toby-plus-v2";
const ASSETS_TO_CACHE = [
  "/", // root
  "/bot.html",
  "/chatbot.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// Install and cache assets
self.addEventListener("install", (event) => {
  console.log("[SW] Install");
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting(); // activate immediately
});

// Activate and clean old caches
self.addEventListener("activate", (event) => {
  console.log("[SW] Activate");
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Intercept fetch requests
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Don’t cache Netlify Functions — but provide offline fallback
  if (url.pathname.startsWith("/.netlify/functions/")) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ offline: true }),
          {
            headers: { "Content-Type": "application/json" },
            status: 503,
            statusText: "Offline"
          }
        );
      })
    );
    return;
  }

  // Cache-first strategy for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).catch(() => caches.match("/bot.html")) // offline fallback
      );
    })
  );
});
