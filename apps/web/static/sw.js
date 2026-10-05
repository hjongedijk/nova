/* NOVA service worker: lets the app install and open when the network is slow.
   Live data and the API are never cached. */
const CACHE = "nova-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  // Newest page first; the saved copy only when the network fails.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (
          response.ok &&
          (request.mode === "navigate" || SHELL.includes(url.pathname))
        )
          caches
            .open(CACHE)
            .then((cache) => cache.put(request, response.clone()));
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => hit || caches.match("/")),
      ),
  );
});
