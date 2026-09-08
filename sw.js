// Friendly service worker: caches the app shell so the installed app opens
// instantly, and shows push notifications. API calls always hit the network.
importScripts("./config.js");
const API = ((self.FRIENDLY_CONFIG || {}).scriptUrl || "").trim();
const CACHE = "friendly-v4";
const SHELL = [
  "./",
  "./index.html",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // API + fonts: network
  // Stale-while-revalidate: serve from cache, refresh the cache in the background.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: e.request.mode === "navigate" }).then(cached => {
      const fetched = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});

// Pushes arrive without a payload (the backend can't encrypt one), so ask the
// API what just happened and show that. iOS requires every push to show a
// notification, so always fall back to a generic line.
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    let body = "Something new in your group";
    try {
      if (API) {
        const r = await fetch(API + "?action=latest", { cache: "no-store" });
        const j = await r.json();
        if (j.ok && j.msg) body = j.msg;
      }
    } catch (err) { /* keep the generic line */ }
    await self.registration.showNotification("Friendly", {
      body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: "friendly-activity",
      data: { url: "./" }
    });
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws =>
      ws.length ? ws[0].focus() : self.clients.openWindow("./"))
  );
});
