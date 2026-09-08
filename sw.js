// Friendly service worker: cache the app shell so the installed PWA opens
// instantly. Firebase (Firestore/Auth) traffic and fonts always hit the
// network. Bump CACHE to invalidate old shells on deploy.
const CACHE = "friendly-fb-v21";
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
  // Network-first: the app needs Firebase anyway, so always take the latest
  // shell when online; the cache is only an offline fallback. (Cache-first
  // could pin a stale shell for a long time.)
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: e.request.mode === "navigate" })
      .then(cached => cached || caches.match("./index.html")))
  );
});

// ---- Web push ----
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Friendly", {
    body: d.body || "", icon: "./icons/icon-192.png", badge: "./icons/icon-192.png",
    data: { url: d.url || "/" }, tag: d.tag || undefined
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    for (const c of cs) if (c.url.startsWith(self.location.origin)) { c.navigate(url); return c.focus(); }
    return clients.openWindow(url);
  }));
});
