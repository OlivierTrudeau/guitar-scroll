const CACHE_NAME = "guitarscroll-v33";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./jam.js",
  "./pitch.js",
  "./analytics.js",
  "./manifest.json",
  "./icon-192.svg",
  "./icon-512.svg",
  "./songs.json",
];

self.addEventListener("install", (e) => {
  // cache.addAll reuses the HTTP cache, which on a phone is often the previous
  // app.js. Reload so this cache name actually stores the new files.
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(ASSETS.map(async (url) => {
        const res = await fetch(new Request(url, { cache: "reload" }));
        if (!res.ok) throw new Error(url);
        await cache.put(url, res);
      }));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  const ready = caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
    .then(() => self.clients.claim());
  e.waitUntil(ready);
  // Reload after activate finishes. Doing it inside waitUntil can stall the
  // navigation on the worker that is waiting for that navigation.
  ready.then(() => {
    setTimeout(() => {
      self.clients.matchAll({ type: "window" }).then((clients) => {
        clients.forEach((client) => client.navigate(client.url).catch(() => {}));
      });
    }, 50);
  });
});

function fromCache(request) {
  // Jam links are ?jam=CODE. The cached shell has no query, and the page still
  // has to load for the socket to connect.
  return caches.open(CACHE_NAME).then((cache) => cache.match(request, { ignoreSearch: true }));
}

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
        .catch(() => fromCache(e.request))
    );
    return;
  }
  e.respondWith(
    fromCache(e.request).then((cached) => cached || fetch(e.request))
  );
});
