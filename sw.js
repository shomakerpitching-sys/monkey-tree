/* sw.js — service worker
 * Caches the app shell so the sky/planet/star features work offline.
 * (Live satellite passes still need a connection — that's expected.)
 */
const CACHE = "monkey-tree-v7";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./stars.js",
  "./constellations.js",
  "./milkyway.js",
  "./manifest.webmanifest",
  "./splash.jpg",
  "./It_s_Kouri_Bitch.jpg",
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
  const req = e.request;
  if (req.method !== "GET") return;
  const url = req.url;

  // Never cache the live satellite data — always go to network.
  if (url.includes("celestrak.org")) {
    e.respondWith(fetch(req).catch(() => new Response("", { status: 504 })));
    return;
  }

  // Page loads (navigations): NETWORK-FIRST so the HTML is always fresh.
  // This is the key fix — it stops a stale/404 page from being served from cache.
  // Falls back to the cached page only when truly offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("./index.html", copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((h) => h || caches.match("./index.html")))
    );
    return;
  }

  // Other assets: cache-first, but ONLY ever store successful (200/ok) responses,
  // so an error like a 404 can never get cached and stuck.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit)
    )
  );
});
