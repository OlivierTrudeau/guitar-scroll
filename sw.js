const CACHE_NAME = "guitarscroll-v16";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./analytics.js",
  "./manifest.json",
  "./icon-192.svg",
  "./icon-512.svg",
  "./songs.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Only handle same-origin requests — let external calls (e.g. GoatCounter
  // analytics on gc.zgo.at) go straight to the network, untouched by the cache.
  if (new URL(e.request.url).origin !== self.location.origin) {
    return;
  }

  if (e.request.url.includes("songs.json")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
