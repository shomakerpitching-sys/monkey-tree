/* sw.js — service worker
 * Caches the app shell so the sky/planet/star features work offline.
 * (Live satellite passes still need a connection — that's expected.)
 */
const CACHE = "monkey-tree-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./stars.js",
  "./constellations.js",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/astronomy.browser.min.js",
  "https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // addAll fails if any URL 404s; add individually so one miss doesn't break install
      Promise.all(ASSETS.map((u) => c.add(u).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  // Never cache the live satellite data — always go to network.
  if (url.includes("celestrak.org")) {
    e.respondWith(fetch(e.request).catch(() => new Response("", { status: 504 })));
    return;
  }
  // Cache-first for everything else (the app shell + libraries).
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => hit)
    )
  );
});
