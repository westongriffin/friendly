// Friendly service worker: cache the app shell so the installed PWA opens
// instantly. Firebase (Firestore/Auth) traffic and fonts always hit the
// network. Bump CACHE to invalidate old shells on deploy.
const CACHE = "friendly-fb-v4";
const SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./themes.js",
  "./firebase-config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/maskable-512.png", "./icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Only cache our own same-origin GETs; never intercept Firebase/font traffic.
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: e.request.mode === "navigate" }).then(cached => {
      const net = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => cached || caches.match("./index.html"));
      return cached || net;
    })
  );
});
