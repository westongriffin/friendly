// Friendly: app (Firebase Auth + Firestore). Real accounts, groups with
// server-enforced privacy, expressive themed events, RSVP + guest management,
// and shared money. Hosted static on GitHub Pages; no build step.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, deleteUser, reauthenticateWithCredential, EmailAuthProvider,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection,
  query, where, onSnapshot, addDoc, arrayUnion, arrayRemove, deleteField, orderBy, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig, mapsKey, adminUids, vapidPublicKey, giphyKey } from "./firebase-config.js";
import { THEMES, themeOf, applyTheme, startParticles, DEFAULT_THEME } from "./themes.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

// Shared demo account (the App Review login): one tap, no sign-up. While signed
// in as it, profile edits and destructive actions are turned off so the sample
// group stays intact for the next visitor. ?demo=1 in the URL opens it directly.
const DEMO = { email: "reviewer@officialfriendly.com", password: "FriendlyReview2026!" };
const isDemo = () => !!(S.user && S.user.email === DEMO.email);
let demoAutoTried = false;
async function demoSignIn() {
  try { await signInWithEmailAndPassword(auth, DEMO.email, DEMO.password); }
  catch (e) { S.ready = true; render(); toast("Couldn't open the demo here. Open officialfriendly.com in a new tab and tap Try the demo."); }
}

// Native bridge (present only inside the Capacitor iOS/Android app). All of
// this degrades to web behavior when window.Capacitor is absent.
const CAP = window.Capacitor || null;
const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
// The iOS shell already keeps the web view below the status bar and above the
// home indicator, so the CSS safe-area padding would double up there.
if (NATIVE) document.documentElement.classList.add("native");
const plugin = n => (CAP && CAP.Plugins && CAP.Plugins[n]) || null;
async function registerPush(uid) {
  const Push = plugin("PushNotifications"); if (!Push) return;
  try {
    let perm = await Push.checkPermissions();
    if (perm.receive !== "granted") perm = await Push.requestPermissions();
    if (perm.receive !== "granted") return;
    Push.addListener("registration", async t => { try { await updateDoc(doc(db, "users", uid), { pushTokens: arrayUnion(t.value) }); } catch {} });
    Push.addListener("pushNotificationActionPerformed", a => { const url = a && a.notification && a.notification.data && a.notification.data.url; if (url) location.hash = url; });
    await Push.register();
  } catch {}
}

// ---------- web push (installed PWA / browsers) ----------
// iPhone only delivers web push to apps added to the Home Screen.
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const STANDALONE = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const WEBPUSH_OK = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function b64ToU8(s) { const pad = "=".repeat((4 - s.length % 4) % 4); const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...b].map(c => c.charCodeAt(0))); }
const pushState = () => NATIVE ? "native" : !WEBPUSH_OK ? "unsupported" : Notification.permission === "denied" ? "denied"
  : (S.profile && S.profile.webPushEnabled && Notification.permission === "granted") ? "on" : "off";
async function enableWebPush() {
  if (NATIVE) return registerPush(myUid());
  if (IOS && !STANDALONE) return toast("On iPhone, first add Friendly to your Home Screen (Share → Add to Home Screen), then turn notifications on from there.");
  if (!WEBPUSH_OK) return toast("This browser can't receive notifications.");
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return toast("Notifications stay off. You can allow them in your browser settings any time.");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(vapidPublicKey) });
    await updateDoc(doc(db, "users", myUid()), { webPush: arrayUnion(JSON.parse(JSON.stringify(sub))), webPushEnabled: true });
    toast("Notifications on 🔔");
  } catch (e) { toast("Couldn't turn on notifications: " + e.message); }
}
async function disableWebPush() {
  try {
    const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription();
    if (sub) { await updateDoc(doc(db, "users", myUid()), { webPush: arrayRemove(JSON.parse(JSON.stringify(sub))) }); await sub.unsubscribe(); }
    await updateDoc(doc(db, "users", myUid()), { webPushEnabled: false }); toast("Notifications off");
  } catch (e) { toast(e.message); }
}

// ---------- tiny helpers ----------
const $ = s => document.querySelector(s);
const el = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2)).replace(/-/g, "");
const AV = ["#FF6B57", "#FFC145", "#2E9E6B", "#5B8CFF", "#E85D9E", "#8A6BE2", "#F2884B", "#3FB6C9"];
const colorFor = id => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AV[h % AV.length]; };
const initials = n => (n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join("");
const first = n => (n || "Someone").split(" ")[0];
const fmt$ = c => (c < 0 ? "−" : "") + "$" + (Math.abs(c) / 100).toFixed(2);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function toast(msg, action, onAction) {
  const t = el("toast"); t.textContent = msg;
  if (action) { const b = document.createElement("button"); b.type = "button"; b.className = "toast-act"; b.textContent = action; b.onclick = () => { t.classList.remove("show"); onAction(); }; t.appendChild(b); }
  t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), action ? 7000 : 3400);
}
function todayStr() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function evDate(ev) { const [y, m, d] = (ev.date || "2000-01-01").split("-").map(Number); return new Date(y, m - 1, d); }
function fmtTime(t) { if (!t) return ""; const [h, mi] = t.split(":").map(Number); const d = new Date(); d.setHours(h, mi); return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function fmtWhen(ev) {
  const d = evDate(ev);
  let s = d.toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric" });
  if (ev.time) s += " · " + fmtTime(ev.time) + (ev.endTime ? "–" + fmtTime(ev.endTime) : "");
  return s;
}
function ago(ts) { const s = (Date.now() - ts) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; return Math.floor(s / 86400) + "d"; }
function parseAmount(v) { const n = Number(String(v).replace(/[$,\s]/g, "")); return isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) : null; }

// ---------- images ----------
// Downscale + JPEG-compress any image (File/Blob/URL) to a self-contained data
// URL that fits comfortably in a Firestore doc. Covers store at ~1000px,
// photo-wall shots at ~900px. Keeps the app on the free plan (no Storage).
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
function blobToURL(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); }); }
async function compressImage(src, maxDim = 1400, quality = 0.8, maxBytes = 720000) {
  const img = await loadImg(typeof src === "string" ? src : await blobToURL(src));
  let w = img.width, h = img.height;
  const scale = Math.min(1, maxDim / Math.max(w, h)); const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
  // Shrink by halves first: one big jump from a 12MP photo to a small canvas
  // throws away detail and looks blurry; stepping down keeps edges crisp.
  let cur = img;
  while (w / 2 >= tw && h / 2 >= th) { const c = document.createElement("canvas"); w = Math.round(w / 2); h = Math.round(h / 2); c.width = w; c.height = h; const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, w, h); cur = c; }
  const c = document.createElement("canvas"); c.width = tw; c.height = th; const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, tw, th);
  let q = quality, out = c.toDataURL("image/jpeg", q);
  // Images live inside Firestore documents (1MB cap), so stay comfortably under it.
  while (out.length > maxBytes && q > 0.55) { q -= 0.07; out = c.toDataURL("image/jpeg", q); }
  if (out.length > maxBytes && maxDim > 800) return compressImage(out, Math.round(maxDim * 0.8), quality, maxBytes);
  return out;
}
async function generateCover(prompt) {
  // Primary: a Gemini image model on Vertex, driven through a Firestore trigger.
  // We write a request doc; the Cloud Function generates the image and writes
  // it back. Keeps the function off the public internet and needs no key in
  // the app. Falls back to a free generator if it doesn't land.
  try {
    const image = await imagenViaFirestore(prompt);
    if (image) return compressImage(image, 1024, 0.8);
  } catch (e) { console.warn("Imagen unavailable, using fallback:", e && e.message); }
  const seed = Math.floor(Math.random() * 1e6);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + ", vibrant celebratory illustration, bold colors, high quality, no text, no words, no numbers, no dates")}?width=1024&height=640&nologo=true&model=flux&seed=${seed}`;
  const res = await fetch(url); if (!res.ok) throw new Error("Generator busy, try again");
  return compressImage(await blobToURL(await res.blob()), 1024, 0.74);
}
// Write coverRequests/{id}, wait for the function to fill in image/status.
function imagenViaFirestore(prompt) {
  return new Promise(async (resolve, reject) => {
    const uid = S.user && S.user.uid; if (!uid) return reject(new Error("signed out"));
    const id = newId(), ref = doc(db, "coverRequests", id);
    let unsub = null, timer = null;
    const done = (fn, arg) => { if (timer) clearTimeout(timer); if (unsub) unsub(); deleteDoc(ref).catch(() => {}); fn(arg); };
    try {
      await setDoc(ref, { uid, prompt: String(prompt).slice(0, 400), status: "pending", createdAt: Date.now() });
    } catch (e) { return reject(e); }
    timer = setTimeout(() => done(reject, new Error("timed out")), 90000);
    unsub = onSnapshot(ref, s => {
      const d = s.data(); if (!d) return;
      if (d.status === "done" && d.image) done(resolve, d.image);
      else if (d.status === "error") done(reject, new Error(d.error || "generation failed"));
    }, err => done(reject, err));
  });
}
function pickFile(accept = "image/*") { return new Promise(res => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); }); }
// Comments/polls live under events by default; groups and expenses reuse the
// same components by passing a pseudo-event with `_col: ["groups", id]` etc.
function subCol(ev, name) { return collection(db, ...(ev._col || ["events", ev.id]), name); }
// Compose a text in the phone's Messages app (iOS wants "&" before body).
// Phone numbers as +15551234567 so the same person matches whether typed with dashes or spaces.
const toE164 = p => { const d = String(p || "").trim(); if (!d) return ""; const n = d.replace(/\D/g, ""); if (d.startsWith("+")) return "+" + n; if (n.length === 10) return "+1" + n; if (n.length === 11 && n[0] === "1") return "+" + n; return n ? "+" + n : ""; };
// Birthdays are stored as YYYY-MM-DD (the year is optional to the user; we only use month and day).
function nextBirthday(b) { if (!b || b.length < 5) return null; const [, mm, dd] = /(\d{2})-(\d{2})$/.exec(b) || []; if (!mm) return null; const now = new Date(); let d = new Date(now.getFullYear(), +mm - 1, +dd); const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()); if (d < t0) d = new Date(now.getFullYear() + 1, +mm - 1, +dd); return d; }
const daysToBirthday = b => { const d = nextBirthday(b); if (!d) return null; const now = new Date(); return Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000); };
const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
// Members' birthdays across every group I'm in (uid -> {name, birthday, groupId}), soonest first.
function upcomingBirthdays(withinDays = 60, onlyGroup = null) {
  const seen = new Map();
  for (const g of S.groups.values()) { if (onlyGroup && g.id !== onlyGroup) continue; for (const [uid, info] of Object.entries(g.members || {})) { if (uid === myUid() || !info.birthday || seen.has(uid)) continue; const days = daysToBirthday(info.birthday); if (days == null || days > withinDays) continue; seen.set(uid, { uid, name: info.name || nameOf(uid), days, date: ymd(nextBirthday(info.birthday)), groupId: g.id }); } }
  return [...seen.values()].sort((a, b) => a.days - b.days);
}
function planBirthday(b) { resetCompose(); compose.date = b.date; compose.groupId = b.groupId; compose.title = first(b.name) + "'s birthday"; compose.emoji = "🎂"; go("#/new"); toast("Pick a theme and invite the crew 🎂"); }
function birthdayCard() {
  const list = upcomingBirthdays(30); let dismissed = []; try { dismissed = JSON.parse(localStorage.getItem("friendlyBdayDismissed") || "[]"); } catch {}
  const b = list.find(x => !dismissed.includes(x.uid + ":" + x.date)); if (!b) return "";
  return `<div class="card notif-card"><span class="notif-ico">🎂</span><div style="flex:1"><b>${esc(first(b.name))}'s birthday is ${b.days === 0 ? "today" : b.days === 1 ? "tomorrow" : "in " + b.days + " days"}</b><div class="muted sm">${esc(fmtDay({ date: b.date }))}. A month out is the sweet spot to plan something.</div></div><span class="btnrow" style="gap:6px"><button class="btn primary small" data-bplan="${b.uid}">Plan something</button><button class="btn ghost small" data-bdismiss="${b.uid}:${b.date}">Later</button></span></div>`;
}
function smsLink(numbers, body) { const sep = /iPhone|iPad|Mac/.test(navigator.userAgent) ? "&" : "?"; return "sms:" + numbers.map(n => n.replace(/[^+\d]/g, "")).join(",") + sep + "body=" + encodeURIComponent(body); }
// Address autocomplete via Google Places (New). Active only once `mapsKey` is
// set in firebase-config.js; without it the field stays a plain text box.
function attachPlaces(input) {
  if (!mapsKey || !input || input._places) return; input._places = true;
  const list = document.createElement("div"); list.className = "places-list"; list.hidden = true;
  input.insertAdjacentElement("afterend", list);
  let timer = null, seq = 0;
  const hide = () => { list.innerHTML = ""; list.hidden = true; };
  input.addEventListener("input", () => {
    if (input._picked) { input._picked = false; return; }
    clearTimeout(timer); const q = input.value.trim(); if (q.length < 3) return hide();
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": mapsKey }, body: JSON.stringify({ input: q, includedRegionCodes: ["us"], languageCode: "en" }) });
        const j = await r.json(); if (my !== seq) return;
        const hits = (j.suggestions || []).map(s => s.placePrediction).filter(Boolean).slice(0, 5);
        if (!hits.length) return hide();
        list.innerHTML = hits.map(p => { const f = p.structuredFormat || {}; return `<button type="button" data-place="${esc(p.text.text)}"><b>${esc((f.mainText || {}).text || p.text.text)}</b><span>${esc((f.secondaryText || {}).text || "")}</span></button>`; }).join("");
        list.hidden = false;
      } catch { hide(); }
    }, 250);
  });
  list.addEventListener("mousedown", e => {
    const b = e.target.closest("[data-place]"); if (!b) return; e.preventDefault();
    input._picked = true; input.value = b.dataset.place; input.dispatchEvent(new Event("input", { bubbles: true })); hide();
  });
  input.addEventListener("blur", () => setTimeout(hide, 150));
}

// ---------- state ----------
const S = {
  user: null, profile: null, ready: false,
  groups: new Map(), pendingInvites: new Map(), events: new Map(),
  expenses: new Map(), settlements: new Map(),
  contacts: new Map(),           // uid -> {name, venmo, phone}
  route: parseRoute(),
  subs: [], eventSubKey: "", commentUnsub: null, comments: [],
  evSubs: [], photos: [], polls: [], songs: []
};

function parseRoute() {
  const h = (location.hash || "#/").replace(/^#/, "");
  const p = h.split("/").filter(Boolean);
  if (!p.length) return { name: "home" };
  if (p[0] === "e") return { name: "event", id: p[1] };
  if (p[0] === "g") return { name: "group", id: p[1] };
  if (p[0] === "join") return { name: "join", id: p[1] };
  if (p[0] === "x") return { name: "expense", id: p[1] };
  if (p[0] === "activity") return { name: "activity" };
  if (p[0] === "photos") return { name: "photos" };
  if (p[0] === "search") return { name: "search" };
  if (p[0] === "new") return { name: "new" };
  if (p[0] === "money") return { name: "money" };
  if (p[0] === "groups") return { name: "groups" };
  if (p[0] === "profile") return { name: "profile" };
  return { name: "home" };
}
// New screen, start at the top (the SPA otherwise keeps the old scroll position,
// so an event page could open at the party wall instead of the cover).
window.addEventListener("hashchange", () => { S.route = parseRoute(); window.scrollTo(0, 0); render(); });
window.go = path => { location.hash = path; };

// ---------- auth ----------
onAuthStateChanged(auth, async u => {
  S.subs.forEach(fn => fn()); S.subs = [];
  S.user = u;
  if (!u) {
    S.profile = null;
    if (!demoAutoTried && new URLSearchParams(location.search).get("demo")) { demoAutoTried = true; demoSignIn(); return; }
    S.ready = true; render(); return;
  }
  const uref = doc(db, "users", u.uid);
  // Ensure a profile doc exists (created at sign-up; guard for older accounts).
  const snap = await getDoc(uref);
  if (!snap.exists()) await setDoc(uref, { name: u.displayName || first(u.email), email: u.email, venmo: "", phone: "", createdAt: Date.now() });
  subscribeAll(u);
  // Open on Events. Only top-level tabs are redirected; a link to an event,
  // group, expense, or invite still goes where it points.
  let pendingJoin = ""; try { pendingJoin = localStorage.getItem("friendlyJoin") || ""; localStorage.removeItem("friendlyJoin"); } catch {}
  if (pendingJoin) location.hash = "#/join/" + pendingJoin;
  else if (/^(#\/?|#\/(money|groups|activity|photos|search|profile))$/.test(location.hash)) location.hash = "#/";
  if (NATIVE) registerPush(u.uid);
});

function subscribeAll(u) {
  const add = fn => S.subs.push(fn);
  // Every core listener gets a named error handler, so a denied query shows
  // in the console as what it is instead of an "uncaught" mystery.
  const on = (name, q, cb) => onSnapshot(q, cb, err => console.warn("listener " + name + ":", err.code || err.message));
  add(on("profile", doc(db, "users", u.uid), d => { S.profile = d.data(); rebuildContacts(); S.ready = true; render(); }));

  add(on("groups", query(collection(db, "groups"), where("memberUids", "array-contains", u.uid)), snap => {
    S.groups = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    rebuildContacts(); resubscribeEvents(u); render();
  }));

  add(on("invites", query(collection(db, "groups"), where("invitedEmails", "array-contains", (u.email || "").toLowerCase())), snap => {
    // Build plain docs first, then key the Map by id. (An earlier version mapped
    // to [id, doc] pairs before filtering, so every invite lost its fields and
    // Join looked up an undefined key: the "Join does nothing" bug.)
    S.pendingInvites = new Map(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(g => !(g.memberUids || []).includes(u.uid)).map(g => [g.id, g]));
    render();
  }));

  // Groups that invited this phone number. Until the matching rule is live the query is
  // denied and simply logs; once deployed, texted invitees see the Join banner too.
  S.pendingInvitesPhone = new Map();
  const phoneKey = (S.profile && S.profile.phoneE164) || "";
  if (phoneKey) add(on("invitesPhone", query(collection(db, "groups"), where("invitedPhones", "array-contains", phoneKey)), snap => {
    S.pendingInvitesPhone = new Map(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(g => !(g.memberUids || []).includes(u.uid)).map(g => [g.id, g])); render();
  }));

  add(on("expenses", query(collection(db, "expenses"), where("involved", "array-contains", u.uid)), snap => {
    S.expenses = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }])); render();
  }));
  add(on("settlements", query(collection(db, "settlements"), where("involved", "array-contains", u.uid)), snap => {
    S.settlements = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }])); render();
  }));

  // activity feed (written by Cloud Functions for everything I'd be notified about)
  add(on("activity", query(collection(db, "activity"), where("uids", "array-contains", u.uid), orderBy("createdAt", "desc"), limit(60)), snap => {
    S.activity = snap.docs.map(d => ({ id: d.id, ...d.data() })); render();
  }));

  // events where I'm directly invited
  add(on("events", query(collection(db, "events"), where("invitedUids", "array-contains", u.uid)), snap => {
    snap.docChanges().forEach(c => { if (c.type === "removed") S.events.delete(c.doc.id); else { const ev = { id: c.doc.id, ...c.doc.data() }; S.events.set(ev.id, ev); noteNames(ev); } });
    render();
  }));
}
// Tear down every listener before signing out; otherwise the SDK re-sends
// them without auth and logs a burst of permission-denied errors.
function stopListening() { S.subs.forEach(fn => fn()); S.subs = []; cleanupEvent(); }
// Remember the guest names an event carries, for guests outside my groups.
function noteNames(ev) { S.nameHints = S.nameHints || new Map(); for (const [uid, n] of Object.entries(ev.names || {})) if (n) S.nameHints.set(uid, n); }

// events tied to any of my groups (re-subscribed when group set changes)
function resubscribeEvents(u) {
  const gids = [...S.groups.keys()].slice(0, 30);
  const key = gids.sort().join(",");
  if (key === S.eventSubKey) return;
  S.eventSubKey = key;
  if (S._groupEventsUnsub) { S._groupEventsUnsub(); S._groupEventsUnsub = null; }
  if (!gids.length) return;
  const subscribe = attempt => {
    S._groupEventsUnsub = onSnapshot(query(collection(db, "events"), where("groupId", "in", gids)), snap => {
      snap.docChanges().forEach(c => { if (c.type === "removed") S.events.delete(c.doc.id); else { const ev = { id: c.doc.id, ...c.doc.data() }; S.events.set(ev.id, ev); noteNames(ev); } });
      render();
    }, err => {
      // Right after creating or joining a group, the local groups snapshot fires
      // before the server has the membership write, so the rule check for this
      // query can fail once. A dead listener would hide every group event, so
      // retry a few times.
      S._groupEventsUnsub = null;
      if (attempt < 4 && S.eventSubKey === key) setTimeout(() => { if (S.eventSubKey === key && !S._groupEventsUnsub) subscribe(attempt + 1); }, 1500 * (attempt + 1));
      else console.warn("group events listener failed:", err && err.message);
    });
  };
  subscribe(0);
  S.subs.push(() => S._groupEventsUnsub && S._groupEventsUnsub());
}

function rebuildContacts() {
  const m = new Map();
  if (S.user && S.profile) m.set(S.user.uid, { name: S.profile.name, venmo: S.profile.venmo, phone: S.profile.phone, photo: S.profile.photo || "" });
  for (const g of S.groups.values())
    for (const [uid, info] of Object.entries(g.members || {})) if (!m.has(uid)) m.set(uid, info);
  S.contacts = m;
}
// Names come from shared groups (contacts); guests who joined an event by link
// are only known by the names the event carries (see noteNames).
const nameHint = uid => (S.nameHints && S.nameHints.get(uid)) || "";
const nameOf = uid => (S.contacts.get(uid) || {}).name || nameHint(uid) || "Someone";
function avatar(uid, cls = "") { const info = S.contacts.get(uid) || {}; const name = info.name || nameHint(uid); if (info.photo) return `<span class="avatar ${cls} has-img"><img src="${info.photo}" alt=""></span>`; return `<span class="avatar ${cls}" style="background:${colorFor(uid)}">${esc(initials(name || "?"))}</span>`; }

// ---------- render root ----------
function render() {
  const root = el("app");
  if (!S.ready) { root.innerHTML = `<div class="splash"><div class="logo-mark"></div><p>Loading…</p></div>`; return; }
  if (!S.user) { if (S.route.name === "event") { renderPreview(root, S.route.id); return; } if (S.route.name === "join") { try { localStorage.setItem("friendlyJoin", S.route.id); } catch {} } renderAuth(root); return; }
  if (!S.profile) { root.innerHTML = `<div class="splash"><div class="logo-mark"></div><p>Setting up your profile…</p></div>`; return; }
  const r = S.route;
  if (r.name === "event") return renderEventPage(root, r.id);
  cleanupEvent();
  root.innerHTML = shell(routeBody(r));
  wireShell();
}

// ---------- auth screen ----------
let authMode = "in";
function renderAuth(root) {
  root.innerHTML = `
  <div class="auth-wrap">
    <canvas id="authbg" class="auth-bg"></canvas>
    <div class="auth-card card">
      <div class="brand xl">Friend<span class="tilt">l</span>y</div>
      <p class="auth-lede">Your friend group's home base for plans, invites, photos, and settling up.</p>
      <div class="seg">
        <button id="segIn" class="${authMode === "in" ? "on" : ""}">Sign in</button>
        <button id="segUp" class="${authMode === "up" ? "on" : ""}">Create account</button>
      </div>
      <button type="button" class="btn lg demo-btn" id="demoBtn">Try the demo · no account needed</button>
      <form id="authForm" class="stack">
        <label class="field ${authMode === "in" ? "hidden" : ""}" id="nameField"><span>Your name</span>
          <input id="aName" maxlength="40" placeholder="Sam Rivera" autocomplete="name"></label>
        <div class="two ${authMode === "in" ? "hidden" : ""}" id="payFields">
          <label class="field"><span>Venmo <span class="muted">(optional)</span></span>
            <input id="aVenmo" placeholder="@sam-rivera" autocomplete="off"></label>
          <label class="field"><span>Phone <span class="muted">(optional)</span></span>
            <input id="aPhone" type="tel" placeholder="+1 555 123 4567" autocomplete="tel"></label>
        </div>
        <label class="field"><span>Email</span>
          <input id="aEmail" type="email" required placeholder="sam@example.com" autocomplete="email"></label>
        <label class="field"><span>Password</span>
          <input id="aPass" type="password" required minlength="6" placeholder="At least 6 characters" autocomplete="${authMode === "in" ? "current-password" : "new-password"}"></label>
        <button class="btn primary lg" type="submit">${authMode === "in" ? "Sign in" : "Create account"}</button>
        ${authMode === "up" ? `<p class="muted sm" style="margin:10px 0 0;text-align:center">By creating an account you agree to the <a href="./terms.html" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">Terms</a>: no harassment or objectionable content, and accounts that post it are removed.</p>` : ""}
      </form>
      ${authMode === "in" ? `<p class="auth-foot"><a id="magicLink">Email me a sign-in link instead</a></p>` : ""}
      <p class="auth-foot">${authMode === "in" ? "New here?" : "Already have an account?"}
        <a id="authSwap">${authMode === "in" ? "Create an account" : "Sign in"}</a></p>
    </div>
  </div>`;
  startParticles(el("authbg"), "confetti");
  el("segIn").onclick = () => { authMode = "in"; renderAuth(root); };
  el("segUp").onclick = () => { authMode = "up"; renderAuth(root); };
  el("demoBtn").onclick = () => { el("demoBtn").disabled = true; el("demoBtn").textContent = "Opening the demo…"; demoSignIn(); };
  el("authSwap").onclick = () => { authMode = authMode === "in" ? "up" : "in"; renderAuth(root); };
  if (el("magicLink")) el("magicLink").onclick = sendMagicLink;
  el("authForm").onsubmit = async e => {
    e.preventDefault();
    const email = el("aEmail").value.trim(), pass = el("aPass").value, name = el("aName").value.trim();
    const venmo = el("aVenmo").value.trim(), phone = el("aPhone").value.trim();
    try {
      if (authMode === "up") {
        if (!name) return toast("Add your name so friends recognize you.");
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await setDoc(doc(db, "users", cred.user.uid), { name, email: email.toLowerCase(), venmo, phone, phoneE164: toE164(phone), createdAt: Date.now() });
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (err) { toast(authError(err)); }
  };
}
function authError(err) {
  const c = (err && err.code) || "";
  if (c.includes("email-already-in-use")) return "That email already has an account. Sign in instead.";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Email or password is incorrect.";
  if (c.includes("weak-password")) return "Password needs at least 6 characters.";
  if (c.includes("invalid-email")) return "That doesn't look like a valid email.";
  return "Couldn't do that: " + (err.message || c);
}

// ---------- app shell ----------
// Pending group invites, pinned to the top of every page until accepted. The
// host's name comes from the group doc itself (invitees can't see hosts'
// profiles yet), so it never falls back to "Someone".
function inviteBanner() {
  const invites = [...new Map([...S.pendingInvites.values(), ...((S.pendingInvitesPhone && [...S.pendingInvitesPhone.values()]) || [])].map(g => [g.id, g])).values()];
  if (!invites.length) return "";
  return `<div class="stack" style="margin-bottom:16px">${invites.map(g => {
    const host = ((g.members || {})[g.ownerId] || {}).name || nameOf(g.ownerId);
    return `<div class="card invite-row">
      <span class="ge" style="background:${g.color || "#FFE0B2"}">${esc(g.emoji || "🎉")}</span>
      <div style="flex:1;min-width:0"><b>${esc(g.name)}</b><div class="muted sm">${esc(host)} invited you to this group</div></div>
      <button class="btn small primary" data-accept="${g.id}">Join</button>
    </div>`; }).join("")}</div>`;
}
function shell(body) {
  const p = S.profile;
  const tab = S.route.name;
  const T = (name, label, path) => `<button class="tab ${tab === name ? "on" : ""}" data-go="${path}">${label}</button>`;
  return `
  ${isDemo() ? `<div class="demo-bar">Demo mode: this is the shared sample account. Explore freely; what you add is visible to other visitors.</div>` : ""}
  <header class="topbar">
    <div class="brand" data-go="#/">Friend<span class="tilt">l</span>y</div>
    <div class="topbar-right"><button class="bell" data-go="#/search" title="Search">🔍</button><button class="bell" data-go="#/activity" title="Activity">🔔${unreadCount() ? `<span class="badge">${unreadCount()}</span>` : ""}</button>
    <button class="me-chip" data-go="#/profile">${avatar(S.user.uid)}<span>${esc(first(p.name))}</span></button></div>
  </header>
  <nav class="tabs">
    ${T("home", "Events", "#/")}
    ${T("groups", "Groups", "#/groups")}
    ${T("money", "Money", "#/money")}
  </nav>
  <main class="wrap">${inviteBanner()}${body}</main>
  ${["new", "group", "expense", "profile"].includes(tab) ? "" : `<button class="fab" data-go="#/new" title="Create event">＋</button>`}`;
}
function wireShell() {
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  document.querySelectorAll("[data-accept]").forEach(b => b.onclick = () => acceptInvite(b.dataset.accept, b));
  if (S.route.name === "home") wireHome();
  if (S.route.name === "new") wireCompose();
  if (S.route.name === "groups") wireGroups();
  if (S.route.name === "group") wireGroupPage();
  if (S.route.name === "money") wireMoney();
  if (S.route.name === "expense") wireExpensePage();
  if (S.route.name === "activity") wireActivity();
  if (S.route.name === "photos") wirePhotosPage();
  if (S.route.name === "search") wireSearch();
  if (S.route.name !== "activity") S._actOpenSeen = null;
  if (S.route.name === "profile") wireProfile();
}
// A group join link (texted from the Add people dialog). Members go straight to the
// group; invited people are added by email or phone match; anyone else is told to ask the host.
function joinBody(gid) {
  if (S.groups.has(gid)) { setTimeout(() => go("#/g/" + gid), 0); return `<p class="muted">Opening your group…</p>`; }
  setTimeout(() => { const b = el("joinNow"); if (b) b.onclick = () => joinGroupByLink(gid, b); if (!joinBody._auto) { joinBody._auto = gid; joinGroupByLink(gid, el("joinNow"), true); } }, 0);
  return `<div class="card empty" style="margin-top:20px"><div class="big">🎉</div><b>You've been invited to a group</b>
    <p class="muted">Tap Join and you're in, as long as the person who texted you used this phone number or your email.</p>
    <button class="btn primary" id="joinNow">Join the group</button>
    <p class="muted sm" id="joinNote" style="margin-top:12px">Your number on file: <b>${esc(S.profile.phoneE164 || S.profile.phone || "none yet")}</b>. If that's not the number they texted, add it on your <a data-go="#/profile">profile</a> and tap Join again.</p></div>`;
}
async function joinGroupByLink(gid, btn, quiet) {
  if (btn) { btn.disabled = true; btn.textContent = "Joining…"; }
  try {
    await updateDoc(doc(db, "groups", gid), { memberUids: arrayUnion(myUid()), invitedPhones: arrayRemove(S.profile.phoneE164 || "-"), invitedEmails: arrayRemove((S.user.email || "").toLowerCase()), [`members.${myUid()}`]: { name: S.profile.name, venmo: S.profile.venmo || "", phone: S.profile.phone || "", photo: S.profile.photo || "", birthday: S.profile.birthday || "" } });
    toast("You're in! 🎉"); go("#/g/" + gid);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "Join the group"; }
    if (!quiet) toast("This group hasn't got you on its list yet. Ask whoever invited you to add you from their Friendly app, then tap Join again.");
  }
}
function routeBody(r) {
  if (r.name === "home") return homeBody();
  if (r.name === "new") return composeBody();
  if (r.name === "groups") return groupsBody();
  if (r.name === "group") return groupPageBody(r.id);
  if (r.name === "join") return joinBody(r.id);
  if (r.name === "money") return moneyBody();
  if (r.name === "expense") return expenseBody(r.id);
  if (r.name === "activity") return activityBody();
  if (r.name === "photos") return photosPageBody();
  if (r.name === "search") return searchBody();
  if (r.name === "profile") return profileBody();
  return homeBody();
}

// ---------- helpers for events visibility/counts ----------
const myUid = () => S.user.uid;
function goingCount(ev) { return (ev.invitedUids || []).reduce((t, u) => (ev.rsvps || {})[u] === "going" ? t + 1 + (((ev.plusOnes || {})[u]) || 0) : t, 0); }
function isFull(ev) { return ev.capacity > 0 && goingCount(ev) >= ev.capacity; }
function canManage(ev) { if (ev._manage != null) return ev._manage; return ev.hostId === myUid() || (ev.cohostUids || []).includes(myUid()); }
function myEvents() {
  return [...S.events.values()].filter(ev => (ev.invitedUids || []).includes(myUid()) || (ev.groupId && S.groups.has(ev.groupId)));
}

// ---------- HOME ----------
let homeFilter = "all";
let homeView = localStorage.getItem("friendlyHomeView") || "cards";   // "cards" | "calendar"
let calYM = null, calDay = null;   // month shown in the calendar, and a tapped day
const fmtDay = ev => evDate(ev).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const RSVP_LABEL = { going: "You're going", maybe: "Maybe", no: "Can't go", waitlist: "Waitlisted", pending: "Pending" };
// One-line event row used by the timeline and by group pages.
function planRow(e) {
  const myR = (e.rsvps || {})[myUid()]; const n = goingCount(e);
  return `<a class="member-row plan-row" data-ev="${e.id}"><span class="li plan-emoji">${esc(e.kind === "meeting" ? "📅" : e.emoji || "🎉")}</span>
    <div style="flex:1;min-width:0"><b>${esc(e.title)}</b><div class="muted sm">${esc(fmtDay(e))}${e.time ? " · " + fmtTime(e.time) : ""}${e.location ? " · " + esc(e.location) : ""}</div></div>
    <span class="muted sm" style="white-space:nowrap">${myR ? RSVP_LABEL[myR] || "" : n + " going"}</span></a>`;
}
function calendarBody(evs) {
  const t = todayStr(); const now = new Date();
  if (!calYM) calYM = { y: now.getFullYear(), m: now.getMonth() };
  const { y, m } = calYM; const first = new Date(y, m, 1); const startDow = first.getDay(); const days = new Date(y, m + 1, 0).getDate();
  const byDay = {}; evs.forEach(e => (byDay[e.date] = byDay[e.date] || []).push(e));
  const key = d => y + "-" + String(m + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  let cells = ""; for (let i = 0; i < startDow; i++) cells += `<div class="cal-cell blank"></div>`;
  for (let d = 1; d <= days; d++) { const k = key(d); const list = byDay[k] || []; cells += `<div class="cal-cell${k === t ? " today" : ""}${list.length ? " has" : ""}${k === calDay ? " sel" : ""}"${list.length ? ` data-calday="${k}"` : ""}><span class="cal-n">${d}</span><span class="cal-dots">${list.slice(0, 3).map(e => esc(e.kind === "meeting" ? "📅" : e.emoji || "🎉")).join("")}</span></div>`; }
  const monthName = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const sel = calDay && byDay[calDay] ? byDay[calDay] : null;
  const agenda = sel || evs.filter(e => e.date >= t).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""))).slice(0, 40);
  let list = "", last = "";
  for (const e of agenda) { if (e.date !== last) { last = e.date; list += `<div class="tl-date">${esc(fmtDay(e))}${e.date === t ? " · Today" : ""}</div>`; } list += planRow(e); }
  return `<div class="card cal"><div class="cal-head"><button class="btn ghost small" id="calPrev" aria-label="Previous month">‹</button><b>${esc(monthName)}</b><button class="btn ghost small" id="calNext" aria-label="Next month">›</button></div>
    <div class="cal-dow">${["S", "M", "T", "W", "T", "F", "S"].map(d => `<span>${d}</span>`).join("")}</div><div class="cal-grid">${cells}</div></div>
    <div class="section-head" style="margin-top:18px"><h2>${sel ? esc(fmtDay(sel[0])) : "Timeline"}</h2>${sel ? `<button class="btn small" id="calClear">All upcoming</button>` : ""}</div>
    <div class="card">${list || `<p class="muted" style="padding:14px 16px;margin:0">Nothing scheduled yet.</p>`}</div>`;
}
function homeBody() {
  const evs = myEvents();
  const t = todayStr();
  let upcoming = evs.filter(e => e.date >= t).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  let past = evs.filter(e => e.date < t).sort((a, b) => b.date.localeCompare(a.date));
  if (homeFilter !== "all") { const f = e => (e.groupId || "none") === homeFilter; upcoming = upcoming.filter(f); past = past.filter(f); }

  // Pending group invites render in shell(), so they show on every page.
  const groups = [...S.groups.values()];
  const filterBar = groups.length ? `<div class="chiprow">
    <button class="fchip ${homeFilter === "all" ? "on" : ""}" data-filter="all">All</button>
    ${groups.map(g => `<button class="fchip ${homeFilter === g.id ? "on" : ""}" data-filter="${g.id}">${esc(g.emoji || "•")} ${esc(g.name)}</button>`).join("")}
    <button class="fchip ${homeFilter === "none" ? "on" : ""}" data-filter="none">Just friends</button>
  </div>` : "";

  return `
  ${notifCard()}
  ${birthdayCard()}
  <div class="section-head"><h2>${homeView === "calendar" ? "Calendar" : "Upcoming"}</h2><span class="btnrow" style="gap:8px"><button class="btn small" id="viewToggle" title="Switch view">${homeView === "calendar" ? "🗂 Cards" : "📅 Calendar"}</button><button class="btn primary small" data-go="#/new">＋ New event</button></span></div>
  ${filterBar}
  ${homeView === "calendar" ? calendarBody([...upcoming, ...past]) : `<div class="ev-grid">${upcoming.length ? upcoming.map(eventCard).join("") : emptyState("🗓️", "No plans yet", "Create your first event: pick a theme and invite the crew.")}</div>
  ${past.length ? `<div class="section-head" style="margin-top:26px"><h2>Past</h2></div><div class="ev-grid dim">${past.map(eventCard).join("")}</div>` : ""}`}`;
}
function emptyState(emoji, title, sub) { return `<div class="card empty"><div class="big">${emoji}</div><b>${esc(title)}</b><p class="muted">${esc(sub)}</p></div>`; }

function eventCard(ev) {
  if (ev.kind === "meeting") return meetingCard(ev);
  const th = themeOf(ev.theme);
  const d = evDate(ev);
  const going = goingCount(ev);
  const guests = (ev.invitedUids || []).slice(0, 5);
  const myR = (ev.rsvps || {})[myUid()];
  const rsvpDot = myR ? `<span class="you-pill ${myR}">${{ going: "You're going", maybe: "Maybe", no: "Can't go", waitlist: "Waitlisted", pending: "Pending" }[myR] || ""}</span>` : "";
  return `
  <a class="ev-card t-${th.id} ${ev.cover ? "has-cover" : ""}" data-ev="${ev.id}" style="--th-accent:${th.accent};--th-ink:${th.ink};--th-on-accent:${th.onAccent}">
    ${ev.cover ? `<img class="cover-img" src="${ev.cover}" alt="" loading="lazy">` : `<div class="ev-card-bg"></div>`}
    <div class="ev-card-body">
      ${ev.cover ? "" : `<div class="ev-card-emoji">${esc(ev.emoji || "🎉")}</div>`}
      <div class="ev-card-title" style="font-family:${th.font},system-ui">${esc(ev.title)}</div>
      <div class="ev-card-date">${MONTHS[d.getMonth()]} ${d.getDate()}${ev.time ? " · " + fmtTime(ev.time) : ""}</div>
      <div class="ev-card-foot">
        <span class="mini-guests">${guests.map(u => avatar(u, "xs")).join("")}${(ev.invitedUids || []).length > 5 ? `<span class="more">+${ev.invitedUids.length - 5}</span>` : ""}</span>
        <span class="count">${going} going${ev.capacity > 0 ? " / " + ev.capacity : ""}</span>
      </div>
      ${rsvpDot}
      ${isNewEvent(ev) ? `<span class="new-pill">New</span>` : ""}
    </div>
  </a>`;
}
function wireHome() {
  document.querySelectorAll("[data-ev]").forEach(a => a.onclick = e => { e.preventDefault(); go("#/e/" + a.dataset.ev); });
  document.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { homeFilter = b.dataset.filter; calDay = null; render(); });
  document.querySelectorAll("[data-bplan]").forEach(b => b.onclick = () => { const x = upcomingBirthdays(400).find(y => y.uid === b.dataset.bplan); if (x) planBirthday(x); });
  document.querySelectorAll("[data-bdismiss]").forEach(b => b.onclick = () => { try { const d = JSON.parse(localStorage.getItem("friendlyBdayDismissed") || "[]"); d.push(b.dataset.bdismiss); localStorage.setItem("friendlyBdayDismissed", JSON.stringify(d.slice(-40))); } catch {} render(); });
  if (el("viewToggle")) el("viewToggle").onclick = () => { homeView = homeView === "calendar" ? "cards" : "calendar"; try { localStorage.setItem("friendlyHomeView", homeView); } catch {} render(); };
  if (el("calPrev")) el("calPrev").onclick = () => { calYM = { y: calYM.m === 0 ? calYM.y - 1 : calYM.y, m: (calYM.m + 11) % 12 }; calDay = null; render(); };
  if (el("calNext")) el("calNext").onclick = () => { calYM = { y: calYM.m === 11 ? calYM.y + 1 : calYM.y, m: (calYM.m + 1) % 12 }; calDay = null; render(); };
  if (el("calClear")) el("calClear").onclick = () => { calDay = null; render(); };
  document.querySelectorAll("[data-calday]").forEach(c => c.onclick = () => { calDay = calDay === c.dataset.calday ? null : c.dataset.calday; render(); });
  if (el("pushOn")) el("pushOn").onclick = enableWebPush;
  if (el("pushLater")) el("pushLater").onclick = () => { localStorage.setItem("friendlyPushDismissed", "1"); render(); };
}

// ---------- GROUPS ----------
function groupsBody() {
  const groups = [...S.groups.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return `
  <div class="section-head"><h2>Your groups</h2><button class="btn primary small" id="newGroupBtn">＋ New group</button></div>
  <p class="muted" style="margin:0 0 14px">Groups are your circles. Invite people once, then plan with them again and again. Everything in a group stays private to its members.</p>
  <div class="stack">${groups.length ? groups.map(groupRow).join("") : emptyState("👥", "No groups yet", "Create a group and invite friends by email.")}</div>`;
}
function groupRow(g) {
  const n = (g.memberUids || []).length;
  return `<a class="card group-row" data-group="${g.id}">
    <span class="ge lg" style="background:${g.color || "#FFE0B2"}">${esc(g.emoji || "🎉")}</span>
    <div style="flex:1;min-width:0"><b>${esc(g.name)}${newCountFor("#/g/" + g.id) ? `<span class="new-count">${newCountFor("#/g/" + g.id)} new</span>` : ""}</b><div class="muted sm">${n} member${n === 1 ? "" : "s"}${g.ownerId === myUid() ? " · you host" : ""}</div></div>
    <span class="chev">›</span></a>`;
}
function wireGroups() {
  el("newGroupBtn").onclick = openGroupDialog;
  document.querySelectorAll("[data-group]").forEach(a => a.onclick = e => { e.preventDefault(); go("#/g/" + a.dataset.group); });
}

function groupPageBody(gid) {
  const g = S.groups.get(gid);
  if (!g) return `<div class="card empty"><b>Group not found</b><p class="muted">You may have left it or it was deleted.</p><button class="btn" data-go="#/groups">Back to groups</button></div>`;
  const members = (g.memberUids || []).map(u => ({ uid: u, ...(g.members || {})[u] }));
  const owner = g.ownerId === myUid();
  // Hosts: the owner plus anyone in hostUids. Hosts invite, manage, and promote; only the owner can delete.
  const hostUids = [g.ownerId, ...(g.hostUids || [])];
  const host = hostUids.includes(myUid());
  return `
  <button class="link-back" data-go="#/groups">‹ Groups</button>
  <div class="group-hero"><span class="ge xl" style="background:${g.color || "#FFE0B2"}">${esc(g.emoji || "🎉")}</span>
    <div><h1>${esc(g.name)}</h1><div class="muted">${members.length} member${members.length === 1 ? "" : "s"}</div></div></div>
  ${g.note || host ? `<div class="card pinned"><span class="pin">📌</span><div style="flex:1;min-width:0;white-space:pre-wrap">${g.note ? esc(g.note) : `<span class="muted">Pin a note for the group: the door code, the address, the standing rules.</span>`}</div>${host ? `<button class="btn ghost small" id="editNote">${g.note ? "Edit" : "Pin a note"}</button>` : ""}</div>` : ""}
  <div class="btnrow">
    <button class="btn primary" data-go="#/new">＋ Plan for this group</button>
    ${host ? `<button class="btn" id="inviteBtn">＋ Add people</button>` : ""}
  </div>
  ${(() => { const t = todayStr(); const evs = myEvents().filter(e => e.groupId === g.id);
    const up = evs.filter(e => e.date >= t).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
    const past = evs.filter(e => e.date < t).sort((a, b) => b.date.localeCompare(a.date));
    return `<div class="section-head" style="margin-top:22px"><h2>Plans</h2>${evs.length ? `<button class="btn small" data-homefilter="${g.id}">Open in Events</button>` : ""}</div>
    <div class="card">${up.length ? up.map(planRow).join("") : `<p class="muted" style="padding:14px 16px;margin:0">Nothing planned yet. Tap “Plan for this group” to start one.</p>`}</div>
    ${past.length ? `<details class="adv" style="margin-top:8px"><summary>${past.length} past</summary><div class="card" style="margin-top:8px">${past.slice(0, 20).map(planRow).join("")}</div></details>` : ""}`; })()}
  ${(() => { const bs = upcomingBirthdays(90, g.id); const anySet = members.some(m => m.birthday); return `<div class="section-head" style="margin-top:22px"><h2>Birthdays</h2></div>
    <div class="card">${bs.length ? bs.map(b => `<div class="member-row">${avatar(b.uid, "lg")}<div style="flex:1;min-width:0"><b>${esc(first(b.name))}</b><div class="muted sm">${esc(fmtDay({ date: b.date }))} · ${b.days === 0 ? "today 🎉" : b.days === 1 ? "tomorrow" : "in " + b.days + " days"}</div></div>${b.days <= 45 ? `<button class="btn small ${b.days <= 30 ? "primary" : ""}" data-bplan="${b.uid}">Plan something</button>` : ""}</div>`).join("") : `<p class="muted sm" style="padding:14px 16px;margin:0">${anySet ? "No birthdays in the next 90 days." : "Nobody has added a birthday yet. Add yours on your profile and the group gets a heads-up a month before."}</p>`}</div>`; })()}
  <div class="section-head" style="margin-top:22px"><h2>Members</h2></div>
  <div class="card">${members.map(m => `<div class="member-row">${avatar(m.uid, "lg")}
    <div style="flex:1;min-width:0"><b>${esc(m.name || "Member")}${m.uid === myUid() ? " (you)" : ""}${hostUids.includes(m.uid) ? " · host" : ""}</b>
    ${m.venmo ? `<div class="muted sm mono">${esc(m.venmo)}</div>` : ""}</div>${host && m.uid !== g.ownerId && m.uid !== myUid() ? `<button class="btn ghost small" data-mkhost="${m.uid}|${hostUids.includes(m.uid) ? 0 : 1}">${hostUids.includes(m.uid) ? "Remove host" : "Make host"}</button>` : ""}</div>`).join("")}</div>
  <div class="section-head" style="margin-top:22px"><h2>Crew tab</h2><button class="btn small" id="gExpense">＋ Expense</button></div>
  ${groupTab(g)}
  ${(g.invitedEmails || []).length ? `<div class="section-head" style="margin-top:18px"><h2>Invited</h2></div>
    <div class="card">${g.invitedEmails.map(e => `<div class="member-row"><span class="avatar lg" style="background:#CBB;opacity:.6">✉︎</span><div style="flex:1"><b class="mono sm">${esc(e)}</b><div class="muted sm">Hasn't joined yet</div></div>${host ? `<button class="btn ghost small" data-uninvite="${esc(e)}">✕</button>` : ""}</div>`).join("")}</div>` : ""}
  <div class="card th-plain" id="wall" style="margin-top:22px"><p class="muted">Loading…</p></div>
  <div class="card th-plain" id="pollsCard" style="margin-top:14px"><p class="muted">Loading…</p></div>
  <div class="btnrow" style="margin-top:20px">
    ${isDemo() ? "" : owner ? `<button class="btn danger-ghost" id="delGroup">Delete group</button>` : `<button class="btn danger-ghost" id="leaveGroup">Leave group</button>`}
  </div>`;
}
function wireGroupPage() {
  const g = S.groups.get(S.route.id); if (!g) { document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go)); return; }
  if (el("inviteBtn")) el("inviteBtn").onclick = () => openInviteDialog(g);
  document.querySelectorAll("[data-ev]").forEach(a => a.onclick = e => { e.preventDefault(); go("#/e/" + a.dataset.ev); });
  document.querySelectorAll("[data-homefilter]").forEach(b => b.onclick = () => { homeFilter = b.dataset.homefilter; go("#/"); });
  document.querySelectorAll("[data-bplan]").forEach(b => b.onclick = () => { const x = upcomingBirthdays(400, g.id).find(y => y.uid === b.dataset.bplan); if (x) planBirthday(x); });
  if (el("editNote")) el("editNote").onclick = () => dialog(`<h3>Pinned note</h3><label class="field"><span>Shown at the top of the group for everyone</span><textarea id="gNote" maxlength="600" style="min-height:110px">${esc(g.note || "")}</textarea></label>`, "Save", async () => {
    try { await updateDoc(doc(db, "groups", g.id), { note: el("gNote").value.trim() }); closeDialog(); toast("Note pinned"); } catch (e) { toast(e.message); }
  });
  document.querySelectorAll("[data-mkhost]").forEach(b => b.onclick = async () => {
    const [uid, add] = b.dataset.mkhost.split("|");
    try { await updateDoc(doc(db, "groups", g.id), { hostUids: add === "1" ? arrayUnion(uid) : arrayRemove(uid) }); toast(add === "1" ? first(nameOf(uid)) + " is now a host" : first(nameOf(uid)) + " is no longer a host"); }
    catch (e) { toast(e.message); }
  });
  if (el("gExpense")) el("gExpense").onclick = () => openExpense(null, g.memberUids, g.id);
  document.querySelectorAll("[data-xopen]").forEach(b => b.onclick = () => go("#/x/" + b.dataset.xopen));
  if (el("delGroup")) el("delGroup").onclick = () => deleteGroup(g);
  if (el("leaveGroup")) el("leaveGroup").onclick = () => leaveGroup(g);
  document.querySelectorAll("[data-uninvite]").forEach(b => b.onclick = () => uninvite(g, b.dataset.uninvite));
  // Live group chat + polls, using the event-page components against groups/{id}/…
  // (S.evSubs is cleared on every render, so these never leak across pages.)
  const pseudo = { id: g.id, _col: ["groups", g.id], _manage: true, title: g.name };
  S.comments = []; S.polls = [];
  const sub = (name, fn) => S.evSubs.push(onSnapshot(subCol(pseudo, name), snap => fn(snap.docs.map(d => ({ id: d.id, ...d.data() }))), e => toast(e.message)));
  sub("comments", rows => { S.comments = rows.sort((a, b) => a.createdAt - b.createdAt); const b = el("wall"); if (b) { b.innerHTML = wallInner(pseudo, "Group chat"); wireWall(pseudo); } });
  sub("polls", rows => { S.polls = rows.sort((a, b) => a.createdAt - b.createdAt); const b = el("pollsCard"); if (b) { b.innerHTML = pollsInner(pseudo, "Poll the group: dates, places, ideas."); wirePolls(pseudo); } });
}

// group create / invite / membership
function openGroupDialog() {
  const emojis = ["🎉", "🍕", "🏕️", "🎮", "🏀", "🍻", "🎬", "🌮", "✈️", "🎨", "🎲", "🏖️"];
  dialog(`<h3>New group</h3>
    <label class="field"><span>Group name</span><input id="gName" maxlength="40" placeholder="Roommates, Book Club, The Crew"></label>
    <label class="field"><span>Icon</span><div class="emoji-pick" id="gEmoji">${emojis.map((e, i) => `<button type="button" class="${i === 0 ? "on" : ""}" data-e="${e}">${e}</button>`).join("")}</div></label>
    <label class="field"><span>Invite by email (optional, comma-separated)</span><input id="gInvite" placeholder="alex@example.com, jo@example.com"></label>`,
    "Create group", async () => {
      const name = el("gName").value.trim(); if (!name) return toast("Give the group a name.");
      const emoji = $("#gEmoji .on")?.dataset.e || "🎉";
      const emails = el("gInvite").value.split(",").map(s => s.trim().toLowerCase()).filter(x => x.includes("@"));
      const memberUids = [myUid()];
      // dedup: block a group whose member set already exists among mine
      const mySet = JSON.stringify([...memberUids].sort());
      for (const g of S.groups.values()) if (JSON.stringify([...(g.memberUids || [])].sort()) === mySet && !(g.invitedEmails || []).length && !emails.length)
        return toast("You already have a group with exactly these members.");
      const id = newId();
      await setDoc(doc(db, "groups", id), {
        name, emoji, color: "#FFE0B2", ownerId: myUid(), memberUids,
        members: { [myUid()]: { name: S.profile.name, venmo: S.profile.venmo || "", phone: S.profile.phone || "" } },
        invitedEmails: emails, createdAt: Date.now()
      });
      closeDialog(); go("#/g/" + id); toast("Group created" + (emails.length ? ", invites sent" : ""));
    });
  document.querySelectorAll("#gEmoji button").forEach(b => b.onclick = () => { document.querySelectorAll("#gEmoji button").forEach(x => x.classList.remove("on")); b.classList.add("on"); });
}
function openInviteDialog(g) {
  const me = myUid(); const picked = [];   // { name, phone, e164, emails[], uid|null }
  const nativeContacts = plugin("Contacts");
  const webPicker = !nativeContacts && ("contacts" in navigator && "ContactsManager" in window);
  const known = [...S.contacts.entries()].filter(([u]) => u !== me && !(g.memberUids || []).includes(u));
  const byPhone = e164 => e164 && known.find(([, i]) => toE164(i.phone) === e164);
  const addPicked = (name, phone, emails) => {
    const e164 = toE164(phone); if (!e164 && !(emails || []).length) return toast("That contact has no phone number or email.");
    if (picked.some(p => (e164 && p.e164 === e164))) return;
    const hit = byPhone(e164); picked.push({ name: name || (hit ? hit[1].name : "") || e164, phone, e164, emails: emails || [], uid: hit ? hit[0] : null }); renderPicked();
  };
  const renderPicked = () => { const box = el("invChosen"); if (box) box.innerHTML = picked.map((p, i) => `<div class="inv-hit"><div style="flex:1;min-width:0"><b>${esc(p.name)}</b><div class="muted sm">${p.uid ? "On Friendly · added right away" : "Gets a text with the join link"}${p.e164 ? " · " + esc(p.e164) : ""}</div></div><button type="button" class="btn ghost small" data-unpick="${i}">✕</button></div>`).join("") || `<p class="muted sm">Nobody picked yet.</p>`; box.querySelectorAll("[data-unpick]").forEach(b => b.onclick = () => { picked.splice(+b.dataset.unpick, 1); renderPicked(); }); };
  dialog(`<h3>Add people to ${esc(g.name)}</h3>
    <p class="muted" style="margin-top:-6px">Pick them from your contacts. Friends already on Friendly are added on the spot; everyone else gets a text from you with a join link.</p>
    ${nativeContacts || webPicker ? `<button type="button" class="btn primary" id="invPick" style="width:100%">📇 Choose from contacts</button>` : `<p class="muted sm">Picking from your address book works in the Friendly iPhone app. Here, type a name and number:</p>`}
    <div class="two" style="margin-top:10px"><label class="field"><span>Name</span><input id="invName" placeholder="Jo Park" maxlength="40" autocomplete="off"></label><label class="field"><span>Phone</span><input id="invPhone" inputmode="tel" placeholder="+1 555 123 4567" autocomplete="off"></label></div>
    <button type="button" class="btn small" id="invAddManual">＋ Add to the list</button>
    <div class="inv-chosen" id="invChosen" style="margin-top:12px"></div>
    ${known.length ? `<details class="adv" style="margin-top:12px"><summary>Friends from your other groups</summary><input class="inv-search" id="invSearch" placeholder="Search by name…" autocomplete="off" style="margin-top:8px"><div class="inv-results" id="invResults"></div></details>` : ""}
    <details class="adv"><summary>Invite by email instead</summary><label class="field" style="margin-top:8px"><span>Emails, comma separated</span><input id="invEmails" placeholder="alex@example.com, jo@example.com"></label><p class="muted sm">They connect automatically when they sign in with that address.</p></details>`,
    "Add & send", async () => {
      const emails = [...new Set([...(el("invEmails") ? el("invEmails").value.split(",") : []), ...picked.flatMap(p => p.uid ? [] : p.emails)].map(x => String(x).trim().toLowerCase()).filter(x => x.includes("@")))];
      const direct = picked.filter(p => p.uid); const texted = picked.filter(p => !p.uid && p.e164);
      if (!direct.length && !texted.length && !emails.length) return toast("Pick someone first.");
      const updates = {};
      if (direct.length) { updates.memberUids = [...new Set([...(g.memberUids || []), ...direct.map(p => p.uid)])]; for (const p of direct) { const info = S.contacts.get(p.uid) || {}; updates[`members.${p.uid}`] = { name: info.name || p.name || "Friend", venmo: info.venmo || "", phone: info.phone || "", photo: info.photo || "", birthday: info.birthday || "" }; } }
      const addE = emails.filter(e => !(g.invitedEmails || []).includes(e)); if (addE.length) updates.invitedEmails = [...(g.invitedEmails || []), ...addE];
      const addP = texted.map(p => p.e164).filter(n => !(g.invitedPhones || []).includes(n)); if (addP.length) updates.invitedPhones = [...(g.invitedPhones || []), ...addP];
      try {
        if (Object.keys(updates).length) await updateDoc(doc(db, "groups", g.id), updates);
        closeDialog(); toast(direct.length ? direct.length + " added" + (texted.length ? ", texting the rest" : "") : texted.length ? "Opening Messages…" : "Invites sent");
        const numbers = picked.map(p => p.e164).filter(Boolean);
        if (numbers.length) setTimeout(() => { location.href = smsLink(numbers, groupInviteText(g)); }, 400);
      } catch (e) { toast(e.message); }
    });
  renderPicked();
  if (el("invAddManual")) el("invAddManual").onclick = () => { addPicked(el("invName").value.trim(), el("invPhone").value.trim(), []); el("invName").value = ""; el("invPhone").value = ""; };
  if (el("invPick")) el("invPick").onclick = async () => {
    try {
      if (nativeContacts) { const r = await nativeContacts.pickContact({ projection: { name: true, emails: true, phones: true } }); const c = r && r.contact; if (!c) return; const nm = c.name ? (c.name.display || [c.name.given, c.name.family].filter(Boolean).join(" ")) : ""; addPicked(nm, ((c.phones || [])[0] || {}).number || "", (c.emails || []).map(e => e.address).filter(Boolean)); }
      else { const rows = await navigator.contacts.select(["name", "tel", "email"], { multiple: true }); rows.forEach(r => addPicked((r.name || [])[0] || "", (r.tel || [])[0] || "", r.email || [])); }
    } catch { toast("Contact picking was cancelled."); }
  };
  if (el("invSearch")) {
    const renderResults = q => { const ql = q.toLowerCase(); const hits = known.filter(([u, i]) => !picked.some(p => p.uid === u) && (i.name || "").toLowerCase().includes(ql)); el("invResults").innerHTML = hits.slice(0, 8).map(([u, i]) => `<div class="inv-hit" data-choose="${u}">${avatar(u)}<div><b>${esc(i.name || "Friend")}</b></div><span class="add">Add</span></div>`).join("") || `<p class="muted sm">No one else to add.</p>`; };
    renderResults(""); el("invSearch").oninput = e => renderResults(e.target.value);
    el("invResults").onclick = e => { const h = e.target.closest("[data-choose]"); if (h) { const i = S.contacts.get(h.dataset.choose) || {}; picked.push({ name: i.name || "Friend", phone: i.phone || "", e164: toE164(i.phone), emails: [], uid: h.dataset.choose }); renderPicked(); renderResults(el("invSearch").value); } };
  }
}
// The text an invitee gets. It comes from the inviter's own number via Messages.
const groupInviteText = g => `Hey! I added you to our group "${g.name}" on Friendly, our crew's home base for plans, invites, photos, and settling up. Join here: https://officialfriendly.com/#/join/${g.id} (free). If you're new, sign up with this phone number and you're in.`;
async function acceptInvite(gid, btn) {
  const g = S.pendingInvites.get(gid) || (S.pendingInvitesPhone && S.pendingInvitesPhone.get(gid)); if (!g) return;
  if (btn) { btn.disabled = true; btn.textContent = "Joining…"; }
  try {
    await updateDoc(doc(db, "groups", gid), {
      memberUids: [...(g.memberUids || []), myUid()],
      invitedEmails: (g.invitedEmails || []).filter(e => e !== (S.user.email || "").toLowerCase()),
      invitedPhones: (g.invitedPhones || []).filter(p => p !== (S.profile.phoneE164 || "-")),
      [`members.${myUid()}`]: { name: S.profile.name, venmo: S.profile.venmo || "", phone: S.profile.phone || "", photo: S.profile.photo || "", birthday: S.profile.birthday || "" }
    });
    toast("You're in! Welcome to " + g.name);
    go("#/groups");
  } catch (e) {
    // Leave the reason on the card, not just in a 3-second toast.
    const msg = "Couldn't join: " + (e.code === "permission-denied" ? "you don't have permission (the invite may be for a different email)" : e.message);
    if (btn) {
      btn.disabled = false; btn.textContent = "Join";
      const row = btn.closest(".invite-row");
      if (row) { let p = row.querySelector(".inv-err"); if (!p) { p = document.createElement("div"); p.className = "inv-err sm"; p.style.cssText = "flex-basis:100%;color:#B3261E"; row.style.flexWrap = "wrap"; row.appendChild(p); } p.textContent = msg; }
    }
    toast(msg);
  }
}
function inviteText(g) { return `Hey! I set up "${g.name}" on Friendly. It's where our group plans hangouts, RSVPs, and splits costs. Grab it at https://officialfriendly.com, sign up with your email, and send me that email so I can add you 🎉`; }
async function uninvite(g, email) { try { await updateDoc(doc(db, "groups", g.id), { invitedEmails: (g.invitedEmails || []).filter(e => e !== email) }); } catch (e) { toast(e.message); } }
async function deleteGroup(g) { if (isDemo()) return toast("Deleting groups is off in demo mode."); if (!confirm(`Delete “${g.name}”? Its events stay, but the group is removed.`)) return; try { await deleteDoc(doc(db, "groups", g.id)); go("#/groups"); toast("Group deleted"); } catch (e) { toast(e.message); } }
async function leaveGroup(g) {
  if (isDemo()) return toast("Leaving groups is off in demo mode.");
  if (!confirm(`Leave “${g.name}”?`)) return;
  try {
    const members = { ...(g.members || {}) }; delete members[myUid()];
    await updateDoc(doc(db, "groups", g.id), { memberUids: (g.memberUids || []).filter(u => u !== myUid()), hostUids: arrayRemove(myUid()), members });
    go("#/groups"); toast("You left " + g.name);
  } catch (e) { toast(e.message); }
}

// ---------- COMPOSE (create event) ----------
const compose = { theme: DEFAULT_THEME, emoji: "🎉", cover: null, coverTab: "emoji",
  title: "", date: "", time: "", end: "", where: "", notes: "", cap: "", approval: false,
  questions: [], invitees: new Set(), cohosts: new Set(), groupId: "" };
function resetCompose() { Object.assign(compose, { theme: DEFAULT_THEME, emoji: "🎉", cover: null, coverTab: "emoji", title: "", date: "", time: "", end: "", where: "", notes: "", cap: "", approval: false, questions: [], invitees: new Set(), cohosts: new Set(), groupId: "", kind: "event", repeat: "", guestEmails: "", _restored: false, _fromDraft: false }); }
function composeBody() {
  restoreDraft();
  const emojis = ["🎉", "🍕", "🌮", "🍻", "🎂", "🎬", "🎮", "🏖️", "🥾", "⚽", "🎲", "🍜", "🎃", "🎄", "🕺", "🔥"];
  const groups = [...S.groups.values()];
  const th = themeOf(compose.theme);
  return `
  <button class="link-back" data-go="#/">‹ Cancel</button>
  <div class="compose">
    <div class="seg kind-seg" id="kindSeg">
      <button type="button" class="${compose.kind !== "meeting" ? "on" : ""}" data-kind="event">🎉 Event</button>
      <button type="button" class="${compose.kind === "meeting" ? "on" : ""}" data-kind="meeting">📅 Meeting</button>
    </div>
    ${compose._fromDraft ? `<p class="muted sm" style="margin:-4px 0 10px">Restored your draft · <a id="discardDraft" style="color:var(--accent);font-weight:600">Discard</a></p>` : ""}
    ${compose.kind === "meeting" ? `<p class="muted sm" style="margin:-4px 0 12px">A plain calendar entry: title, time, place, who. Everyone gets a calendar invite by email.</p>` : ""}
    <div class="${compose.kind === "meeting" ? "hidden" : ""}">
    <div class="compose-preview t-${th.id}" id="cPreview" style="--th-accent:${th.accent};--th-ink:${th.ink};--th-on-accent:${th.onAccent};font-family:${th.font},system-ui">
      ${compose.cover ? `<div class="preview-cover"><img src="${compose.cover}" alt=""></div>` : ""}
      <canvas class="preview-canvas" id="cCanvas"></canvas>
      <div class="preview-body" style="${compose.cover ? "color:#fff" : ""}">
        ${compose.cover ? "" : `<div class="preview-emoji" id="cPvEmoji">${esc(compose.emoji)}</div>`}
        <div class="preview-title" id="cPvTitle">Your event</div>
        <div class="preview-date" id="cPvDate">Pick a date</div>
      </div>
    </div>

    <div class="section-head" style="margin-top:18px"><h2>Cover</h2></div>
    <div class="form-card card">
      <div class="cover-tabs">
        <button type="button" data-ctab="emoji" class="${compose.coverTab === "emoji" ? "on" : ""}">Emoji</button>
        <button type="button" data-ctab="upload" class="${compose.coverTab === "upload" ? "on" : ""}">Upload</button>
        <button type="button" data-ctab="ai" class="${compose.coverTab === "ai" ? "on" : ""}">✨ AI art</button>
      </div>
      <div class="cover-panel" id="coverPanel">${coverPanel()}</div>
    </div>

    <div class="section-head" style="margin-top:18px"><h2>Theme</h2></div>
    <div class="theme-strip" id="themeStrip">
      ${THEMES.map(t => `<button class="theme-swatch t-${t.id} ${t.id === compose.theme ? "on" : ""}" data-theme="${t.id}" title="${t.name}"><span class="theme-swatch-bg"></span><span class="theme-name" style="font-family:${t.font},system-ui">${esc(t.name)}</span></button>`).join("")}
    </div>
    </div>

    <div class="form-card card">
      <label class="field"><span>${compose.kind === "meeting" ? "Meeting title" : "What's the plan?"}</span><input id="cTitle" maxlength="80" value="${esc(compose.title)}" placeholder="Rooftop taco night"></label>
      <div class="two">
        <label class="field"><span>Date</span><input id="cDate" type="date" value="${compose.date || todayStr()}"></label>
        <label class="field"><span>Start</span><input id="cTime" type="time" value="${compose.time}"></label>
      </div>
      <div class="two">
        <label class="field"><span>End</span><input id="cEnd" type="time" value="${compose.end}"></label>
        <label class="field"><span>Max spots</span><input id="cCap" type="number" min="1" max="1000" value="${compose.cap}" placeholder="No limit"></label>
      </div>
      <label class="field"><span>Where</span><input id="cWhere" maxlength="90" value="${esc(compose.where)}" placeholder="Address or vibe"></label>
      <label class="field"><span>The details</span><textarea id="cNotes" maxlength="600" placeholder="Dress code, what to bring, parking…">${esc(compose.notes)}</textarea></label>
      <div class="two stack-sm">
        <label class="field"><span>Repeats</span><select id="cRepeat"><option value="" ${!compose.repeat ? "selected" : ""}>Never</option><option value="weekly" ${compose.repeat === "weekly" ? "selected" : ""}>Every week</option><option value="biweekly" ${compose.repeat === "biweekly" ? "selected" : ""}>Every 2 weeks</option><option value="monthly" ${compose.repeat === "monthly" ? "selected" : ""}>Every month</option></select></label>
        <label class="field"><span>Also email invites to</span><input id="cEmails" value="${esc(compose.guestEmails || "")}" placeholder="pat@example.com, sam@…"></label>
      </div>
      <p class="muted sm" style="margin:-4px 0 0">Guests get a calendar invite at their email on file. Add anyone who isn't on Friendly here.</p>
    </div>

    <div class="section-head"><h2>Who's invited</h2></div>
    <div class="form-card card">
      ${groups.length ? `<label class="field"><span>Invite a whole group</span>
        <select id="cGroup"><option value="">Hand-pick friends instead</option>${groups.map(g => `<option value="${g.id}" ${compose.groupId === g.id ? "selected" : ""}>${esc(g.emoji || "")} ${esc(g.name)} (${(g.memberUids || []).length})</option>`).join("")}</select></label>` : `<p class="muted">You're not in any groups yet. <a data-go="#/groups">Create one</a> to invite people, or invite friends you already share a group with below.</p>`}
      <div id="cPickWrap" class="${compose.groupId ? "hidden" : ""}">
        <span class="field-label">Friends</span>
        <div class="check-grid" id="cInvitees">${contactChecks("inv", compose.invitees)}</div>
      </div>
      <div class="${compose.kind === "meeting" ? "hidden" : ""}">
      <details class="adv"><summary>Co-hosts &amp; approval</summary>
        <span class="field-label" style="margin-top:10px">Co-hosts (can edit &amp; manage)</span>
        <div class="check-grid" id="cCohosts">${contactChecks("coh", compose.cohosts)}</div>
        <label class="switch"><input type="checkbox" id="cApproval"><span>Approve guests before they're in</span></label>
      </details>
      <label class="switch" style="margin-top:12px"><input type="checkbox" id="cOpenLink" ${compose.openLink === false ? "" : "checked"}><span>Anyone with the link can join (so you can text people who aren't on Friendly yet)</span></label>
      <button type="button" class="btn small" id="cTextInvite" style="margin-top:10px">💬 Create &amp; text friends the invite</button>
      <p class="muted sm" style="margin:6px 0 0">Creates the event, then opens Messages with the invite and link already written, sent from your own number.</p>
      </div>
    </div>

    <div class="${compose.kind === "meeting" ? "hidden" : ""}">
    <div class="section-head"><h2>RSVP questions <span class="muted sm">optional</span></h2></div>
    <div class="form-card card">
      <div id="qList" class="stack">${compose.questions.map(q => qRow(q)).join("")}</div>
      <button class="btn ghost small" id="addQ">＋ Add a question</button>
      <p class="muted sm" style="margin:8px 0 0">e.g. “What are you bringing?” · “Any dietary restrictions?”</p>
    </div>

    </div>
    <button class="btn primary lg full" id="createEventBtn">${compose.kind === "meeting" ? "Create meeting &amp; send invites" : "Create event &amp; send invites"}</button>
  </div>`;
}
function qRow(q) { return `<div class="q-row" data-q="${q.id}"><input value="${esc(q.q)}" data-qedit="${q.id}" maxlength="80" placeholder="Your question"><button class="btn ghost small" data-qdel="${q.id}">✕</button></div>`; }
const COVER_EMOJIS = ["🎉", "🍕", "🌮", "🍻", "🎂", "🎬", "🎮", "🏖️", "🥾", "⚽", "🎲", "🍜", "🎃", "🎄", "🕺", "🔥"];
function coverPanel() {
  if (compose.cover) return `<div class="cover-preview-img"><img src="${compose.cover}" alt="cover"><button type="button" class="rm" id="coverRemove">✕</button></div>`;
  if (compose.coverTab === "upload") return `<div class="cover-drop" id="coverDrop">📷 Tap to upload a photo</div>`;
  if (compose.coverTab === "ai") return `<div class="ai-row"><input id="aiPrompt" placeholder="e.g. neon rooftop taco party at sunset"><button type="button" class="btn primary" id="aiGo">Generate</button></div><p class="muted sm" style="margin:8px 0 0">Describe your vibe and AI paints a one-of-a-kind cover.</p>`;
  return `<div class="emoji-pick" id="cEmoji">${COVER_EMOJIS.map(e => `<button type="button" class="${e === compose.emoji ? "on" : ""}" data-e="${e}">${e}</button>`).join("")}</div>`;
}
function contactChecks(name, set) {
  const others = [...S.contacts.entries()].filter(([u]) => u !== myUid());
  if (!others.length) return `<span class="muted sm">No friends yet. Invite people to a group first.</span>`;
  return others.map(([u, info]) => `<label class="cbox"><input type="checkbox" name="${name}" value="${u}" ${set.has(u) ? "checked" : ""}>${avatar(u)} ${esc(first(info.name))}</label>`).join("");
}
function syncCompose() {
  compose.title = el("cTitle").value; compose.date = el("cDate").value; compose.time = el("cTime").value;
  compose.end = el("cEnd").value; compose.where = el("cWhere").value; compose.notes = el("cNotes").value;
  compose.cap = el("cCap").value; if (el("cApproval")) compose.approval = el("cApproval").checked;
  if (el("cOpenLink")) compose.openLink = el("cOpenLink").checked;
  if (el("cRepeat")) compose.repeat = el("cRepeat").value; if (el("cEmails")) compose.guestEmails = el("cEmails").value;
  saveDraft();
}
function wireCompose() {
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  composeStop = startParticles(el("cCanvas"), compose.theme);
  const upd = () => {
    el("cPvTitle").textContent = el("cTitle").value.trim() || "Your event";
    const dv = el("cDate").value, tv = el("cTime").value;
    el("cPvDate").textContent = dv ? evDate({ date: dv }).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) + (tv ? " · " + fmtTime(tv) : "") : "Pick a date";
  };
  ["cTitle", "cDate", "cTime", "cEnd", "cWhere", "cNotes", "cCap"].forEach(id => el(id).oninput = () => { syncCompose(); upd(); }); upd();
  attachPlaces(el("cWhere"));
  wireCover();
  document.querySelectorAll("[data-theme]").forEach(b => b.onclick = () => { syncCompose(); compose.theme = b.dataset.theme; render(); });
  const gsel = el("cGroup"); if (gsel) gsel.onchange = () => { compose.groupId = gsel.value; el("cPickWrap").classList.toggle("hidden", !!compose.groupId); };
  el("addQ").onclick = () => { compose.questions.push({ id: newId().slice(0, 6), q: "" }); el("qList").insertAdjacentHTML("beforeend", qRow(compose.questions[compose.questions.length - 1])); wireQ(); };
  wireQ();
  el("createEventBtn").onclick = () => createEvent(false);
  document.querySelectorAll("[data-kind]").forEach(b => b.onclick = () => { syncCompose(); compose.kind = b.dataset.kind; render(); });
  if (el("discardDraft")) el("discardDraft").onclick = () => { localStorage.removeItem("friendlyDraft"); resetCompose(); compose._restored = true; render(); };
  el("cTextInvite").onclick = () => createEvent(true);
}
function refreshCoverUI() {
  el("coverPanel").innerHTML = coverPanel();
  const pv = $("#cPreview");
  const oldCover = pv.querySelector(".preview-cover"); if (oldCover) oldCover.remove();
  const body = pv.querySelector(".preview-body");
  if (compose.cover) { pv.insertAdjacentHTML("afterbegin", `<div class="preview-cover"><img src="${compose.cover}" alt=""></div>`); body.style.color = "#fff"; const em = el("cPvEmoji"); if (em) em.remove(); }
  else { body.style.color = ""; if (!el("cPvEmoji")) body.insertAdjacentHTML("afterbegin", `<div class="preview-emoji" id="cPvEmoji">${esc(compose.emoji)}</div>`); }
  wireCover();
}
function wireCover() {
  document.querySelectorAll("[data-ctab]").forEach(b => b.onclick = () => { compose.coverTab = b.dataset.ctab; refreshCoverUI(); });
  document.querySelectorAll("#cEmoji button").forEach(b => b.onclick = () => { compose.emoji = b.dataset.e; document.querySelectorAll("#cEmoji button").forEach(x => x.classList.remove("on")); b.classList.add("on"); const em = el("cPvEmoji"); if (em) em.textContent = b.dataset.e; });
  if (el("coverRemove")) el("coverRemove").onclick = () => { compose.cover = null; refreshCoverUI(); };
  if (el("coverDrop")) el("coverDrop").onclick = async () => { const f = await pickFile(); if (!f) return; el("coverDrop").textContent = "Processing…"; try { compose.cover = await compressImage(f, 1600, 0.82); refreshCoverUI(); } catch { toast("Couldn't read that image."); el("coverDrop").textContent = "📷 Tap to upload a photo"; } };
  if (el("aiGo")) el("aiGo").onclick = async () => {
    const p = el("aiPrompt").value.trim(); if (!p) return toast("Describe the vibe first.");
    el("coverPanel").innerHTML = `<div class="cover-spin"><div class="spinner"></div>Painting your cover…</div>`;
    try { compose.cover = await generateCover(p); refreshCoverUI(); toast("Fresh cover, made for you ✨"); }
    catch (e) { toast(e.message || "Generator busy, try again."); compose.coverTab = "ai"; refreshCoverUI(); }
  };
}
let composeStop = () => {};
function wireQ() {
  document.querySelectorAll("[data-qdel]").forEach(b => b.onclick = () => { compose.questions = compose.questions.filter(q => q.id !== b.dataset.qdel); $(`.q-row[data-q="${b.dataset.qdel}"]`)?.remove(); });
  document.querySelectorAll("[data-qedit]").forEach(i => i.oninput = () => { const q = compose.questions.find(q => q.id === i.dataset.qedit); if (q) q.q = i.value; });
}
async function createEvent(thenText) {
  const title = el("cTitle").value.trim(); if (!title) return toast("Add a title.");
  const date = el("cDate").value; if (!date) return toast("Pick a date.");
  let invitedUids, groupId = compose.groupId || null;
  if (groupId) { const g = S.groups.get(groupId); invitedUids = [...new Set([...(g.memberUids || []), myUid()])]; }
  else { invitedUids = [...new Set([...[...document.querySelectorAll('input[name=inv]:checked')].map(i => i.value), myUid()])]; }
  const cohostUids = [...document.querySelectorAll('input[name=coh]:checked')].map(i => i.value).filter(u => u !== myUid());
  const questions = compose.questions.filter(q => q.q.trim());
  const id = newId();
  const ev = {
    hostId: myUid(), hostName: S.profile.name, cohostUids, groupId, invitedUids,
    // Guest names travel with the event so link-joined guests can see who's who.
    names: Object.fromEntries(invitedUids.map(u => [u, u === myUid() ? S.profile.name : nameOf(u)])),
    title, emoji: compose.emoji, theme: compose.theme, cover: compose.cover || "",
    date, time: el("cTime").value || "", endTime: el("cEnd").value || "",
    location: el("cWhere").value.trim(), notes: el("cNotes").value.trim(),
    capacity: Number(el("cCap").value) || 0, approval: !!el("cApproval").checked,
    questions, rsvps: { [myUid()]: "going" }, plusOnes: {}, hypes: {}, answers: {},
    openLink: el("cOpenLink") ? el("cOpenLink").checked : true,
    kind: compose.kind === "meeting" ? "meeting" : "event", repeat: el("cRepeat") ? el("cRepeat").value : "",
    guestEmails: (el("cEmails") ? el("cEmails").value : "").split(",").map(x => x.trim().toLowerCase()).filter(x => x.includes("@")), sequence: 0,
    createdAt: Date.now()
  };
  try {
    el("createEventBtn").disabled = true; el("createEventBtn").textContent = "Creating…";
    await setDoc(doc(db, "events", id), ev);
    composeStop(); resetCompose(); localStorage.removeItem("friendlyDraft");
    go("#/e/" + id); toast((ev.kind === "meeting" ? "Meeting" : "Event") + " created, invites are on their way");
    // "Create & text": hand off to Messages once the event page is up.
    if (thenText) setTimeout(() => textEventInvite({ id, ...ev }), 400);
  } catch (e) { toast("Couldn't create: " + e.message); el("createEventBtn").disabled = false; el("createEventBtn").textContent = "Create event & send invites"; }
}

// ---------- EVENT PAGE (the themed invite) ----------
let eventBgStop = () => {};
function cleanupEvent() { S.evSubs.forEach(fn => fn()); S.evSubs = []; eventBgStop(); eventBgStop = () => {}; }
function renderEventPage(root, id) {
  cleanupEvent();
  const ev = S.events.get(id);
  if (!ev) { root.innerHTML = shell(`<div class="card empty"><b>Loading event…</b><p class="muted">If this stays, you may not have access.</p><button class="btn" data-go="#/">Home</button></div>`); wireShell(); getDoc(doc(db, "events", id)).then(d => { if (d.exists()) { S.events.set(id, { id, ...d.data() }); render(); } }); return; }
  if (ev.kind === "meeting") { root.innerHTML = shell(meetingBody(ev)); wireShell(); wireMeeting(ev); return; }
  const th = themeOf(ev.theme);
  root.innerHTML = `<div class="event-page t-${th.id}" id="evPage" style="--th-font:${th.font},system-ui;--th-ink:${th.ink};--th-sub:${th.sub};--th-accent:${th.accent};--th-on-accent:${th.onAccent};--th-chip:${th.chip};--th-card:${th.card}">
    <canvas class="event-bg-canvas" id="evCanvas"></canvas>
    <div class="event-scroll">${eventInner(ev)}</div>
  </div>`;
  eventBgStop = startParticles(el("evCanvas"), ev.theme);
  wireEventPage(ev);
  // live subcollections (comments, photos, polls, songs)
  S.evSubs.forEach(fn => fn()); S.evSubs = [];
  S.comments = []; S.photos = []; S.polls = []; S.songs = [];
  const sub = (name, fn) => S.evSubs.push(onSnapshot(collection(db, "events", id, name), snap => fn(snap.docs.map(d => ({ id: d.id, ...d.data() }))), err => console.warn("listener event/" + name + ":", err.code || err.message)));
  sub("comments", rows => { S.comments = rows.sort((a, b) => a.createdAt - b.createdAt); const b = el("wall"); if (b) { b.innerHTML = wallInner(ev); wireWall(ev); } const dc = el("dayCard"); if (dc) { dc.innerHTML = dayInner(ev); wireDay(ev); } });
  sub("photos", rows => { S.photos = rows.sort((a, b) => b.createdAt - a.createdAt); const b = el("photosCard"); if (b) { b.innerHTML = photosInner(ev); wirePhotos(ev); } });
  sub("polls", rows => { S.polls = rows.sort((a, b) => a.createdAt - b.createdAt); const b = el("pollsCard"); if (b) { b.innerHTML = pollsInner(ev); wirePolls(ev); } });
  sub("songs", rows => { S.songs = rows.sort((a, b) => (Object.keys(b.votes || {}).length - Object.keys(a.votes || {}).length) || a.createdAt - b.createdAt); const b = el("playlistCard"); if (b) { b.innerHTML = playlistInner(ev); wirePlaylist(ev); } });
}
function statusGroups(ev) {
  const g = { going: [], maybe: [], no: [], waitlist: [], pending: [], none: [] };
  (ev.invitedUids || []).forEach(u => g[(ev.rsvps || {})[u] || "none"].push(u));
  return g;
}
function eventInner(ev) {
  const th = themeOf(ev.theme);
  const me = myUid();
  const myR = (ev.rsvps || {})[me];
  const myPlus = ((ev.plusOnes || {})[me]) || 0;
  const g = statusGroups(ev);
  const going = goingCount(ev);
  const full = isFull(ev);
  const hosts = [ev.hostId, ...(ev.cohostUids || [])].filter((v, i, a) => a.indexOf(v) === i);
  const manage = canManage(ev);
  const grp = ev.groupId ? S.groups.get(ev.groupId) : null;

  const HYPES = ["🔥", "❤️", "🎉", "😂", "🙌"];
  const hypeBar = `<div class="hype-bar">${HYPES.map(h => {
    const n = Object.values(ev.hypes || {}).filter(v => v === h).length;
    const mine = (ev.hypes || {})[me] === h;
    return `<button class="hype ${mine ? "on" : ""}" data-hype="${h}">${h}${n ? `<b>${n}</b>` : ""}</button>`;
  }).join("")}</div>`;

  const rsvpBtns = (ev.invitedUids || []).includes(me) ? `
    <div class="rsvp">
      <button class="rb going ${myR === "going" ? "on" : ""}" data-rsvp="going">Going</button>
      <button class="rb maybe ${myR === "maybe" ? "on" : ""}" data-rsvp="maybe">Maybe</button>
      <button class="rb no ${myR === "no" ? "on" : ""}" data-rsvp="no">Can't go</button>
    </div>
    ${myR === "going" || myR === "waitlist" ? `<div class="plus"><span>Bringing</span>
      <button data-plus="-1" ${myPlus <= 0 ? "disabled" : ""}>−</button><b>+${myPlus}</b><button data-plus="1">＋</button></div>
    ${myPlus > 0 ? `<input class="plus-name" id="plusName" maxlength="60" placeholder="Who's coming with you?" value="${esc((ev.plusNames || {})[me] || "")}">` : ""}` : ""}
    ${myR === "pending" ? `<p class="pending-note">⏳ Waiting for the host to approve you.</p>` : ""}
    ${full && myR !== "going" ? `<p class="full-note">This event is full. RSVP to join the waitlist.</p>` : ""}
    ${questionsBlock(ev, me, myR)}` : ev.openLink ? `<p class="not-invited">You're invited! Join the guest list to RSVP.</p><div class="rsvp"><button class="rb going" data-join>Join this event</button></div>` : `<p class="not-invited">You're viewing this event but aren't on the guest list.</p>`;

  const guestList = ["going", "maybe", "waitlist", "pending", "no", "none"].map(k => {
    if (!g[k].length) return "";
    const label = { going: "Going", maybe: "Maybe", waitlist: "Waitlist", pending: "Awaiting approval", no: "Can't make it", none: "Invited" }[k];
    return `<div class="guest-group"><div class="guest-label">${label} · ${g[k].length}</div><div class="guest-chips">${g[k].map(u => `
      <span class="guest-chip">${avatar(u)}${esc(first(nameOf(u)))}${(ev.plusOnes || {})[u] ? `<i class="plusone">+${ev.plusOnes[u]}</i>` : ""}
      ${manage && (k === "pending") ? `<button class="approve" data-approve="${u}" title="Approve">✓</button>` : ""}
      ${manage && (k === "waitlist") ? `<button class="approve" data-promote="${u}" title="Move in">↑</button>` : ""}</span>`).join("")}</div></div>`;
  }).join("");

  const cost = [...S.expenses.values()].filter(x => x.eventId === ev.id).reduce((t, x) => t + x.amountCents, 0);

  return `
  <button class="ev-back" data-go="#/">‹</button>
  ${ev.cover ? `<div class="event-cover"><img src="${ev.cover}" alt="${esc(ev.title)}"></div>` : ""}
  <div class="event-hero">
    ${ev.cover ? "" : `<div class="ev-emoji">${esc(ev.emoji || "🎉")}</div>`}
    <h1 class="ev-title">${esc(ev.title)}</h1>
    <div class="ev-when">${esc(fmtWhen(ev))}</div>
    <div class="ev-count">${countdown(ev)}</div>
    ${ev.location ? `<div class="ev-where"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener" title="Open in Google Maps">📍 ${esc(ev.location)}</a></div>${/zoom|meet\.google|teams|http|online|call/i.test(ev.location) ? "" : `<details class="map-wrap"><summary>Show map</summary><iframe class="map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://maps.google.com/maps?q=${encodeURIComponent(ev.location)}&output=embed" title="Map"></iframe></details>`}` : ""}
    <div class="ev-hosts">Hosted by ${hosts.map(u => esc(first(nameOf(u)))).join(" & ")}${grp ? ` · <span class="grp-tag">${esc(grp.emoji || "")} ${esc(grp.name)}</span>` : ""}</div>
    ${ev.capacity > 0 ? `<div class="ev-cap ${full ? "full" : ""}">${going} / ${ev.capacity} spots${full ? " · full" : ""}</div>` : ""}
    ${hypeBar}
  </div>

  ${ev.notes ? `<div class="ev-card-glass ev-notes">${esc(ev.notes).replace(/\n/g, "<br>")}</div>` : ""}

  <div class="ev-card-glass">${rsvpBtns}</div>

  <div class="ev-card-glass">
    <div class="glass-head">Guest list <span>${(ev.invitedUids || []).length} invited</span></div>
    ${guestList || `<p class="muted-th">No guests yet.</p>`}
    ${manage && (ev.questions || []).length ? `<button class="btn-th ghost small" id="viewAnswers">View RSVP answers</button>` : ""}
    ${manage && (ev.invitedUids || []).filter(u => u !== me && !(ev.rsvps || {})[u]).length ? `<button class="btn-th ghost small" id="nudgeBtn">Nudge ${(ev.invitedUids || []).filter(u => u !== me && !(ev.rsvps || {})[u]).length} who haven't answered</button>` : ""}
  </div>

  <div class="ev-card-glass" id="dayCard">${dayInner(ev)}</div>
  <div class="ev-card-glass" id="pollsCard">${pollsInner(ev)}</div>
  <div class="ev-card-glass" id="playlistCard">${playlistInner(ev)}</div>
  <div class="ev-card-glass" id="photosCard">${photosInner(ev)}</div>
  <div class="ev-card-glass" id="wall">${wallInner(ev)}</div>

  <div class="ev-actions">
    <button class="btn-th" data-share>Share invite</button>
    ${manage ? `<button class="btn-th" data-text>Text invite</button>` : ""}
    <button class="btn-th" data-cal>Add to calendar</button>
    <button class="btn-th" data-expense>${cost ? fmt$(cost) + " · " : ""}Expenses</button>
    ${manage ? `<button class="btn-th" data-edit>Edit</button><button class="btn-th" data-dup>Duplicate</button><button class="btn-th danger" data-del>Delete</button>` : ""}
  </div>
  <div class="ev-foot">Friendly</div>`;
}
function questionsBlock(ev, me, myR) {
  if (!(ev.questions || []).length || !(myR === "going" || myR === "maybe" || myR === "waitlist")) return "";
  const mine = (ev.answers || {})[me] || {};
  return `<div class="q-answers"><div class="glass-head sm">A few questions from the host</div>
    ${ev.questions.map(q => `<label class="qa"><span>${esc(q.q)}</span><input data-answer="${q.id}" value="${esc(mine[q.id] || "")}" placeholder="Your answer"></label>`).join("")}
    <button class="btn-th ghost small" id="saveAnswers">Save answers</button></div>`;
}
// Reactions: the five original short names plus any emoji from the keyboard,
// stored as "e<hex>_<hex>" so the key is a plain field name (Firestore field
// paths can't hold emoji).
const REACTS = { heart: "❤️", laugh: "😂", fire: "🔥", up: "👍", wow: "😮" };
const QUICK_REACTS = ["❤️", "😂", "🔥", "👍", "😮", "🎉", "😍", "🙏"];
const rkey = e => Object.keys(REACTS).find(k => REACTS[k] === e) || "e" + [...e].map(ch => ch.codePointAt(0).toString(16)).join("_");
const rshow = k => REACTS[k] || (/^e[0-9a-f_]+$/.test(k) ? k.slice(1).split("_").map(h => String.fromCodePoint(parseInt(h, 16))).join("") : "");
const firstGrapheme = v => { try { return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(v)][0].segment; } catch { return [...v][0]; } };
let replyTo = null;   // { id, name, ctx } while composing a threaded reply
const parentPatch = ev => replyTo && replyTo.ctx === ev.id ? { parentId: replyTo.id } : {};
function renderText(text, mentions) {
  let h = esc(text);
  (mentions || []).forEach(u => { const n = first(nameOf(u)); if (n && n !== "Someone") h = h.split("@" + esc(n)).join(`<b class="mention">@${esc(n)}</b>`); });
  return h;
}
// Who can be @mentioned here: the event's guests, the group's members, or the expense's people.
function wallParticipants(ev) {
  const ids = ev._col && ev._col[0] === "groups" ? ((S.groups.get(ev.id) || {}).memberUids || [])
    : ev._col && ev._col[0] === "expenses" ? ((S.expenses.get(ev.id) || {}).involved || []) : (ev.invitedUids || []);
  return ids.filter(u => u !== myUid()).map(u => ({ uid: u, name: first(nameOf(u)) })).filter(p => p.name !== "Someone");
}
function lightbox(src) { const box = document.createElement("div"); box.className = "lightbox"; box.innerHTML = `<img src="${src}" alt="">`; box.onclick = () => box.remove(); document.body.appendChild(box); }
function wallInner(ev, title = "Party wall") {
  const all = S.comments.filter(c => !c.kind && visibleContent(c)); const me = myUid();
  if (replyTo && replyTo.ctx !== ev.id) replyTo = null;
  const ids = new Set(all.map(c => c.id));
  const kids = {}; all.forEach(c => { if (c.parentId && ids.has(c.parentId)) (kids[c.parentId] = kids[c.parentId] || []).push(c); });
  const tops = all.filter(c => !(c.parentId && ids.has(c.parentId)));
  const msg = (c, topId) => {
    const rx = Object.entries(c.reactions || {}).filter(([k, us]) => rshow(k) && us && us.length);
    const who = first(c.authorName || nameOf(c.authorId));
    return `<div class="wall-msg${topId ? " reply" : ""}">${avatar(c.authorId, "sm")}<div style="flex:1;min-width:0"><div class="wall-who">${esc(who)} <i>${ago(c.createdAt)}</i></div>
      ${c.gif ? `<img class="wall-img wall-gif" src="${esc(c.gif)}" alt="GIF">` : ""}${c.img ? `<img class="wall-img" src="${c.img}" alt="">` : ""}${c.text ? `<div class="wall-text">${renderText(c.text, c.mentions)}</div>` : ""}
      <div class="react-row">${rx.map(([k, us]) => `<button type="button" class="react ${us.includes(me) ? "on" : ""}" data-react="${c.id}|${k}">${rshow(k)} ${us.length}</button>`).join("")}<button type="button" class="react add" data-reactpick="${c.id}" title="React">＋</button><button type="button" class="react add" data-reply="${topId || c.id}|${esc(who)}">↩ Reply</button></div>
      ${(kids[c.id] || []).map(r => msg(r, c.id)).join("")}</div>
      ${c.authorId === me || isAdmin() ? `<button class="wall-del" data-delc="${c.id}" title="Delete">✕</button>` : `<button class="wall-del" data-report="comment|${c.id}" title="Report">⚑</button>`}</div>`;
  };
  return `<div class="glass-head">${esc(title)} <span>${all.length}</span></div>
    <div class="wall-list scroll-cap" id="wallList">${tops.length ? tops.map(c => msg(c, "")).join("") : `<p class="muted-th">Be the first to say something 👋</p>`}</div>
    <div class="reply-chip" id="replyChip" ${replyTo ? "" : "hidden"}>Replying to <b>${esc(replyTo ? replyTo.name : "")}</b><button type="button" id="cancelReply" title="Cancel reply">✕</button></div>
    <div class="mention-list" id="mentionList" hidden></div>
    <form class="wall-form" id="wallForm"><button type="button" class="btn-th small" id="wallPhoto" title="Add a photo">📷</button>${giphyKey ? `<button type="button" class="btn-th small" id="wallGif" title="Add a GIF">GIF</button>` : ""}<input id="wallInput" maxlength="300" placeholder="Say something… @ to mention" autocomplete="off"><button class="btn-th accent small">Post</button></form>`;
}
function wireWall(ev) {
  const f = el("wallForm"); if (f) f.onsubmit = e => { e.preventDefault(); postComment(ev); };
  const list = el("wallList"); if (list) list.scrollTop = list.scrollHeight;
  const bindReacts = () => document.querySelectorAll("[data-react]").forEach(b => b.onclick = () => { const [cid, k] = b.dataset.react.split("|"); toggleReaction(ev, cid, k); });
  bindReacts();
  document.querySelectorAll("[data-delc]").forEach(b => b.onclick = () => deleteComment(ev, b.dataset.delc));
  document.querySelectorAll("[data-report]").forEach(b => b.onclick = () => { const [kind, id] = b.dataset.report.split("|"); reportContent(ev, kind, id); });
  // "＋" opens a row of common emoji plus a tiny box that accepts any emoji from the keyboard.
  document.querySelectorAll("[data-reactpick]").forEach(b => b.onclick = () => {
    const cid = b.dataset.reactpick; const box = document.createElement("span"); box.className = "react-pick";
    box.innerHTML = QUICK_REACTS.map(e => `<button type="button" class="react" data-react="${cid}|${rkey(e)}">${e}</button>`).join("") + `<input class="react-any" maxlength="8" placeholder="any" aria-label="Any emoji" inputmode="text">`;
    b.replaceWith(box); bindReacts();
    const inp = box.querySelector(".react-any");
    inp.oninput = () => { const v = inp.value.trim(); if (!v || /^[\x20-\x7e]+$/.test(v)) return; inp.value = ""; toggleReaction(ev, cid, rkey(firstGrapheme(v))); };
  });
  document.querySelectorAll("[data-reply]").forEach(b => b.onclick = () => {
    const [id, name] = b.dataset.reply.split("|"); replyTo = { id, name, ctx: ev.id };
    const ch = el("replyChip"); if (ch) { ch.hidden = false; ch.querySelector("b").textContent = name; }
    const inp = el("wallInput"); if (inp) inp.focus();
  });
  const cr = el("cancelReply"); if (cr) cr.onclick = () => { replyTo = null; el("replyChip").hidden = true; };
  document.querySelectorAll(".wall-img").forEach(im => im.onclick = () => lightbox(im.src));
  const ph = el("wallPhoto"); if (ph) ph.onclick = async () => {
    const file = await pickFile(); if (!file) return; toast("Adding photo…");
    try { await addDoc(subCol(ev, "comments"), { authorId: myUid(), authorName: S.profile.name, text: "", img: await compressImage(file, 1200, 0.8), ...parentPatch(ev), createdAt: Date.now() }); replyTo = null; }
    catch (e) { toast("Couldn't add photo: " + e.message); }
  };
  const gb = el("wallGif"); if (gb) gb.onclick = () => openGifPicker(ev);
  const inp = el("wallInput"), ml = el("mentionList");
  if (inp && ml) inp.oninput = () => {
    const m = /@(\w*)$/.exec(inp.value); if (!m) { ml.hidden = true; return; }
    const hits = wallParticipants(ev).filter(p => p.name.toLowerCase().startsWith(m[1].toLowerCase())).slice(0, 6);
    ml.innerHTML = hits.map(p => `<button type="button" data-mention="${esc(p.name)}">@${esc(p.name)}</button>`).join(""); ml.hidden = !hits.length;
    ml.querySelectorAll("[data-mention]").forEach(b => b.onclick = () => { inp.value = inp.value.replace(/@\w*$/, "@" + b.dataset.mention + " "); ml.hidden = true; inp.focus(); });
  };
}
// GIF search (GIPHY). The button only appears once giphyKey is set in firebase-config.js.
function openGifPicker(ev) {
  dialog(`<h3>Add a GIF</h3><input id="gifQ" class="search-box" placeholder="Search GIPHY…" autocomplete="off"><div class="gif-grid" id="gifGrid"><p class="muted sm">Loading…</p></div><p class="muted sm" style="margin:6px 0 0">Powered by GIPHY</p>`, null, null);
  const grid = el("gifGrid"), q = el("gifQ"); let timer;
  const load = async term => {
    const url = term ? `https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(term)}&limit=24&rating=pg-13` : `https://api.giphy.com/v1/gifs/trending?api_key=${giphyKey}&limit=24&rating=pg-13`;
    try {
      const j = await (await fetch(url)).json();
      grid.innerHTML = (j.data || []).map(g => `<img src="${esc(g.images.fixed_height_small.url)}" data-gif="${esc(g.images.fixed_height.url)}" alt="${esc(g.title || "GIF")}" loading="lazy">`).join("") || `<p class="muted sm">No GIFs found.</p>`;
      grid.querySelectorAll("[data-gif]").forEach(im => im.onclick = async () => {
        const gif = im.dataset.gif; closeDialog();
        try { await addDoc(subCol(ev, "comments"), { authorId: myUid(), authorName: S.profile.name, text: "", gif, ...parentPatch(ev), createdAt: Date.now() }); replyTo = null; }
        catch (e) { toast("Couldn't add GIF: " + e.message); }
      });
    } catch { grid.innerHTML = `<p class="muted sm">GIPHY isn't reachable right now.</p>`; }
  };
  load(""); q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => load(q.value.trim()), 350); }; q.focus();
}
async function toggleReaction(ev, cid, k) {
  const c = S.comments.find(x => x.id === cid); const has = c && (c.reactions || {})[k] && c.reactions[k].includes(myUid());
  try { await updateDoc(doc(subCol(ev, "comments"), cid), { [`reactions.${k}`]: has ? arrayRemove(myUid()) : arrayUnion(myUid()) }); } catch (e) { toast(e.message); }
}

// ---------- DAY-OF CARD: weather, "on my way", calendar, bring list, carpool ----------
// Typed entries live in the event's comments collection (kind: status | bring | ride),
// and claims/seats are stored as reactions, so the existing rules cover them.
const typed = (kind, filter = visibleContent) => S.comments.filter(c => c.kind === kind && filter(c));
const daysUntil = ev => Math.round((evDate(ev) - new Date(todayStr() + "T00:00")) / 86400000);
function dayInner(ev) {
  const me = myUid(); const du = daysUntil(ev); const soon = du >= 0 && du <= 1;
  const latest = {}; typed("status").forEach(c => { if (!latest[c.authorId] || latest[c.authorId].createdAt < c.createdAt) latest[c.authorId] = c; });
  const statuses = Object.values(latest).filter(c => c.status !== "clear" && Date.now() - c.createdAt < 36e5 * 18).sort((a, b) => b.createdAt - a.createdAt);
  const mine = latest[me] && latest[me].status !== "clear" ? latest[me].status : "";
  const items = typed("bring"); const rides = typed("ride");
  return `<div class="glass-head">Day of <span>${esc(fmtDay(ev))}</span></div>
    <div id="wx" class="muted-th sm" style="margin:-4px 0 8px">${ev._wx || ""}</div>
    ${statuses.length ? `<div class="chipwrap">${statuses.map(c => `<span class="day-chip">${c.status === "late" ? "⏰" : "🚗"} ${esc(first(c.authorName || nameOf(c.authorId)))} ${c.status === "late" ? "is running late" : "is on the way"} <i>${ago(c.createdAt)}</i></span>`).join("")}</div>` : ""}
    <div class="btnrow" style="margin:4px 0 10px">
      ${soon || mine ? `<button type="button" class="btn-th small ${mine === "omw" ? "accent" : ""}" data-status="omw">🚗 On my way</button><button type="button" class="btn-th small ${mine === "late" ? "accent" : ""}" data-status="late">⏰ Running late</button>` : ""}
      <button type="button" class="btn-th small" id="addCal">📆 Add to calendar</button>
    </div>
    <div class="glass-sub">Bring list <button type="button" class="btn-th ghost small" id="addBring">＋ Add</button></div>
    ${items.length ? items.map(c => { const who = ((c.reactions || {}).claim || []); return `<div class="day-row"><span style="flex:1;min-width:0"><b>${esc(c.item)}</b>${c.qty ? ` <span class="muted-th sm">× ${esc(c.qty)}</span>` : ""}${who.length ? `<div class="muted-th sm">${who.map(u => esc(first(nameOf(u)))).join(", ")} ${who.length === 1 ? "has" : "have"} it</div>` : ""}</span>
        <button type="button" class="btn-th small ${who.includes(me) ? "accent" : ""}" data-claim="${c.id}">${who.includes(me) ? "✓ Bringing it" : "I'll bring it"}</button>${c.authorId === me || canManage(ev) ? `<button type="button" class="wall-del" data-delc="${c.id}" title="Remove">✕</button>` : ""}</div>`; }).join("") : `<p class="muted-th sm" style="margin:2px 0 8px">Nothing on the list yet. Add what's needed and people claim it.</p>`}
    <div class="glass-sub">Carpool <button type="button" class="btn-th ghost small" id="addRide">🚗 Offer a ride</button></div>
    ${rides.length ? rides.map(c => { const riders = ((c.reactions || {}).ride || []); const left = Math.max(0, (c.seats || 0) - riders.length); const inCar = riders.includes(me); const driver = c.authorId === me; return `<div class="day-row"><span style="flex:1;min-width:0"><b>${esc(first(c.authorName || nameOf(c.authorId)))} is driving</b>${c.from ? ` <span class="muted-th sm">from ${esc(c.from)}</span>` : ""}<div class="muted-th sm">${left} seat${left === 1 ? "" : "s"} left${riders.length ? " · " + riders.map(u => esc(first(nameOf(u)))).join(", ") : ""}${c.note ? " · " + esc(c.note) : ""}</div></span>
        ${driver ? `<button type="button" class="wall-del" data-delc="${c.id}" title="Remove">✕</button>` : `<button type="button" class="btn-th small ${inCar ? "accent" : ""}" data-ride="${c.id}" ${!inCar && !left ? "disabled" : ""}>${inCar ? "✓ Riding" : left ? "Need a seat" : "Full"}</button>`}</div>`; }).join("") : `<p class="muted-th sm" style="margin:2px 0 4px">No rides offered yet.</p>`}`;
}
function wireDay(ev) {
  const me = myUid();
  document.querySelectorAll("[data-status]").forEach(b => b.onclick = async () => {
    const latest = typed("status").filter(c => c.authorId === me).sort((a, b) => b.createdAt - a.createdAt)[0];
    const status = latest && latest.status === b.dataset.status ? "clear" : b.dataset.status;
    try { await addDoc(subCol(ev, "comments"), { kind: "status", status, authorId: me, authorName: S.profile.name, text: "", createdAt: Date.now() }); toast(status === "clear" ? "Status cleared" : status === "late" ? "Everyone can see you're running late" : "Everyone can see you're on the way"); }
    catch (e) { toast(e.message); }
  });
  if (el("addCal")) el("addCal").onclick = () => openCalendarDialog(ev);
  if (el("addBring")) el("addBring").onclick = () => dialog(`<h3>Add to the bring list</h3><label class="field"><span>What</span><input id="bItem" placeholder="Ice, cups, a dessert…" maxlength="60"></label><label class="field"><span>How many <span class="muted">(optional)</span></span><input id="bQty" placeholder="2 bags" maxlength="20"></label>`, "Add", async () => {
    const item = el("bItem").value.trim(); if (!item) return toast("Say what's needed.");
    try { await addDoc(subCol(ev, "comments"), { kind: "bring", item, qty: el("bQty").value.trim(), authorId: me, authorName: S.profile.name, text: "", createdAt: Date.now() }); closeDialog(); } catch (e) { toast(e.message); }
  });
  document.querySelectorAll("[data-claim]").forEach(b => b.onclick = async () => {
    const c = S.comments.find(x => x.id === b.dataset.claim); const has = c && ((c.reactions || {}).claim || []).includes(me);
    try { await updateDoc(doc(subCol(ev, "comments"), b.dataset.claim), { "reactions.claim": has ? arrayRemove(me) : arrayUnion(me) }); } catch (e) { toast(e.message); }
  });
  if (el("addRide")) el("addRide").onclick = () => dialog(`<h3>Offer a ride</h3><div class="two"><label class="field"><span>Seats</span><input id="rSeats" inputmode="numeric" value="3"></label><label class="field"><span>Leaving from</span><input id="rFrom" placeholder="Downtown, 6:30" maxlength="60"></label></div><label class="field"><span>Note <span class="muted">(optional)</span></span><input id="rNote" placeholder="Back by 11, no smoking" maxlength="80"></label>`, "Offer", async () => {
    const seats = Math.max(1, Math.min(8, parseInt(el("rSeats").value, 10) || 1));
    try { await addDoc(subCol(ev, "comments"), { kind: "ride", seats, from: el("rFrom").value.trim(), note: el("rNote").value.trim(), authorId: me, authorName: S.profile.name, text: "", createdAt: Date.now() }); closeDialog(); } catch (e) { toast(e.message); }
  });
  document.querySelectorAll("[data-ride]").forEach(b => b.onclick = async () => {
    const c = S.comments.find(x => x.id === b.dataset.ride); const has = c && ((c.reactions || {}).ride || []).includes(me);
    try { await updateDoc(doc(subCol(ev, "comments"), b.dataset.ride), { "reactions.ride": has ? arrayRemove(me) : arrayUnion(me) }); } catch (e) { toast(e.message); }
  });
  document.querySelectorAll("#dayCard [data-delc]").forEach(b => b.onclick = () => deleteComment(ev, b.dataset.delc));
}
// Weather from Open-Meteo (no key). Geocodes the location text, falling back to its last parts (city, state).
const WX = { 0: "☀️ Clear", 1: "🌤 Mostly clear", 2: "⛅ Partly cloudy", 3: "☁️ Cloudy", 45: "🌫 Fog", 48: "🌫 Fog", 51: "🌦 Drizzle", 53: "🌦 Drizzle", 55: "🌧 Drizzle", 61: "🌧 Light rain", 63: "🌧 Rain", 65: "🌧 Heavy rain", 71: "🌨 Snow", 73: "🌨 Snow", 75: "❄️ Heavy snow", 80: "🌦 Showers", 81: "🌧 Showers", 82: "⛈ Heavy showers", 95: "⛈ Thunderstorms", 96: "⛈ Storms w/ hail", 99: "⛈ Storms w/ hail" };
async function loadWeather(ev) {
  const box = el("wx"); if (!box || !ev.location || /zoom|meet\.google|teams|http|online|call/i.test(ev.location)) return;
  const du = daysUntil(ev); if (du < 0 || du > 15) return;
  const key = "wx:" + ev.date + ":" + ev.location; let cached = null; try { cached = JSON.parse(sessionStorage.getItem(key) || "null"); } catch {}
  const show = txt => { ev._wx = txt; const b = el("wx"); if (b) b.textContent = txt; };
  if (cached && Date.now() - cached.at < 36e5) return show(cached.txt);
  try {
    const parts = ev.location.split(",").map(p => p.trim()).filter(Boolean);
    const tries = [parts.slice(-2).join(", "), parts.slice(-1)[0], parts.slice(-3, -1).join(", ")].filter(Boolean);
    let hit = null; for (const q of tries) { const g = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(q.replace(/\b\d{5}(-\d{4})?\b/g, "").trim()) + "&count=1&language=en")).json(); if (g.results && g.results[0]) { hit = g.results[0]; break; } }
    if (!hit) return;
    const f = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto&start_date=${ev.date}&end_date=${ev.date}`)).json();
    const d = f.daily; if (!d || !d.weather_code) return;
    const txt = `${WX[d.weather_code[0]] || "🌡"} · ${Math.round(d.temperature_2m_max[0])}° / ${Math.round(d.temperature_2m_min[0])}°${d.precipitation_probability_max && d.precipitation_probability_max[0] != null ? " · " + d.precipitation_probability_max[0] + "% rain" : ""} · ${esc(hit.name)}`;
    try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), txt })); } catch {}
    show(txt);
  } catch {}
}
// Add one event to a calendar: an .ics file (Apple, Outlook) or a Google Calendar link.
function eventIcs(ev) {
  const dt = (d, t) => d.replace(/-/g, "") + "T" + (t || "09:00").replace(":", "") + "00";
  const end = () => { if (ev.endTime) return dt(ev.date, ev.endTime); const [h, m] = (ev.time || "09:00").split(":").map(Number); const e = new Date(2000, 0, 1, h + 2, m); return dt(ev.date, String(e.getHours()).padStart(2, "0") + ":" + String(e.getMinutes()).padStart(2, "0")); };
  const escI = v => String(v || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Friendly//officialfriendly.com//EN", "BEGIN:VEVENT", "UID:" + ev.id + "@officialfriendly.com", "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z", "DTSTART:" + dt(ev.date, ev.time), "DTEND:" + end(), "SUMMARY:" + escI((ev.emoji ? ev.emoji + " " : "") + ev.title), ev.location ? "LOCATION:" + escI(ev.location) : "", "DESCRIPTION:" + escI((ev.notes ? ev.notes + "\n\n" : "") + "https://officialfriendly.com/#/e/" + ev.id), "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
}
function openCalendarDialog(ev) {
  const dt = (d, t) => d.replace(/-/g, "") + "T" + (t || "09:00").replace(":", "") + "00";
  const [h, m] = (ev.time || "09:00").split(":").map(Number); const e = new Date(2000, 0, 1, h + 2, m);
  const g = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent((ev.emoji ? ev.emoji + " " : "") + ev.title)}&dates=${dt(ev.date, ev.time)}/${ev.endTime ? dt(ev.date, ev.endTime) : dt(ev.date, String(e.getHours()).padStart(2, "0") + ":" + String(e.getMinutes()).padStart(2, "0"))}&location=${encodeURIComponent(ev.location || "")}&details=${encodeURIComponent("https://officialfriendly.com/#/e/" + ev.id)}`;
  dialog(`<h3>Add to calendar</h3><p class="muted" style="margin-top:-6px">Just this event. To keep every Friendly plan in your calendar automatically, use Calendar sync on your profile.</p>
    <div class="stack"><button type="button" class="btn primary" id="calApple">📆 Apple / iPhone Calendar</button><a class="btn" href="${g}" target="_blank" rel="noopener">Google Calendar</a><button type="button" class="btn" data-go="#/profile">Calendar sync (all events)</button></div>`, null, null);
  el("calApple").onclick = () => { const blob = new Blob([eventIcs(ev)], { type: "text/calendar;charset=utf-8" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = (ev.title || "event").replace(/[^\w]+/g, "-") + ".ics"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); toast("Open the downloaded file to add it to your calendar."); };
  document.querySelectorAll("#appDialog [data-go]").forEach(b => b.onclick = () => { closeDialog(); go(b.dataset.go); });
}
// The morning after, the host's app posts a recap on the wall once.
async function maybePostRecap(ev) {
  if (!canManage(ev) || ev.recapPosted || ev._recapTried || ev.kind === "meeting") return;
  const du = daysUntil(ev); if (du >= 0 || du < -7) return; ev._recapTried = true;
  await new Promise(r => setTimeout(r, 4000)); if (!S.route || S.route.id !== ev.id) return;
  const going = goingCount(ev); const photos = S.photos.length; const spent = [...S.expenses.values()].filter(x => x.eventId === ev.id).reduce((t, x) => t + x.amountCents, 0);
  const polls = S.polls.map(p => { const counts = {}; Object.values(p.votes || {}).forEach(i => counts[i] = (counts[i] || 0) + 1); const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]; return top != null && p.options ? p.q + ": " + p.options[top] : ""; }).filter(Boolean);
  const text = `🎉 That's a wrap on ${ev.title}! ${going} went${photos ? `, ${photos} photo${photos === 1 ? "" : "s"} in the album` : ""}${polls.length ? ". " + polls.join("; ") : ""}${spent ? `. ${fmt$(spent)} on the tab, settle up on Money` : ""}. Thanks for coming!`;
  try { await addDoc(subCol(ev, "comments"), { recap: true, authorId: myUid(), authorName: S.profile.name, text, createdAt: Date.now() }); await updateDoc(doc(db, "events", ev.id), { recapPosted: true }); } catch {}
}

function wireEventPage(ev) {
  const id = ev.id;
  wireDay(ev); loadWeather(ev); maybePostRecap(ev);
  const dup = $("[data-dup]"); if (dup) dup.onclick = () => duplicateEvent(ev);
  // Group members who joined after the event was created aren't in invitedUids
  // yet (it's snapshotted at creation); add them quietly so they can RSVP.
  S._autoJoined = S._autoJoined || new Set();
  if (!(ev.invitedUids || []).includes(myUid()) && ev.groupId && S.groups.has(ev.groupId) && !S._autoJoined.has(id)) {
    S._autoJoined.add(id);
    updateDoc(doc(db, "events", id), { invitedUids: arrayUnion(myUid()), [`names.${myUid()}`]: S.profile.name }).catch(e => console.warn("auto-join failed:", e.message));
  }
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  document.querySelectorAll("[data-rsvp]").forEach(b => b.onclick = () => setRsvp(ev, b.dataset.rsvp));
  document.querySelectorAll("[data-plus]").forEach(b => b.onclick = () => setPlus(ev, Number(b.dataset.plus)));
  document.querySelectorAll("[data-hype]").forEach(b => b.onclick = () => setHype(ev, b.dataset.hype));
  document.querySelectorAll("[data-approve]").forEach(b => b.onclick = () => hostSetRsvp(ev, b.dataset.approve, "going"));
  document.querySelectorAll("[data-promote]").forEach(b => b.onclick = () => hostSetRsvp(ev, b.dataset.promote, "going"));
  if (el("saveAnswers")) el("saveAnswers").onclick = () => saveAnswers(ev);
  if (el("plusName")) el("plusName").onchange = () => updateDoc(doc(db, "events", ev.id), { [`plusNames.${myUid()}`]: el("plusName").value.trim() }).then(() => toast("Saved")).catch(e => toast(e.message));
  if (el("viewAnswers")) el("viewAnswers").onclick = () => showAnswers(ev);
  if (el("nudgeBtn")) el("nudgeBtn").onclick = () => nudge(ev, el("nudgeBtn"));
  const share = $("[data-share]"); if (share) share.onclick = () => shareEvent(ev);
  const txt = $("[data-text]"); if (txt) txt.onclick = () => textEventInvite(ev);
  const join = $("[data-join]"); if (join) join.onclick = () => joinViaLink(ev, join);
  const cal = $("[data-cal]"); if (cal) cal.onclick = () => downloadIcs(ev);
  const exp = $("[data-expense]"); if (exp) exp.onclick = () => openExpense(ev.id, ev.invitedUids, ev.groupId || null);
  const edit = $("[data-edit]"); if (edit) edit.onclick = () => editEvent(ev);
  const del = $("[data-del]"); if (del) del.onclick = () => delEvent(ev);
  wireWall(ev);
}

// ----- Polls -----
function pollsInner(ev, hint = "Add a poll to help decide: food, time, theme.") {
  const me = myUid(); const manage = canManage(ev);
  const list = S.polls.map(p => {
    const total = Object.keys(p.votes || {}).length || 0;
    const mine = (p.votes || {})[me];
    return `<div class="poll"><div class="poll-q">${esc(p.q)}</div>${(p.options || []).map((o, i) => {
      const n = Object.values(p.votes || {}).filter(v => v === i).length;
      const pct = total ? Math.round(n / total * 100) : 0;
      return `<div class="poll-opt ${mine === i ? "mine" : ""}" data-vote="${p.id}|${i}"><div class="poll-bar" style="transform:scaleX(${total ? n / total : 0})"></div><div class="poll-opt-in"><span>${esc(o)}</span><span>${pct}%</span></div></div>`;
    }).join("")}<div class="muted-th sm" style="margin-top:4px">${total} vote${total === 1 ? "" : "s"}${manage ? ` · <a data-delpoll="${p.id}">remove</a>` : ""}${planBtn(ev, p)}</div></div>`;
  }).join("");
  return `<div class="glass-head">Polls${manage ? ` <a class="btn-th ghost small" id="addPoll">＋ Add</a>` : `<span>${S.polls.length}</span>`}</div><div class="scroll-cap">${list || `<p class="muted-th">${manage ? esc(hint) : "No polls yet."}</p>`}</div>`;
}
// Group date polls: the leading dated option can become an event in one tap.
function planBtn(ev, p) {
  if (!(ev._col && ev._col[0] === "groups") || !p.dates) return "";
  const counts = {}; Object.values(p.votes || {}).forEach(i => counts[i] = (counts[i] || 0) + 1);
  const lead = Object.keys(p.dates).sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0]; if (lead == null) return "";
  return ` · <a data-plan="${p.dates[lead]}|${esc(p.q)}">📅 Plan it for ${esc(p.options[lead])}</a>`;
}
function wirePolls(ev) {
  document.querySelectorAll("[data-plan]").forEach(a => a.onclick = () => { const [date, q] = a.dataset.plan.split("|"); resetCompose(); compose.date = date; compose.groupId = ev._col ? ev.id : ""; compose.title = ""; go("#/new"); toast("Date set to " + date + ", pick a title"); });
  document.querySelectorAll("[data-vote]").forEach(b => b.onclick = () => { const [pid, i] = b.dataset.vote.split("|"); votePoll(ev, pid, +i); });
  if (el("addPoll")) el("addPoll").onclick = () => addPollDialog(ev);
  document.querySelectorAll("[data-delpoll]").forEach(b => b.onclick = () => deleteDoc(doc(subCol(ev, "polls"), b.dataset.delpoll)).catch(e => toast(e.message)));
}
async function votePoll(ev, pid, i) { try { await updateDoc(doc(subCol(ev, "polls"), pid), { [`votes.${myUid()}`]: i }); } catch (e) { toast(e.message); } }
function addPollDialog(ev) {
  dialog(`<h3>New poll</h3><label class="field"><span>Question</span><input id="pq" placeholder="What should we eat? · Which weekend works?"></label>
    <label class="field"><span>Options (one per line)</span><textarea id="popts" placeholder="Tacos\nPizza\nSushi"></textarea></label>
    <div class="two"><label class="field"><span>Or add dates</span><input type="date" id="pdate"></label>
    <label class="field"><span>&nbsp;</span><button type="button" class="btn small" id="pAddDate">＋ Add date as option</button></label></div>`,
    "Add poll", async () => {
      const q = el("pq").value.trim(); const opts = el("popts").value.split("\n").map(s => s.trim()).filter(Boolean);
      if (!q || opts.length < 2) return toast("Add a question and at least two options.");
      const dates = {}; opts.forEach((o, i) => { if (dateByLabel[o]) dates[i] = dateByLabel[o]; });
      try { await addDoc(subCol(ev, "polls"), { q, options: opts, dates, votes: {}, authorId: myUid(), createdAt: Date.now() }); closeDialog(); } catch (e) { toast(e.message); }
    });
  // Date polls: each picked date becomes an option like "Sat, Oct 4" (and remembers the real date).
  const dateByLabel = {};
  el("pAddDate").onclick = () => {
    const v = el("pdate").value; if (!v) return toast("Pick a date first.");
    const [y, m, d] = v.split("-").map(Number);
    const label = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    dateByLabel[label] = v;
    const ta = el("popts"); ta.value = [...ta.value.split("\n").filter(Boolean), label].join("\n"); el("pdate").value = "";
    if (!el("pq").value.trim()) el("pq").value = "Which day works?";
  };
}

// ----- Playlist -----
function playlistInner(ev) {
  const me = myUid();
  const list = S.songs.map(s => {
    const votes = Object.keys(s.votes || {}).length; const voted = (s.votes || {})[me];
    return `<div class="song"><div class="up ${voted ? "voted" : ""}"><button data-upvote="${s.id}">▲</button>${votes}</div>
      <div class="st"><b>${esc(s.title)}</b>${s.artist ? `<span>${esc(s.artist)}</span>` : ""}</div>
      ${s.addedBy === me ? `<button class="wall-del" data-delsong="${s.id}">✕</button>` : ""}</div>`;
  }).join("");
  return `<div class="glass-head">Playlist <a class="btn-th ghost small" id="addSong">＋ Add song</a></div>${list || `<p class="muted-th">Build the vibe: add songs, upvote favorites.</p>`}`;
}
function wirePlaylist(ev) {
  if (el("addSong")) el("addSong").onclick = () => addSongDialog(ev);
  document.querySelectorAll("[data-upvote]").forEach(b => b.onclick = () => toggleSongVote(ev, b.dataset.upvote));
  document.querySelectorAll("[data-delsong]").forEach(b => b.onclick = () => deleteDoc(doc(db, "events", ev.id, "songs", b.dataset.delsong)).catch(e => toast(e.message)));
}
async function toggleSongVote(ev, sid) {
  const s = S.songs.find(x => x.id === sid); if (!s) return; const has = (s.votes || {})[myUid()];
  try { await updateDoc(doc(db, "events", ev.id, "songs", sid), { [`votes.${myUid()}`]: has ? null : true }); } catch (e) { toast(e.message); }
}
function addSongDialog(ev) {
  dialog(`<h3>Add a song</h3><label class="field"><span>Song</span><input id="sgTitle" placeholder="Song title"></label>
    <label class="field"><span>Artist (optional)</span><input id="sgArtist" placeholder="Artist"></label>`,
    "Add", async () => {
      const t = el("sgTitle").value.trim(); if (!t) return toast("Add a song title.");
      try { await addDoc(collection(db, "events", ev.id, "songs"), { title: t, artist: el("sgArtist").value.trim(), votes: { [myUid()]: true }, addedBy: myUid(), createdAt: Date.now() }); closeDialog(); } catch (e) { toast(e.message); }
    });
}

// ----- Photo wall -----
function photosInner(ev) {
  const ps = S.photos.filter(visibleContent);
  const tiles = ps.map(p => `<div class="photo-tile"><img src="${p.img}" data-photo="${p.id}" alt="" loading="lazy">${p.addedBy === myUid() || isAdmin() ? `<button class="photo-act" data-delphoto="${p.id}" title="Remove">✕</button>` : `<button class="photo-act" data-report="photo|${p.id}" title="Report">⚑</button>`}</div>`).join("");
  return `<div class="glass-head">Photos <span>${ps.length}</span></div><div class="photo-grid"><button class="photo-add" id="addPhoto">＋</button>${tiles || ""}</div>${ps.length ? "" : `<p class="muted-th" style="margin-top:8px">Share pics from the night.</p>`}`;
}
function wirePhotos(ev) {
  if (el("addPhoto")) el("addPhoto").onclick = async () => {
    const f = await pickFile(); if (!f) return; toast("Uploading photo…");
    try { const img = await compressImage(f, 1400, 0.8); await addDoc(collection(db, "events", ev.id, "photos"), { img, addedBy: myUid(), createdAt: Date.now() }); }
    catch (e) { toast("Couldn't add photo: " + e.message); }
  };
  document.querySelectorAll("[data-photo]").forEach(im => im.onclick = () => lightbox(im.src));
  document.querySelectorAll("[data-delphoto]").forEach(b => b.onclick = () => { if (confirm("Remove this photo?")) deleteDoc(doc(subCol(ev, "photos"), b.dataset.delphoto)).catch(e => toast(e.message)); });
  document.querySelectorAll("#photosCard [data-report]").forEach(b => b.onclick = () => { const [kind, id] = b.dataset.report.split("|"); reportContent(ev, kind, id); });
}
async function setRsvp(ev, status) {
  const me = myUid();
  if (status === "going" && ev.approval && ev.hostId !== me && !(ev.cohostUids || []).includes(me)) status = "pending";
  else if (status === "going" && isFull(ev) && (ev.rsvps || {})[me] !== "going") status = "waitlist";
  try { await updateDoc(doc(db, "events", ev.id), { [`rsvps.${me}`]: status }); }
  catch (e) { toast("Couldn't RSVP: " + e.message); }
}
async function setPlus(ev, delta) {
  const me = myUid(); const cur = ((ev.plusOnes || {})[me]) || 0; const n = Math.max(0, cur + delta);
  try { await updateDoc(doc(db, "events", ev.id), { [`plusOnes.${me}`]: n }); } catch (e) { toast(e.message); }
}
async function setHype(ev, emoji) {
  const me = myUid(); const cur = (ev.hypes || {})[me]; const next = cur === emoji ? null : emoji;
  try { await updateDoc(doc(db, "events", ev.id), { [`hypes.${me}`]: next }); } catch (e) { toast(e.message); }
}
async function hostSetRsvp(ev, uid, status) { try { await updateDoc(doc(db, "events", ev.id), { [`rsvps.${uid}`]: status }); toast(first(nameOf(uid)) + " is in"); } catch (e) { toast(e.message); } }
async function saveAnswers(ev) {
  const me = myUid(); const a = {}; document.querySelectorAll("[data-answer]").forEach(i => a[i.dataset.answer] = i.value.trim());
  try { await updateDoc(doc(db, "events", ev.id), { [`answers.${me}`]: a }); toast("Answers saved"); } catch (e) { toast(e.message); }
}
function showAnswers(ev) {
  const rows = (ev.invitedUids || []).filter(u => (ev.answers || {})[u]).map(u => `<div class="ans-block"><b>${esc(nameOf(u))}</b>${ev.questions.map(q => `<div class="ans"><span>${esc(q.q)}</span> ${esc((ev.answers[u] || {})[q.id] || "(no answer)")}</div>`).join("")}</div>`).join("");
  dialog(`<h3>RSVP answers</h3>${rows || `<p class="muted">No answers yet.</p>`}`, null, null);
}
async function postComment(ev) {
  const input = el("wallInput"); const text = input.value.trim(); if (!text) return;
  input.value = ""; const ml = el("mentionList"); if (ml) ml.hidden = true;
  const mentions = wallParticipants(ev).filter(p => new RegExp("@" + p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(text)).map(p => p.uid);
  const patch = parentPatch(ev); replyTo = null; const ch = el("replyChip"); if (ch) ch.hidden = true;
  try { await addDoc(subCol(ev, "comments"), { authorId: myUid(), authorName: S.profile.name, text, mentions, ...patch, createdAt: Date.now() }); }
  catch (e) { toast("Couldn't post: " + e.message); }
}
// ----- Reporting & blocking (App Store guideline 1.2 for user content) -----
const isAdmin = () => adminUids.includes(myUid());
const REPORT_REASONS = ["Spam", "Harassment or bullying", "Hate or violence", "Nudity or sexual content", "Something else"];
// Hide anything I reported and everything from people I blocked.
const visibleContent = item => !(S.profile.blockedUids || []).includes(item.authorId || item.addedBy) && !(S.profile.hiddenIds || []).includes(item.id);
function reportContent(ev, kind, id) {
  const item = (kind === "photo" ? S.photos : S.comments).find(x => x.id === id); if (!item) return;
  const who = item.authorId || item.addedBy;
  dialog(`<h3>Report this ${kind === "photo" ? "photo" : "comment"}</h3>
    <p class="muted" style="margin-top:-6px">We review every report within 24 hours. Reported content is hidden from you right away.</p>
    <label class="field"><span>Reason</span><select id="rpReason">${REPORT_REASONS.map(r => `<option>${r}</option>`).join("")}</select></label>
    <label class="cbox"><input type="checkbox" id="rpBlock"> Also block ${esc(first(nameOf(who)))}: hide everything they post</label>`,
    "Report", async () => {
      const path = doc(subCol(ev, kind === "photo" ? "photos" : "comments"), id).path;
      const up = { hiddenIds: arrayUnion(id) }; if (el("rpBlock").checked) up.blockedUids = arrayUnion(who);
      try {
        await addDoc(collection(db, "reports"), { reporterId: myUid(), reporterName: S.profile.name, targetUid: who, kind, path, snippet: kind === "photo" ? "(photo)" : String(item.text || "").slice(0, 200), reason: el("rpReason").value, status: "open", createdAt: Date.now() });
        await updateDoc(doc(db, "users", myUid()), up);
        closeDialog(); toast("Thanks. We'll review it within 24 hours.");
      } catch (e) { toast(e.message); }
    });
}
async function deleteComment(ev, cid) { try { await deleteDoc(doc(subCol(ev, "comments"), cid)); } catch (e) { toast(e.message); } }
const FN_BASE = "https://us-central1-friendly-6992a.cloudfunctions.net";
// Links people text or share go through /share/p/{id} so iMessage, WhatsApp
// and Slack show a rich preview (cover, title, when); it forwards to the app.
const eventUrl = ev => ev.openLink ? FN_BASE + "/share/p/" + ev.id : "https://officialfriendly.com/#/e/" + ev.id;
// Text the invite from the organizer's own phone; the link lets people who
// aren't on Friendly yet sign up and join (when "anyone with the link" is on).
function textEventInvite(ev) {
  const when = fmtWhen(ev) + (ev.location ? " at " + ev.location : "");
  const body = `You're invited! ${ev.emoji || "🎉"} ${ev.title}, ${when}. RSVP here: ${eventUrl(ev)}` + (ev.openLink ? "" : " (sign up with the email I invited)");
  location.href = smsLink([], body);
}
async function joinViaLink(ev, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Joining…"; }
  try { await updateDoc(doc(db, "events", ev.id), { invitedUids: arrayUnion(myUid()), [`names.${myUid()}`]: S.profile.name }); toast("You're on the list! RSVP below."); }
  catch (e) { if (btn) { btn.disabled = false; btn.textContent = "Join this event"; } toast("Couldn't join: " + e.message); }
}
function shareEvent(ev) {
  const url = eventUrl(ev);
  if (navigator.share) navigator.share({ title: ev.title, text: "You're invited: " + ev.title, url }).catch(() => {});
  else navigator.clipboard.writeText(url).then(() => toast("Invite link copied")).catch(() => prompt("Copy link:", url));
}
function downloadIcs(ev) {
  const pad = n => String(n).padStart(2, "0");
  const parts = ev.date.split("-").map(Number);
  const esc2 = s => String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  let dts, dte;
  if (ev.time) { const [h, m] = ev.time.split(":").map(Number); const s = new Date(parts[0], parts[1] - 1, parts[2], h, m); const e = ev.endTime ? (() => { const [H, M] = ev.endTime.split(":").map(Number); return new Date(parts[0], parts[1] - 1, parts[2], H, M); })() : new Date(s.getTime() + 2 * 3600e3); const f = d => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "T" + pad(d.getHours()) + pad(d.getMinutes()) + "00"; dts = "DTSTART:" + f(s); dte = "DTEND:" + f(e); }
  else { const d = ev.date.replace(/-/g, ""); const nx = new Date(parts[0], parts[1] - 1, parts[2] + 1); dts = "DTSTART;VALUE=DATE:" + d; dte = "DTEND;VALUE=DATE:" + nx.getFullYear() + pad(nx.getMonth() + 1) + pad(nx.getDate()); }
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Friendly//EN", "BEGIN:VEVENT", "UID:" + ev.id + "@officialfriendly.com", "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z", dts, dte, "SUMMARY:" + esc2(ev.emoji + " " + ev.title), ev.location ? "LOCATION:" + esc2(ev.location) : "", "DESCRIPTION:" + esc2((ev.notes || "") + "\nRSVP: " + location.origin + location.pathname + "#/e/" + ev.id), "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
  const a = document.createElement("a"); a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics); a.download = ev.title.replace(/[^a-z0-9]+/gi, "-") + ".ics"; a.click();
}
async function delEvent(ev) { if (isDemo()) return toast("Deleting events is off in demo mode."); if (!confirm(`Delete “${ev.title}”?`)) return; try { await deleteDoc(doc(db, "events", ev.id)); go("#/"); toast("Event deleted"); } catch (e) { toast(e.message); } }
function editEvent(ev) {
  dialog(`<h3>Edit event</h3>
    <label class="field"><span>Title</span><input id="eTitle" value="${esc(ev.title)}"></label>
    <div class="two"><label class="field"><span>Date</span><input id="eDate" type="date" value="${ev.date}"></label>
    <label class="field"><span>Start</span><input id="eTime" type="time" value="${ev.time || ""}"></label></div>
    <label class="field"><span>Where</span><input id="eWhere" value="${esc(ev.location || "")}"></label>
    <label class="field"><span>Repeats</span><select id="eRepeat"><option value="" ${!ev.repeat ? "selected" : ""}>Never</option><option value="weekly" ${ev.repeat === "weekly" ? "selected" : ""}>Every week</option><option value="biweekly" ${ev.repeat === "biweekly" ? "selected" : ""}>Every 2 weeks</option><option value="monthly" ${ev.repeat === "monthly" ? "selected" : ""}>Every month</option></select></label>
    <label class="field"><span>Details</span><textarea id="eNotes">${esc(ev.notes || "")}</textarea></label>
    <span class="field-label" style="margin-top:10px">Co-hosts (can edit &amp; manage)</span><div class="check-grid">${contactChecks("ecoh", new Set(ev.cohostUids || []))}</div>`,
    "Save", async () => {
      const cohostUids = [...document.querySelectorAll("input[name=ecoh]:checked")].map(i => i.value).filter(u => u !== ev.hostId);
      try { await updateDoc(doc(db, "events", ev.id), { cohostUids, ...(cohostUids.length ? { invitedUids: arrayUnion(...cohostUids) } : {}), title: el("eTitle").value.trim(), date: el("eDate").value, time: el("eTime").value, location: el("eWhere").value.trim(), notes: el("eNotes").value.trim(), repeat: el("eRepeat").value }); closeDialog(); toast("Saved"); } catch (e) { toast(e.message); }
    });
  attachPlaces(el("eWhere"));
}

// ---------- MONEY ----------
function pairwise() {
  const owes = {};
  const add = (d, c, cents) => { if (d === c || !cents) return; (owes[d] = owes[d] || {})[c] = (owes[d][c] || 0) + cents; };
  for (const x of S.expenses.values()) {
    // Itemized expenses carry exact per-person amounts; otherwise split evenly.
    if (x.shares) { for (const [u, c] of Object.entries(x.shares)) if (S.contacts.has(u)) add(u, x.paidBy, c); continue; }
    const split = (x.split || []).filter(u => S.contacts.has(u)); if (!split.length) continue;
    const base = Math.floor(x.amountCents / split.length); let rem = x.amountCents - base * split.length;
    for (const u of split) add(u, x.paidBy, base + (rem-- > 0 ? 1 : 0));
  }
  for (const s of S.settlements.values()) add(s.to, s.from, s.amountCents);
  const pairs = []; const seen = new Set();
  for (const a in owes) for (const b in owes[a]) { const k = a < b ? a + b : b + a; if (seen.has(k)) continue; seen.add(k); const net = (owes[a]?.[b] || 0) - (owes[b]?.[a] || 0); if (net > 0) pairs.push({ from: a, to: b, amount: net }); else if (net < 0) pairs.push({ from: b, to: a, amount: -net }); }
  return pairs;
}
function moneyBody() {
  const me = myUid(); const pairs = pairwise();
  const iOwe = pairs.filter(p => p.from === me).reduce((t, p) => t + p.amount, 0);
  const owed = pairs.filter(p => p.to === me).reduce((t, p) => t + p.amount, 0);
  const settleList = S.simplePay ? simplify(pairs) : pairs;
  const mine = settleList.filter(p => p.from === me || p.to === me);
  const rows = [...[...S.expenses.values()].map(x => ({ ...x, kind: "e" })), ...[...S.settlements.values()].map(s => ({ ...s, kind: "s" }))].sort((a, b) => b.createdAt - a.createdAt);
  return `
  <div class="section-head"><h2>Money</h2><button class="btn primary small" id="addExpense">＋ Expense</button></div>
  <div class="tiles"><div class="card tile owe"><span class="muted sm">You owe</span><div class="amt">${fmt$(iOwe)}</div></div>
    <div class="card tile owed"><span class="muted sm">Owed to you</span><div class="amt">${fmt$(owed)}</div></div></div>
  ${mine.length ? `<div class="section-head"><h2>Settle up</h2>${pairs.length > 1 ? `<button class="btn small ${S.simplePay ? "primary" : ""}" id="simplePay" title="Combine debts into the fewest payments">${S.simplePay ? "✓ Fewest payments" : "Fewest payments"}</button>` : ""}</div><div class="stack">${mine.map(p => {
    const other = S.contacts.get(p.from === me ? p.to : p.from) || {};
    let pay = "";
    if (p.from === me) { if (other.venmo) pay += `<button class="btn small venmo" data-venmo="${p.to}" data-amt="${p.amount}">Venmo</button>`; if (other.phone) pay += `<button class="btn small apple" data-apple="${p.to}" data-amt="${p.amount}"> Cash</button>`; }
    else if (other.venmo) pay = `<button class="btn small venmo" data-request="${p.from}" data-amt="${p.amount}">Request</button>`;
    return `<div class="card settle-row"><div class="settle-top">${avatar(p.from)}<div style="flex:1"><b>${p.from === me ? "You owe " + esc(nameOf(p.to)) : esc(nameOf(p.from)) + " owes you"}</b></div><span class="amt sm">${fmt$(p.amount)}</span></div><div class="settle-actions">${pay}<button class="btn small" data-record="${p.from}|${p.to}|${p.amount}">${p.from === me ? "Mark as paid" : "Mark as received"}</button></div></div>`;
  }).join("")}</div>` : ""}
  <div class="section-head"><h2>Activity</h2></div>
  <div class="card">${rows.length ? rows.map(r => {
    if (r.kind === "s") return `<div class="ledger"><div class="li pay">⤴</div><div style="flex:1"><b>${esc(nameOf(r.from))} paid ${esc(nameOf(r.to))}</b><div class="muted sm">${r.note ? esc(r.note) + " · " : ""}${new Date(r.createdAt).toLocaleDateString()}</div></div><span class="amt sm">${fmt$(r.amountCents)}</span>${r.addedBy === me ? `<button class="btn ghost small" data-dels="${r.id}">✕</button>` : ""}</div>`;
    const n = (r.split || []).length || 1;
    return `<div class="ledger"><div class="li">🧾</div><div style="flex:1"><b>${esc(r.desc)}</b><div class="muted sm">${esc(nameOf(r.paidBy))} paid · ${r.shares ? "itemized, " + n + " people" : `split ${n} way${n > 1 ? "s" : ""}`} · ${new Date(r.createdAt).toLocaleDateString()}</div></div><span class="amt sm">${fmt$(r.amountCents)}</span><button class="btn ghost small" data-xopen="${r.id}" title="Details & discussion">💬</button>${r.addedBy === me ? `<button class="btn ghost small" data-dele="${r.id}">✕</button>` : ""}</div>`;
  }).join("") : emptyState("💸", "No shared costs yet", "Add an expense after your next hangout.")}</div>`;
}
function wireMoney() {
  el("addExpense").onclick = () => openExpense(null, null);
  if (el("simplePay")) el("simplePay").onclick = () => { S.simplePay = !S.simplePay; render(); };
  document.querySelectorAll("[data-xopen]").forEach(b => b.onclick = () => go("#/x/" + b.dataset.xopen));
  document.querySelectorAll("[data-venmo]").forEach(b => b.onclick = () => payVenmo(b.dataset.venmo, +b.dataset.amt, "pay"));
  document.querySelectorAll("[data-request]").forEach(b => b.onclick = () => payVenmo(b.dataset.request, +b.dataset.amt, "charge"));
  document.querySelectorAll("[data-apple]").forEach(b => b.onclick = () => payApple(b.dataset.apple, +b.dataset.amt));
  document.querySelectorAll("[data-record]").forEach(b => b.onclick = () => { const [f, t, a] = b.dataset.record.split("|"); openSettle(f, t, +a); });
  document.querySelectorAll("[data-dele]").forEach(b => b.onclick = () => deleteDoc(doc(db, "expenses", b.dataset.dele)).catch(e => toast(e.message)));
  document.querySelectorAll("[data-dels]").forEach(b => b.onclick = () => deleteDoc(doc(db, "settlements", b.dataset.dels)).catch(e => toast(e.message)));
}
// ---------- EXPENSE PAGE (details + discussion) ----------
function expenseBody(id) {
  const x = S.expenses.get(id);
  if (!x) return `<div class="card empty"><b>Expense not found</b><p class="muted">It may have been deleted.</p><button class="btn" data-go="#/money">Back to Money</button></div>`;
  const n = (x.split || []).length || 1, share = Math.round(x.amountCents / n);
  const ev = x.eventId ? S.events.get(x.eventId) : null;
  return `
  <button class="link-back" data-go="#/money">‹ Money</button>
  <div class="group-hero"><span class="li" style="width:52px;height:52px;font-size:24px">🧾</span>
    <div><h1>${esc(x.desc || "Expense")}</h1><div class="muted">${fmt$(x.amountCents)} · ${esc(nameOf(x.paidBy))} paid${ev ? " · " + esc(ev.title) : ""} · ${new Date(x.createdAt).toLocaleDateString()}</div></div></div>
  ${x.receipt ? `<div class="btnrow" style="margin-top:12px"><button class="btn small" id="viewReceipt">🧾 View receipt</button></div>` : ""}
  <div class="section-head"><h2>${x.shares ? "Who owes what" : `Split ${n} way${n > 1 ? "s" : ""}`}</h2></div>
  <div class="card">${(x.split || []).map(u => `<div class="member-row">${avatar(u, "lg")}<div style="flex:1;min-width:0"><b>${esc(nameOf(u))}${u === myUid() ? " (you)" : ""}</b></div><span class="amt sm">${fmt$(x.shares ? (x.shares[u] || 0) : share)}</span></div>`).join("")}</div>
  ${(x.items || []).length ? `<div class="section-head" style="margin-top:22px"><h2>Receipt${x.merchant ? " · " + esc(x.merchant) : ""}</h2></div>
  <div class="card">${x.items.map(it => `<div class="member-row"><div style="flex:1;min-width:0"><b>${esc(it.name)}</b><div class="muted sm">${(it.uids || []).map(u => esc(first(nameOf(u)))).join(", ") || "unassigned"}</div></div><span class="amt sm">${fmt$(it.cents)}</span></div>`).join("")}
    ${x.tax ? `<div class="member-row"><div style="flex:1"><b>Tax</b><div class="muted sm">split in proportion</div></div><span class="amt sm">${fmt$(x.tax)}</span></div>` : ""}
    ${x.tip ? `<div class="member-row"><div style="flex:1"><b>Tip</b><div class="muted sm">split in proportion</div></div><span class="amt sm">${fmt$(x.tip)}</span></div>` : ""}</div>` : ""}
  <div class="card th-plain" id="wall" style="margin-top:22px"><p class="muted">Loading…</p></div>`;
}
function wireExpensePage() {
  const x = S.expenses.get(S.route.id); if (!x) return;
  const pseudo = { id: x.id, _col: ["expenses", x.id], _manage: false, title: x.desc };
  if (el("viewReceipt")) el("viewReceipt").onclick = () => lightbox(x.receipt);
  S.comments = [];
  S.evSubs.push(onSnapshot(subCol(pseudo, "comments"), snap => {
    S.comments = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.createdAt - b.createdAt);
    const b = el("wall"); if (b) { b.innerHTML = wallInner(pseudo, "Discussion"); wireWall(pseudo); }
  }, e => toast(e.message)));
}
function payVenmo(uid, cents, txn) { const v = (S.contacts.get(uid) || {}).venmo; if (!v) return; window.open(`https://venmo.com/${encodeURIComponent(v.replace(/^@/, ""))}?txn=${txn}&amount=${(cents / 100).toFixed(2)}&note=${encodeURIComponent("Friendly 🤝")}`, "_blank"); if (txn === "pay") markPaid(myUid(), uid, cents, "Venmo"); else toast("Request sent in Venmo."); }
// Marks a payment as made. Undo is offered right away, and every settlement can
// be removed later from the Activity list too.
async function markPaid(from, to, cents, note) {
  const ref = doc(db, "settlements", newId());
  try { await setDoc(ref, { from, to, amountCents: cents, involved: [from, to], note: note || "", addedBy: myUid(), createdAt: Date.now() }); }
  catch (e) { return toast(e.message); }
  toast(note ? `Opened ${note} · marked as paid` : "Marked as paid", "Undo", () => deleteDoc(ref).then(() => toast("Undone")).catch(e => toast(e.message)));
}
function payApple(uid, cents) { const p = (S.contacts.get(uid) || {}).phone; if (!p) return; const sep = /iPhone|iPad|Mac/.test(navigator.userAgent) ? "&" : "?"; location.href = "sms:" + p.replace(/[^+\d]/g, "") + sep + "body=" + encodeURIComponent(`Sending $${(cents / 100).toFixed(2)} Apple Cash for our Friendly tab 🤝`); markPaid(myUid(), uid, cents, "Apple Cash"); }
const payerOptions = (people, sel) => people.map(([u, i]) => `<option value="${u}" ${u === (sel || myUid()) ? "selected" : ""}>${esc(first(i.name))}</option>`).join("");
// An expense between exactly the members of one group belongs to that group,
// even when it was added from the Money tab instead of the group page.
function matchGroupId(involved) {
  const key = [...new Set(involved)].sort().join("|"); if (involved.length < 2) return null;
  for (const g of S.groups.values()) if ([...new Set(g.memberUids || [])].sort().join("|") === key) return g.id;
  return null;
}
const inGroup = (x, g) => x.groupId === g.id || (!x.groupId && (x.involved || []).length >= 2 && [...new Set(x.involved)].sort().join("|") === [...new Set(g.memberUids || [])].sort().join("|"));
function openExpense(eventId, restrict, groupId) {
  const people = [...S.contacts.entries()];
  dialog(`<h3>Add expense</h3>
    <label class="field"><span>What was it?</span><input id="xDesc" maxlength="80" placeholder="Pizza & drinks"></label>
    <div class="two"><label class="field"><span>Amount ($)</span><input id="xAmt" inputmode="decimal" placeholder="42.50"></label>
    <label class="field"><span>Paid by</span><select id="xPayer">${payerOptions(people)}</select></label></div>
    <span class="field-label">Split between</span><div class="check-grid" id="xSplit">${people.map(([u, i]) => `<label class="cbox"><input type="checkbox" name="spl" value="${u}" ${!restrict || restrict.includes(u) ? "checked" : ""}>${esc(first(i.name))}</label>`).join("")}</div>
    <button type="button" class="btn small" id="xScan" style="margin-top:12px">📷 Scan a receipt to itemize</button>
    <p class="muted sm" style="margin-top:6px">Snap the receipt, assign each line to whoever had it. Tax and tip split in proportion.</p>`,
    "Add expense", async () => {
      const amount = parseAmount(el("xAmt").value); if (!amount) return toast("Enter a valid amount.");
      const split = [...document.querySelectorAll('input[name=spl]:checked')].map(i => i.value); if (!split.length) return toast("Pick who splits it.");
      const paidBy = el("xPayer").value; const involved = [...new Set([...split, paidBy])];
      try { await setDoc(doc(db, "expenses", newId()), { desc: el("xDesc").value.trim(), amountCents: amount, paidBy, split, involved, eventId: eventId || null, groupId: groupId || (eventId && (S.events.get(eventId) || {}).groupId) || matchGroupId(involved), addedBy: myUid(), createdAt: Date.now() }); closeDialog(); toast("Expense added"); } catch (e) { toast(e.message); }
    });
  el("xScan").onclick = () => scanReceipt(eventId, restrict, { desc: el("xDesc").value.trim(), paidBy: el("xPayer").value }, groupId);
}

// ----- Receipt scan → itemize → assign -----
// Generic request/response doc: write {uid, ...payload, status:"pending"},
// resolve with the doc once a Cloud Function marks it done.
function requestViaFirestore(col, payload, timeoutMs = 90000) {
  return new Promise(async (resolve, reject) => {
    const uid = S.user && S.user.uid; if (!uid) return reject(new Error("signed out"));
    const ref = doc(db, col, newId());
    let unsub = null, timer = null;
    const done = (fn, arg) => { clearTimeout(timer); if (unsub) unsub(); deleteDoc(ref).catch(() => {}); fn(arg); };
    try { await setDoc(ref, { uid, ...payload, status: "pending", createdAt: Date.now() }); } catch (e) { return reject(e); }
    timer = setTimeout(() => done(reject, new Error("timed out")), timeoutMs);
    unsub = onSnapshot(ref, s => { const d = s.data(); if (!d) return; if (d.status === "done") done(resolve, d); else if (d.status === "error") done(reject, new Error(d.error || "failed")); }, err => done(reject, err));
  });
}
async function scanReceipt(eventId, restrict, seed, groupId) {
  const f = await pickFile("image/*"); if (!f) return;
  toast("Reading the receipt…");
  try {
    const image = await compressImage(f, 2000, 0.85);
    const thumb = await compressImage(f, 1000, 0.72);   // kept on the expense for reference
    const res = await requestViaFirestore("receiptRequests", { image });
    itemizeDialog(eventId, restrict, seed, res.data || {}, thumb, groupId);
  } catch (e) { toast("Couldn't read that receipt: " + e.message); }
}
const toCents = v => Math.max(0, Math.round((Number(v) || 0) * 100));
// Each item's cost splits evenly among the people on it; tax and tip follow
// each person's share of the subtotal. Rounding drift lands on the biggest share.
function computeShares(items, tax, tip) {
  const sub = {}; let subtotal = 0;
  for (const it of items) {
    const who = [...it.uids]; if (!who.length || !it.cents) continue;
    subtotal += it.cents; const base = Math.floor(it.cents / who.length); let rem = it.cents - base * who.length;
    for (const u of who) sub[u] = (sub[u] || 0) + base + (rem-- > 0 ? 1 : 0);
  }
  const shares = {}; let sum = 0;
  for (const [u, c] of Object.entries(sub)) { shares[u] = c + (subtotal ? Math.round((tax + tip) * c / subtotal) : 0); sum += shares[u]; }
  const total = subtotal + tax + tip, drift = total - sum;
  if (drift && Object.keys(shares).length) { const big = Object.keys(shares).sort((a, b) => shares[b] - shares[a])[0]; shares[big] += drift; }
  return { shares, subtotal, total };
}
function itemizeDialog(eventId, restrict, seed, data, receipt, groupId) {
  const people = [...S.contacts.entries()].filter(([u]) => !restrict || restrict.includes(u) || u === seed.paidBy);
  const items = (data.items || []).map(it => ({ name: String(it.name || "Item").slice(0, 60), cents: toCents(it.price), uids: new Set() }));
  const st = { tax: toCents(data.tax), tip: toCents(data.tip) };
  const chips = it => people.map(([u, i]) => `<button type="button" class="${it.uids.has(u) ? "on" : ""}" data-who="${u}">${esc(first(i.name))}</button>`).join("");
  const rowHtml = (it, k) => `<div class="itz-item" data-k="${k}">
      <input class="nm" value="${esc(it.name)}" maxlength="60" aria-label="Item">
      <input class="pr" inputmode="decimal" value="${(it.cents / 100).toFixed(2)}" aria-label="Price">
      <div class="who">${chips(it)}<button type="button" class="all" data-all="1">everyone</button></div></div>`;
  dialog(`<h3>Itemize${data.merchant ? " · " + esc(data.merchant) : ""}</h3>
    <div class="two"><label class="field"><span>What was it?</span><input id="xDesc" maxlength="80" value="${esc(seed.desc || data.merchant || "")}" placeholder="Dinner"></label>
    <label class="field"><span>Paid by</span><select id="xPayer">${payerOptions(people, seed.paidBy)}</select></label></div>
    <p class="muted sm" style="margin:-2px 0 6px">Tap who had each line. Tax and tip are split in proportion to what each person ordered.</p>
    <div id="itz">${items.map(rowHtml).join("")}</div>
    <button type="button" class="btn small" id="itzAdd" style="margin-top:8px">＋ Add a line</button>
    <div class="two" style="margin-top:12px"><label class="field"><span>Tax ($)</span><input id="xTax" inputmode="decimal" value="${(st.tax / 100).toFixed(2)}"></label>
    <label class="field"><span>Tip ($)</span><input id="xTip" inputmode="decimal" value="${(st.tip / 100).toFixed(2)}"></label></div>
    <div class="btnrow" style="margin-top:-4px">${[15, 18, 20].map(p => `<button type="button" class="btn ghost small" data-tip="${p}">Tip ${p}%</button>`).join("")}</div>
    <div class="itz-sum card" id="itzSum"></div>`,
    "Add expense", async () => {
      const unassigned = items.filter(it => it.cents && !it.uids.size).length;
      if (unassigned) return toast(unassigned + " line" + (unassigned > 1 ? "s" : "") + " still need" + (unassigned > 1 ? "" : "s") + " a person.");
      const { shares, total } = computeShares(items, st.tax, st.tip); const split = Object.keys(shares); if (!split.length) return toast("Assign at least one line.");
      const paidBy = el("xPayer").value; const involved = [...new Set([...split, paidBy])];
      const rec = { desc: el("xDesc").value.trim() || data.merchant || "Receipt", amountCents: total, paidBy, split, shares, involved, eventId: eventId || null, groupId: groupId || (eventId && (S.events.get(eventId) || {}).groupId) || matchGroupId(involved), addedBy: myUid(), createdAt: Date.now(),
        items: items.filter(it => it.cents).map(it => ({ name: it.name, cents: it.cents, uids: [...it.uids] })), tax: st.tax, tip: st.tip, merchant: data.merchant || "", receipt: receipt || "" };
      rec.groupId = groupId || (eventId && (S.events.get(eventId) || {}).groupId) || null;
      try { await setDoc(doc(db, "expenses", newId()), rec); closeDialog(); toast("Itemized expense added"); } catch (e) { toast(e.message); }
    });
  const renderSum = () => {
    const { shares, subtotal, total } = computeShares(items, st.tax, st.tip);
    el("itzSum").innerHTML = `<div><span>Subtotal</span><b>${fmt$(subtotal)}</b></div><div><span>Tax + tip</span><b>${fmt$(st.tax + st.tip)}</b></div><div class="tot"><span>Total</span><b>${fmt$(total)}</b></div>
      ${Object.entries(shares).map(([u, c]) => `<div><span>${esc(first(nameOf(u)))}</span><b>${fmt$(c)}</b></div>`).join("") || `<div class="muted">Assign lines to see who owes what.</div>`}`;
  };
  const wireRows = () => {
    document.querySelectorAll("#itz .itz-item").forEach(row => {
      const it = items[+row.dataset.k];
      row.querySelector(".nm").oninput = e => { it.name = e.target.value; };
      row.querySelector(".pr").oninput = e => { it.cents = toCents(e.target.value); renderSum(); };
      row.querySelectorAll("[data-who]").forEach(b => b.onclick = () => { const u = b.dataset.who; it.uids.has(u) ? it.uids.delete(u) : it.uids.add(u); b.classList.toggle("on", it.uids.has(u)); renderSum(); });
      row.querySelector("[data-all]").onclick = () => { const all = people.every(([u]) => it.uids.has(u)); people.forEach(([u]) => all ? it.uids.delete(u) : it.uids.add(u)); row.querySelectorAll("[data-who]").forEach(b => b.classList.toggle("on", it.uids.has(b.dataset.who))); renderSum(); };
    });
  };
  el("itzAdd").onclick = () => { items.push({ name: "", cents: 0, uids: new Set() }); el("itz").insertAdjacentHTML("beforeend", rowHtml(items[items.length - 1], items.length - 1)); wireRows(); el("itz").lastElementChild.querySelector(".nm").focus(); };
  el("xTax").oninput = e => { st.tax = toCents(e.target.value); renderSum(); };
  el("xTip").oninput = e => { st.tip = toCents(e.target.value); renderSum(); };
  document.querySelectorAll("[data-tip]").forEach(b => b.onclick = () => { const { subtotal } = computeShares(items, 0, 0); st.tip = Math.round(subtotal * +b.dataset.tip / 100); el("xTip").value = (st.tip / 100).toFixed(2); renderSum(); });
  wireRows(); renderSum();
}
function openSettle(from, to, amount) {
  const people = [...S.contacts.entries()];
  const opts = sel => people.map(([u, i]) => `<option value="${u}" ${u === sel ? "selected" : ""}>${esc(first(i.name))}</option>`).join("");
  dialog(`<h3>Mark as paid</h3><p class="muted" style="margin-top:-6px">Log a payback so balances update. You can undo it right after.</p>
    <div class="two"><label class="field"><span>From</span><select id="sFrom">${opts(from || myUid())}</select></label>
    <label class="field"><span>To</span><select id="sTo">${opts(to)}</select></label></div>
    <label class="field"><span>Amount ($)</span><input id="sAmt" inputmode="decimal" value="${amount ? (amount / 100).toFixed(2) : ""}"></label>`,
    "Mark paid", async () => {
      const amt = parseAmount(el("sAmt").value); if (!amt) return toast("Enter a valid amount.");
      const f = el("sFrom").value, t = el("sTo").value; if (f === t) return toast("Pick two people.");
      closeDialog(); markPaid(f, t, amt, "");
    });
}

// ---------- PROFILE ----------
function profileBody() {
  const p = S.profile;
  return `
  <button class="link-back" data-go="#/">‹ Back</button>
  <div class="profile-hero"><button type="button" class="avatar-edit" id="photoBtn" title="Change photo">${avatar(myUid(), "xxl")}<span class="cam">📷</span></button><div><h1>${esc(p.name)}</h1><div class="muted mono">${esc(p.email || "")}</div></div></div>
  ${isDemo() ? `<div class="card" style="padding:14px 16px"><b>Shared demo account</b><p class="muted sm" style="margin:6px 0 0">Profile changes are off in demo mode. Create your own account to set up a profile, Venmo, and phone.</p></div>` : `<div class="form-card card">
    <label class="field"><span>Name</span><input id="pName" value="${esc(p.name)}" maxlength="40"></label>
    <div class="two"><label class="field"><span>Venmo</span><input id="pVenmo" value="${esc(p.venmo || "")}" placeholder="@sam-rivera"></label>
    <label class="field"><span>Phone (Apple Cash)</span><input id="pPhone" value="${esc(p.phone || "")}" placeholder="+1 555 123 4567"></label></div>
    <label class="field"><span>Birthday <span class="muted">(so your groups can plan something)</span></span><input id="pBday" type="date" value="${esc(p.birthday || "")}"></label>
    <p class="muted sm">Your Venmo and phone are shared only with people in your groups, so they can pay you back.</p>
    <button class="btn primary" id="saveProfile">Save profile</button>
  </div>`}
  <button class="btn" id="memoriesBtn" style="margin-top:14px">📸 Memories: photos from all your events</button>
  <div class="section-head" style="margin-top:22px"><h2>Notifications</h2></div>
  <div class="card member-row"><span class="li">🔔</span><div style="flex:1;min-width:0"><b>${({ on: "On for this device", off: "Off", denied: "Blocked in your browser settings", unsupported: "Not available in this browser", native: "Managed in iPhone Settings" })[pushState()]}</b><div class="muted sm">${IOS && !STANDALONE && pushState() === "off" ? "Add Friendly to your Home Screen first (Share → Add to Home Screen)." : "Invites, comments, RSVPs, and day-of reminders."}</div></div>${pushState() === "off" ? `<button class="btn small primary" id="pushToggle">Turn on</button>` : pushState() === "on" ? `<button class="btn small" id="pushToggle">Turn off</button>` : ""}</div>
  <div class="section-head" style="margin-top:22px"><h2>Calendar sync</h2></div>
  <div class="card" style="padding:14px 16px"><p class="muted sm" style="margin:0 0 10px">Subscribe once and every event you're invited to appears in your calendar and stays up to date when plans change.</p>
    <div class="btnrow"><button class="btn primary small" id="calSubscribe">Add to iPhone / Apple Calendar</button><button class="btn small" id="calCopy">Copy link for Google Calendar</button></div>
    <p class="muted sm" style="margin:8px 0 0">Google Calendar: Other calendars → ＋ → From URL → paste the link. Calendars refresh on their own schedule (usually within a few hours).</p></div>
  <button class="btn danger-ghost" id="signOut" style="margin-top:20px">Sign out</button>
  ${isDemo() ? "" : `<button class="btn ghost small" id="deleteAccount" style="margin-top:28px;opacity:.7">Delete my account</button>`}
  ${isAdmin() ? `<div class="section-head" style="margin-top:28px"><h2>Reports <span class="muted sm">moderation</span></h2></div>
  <div class="card" id="reportsCard"><p class="muted" style="padding:14px 16px;margin:0">Loading…</p></div>` : ""}`;
}
// Moderation queue (admins only): remove the reported content or dismiss.
function reportsInner(rows) {
  if (!rows.length) return `<p class="muted" style="padding:14px 16px;margin:0">No open reports. 🎉</p>`;
  return rows.map(r => `<div class="member-row" style="align-items:flex-start;flex-wrap:wrap"><div style="flex:1;min-width:0"><b>${esc(r.reason)}</b> <span class="muted sm">· ${esc(r.kind)} · by ${esc(r.reporterName || "someone")} · ${ago(r.createdAt)}</span>
    <div class="sm" style="margin-top:4px;overflow-wrap:anywhere">${esc(r.snippet || "")}</div><div class="muted sm mono">${esc(r.path)}</div></div>
    <div class="btnrow" style="width:100%;margin-top:6px"><button class="btn small danger-ghost" data-rmreport="${r.id}">Remove content</button><button class="btn small" data-dismiss="${r.id}">Dismiss</button></div></div>`).join("");
}
function wireReports() {
  if (!el("reportsCard")) return;
  S.evSubs.push(onSnapshot(query(collection(db, "reports"), where("status", "==", "open")), snap => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt - a.createdAt);
    const c = el("reportsCard"); if (!c) return; c.innerHTML = reportsInner(rows);
    c.querySelectorAll("[data-rmreport]").forEach(b => b.onclick = async () => {
      const r = rows.find(x => x.id === b.dataset.rmreport); if (!r || !confirm("Remove this content for everyone?")) return;
      try { await deleteDoc(doc(db, r.path)); await updateDoc(doc(db, "reports", r.id), { status: "removed", handledAt: Date.now() }); toast("Content removed"); } catch (e) { toast(e.message); }
    });
    c.querySelectorAll("[data-dismiss]").forEach(b => b.onclick = () => updateDoc(doc(db, "reports", b.dataset.dismiss), { status: "dismissed", handledAt: Date.now() }).catch(e => toast(e.message)));
  }, err => toast("Reports: " + err.message)));
}
function wireProfile() {
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  if (el("saveProfile")) el("saveProfile").onclick = async () => {
    const name = el("pName").value.trim(); if (!name) return toast("Name can't be empty.");
    const venmo = el("pVenmo").value.trim(), phone = el("pPhone").value.trim();
    try {
      const birthday = (el("pBday") || {}).value || "";
      await updateDoc(doc(db, "users", myUid()), { name, venmo, phone, phoneE164: toE164(phone), birthday });
      // propagate name/contact into each group's denormalized members map
      for (const g of S.groups.values()) if ((g.memberUids || []).includes(myUid())) await updateDoc(doc(db, "groups", g.id), { [`members.${myUid()}`]: { name, venmo, phone, photo: S.profile.photo || "", birthday } }).catch(() => {});
      toast("Profile saved");
    } catch (e) { toast(e.message); }
  };
  el("signOut").onclick = () => { stopListening(); signOut(auth); };
  const pt = el("pushToggle"); if (pt) pt.onclick = () => pushState() === "on" ? disableWebPush() : enableWebPush();
  el("photoBtn").onclick = async () => {
    if (isDemo()) return toast("Photo changes are off in demo mode.");
    const f = await pickFile(); if (!f) return; toast("Updating photo…");
    try {
      const photo = await compressImage(f, 320, 0.82);
      await updateDoc(doc(db, "users", myUid()), { photo });
      for (const g of S.groups.values()) if ((g.memberUids || []).includes(myUid())) await updateDoc(doc(db, "groups", g.id), { [`members.${myUid()}.photo`]: photo }).catch(() => {});
      toast("Photo updated");
    } catch (e) { toast(e.message); }
  };
  if (el("memoriesBtn")) el("memoriesBtn").onclick = () => go("#/photos");
  // Calendar feed: a private token on the profile, made on first use.
  const calUrl = async () => {
    let t = S.profile.calToken;
    if (!t) { t = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join(""); await updateDoc(doc(db, "users", myUid()), { calToken: t }); }
    return FN_BASE + "/cal?u=" + myUid() + "&t=" + t;
  };
  if (el("calSubscribe")) el("calSubscribe").onclick = async () => { try { const u = await calUrl(); location.href = u.replace(/^https:/, "webcal:"); } catch (e) { toast(e.message); } };
  if (el("calCopy")) el("calCopy").onclick = async () => { try { const u = await calUrl(); await navigator.clipboard.writeText(u); toast("Link copied. Google Calendar: Other calendars → From URL"); } catch (e) { toast(e.message); } };
  wireReports();
  // App Store requires in-app account deletion (guideline 5.1.1). Re-auth first:
  // Firebase refuses to delete a user without a recent sign-in.
  if (el("deleteAccount")) el("deleteAccount").onclick = () => dialog(`
    <h2>Delete your account?</h2>
    <p class="muted">This removes your profile, sign-in, and notifications, and takes you out of your groups. Events and expenses you were part of stay visible to the other people involved.</p>
    <label class="field"><span>Confirm your password</span><input type="password" id="delPw" autocomplete="current-password"></label>`,
    "Delete account", deleteAccount);
}
async function deleteAccount() {
  const u = auth.currentUser, pw = (el("delPw") || {}).value || "";
  if (!pw) return toast("Enter your password to confirm.");
  try {
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, pw));
    // Leave every group; hand a group I own to its next member, or delete it if I'm the last one.
    for (const g of S.groups.values()) {
      const others = (g.memberUids || []).filter(x => x !== u.uid);
      if (g.ownerId === u.uid && !others.length) { await deleteDoc(doc(db, "groups", g.id)).catch(() => {}); continue; }
      const up = { memberUids: arrayRemove(u.uid), hostUids: arrayRemove(u.uid), [`members.${u.uid}`]: deleteField() };
      if (g.ownerId === u.uid) up.ownerId = others[0];
      await updateDoc(doc(db, "groups", g.id), up).catch(() => {});
    }
    await deleteDoc(doc(db, "users", u.uid));
    stopListening();
    await deleteUser(u);
    closeDialog(); toast("Your account has been deleted.");
  } catch (e) { toast(e.code === "auth/invalid-credential" || e.code === "auth/wrong-password" ? "That password didn't match." : e.message); }
}

// ---------- ACTIVITY ----------
const seenAt = () => (S.profile && S.profile.activitySeenAt) || 0;
const unreadCount = () => (S.activity || []).filter(a => a.createdAt > seenAt()).length;
const newCountFor = urlTail => (S.activity || []).filter(a => a.createdAt > seenAt() && String(a.url || "").endsWith(urlTail)).length;
const isNewEvent = ev => (S.activity || []).some(a => a.createdAt > seenAt() && String(a.url || "").endsWith("#/e/" + ev.id));
const actIcon = a => /waiting on your RSVP/.test(a.title) ? "📣" : /mentioned you/.test(a.title) ? "＠" : /to a meeting/.test(a.title) ? "📅" : /You're in!/.test(a.title) ? "🎟️" : /still owe/.test(a.title) ? "💸" : /invited you/.test(a.title) ? "🎟️" : /^Today:/.test(a.title) ? "⏰" : /reported/i.test(a.title) ? "⚑" : /is going|might come|can't make|joined the waitlist|requested/.test(a.title) ? "✅" : "💬";
function notifCard() {
  if (NATIVE || localStorage.getItem("friendlyPushDismissed")) return "";
  const st = pushState(); if (st !== "off") return "";
  const needsInstall = IOS && !STANDALONE;
  return `<div class="card notif-card"><span class="li">🔔</span><div style="flex:1;min-width:0"><b>${needsInstall ? "Get a buzz when plans change" : "Turn on notifications"}</b><div class="muted sm">${needsInstall ? "Add Friendly to your Home Screen (Share → Add to Home Screen), then turn them on from your profile." : "New invites, comments, RSVPs, and day-of reminders, right on this device."}</div></div><div class="btnrow">${needsInstall ? "" : `<button class="btn primary small" id="pushOn">Turn on</button>`}<button class="btn ghost small" id="pushLater">Later</button></div></div>`;
}
function activityBody() {
  if (S._actOpenSeen == null) S._actOpenSeen = seenAt();   // keep "new" highlights until you leave the page
  const rows = S.activity || [];
  return `<div class="section-head"><h2>Activity</h2></div>
  <div class="card">${rows.length ? rows.map(a => `<a class="act-row ${a.createdAt > S._actOpenSeen ? "new" : ""}" data-act="${esc(a.url || "#/")}"><span class="li">${actIcon(a)}</span><div style="flex:1;min-width:0"><b>${esc(a.title)}</b><div class="muted sm" style="overflow-wrap:anywhere">${esc(a.body || "")}</div></div><span class="muted sm">${ago(a.createdAt)}</span></a>`).join("") : emptyState("🔔", "Nothing yet", "Invites, comments, RSVPs, and reminders will show up here.")}</div>`;
}
function wireActivity() {
  document.querySelectorAll("[data-act]").forEach(a => a.onclick = e => { e.preventDefault(); location.hash = String(a.dataset.act).replace(/^.*#/, "#"); });
  if (unreadCount()) updateDoc(doc(db, "users", myUid()), { activitySeenAt: Date.now() }).catch(() => {});
}

// ---------- MEETINGS (plain calendar entries, rendered in the normal shell) ----------
function meetingBody(ev) {
  const me = myUid(); const myR = (ev.rsvps || {})[me]; const invited = (ev.invitedUids || []).includes(me); const manage = canManage(ev);
  const g = statusGroups(ev);
  const row = (label, uids) => uids.length ? `<div class="muted sm" style="margin:8px 0 4px;font-weight:600">${label} · ${uids.length}</div>${uids.map(u => `<div class="member-row" style="padding:6px 0">${avatar(u, "sm")}<span>${esc(nameOf(u))}${u === ev.hostId ? " · organizer" : ""}</span></div>`).join("")}` : "";
  return `
  <button class="link-back" data-go="#/">‹ Back</button>
  <div class="group-hero"><span class="li" style="width:52px;height:52px;font-size:24px">📅</span>
    <div><h1>${esc(ev.title)}</h1><div class="muted">${esc(fmtWhen(ev))} · ${countdown(ev)}${ev.repeat ? " · repeats " + { weekly: "weekly", biweekly: "every 2 weeks", monthly: "monthly" }[ev.repeat] : ""}</div></div></div>
  <div class="card" style="padding:14px 16px">
    ${ev.location ? `<p style="margin:0 0 8px">📍 <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">${esc(ev.location)}</a></p>` : ""}
    <p class="muted" style="margin:0 0 8px">Organized by ${esc(nameOf(ev.hostId) === "Someone" ? (ev.hostName || "the organizer") : nameOf(ev.hostId))}</p>
    ${ev.notes ? `<p style="margin:0;white-space:pre-wrap">${esc(ev.notes)}</p>` : ""}
  </div>
  ${invited ? `<div class="btnrow" style="margin-top:14px">
    <button class="btn ${myR === "going" ? "primary" : ""}" data-rsvp="going">${myR === "going" ? "✓ Accepted" : "Accept"}</button>
    <button class="btn ${myR === "maybe" ? "primary" : ""}" data-rsvp="maybe">${myR === "maybe" ? "✓ Maybe" : "Maybe"}</button>
    <button class="btn ${myR === "no" ? "primary" : ""}" data-rsvp="no">${myR === "no" ? "✓ Declined" : "Decline"}</button>
  </div>` : ev.openLink ? `<div class="btnrow" style="margin-top:14px"><button class="btn primary" data-join>Join this meeting</button></div>` : `<p class="muted" style="margin-top:12px">You're viewing this meeting but aren't on the invite list.</p>`}
  <div class="btnrow" style="margin-top:10px">
    <button class="btn small" data-cal>Add to calendar</button>
    ${manage ? `<button class="btn small" data-text>Text invite</button><button class="btn small" data-nudge>Nudge non-responders</button><button class="btn small" data-edit>Edit</button><button class="btn small" data-dup>Duplicate</button><button class="btn small danger-ghost" data-del>Delete</button>` : ""}
  </div>
  <div class="section-head" style="margin-top:22px"><h2>Who's coming</h2></div>
  <div class="card" style="padding:8px 16px">${row("Accepted", g.going) + row("Maybe", g.maybe) + row("Declined", g.no) + row("No answer yet", g.none) || `<p class="muted">Nobody invited yet.</p>`}</div>
  <div class="card th-plain" id="wall" style="margin-top:22px"><p class="muted">Loading…</p></div>`;
}
function wireMeeting(ev) {
  // Group members who joined after the meeting was made aren't on it yet; add them quietly.
  S._autoJoined = S._autoJoined || new Set();
  if (!(ev.invitedUids || []).includes(myUid()) && ev.groupId && S.groups.has(ev.groupId) && !S._autoJoined.has(ev.id)) {
    S._autoJoined.add(ev.id);
    updateDoc(doc(db, "events", ev.id), { invitedUids: arrayUnion(myUid()), [`names.${myUid()}`]: S.profile.name }).catch(e => console.warn("auto-join failed:", e.message));
  }
  document.querySelectorAll("[data-rsvp]").forEach(b => b.onclick = () => setRsvp(ev, b.dataset.rsvp));
  const j = $("[data-join]"); if (j) j.onclick = () => joinViaLink(ev, j);
  const cal = $("[data-cal]"); if (cal) cal.onclick = () => downloadIcs(ev);
  const txt = $("[data-text]"); if (txt) txt.onclick = () => textEventInvite(ev);
  const nd = $("[data-nudge]"); if (nd) nd.onclick = () => nudge(ev, nd);
  const ed = $("[data-edit]"); if (ed) ed.onclick = () => editEvent(ev);
  const dp = $("[data-dup]"); if (dp) dp.onclick = () => duplicateEvent(ev);
  const dl = $("[data-del]"); if (dl) dl.onclick = () => delEvent(ev);
  const pseudo = { id: ev.id, _col: ["events", ev.id], _manage: false, title: ev.title };
  S.comments = [];
  S.evSubs.push(onSnapshot(subCol(pseudo, "comments"), snap => { S.comments = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.createdAt - b.createdAt); const w = el("wall"); if (w) { w.innerHTML = wallInner(pseudo, "Notes & questions"); wireWall(pseudo); } }, err => toast(err.message)));
}
// Host asks the guests who haven't answered to RSVP (Cloud Function delivers).
async function nudge(ev, btn) {
  const pending = (ev.invitedUids || []).filter(u => u !== myUid() && !(ev.rsvps || {})[u]);
  if (!pending.length) return toast("Everyone has answered already.");
  if (btn) { btn.disabled = true; btn.textContent = "Nudging…"; }
  try { await addDoc(collection(db, "nudges"), { eventId: ev.id, by: myUid(), createdAt: Date.now() }); toast("Nudged " + pending.length + " " + (pending.length === 1 ? "person" : "people")); }
  catch (e) { toast(e.message); }
  if (btn) { btn.disabled = false; btn.textContent = "Nudge non-responders"; }
}
function meetingCard(ev) {
  const d = evDate(ev); const myR = (ev.rsvps || {})[myUid()];
  const going = (ev.invitedUids || []).filter(u => (ev.rsvps || {})[u] === "going").length;
  return `<a class="card meet-card" data-ev="${ev.id}"><span class="li">📅</span>
    <div style="flex:1;min-width:0"><b>${esc(ev.title)}</b><div class="muted sm">${MONTHS[d.getMonth()]} ${d.getDate()}${ev.time ? " · " + fmtTime(ev.time) : ""}${ev.location ? " · " + esc(ev.location) : ""}</div><div class="muted sm">${going} accepted${ev.repeat ? " · ↻ repeats" : ""}</div></div>
    ${myR ? `<span class="you-pill ${myR}">${{ going: "Accepted", maybe: "Maybe", no: "Declined" }[myR] || ""}</span>` : `<span class="chev">›</span>`}${isNewEvent(ev) ? `<span class="new-pill" style="position:static;margin-left:6px">New</span>` : ""}</a>`;
}

// ---------- signed-out preview of a link invite ----------
async function renderPreview(root, id) {
  root.innerHTML = `<div class="auth-wrap"><canvas id="authbg" class="auth-bg"></canvas><div class="pv-wrap"><div class="card pv-card"><p class="muted">Loading invite…</p></div><div id="authRoot"></div></div></div>`;
  startParticles(el("authbg"), "confetti");
  let p = null; try { const d = await getDoc(doc(db, "previews", id)); p = d.exists() ? d.data() : null; } catch {}
  const card = $(".pv-card"); if (!card) return;
  if (!p) { card.innerHTML = `<b>This invite needs a sign-in.</b><p class="muted" style="margin:6px 0 0">Sign in or create an account below and the event will open.</p>`; }
  else {
    const when = fmtWhen({ date: p.date, time: p.time, endTime: p.endTime });
    card.innerHTML = `${p.cover ? `<img class="pv-cover" src="${p.cover}" alt="">` : ""}<div class="pv-body">
      <p class="muted sm" style="margin:0 0 4px">${esc(p.hostName || "A friend")} invited you${p.kind === "meeting" ? " to a meeting" : ""}</p>
      <h2 style="margin:0 0 6px">${p.kind === "meeting" ? "📅" : esc(p.emoji || "🎉")} ${esc(p.title)}</h2>
      <p style="margin:0 0 4px">${esc(when)}</p>${p.location ? `<p class="muted" style="margin:0 0 4px">📍 ${esc(p.location)}</p>` : ""}
      <p class="muted sm" style="margin:8px 0 0">${p.going} going${p.capacity ? " / " + p.capacity : ""} · Sign in or create a free account below to RSVP.</p></div>`;
  }
  renderAuth(el("authRoot"));
}

// ---------- MEMORIES (photo archive across my events) ----------
S.memories = S.memories || new Map();   // eventId -> photos[]
async function loadMemories() {
  const evs = [...S.events.values()].sort((a, b) => b.date.localeCompare(a.date));
  await Promise.all(evs.filter(ev => !S.memories.has(ev.id)).map(async ev => {
    try { const snap = await getDocs(collection(db, "events", ev.id, "photos")); S.memories.set(ev.id, snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(visibleContent)); }
    catch { S.memories.set(ev.id, []); }
  }));
}
const yearAgoEvents = () => { const t = new Date(); t.setFullYear(t.getFullYear() - 1); const c = t.getTime(); return [...S.events.values()].filter(ev => Math.abs(evDate(ev).getTime() - c) < 8 * 86400e3); };
function photosPageBody() {
  const evs = [...S.events.values()].filter(ev => (S.memories.get(ev.id) || []).length).sort((a, b) => b.date.localeCompare(a.date));
  const ago1 = yearAgoEvents().filter(ev => (S.memories.get(ev.id) || []).length);
  const section = (ev, label) => `<div class="section-head" style="margin-top:18px"><h2>${label ? label + " · " : ""}${esc(ev.emoji || "")} ${esc(ev.title)}</h2><a class="muted sm" data-go="#/e/${ev.id}">${esc(fmtWhen(ev))} ›</a></div>
    <div class="photo-grid mem-grid">${(S.memories.get(ev.id) || []).map(p => `<img src="${p.img}" data-mem="${p.id}" alt="" loading="lazy">`).join("")}</div>`;
  return `<button class="link-back" data-go="#/profile">‹ Profile</button>
  <div class="section-head"><h2>Memories</h2><span class="muted sm">${evs.reduce((t, ev) => t + S.memories.get(ev.id).length, 0)} photos</span></div>
  ${S._memLoading ? `<p class="muted">Gathering photos…</p>` : ""}
  ${ago1.map(ev => section(ev, "🕰️ One year ago")).join("")}
  ${evs.length ? evs.map(ev => section(ev)).join("") : (S._memLoading ? "" : emptyState("📸", "No photos yet", "Photos added to your events' photo walls show up here, newest first."))}`;
}
function wirePhotosPage() {
  document.querySelectorAll("[data-mem]").forEach(im => im.onclick = () => lightbox(im.src));
  // Fetch only events not cached yet; re-render only if that fetched something
  // (otherwise render -> wire -> load -> render would loop forever).
  const missing = [...S.events.values()].some(ev => !S.memories.has(ev.id));
  if (S._memLoading || !missing) return;
  S._memLoading = true;
  loadMemories().then(() => { S._memLoading = false; if (S.route.name === "photos") render(); });
}

// ---------- sprint 3b helpers: countdown, group tab, simplify, search, drafts, duplicate, magic link ----------
function countdown(ev) {
  if (!ev.date) return "";
  const [y, m, d] = ev.date.split("-").map(Number); const [sh, sm] = (ev.time || "09:00").split(":").map(Number);
  const start = new Date(y, m - 1, d, sh, sm).getTime();
  const end = ev.endTime ? new Date(y, m - 1, d, ...ev.endTime.split(":").map(Number)).getTime() : start + 3 * 3600e3;
  const now = Date.now(), diff = start - now, H = 3600e3, D = 24 * H;
  if (now >= start && now <= end) return "Happening now 🎉";
  if (diff > 0) { if (diff < H) return "Starts in " + Math.max(1, Math.round(diff / 60000)) + " min"; if (diff < D) return "Starts in " + Math.round(diff / H) + " hours"; const days = Math.round(diff / D); return days === 1 ? "Tomorrow" : "In " + days + " days"; }
  const ago = now - end; if (ago < D) return "Earlier today"; const days = Math.round(ago / D); return days === 1 ? "Yesterday" : days + " days ago";
}
// Balances between the members of one group, from that group's expenses (and settlements between members).
function groupBalances(g) {
  const members = new Set(g.memberUids || []); const owes = {};
  const add = (a, b, cents) => { if (a === b || !cents || !members.has(a) || !members.has(b)) return; (owes[a] = owes[a] || {})[b] = (owes[a][b] || 0) + cents; };
  const xs = [...S.expenses.values()].filter(x => inGroup(x, g));
  for (const x of xs) {
    if (x.shares) { for (const [u, c] of Object.entries(x.shares)) add(u, x.paidBy, c); continue; }
    const split = x.split || []; if (!split.length) continue;
    const base = Math.floor(x.amountCents / split.length); let rem = x.amountCents - base * split.length;
    for (const u of split) add(u, x.paidBy, base + (rem-- > 0 ? 1 : 0));
  }
  for (const s of S.settlements.values()) if (members.has(s.from) && members.has(s.to)) add(s.to, s.from, s.amountCents);
  const pairs = []; const seen = new Set();
  for (const a in owes) for (const b in owes[a]) { const k = a < b ? a + b : b + a; if (seen.has(k)) continue; seen.add(k); const net = (owes[a]?.[b] || 0) - (owes[b]?.[a] || 0); if (net > 0) pairs.push({ from: a, to: b, amount: net }); else if (net < 0) pairs.push({ from: b, to: a, amount: -net }); }
  return { expenses: xs.sort((a, b) => b.createdAt - a.createdAt), total: xs.reduce((t, x) => t + x.amountCents, 0), pairs };
}
function groupTab(g) {
  const { expenses, total, pairs } = groupBalances(g);
  if (!expenses.length) return `<div class="card empty" style="padding:16px"><b>No shared costs yet</b><p class="muted" style="margin:4px 0 0">Add an expense here and it lands on this group's tab.</p></div>`;
  return `<div class="card">
    <div class="member-row"><div style="flex:1"><b>Total spent together</b><div class="muted sm">${expenses.length} expense${expenses.length === 1 ? "" : "s"}</div></div><span class="amt sm">${fmt$(total)}</span></div>
    ${pairs.length ? pairs.map(p => `<div class="member-row">${avatar(p.from)}<div style="flex:1;min-width:0"><b>${esc(first(nameOf(p.from)))} owes ${esc(first(nameOf(p.to)))}</b></div><span class="amt sm">${fmt$(p.amount)}</span></div>`).join("") : `<div class="member-row"><div class="muted">All square 🎉</div></div>`}
    ${expenses.slice(0, 5).map(x => `<div class="ledger"><div class="li">🧾</div><div style="flex:1;min-width:0"><b>${esc(x.desc)}</b><div class="muted sm">${esc(first(nameOf(x.paidBy)))} paid · ${new Date(x.createdAt).toLocaleDateString()}</div></div><span class="amt sm">${fmt$(x.amountCents)}</span><button class="btn ghost small" data-xopen="${x.id}">💬</button></div>`).join("")}
    <div class="member-row"><a class="muted sm" data-go="#/money">Settle up from the Money tab ›</a></div></div>`;
}
// Fewest payments that settle everyone: net each person, then match the biggest debtor to the biggest creditor.
function simplify(pairs) {
  const bal = {}; pairs.forEach(p => { bal[p.from] = (bal[p.from] || 0) - p.amount; bal[p.to] = (bal[p.to] || 0) + p.amount; });
  const debt = Object.entries(bal).filter(([, v]) => v < 0).map(([u, v]) => ({ u, v: -v })).sort((a, b) => b.v - a.v);
  const cred = Object.entries(bal).filter(([, v]) => v > 0).map(([u, v]) => ({ u, v })).sort((a, b) => b.v - a.v);
  const out = []; let i = 0, j = 0;
  while (i < debt.length && j < cred.length) { const amt = Math.min(debt[i].v, cred[j].v); if (amt > 0) out.push({ from: debt[i].u, to: cred[j].u, amount: amt }); debt[i].v -= amt; cred[j].v -= amt; if (debt[i].v <= 0) i++; if (cred[j].v <= 0) j++; }
  return out;
}
// ---------- SEARCH ----------
S.q = S.q || "";
function searchResults(q) {
  const ql = q.trim().toLowerCase(); if (!ql) return "";
  const hit = s => String(s || "").toLowerCase().includes(ql);
  const evs = [...S.events.values()].filter(ev => hit(ev.title) || hit(ev.location) || hit(ev.notes)).sort((a, b) => b.date.localeCompare(a.date));
  const gs = [...S.groups.values()].filter(g => hit(g.name));
  const xs = [...S.expenses.values()].filter(x => hit(x.desc) || hit(x.merchant)).sort((a, b) => b.createdAt - a.createdAt);
  if (!evs.length && !gs.length && !xs.length) return emptyState("🔍", "Nothing matched", "Try a different word: event titles, places, notes, groups, and expenses are searchable.");
  return `${evs.length ? `<div class="section-head"><h2>Events</h2></div><div class="stack">${evs.map(ev => `<a class="card meet-card" data-ev="${ev.id}"><span class="li">${ev.kind === "meeting" ? "📅" : esc(ev.emoji || "🎉")}</span><div style="flex:1;min-width:0"><b>${esc(ev.title)}</b><div class="muted sm">${esc(fmtWhen(ev))}${ev.location ? " · " + esc(ev.location) : ""}</div></div><span class="chev">›</span></a>`).join("")}</div>` : ""}
    ${gs.length ? `<div class="section-head"><h2>Groups</h2></div><div class="stack">${gs.map(groupRow).join("")}</div>` : ""}
    ${xs.length ? `<div class="section-head"><h2>Expenses</h2></div><div class="card">${xs.map(x => `<div class="ledger"><div class="li">🧾</div><div style="flex:1;min-width:0"><b>${esc(x.desc)}</b><div class="muted sm">${esc(first(nameOf(x.paidBy)))} paid · ${new Date(x.createdAt).toLocaleDateString()}</div></div><span class="amt sm">${fmt$(x.amountCents)}</span><button class="btn ghost small" data-xopen="${x.id}">💬</button></div>`).join("")}</div>` : ""}`;
}
function searchBody() {
  return `<div class="section-head"><h2>Search</h2></div>
  <input class="search-box" id="searchBox" value="${esc(S.q)}" placeholder="Events, places, groups, expenses…" autocomplete="off">
  <div id="searchResults">${searchResults(S.q)}</div>`;
}
function wireSearch() {
  const box = el("searchBox"); if (!box) return; box.focus();
  const wireResults = () => {
    document.querySelectorAll("#searchResults [data-ev]").forEach(a => a.onclick = e => { e.preventDefault(); go("#/e/" + a.dataset.ev); });
    document.querySelectorAll("#searchResults [data-group]").forEach(a => a.onclick = e => { e.preventDefault(); go("#/g/" + a.dataset.group); });
    document.querySelectorAll("#searchResults [data-xopen]").forEach(b => b.onclick = () => go("#/x/" + b.dataset.xopen));
    document.querySelectorAll("#searchResults [data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  };
  box.oninput = () => { S.q = box.value; el("searchResults").innerHTML = searchResults(S.q); wireResults(); };
  wireResults();
}
// ---------- drafts (the composer remembers what you typed) ----------
function saveDraft() {
  try { if (compose.title || compose.notes) localStorage.setItem("friendlyDraft", JSON.stringify({ ...compose, invitees: [...compose.invitees], cohosts: [...compose.cohosts], _restored: undefined, _fromDraft: undefined })); } catch {}
}
function restoreDraft() {
  if (compose._restored || compose.title) return; compose._restored = true;
  try { const d = JSON.parse(localStorage.getItem("friendlyDraft") || "null"); if (!d || !(d.title || d.notes)) return;
    Object.assign(compose, d, { invitees: new Set(d.invitees || []), cohosts: new Set(d.cohosts || []), cover: d.cover || null, questions: d.questions || [] }); compose._fromDraft = true; } catch {}
}
function duplicateEvent(ev) {
  resetCompose(); compose._restored = true;
  Object.assign(compose, { title: ev.title, emoji: ev.emoji || "🎉", theme: ev.theme || DEFAULT_THEME, cover: ev.cover || null, coverTab: ev.cover ? "upload" : "emoji", time: ev.time || "", end: ev.endTime || "", where: ev.location || "", notes: ev.notes || "", cap: ev.capacity ? String(ev.capacity) : "", approval: !!ev.approval, questions: (ev.questions || []).map(q => ({ ...q, id: newId() })), groupId: ev.groupId || "", invitees: new Set(ev.groupId ? [] : (ev.invitedUids || []).filter(u => u !== myUid())), cohosts: new Set(ev.cohostUids || []), kind: ev.kind || "event", repeat: ev.repeat || "", openLink: ev.openLink !== false, date: "" });
  go("#/new"); toast("Copied. Pick a date and it's ready.");
}
// ---------- passwordless sign-in (email link) ----------
async function sendMagicLink() {
  const email = (el("aEmail").value || "").trim(); if (!email.includes("@")) return toast("Enter your email first.");
  try {
    await sendSignInLinkToEmail(auth, email, { url: location.origin + location.pathname + location.hash, handleCodeInApp: true });
    localStorage.setItem("friendlyMagicEmail", email); toast("Check your email for a sign-in link ✉️");
  } catch (e) { toast(e.code === "auth/operation-not-allowed" ? "Sign-in links aren't switched on yet. Use your password for now." : authError(e)); }
}
if (isSignInWithEmailLink(auth, location.href)) {
  const email = localStorage.getItem("friendlyMagicEmail") || prompt("Confirm your email to finish signing in");
  if (email) signInWithEmailLink(auth, email, location.href).then(() => { localStorage.removeItem("friendlyMagicEmail"); history.replaceState(null, "", location.pathname + location.hash); }).catch(e => toast(authError(e)));
}

// ---------- dialog helper ----------
function dialog(inner, okLabel, onOk) {
  closeDialog();
  const d = document.createElement("dialog");
  d.className = "app-dialog"; d.id = "appDialog";
  d.innerHTML = `<form method="dialog" class="dlg-inner">${inner}
    <div class="dlg-actions">${okLabel ? `<button type="button" class="btn" id="dlgCancel">Cancel</button><button type="button" class="btn primary" id="dlgOk">${esc(okLabel)}</button>` : `<button type="button" class="btn primary" id="dlgCancel">Close</button>`}</div></form>`;
  document.body.appendChild(d); d.showModal();
  el("dlgCancel").onclick = closeDialog;
  if (el("dlgOk")) el("dlgOk").onclick = onOk;
  d.addEventListener("close", () => d.remove());
}
function closeDialog() { const d = el("appDialog"); if (d) { d.close(); d.remove(); } }
window.closeDialog = closeDialog;

// register service worker
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));

render();
