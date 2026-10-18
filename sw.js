// Friendly service worker: keeps a full copy of the app (our files, the Firebase SDK, and the fonts) so
// it opens with no signal at all; Firestore's own device cache supplies the data. Our files are
// network-first with a short timeout (fresh when online, instant from the copy on a dead or crawling
// connection); the versioned Firebase SDK and font files never change, so they're cache-first.
// Bump CACHE on deploy.
const CACHE = "friendly-fb-v242";
const SHELL = [
  "./", "./index.html", "./styles.css", "./app.js", "./blip.js", "./themes.js", "./diag-worker.js", "./version.json",
  "./firebase-config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/maskable-512.png", "./icons/apple-touch-icon.png"
];
const SDK = ["app", "auth", "firestore"].map(m => `https://www.gstatic.com/firebasejs/10.12.5/firebase-${m}.js`);
const IMMUTABLE = /^https:\/\/(www\.gstatic\.com\/firebasejs\/|fonts\.gstatic\.com\/)/, FONT_CSS = /^https:\/\/fonts\.googleapis\.com\//;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all([
    c.addAll(SHELL),
    ...SDK.map(u => fetch(new Request(u, { mode: "cors" })).then(r => r.ok && c.put(u, r)).catch(() => {}))
  ])).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// One cached copy per file, whatever ?v= it was asked for with.
const keyOf = url => url.origin + url.pathname;
function fresh(req, ms) {
  const url = new URL(req.url);
  const net = fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(keyOf(url), copy)); } return res; });
  const late = new Promise((_, no) => setTimeout(() => no(new Error("slow")), ms));
  return Promise.race([net, late]).catch(async () => {
    const hit = await caches.match(keyOf(url))
      || (req.mode === "navigate" ? (await caches.match(url.origin + "/index.html")) || (await caches.match(url.origin + "/")) : null);
    return hit || net;   // nothing saved yet: keep waiting on the network after all
  });
}
// A versioned file (app.js?v=176) never changes, so that exact URL is served from the cache when we have it,
// else from the network (saved under both its full URL and its path). Only with no network at all does an
// older copy stand in. The page and version.json stay network-first, so an update shows up on the next open.
function versioned(req) {
  const url = new URL(req.url);
  return caches.match(url.href).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const a = res.clone(), b = res.clone(); caches.open(CACHE).then(c => { c.put(url.href, a); c.put(keyOf(url), b); }); }
    return res;
  }).catch(() => caches.match(keyOf(url)).then(old => old || Response.error())));
}
// The app's page comes straight from the cache when we have it, and the network copy refreshes the cache in the
// background. After iOS kills the page (to get memory back) it reloads at once, and that reload has to paint even
// with no signal: waiting on the network here is what left phones on a blank green screen.
function pageFirst(e) {
  const req = e.request, url = new URL(req.url), keys = [url.origin + "/", url.origin + "/index.html"];
  const net = fetch(req).then(res => { if (res.ok) { const a = res.clone(), b = res.clone(); caches.open(CACHE).then(c => { c.put(keys[0], a); c.put(keys[1], b); }); } return res; });
  return caches.match(keys[0]).then(hit => hit || caches.match(keys[1])).then(hit => {
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => Response.error());
  });
}
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin && e.request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) { e.respondWith(pageFirst(e)); return; }
  if (url.origin === location.origin && url.searchParams.has("v")) { e.respondWith(versioned(e.request)); return; }
  if (url.origin === location.origin) { e.respondWith(fresh(e.request, url.pathname.endsWith("version.json") ? 2500 : 4000)); return; }
  if (IMMUTABLE.test(url.href)) {
    e.respondWith(caches.match(url.href).then(hit => hit || fetch(e.request).then(res => { if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(url.href, copy)); } return res; })));
    return;
  }
  if (FONT_CSS.test(url.href)) {
    e.respondWith(caches.match(url.href).then(hit => { const net = fetch(e.request).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(url.href, copy)); } return res; }).catch(() => hit); return hit || net; }));
  }
  // Everything else (Firestore, Auth, functions, images elsewhere) goes straight to the network.
});

// ---- Web push ----
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  // d.badge = unread count for the Home Screen icon (where the browser supports it).
  const setBadge = typeof d.badge === "number" && self.navigator && self.navigator.setAppBadge ? self.navigator.setAppBadge(d.badge).catch(() => {}) : Promise.resolve();
  e.waitUntil(Promise.all([setBadge, self.registration.showNotification(d.title || "Friendly", {
    body: d.body || "", icon: "./icons/icon-192.png", badge: "./icons/icon-192.png",
    data: { url: d.url || "/" }, tag: d.tag || undefined
  })]));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    for (const c of cs) if (c.url.startsWith(self.location.origin)) { c.navigate(url); return c.focus(); }
    return clients.openWindow(url);
  }));
});
