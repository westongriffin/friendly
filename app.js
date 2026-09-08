// Friendly — app (Firebase Auth + Firestore). Real accounts, groups with
// server-enforced privacy, expressive themed events, RSVP + guest management,
// and shared money. Hosted static on GitHub Pages; no build step.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection,
  query, where, onSnapshot, addDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { THEMES, themeOf, applyTheme, startParticles, DEFAULT_THEME } from "./themes.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

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
function toast(msg) { const t = el("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 3400); }
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
async function compressImage(src, maxDim = 1000, quality = 0.72) {
  const img = await loadImg(typeof src === "string" ? src : await blobToURL(src));
  let { width: w, height: h } = img;
  const scale = Math.min(1, maxDim / Math.max(w, h)); w = Math.round(w * scale); h = Math.round(h * scale);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", quality);
}
async function generateCover(prompt) {
  // Pollinations is a free, no-API-key image generator (Stable Diffusion).
  // We bake the result into a data URL so the invite is self-contained.
  const seed = Math.floor(Math.random() * 1e6);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + ", vibrant party invitation art, bold, high quality")}?width=1024&height=640&nologo=true&seed=${seed}`;
  const res = await fetch(url); if (!res.ok) throw new Error("Generator busy — try again");
  const blob = await res.blob();
  return compressImage(await blobToURL(blob), 1024, 0.74);
}
function pickFile(accept = "image/*") { return new Promise(res => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); }); }

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
  if (p[0] === "new") return { name: "new" };
  if (p[0] === "money") return { name: "money" };
  if (p[0] === "groups") return { name: "groups" };
  if (p[0] === "profile") return { name: "profile" };
  return { name: "home" };
}
window.addEventListener("hashchange", () => { S.route = parseRoute(); render(); });
window.go = path => { location.hash = path; };

// ---------- auth ----------
onAuthStateChanged(auth, async u => {
  S.subs.forEach(fn => fn()); S.subs = [];
  S.user = u;
  if (!u) { S.profile = null; S.ready = true; render(); return; }
  const uref = doc(db, "users", u.uid);
  // Ensure a profile doc exists (created at sign-up; guard for older accounts).
  const snap = await getDoc(uref);
  if (!snap.exists()) await setDoc(uref, { name: u.displayName || first(u.email), email: u.email, venmo: "", phone: "", createdAt: Date.now() });
  subscribeAll(u);
});

function subscribeAll(u) {
  const add = fn => S.subs.push(fn);
  add(onSnapshot(doc(db, "users", u.uid), d => { S.profile = d.data(); rebuildContacts(); S.ready = true; render(); }));

  add(onSnapshot(query(collection(db, "groups"), where("memberUids", "array-contains", u.uid)), snap => {
    S.groups = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    rebuildContacts(); resubscribeEvents(u); render();
  }));

  add(onSnapshot(query(collection(db, "groups"), where("invitedEmails", "array-contains", (u.email || "").toLowerCase())), snap => {
    S.pendingInvites = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]).filter(g => !(g.memberUids || []).includes(u.uid)).map(g => [g.id, g]));
    render();
  }));

  add(onSnapshot(query(collection(db, "expenses"), where("involved", "array-contains", u.uid)), snap => {
    S.expenses = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }])); render();
  }));
  add(onSnapshot(query(collection(db, "settlements"), where("involved", "array-contains", u.uid)), snap => {
    S.settlements = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }])); render();
  }));

  // events where I'm directly invited
  add(onSnapshot(query(collection(db, "events"), where("invitedUids", "array-contains", u.uid)), snap => {
    snap.docChanges().forEach(c => { if (c.type === "removed") S.events.delete(c.doc.id); else S.events.set(c.doc.id, { id: c.doc.id, ...c.doc.data() }); });
    render();
  }));
}

// events tied to any of my groups (re-subscribed when group set changes)
function resubscribeEvents(u) {
  const gids = [...S.groups.keys()].slice(0, 30);
  const key = gids.sort().join(",");
  if (key === S.eventSubKey) return;
  S.eventSubKey = key;
  if (S._groupEventsUnsub) { S._groupEventsUnsub(); S._groupEventsUnsub = null; }
  if (!gids.length) return;
  S._groupEventsUnsub = onSnapshot(query(collection(db, "events"), where("groupId", "in", gids)), snap => {
    snap.docChanges().forEach(c => { if (c.type === "removed") S.events.delete(c.doc.id); else S.events.set(c.doc.id, { id: c.doc.id, ...c.doc.data() }); });
    render();
  });
  S.subs.push(() => S._groupEventsUnsub && S._groupEventsUnsub());
}

function rebuildContacts() {
  const m = new Map();
  if (S.user && S.profile) m.set(S.user.uid, { name: S.profile.name, venmo: S.profile.venmo, phone: S.profile.phone });
  for (const g of S.groups.values())
    for (const [uid, info] of Object.entries(g.members || {})) if (!m.has(uid)) m.set(uid, info);
  S.contacts = m;
}
const nameOf = uid => (S.contacts.get(uid) || {}).name || "Someone";
function avatar(uid, cls = "") { const info = S.contacts.get(uid) || {}; return `<span class="avatar ${cls}" style="background:${colorFor(uid)}">${esc(initials(info.name || "?"))}</span>`; }

// ---------- render root ----------
function render() {
  const root = el("app");
  if (!S.ready) { root.innerHTML = `<div class="splash"><div class="logo-mark"></div><p>Loading…</p></div>`; return; }
  if (!S.user) { renderAuth(root); return; }
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
      <p class="auth-lede">Plan get-togethers your friends will actually remember.</p>
      <div class="seg">
        <button id="segIn" class="${authMode === "in" ? "on" : ""}">Sign in</button>
        <button id="segUp" class="${authMode === "up" ? "on" : ""}">Create account</button>
      </div>
      <form id="authForm" class="stack">
        <label class="field ${authMode === "in" ? "hidden" : ""}" id="nameField"><span>Your name</span>
          <input id="aName" maxlength="40" placeholder="Sam Rivera" autocomplete="name"></label>
        <label class="field"><span>Email</span>
          <input id="aEmail" type="email" required placeholder="sam@example.com" autocomplete="email"></label>
        <label class="field"><span>Password</span>
          <input id="aPass" type="password" required minlength="6" placeholder="At least 6 characters" autocomplete="${authMode === "in" ? "current-password" : "new-password"}"></label>
        <button class="btn primary lg" type="submit">${authMode === "in" ? "Sign in" : "Create account"}</button>
      </form>
      <p class="auth-foot">${authMode === "in" ? "New here?" : "Already have an account?"}
        <a id="authSwap">${authMode === "in" ? "Create an account" : "Sign in"}</a></p>
    </div>
  </div>`;
  startParticles(el("authbg"), "confetti");
  el("segIn").onclick = () => { authMode = "in"; renderAuth(root); };
  el("segUp").onclick = () => { authMode = "up"; renderAuth(root); };
  el("authSwap").onclick = () => { authMode = authMode === "in" ? "up" : "in"; renderAuth(root); };
  el("authForm").onsubmit = async e => {
    e.preventDefault();
    const email = el("aEmail").value.trim(), pass = el("aPass").value, name = el("aName").value.trim();
    try {
      if (authMode === "up") {
        if (!name) return toast("Add your name so friends recognize you.");
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await setDoc(doc(db, "users", cred.user.uid), { name, email: email.toLowerCase(), venmo: "", phone: "", createdAt: Date.now() });
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (err) { toast(authError(err)); }
  };
}
function authError(err) {
  const c = (err && err.code) || "";
  if (c.includes("email-already-in-use")) return "That email already has an account — sign in instead.";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Email or password is incorrect.";
  if (c.includes("weak-password")) return "Password needs at least 6 characters.";
  if (c.includes("invalid-email")) return "That doesn't look like a valid email.";
  return "Couldn't do that: " + (err.message || c);
}

// ---------- app shell ----------
function shell(body) {
  const p = S.profile;
  const tab = S.route.name;
  const T = (name, label, path) => `<button class="tab ${tab === name ? "on" : ""}" data-go="${path}">${label}</button>`;
  return `
  <header class="topbar">
    <div class="brand" data-go="#/">Friend<span class="tilt">l</span>y</div>
    <button class="me-chip" data-go="#/profile">${avatar(S.user.uid)}<span>${esc(first(p.name))}</span></button>
  </header>
  <nav class="tabs">
    ${T("home", "Events", "#/")}
    ${T("groups", "Groups", "#/groups")}
    ${T("money", "Money", "#/money")}
  </nav>
  <main class="wrap">${body}</main>
  <button class="fab" data-go="#/new" title="Create event">＋</button>`;
}
function wireShell() {
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  if (S.route.name === "home") wireHome();
  if (S.route.name === "new") wireCompose();
  if (S.route.name === "groups") wireGroups();
  if (S.route.name === "group") wireGroupPage();
  if (S.route.name === "money") wireMoney();
  if (S.route.name === "profile") wireProfile();
}
function routeBody(r) {
  if (r.name === "home") return homeBody();
  if (r.name === "new") return composeBody();
  if (r.name === "groups") return groupsBody();
  if (r.name === "group") return groupPageBody(r.id);
  if (r.name === "money") return moneyBody();
  if (r.name === "profile") return profileBody();
  return homeBody();
}

// ---------- helpers for events visibility/counts ----------
const myUid = () => S.user.uid;
function goingCount(ev) { return (ev.invitedUids || []).reduce((t, u) => (ev.rsvps || {})[u] === "going" ? t + 1 + (((ev.plusOnes || {})[u]) || 0) : t, 0); }
function isFull(ev) { return ev.capacity > 0 && goingCount(ev) >= ev.capacity; }
function canManage(ev) { return ev.hostId === myUid() || (ev.cohostUids || []).includes(myUid()); }
function myEvents() {
  return [...S.events.values()].filter(ev => (ev.invitedUids || []).includes(myUid()) || (ev.groupId && S.groups.has(ev.groupId)));
}

// ---------- HOME ----------
let homeFilter = "all";
function homeBody() {
  const evs = myEvents();
  const t = todayStr();
  let upcoming = evs.filter(e => e.date >= t).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  let past = evs.filter(e => e.date < t).sort((a, b) => b.date.localeCompare(a.date));
  if (homeFilter !== "all") { const f = e => (e.groupId || "none") === homeFilter; upcoming = upcoming.filter(f); past = past.filter(f); }

  const invites = [...S.pendingInvites.values()];
  const inviteBanner = invites.length ? `<div class="stack" style="margin-bottom:16px">${invites.map(g => `
    <div class="card invite-row">
      <span class="ge" style="background:${g.color || "#FFE0B2"}">${esc(g.emoji || "🎉")}</span>
      <div style="flex:1;min-width:0"><b>${esc(g.name)}</b><div class="muted sm">${esc(nameOf(g.ownerId))} invited you to this group</div></div>
      <button class="btn small primary" data-accept="${g.id}">Join</button>
    </div>`).join("")}</div>` : "";

  const groups = [...S.groups.values()];
  const filterBar = groups.length ? `<div class="chiprow">
    <button class="fchip ${homeFilter === "all" ? "on" : ""}" data-filter="all">All</button>
    ${groups.map(g => `<button class="fchip ${homeFilter === g.id ? "on" : ""}" data-filter="${g.id}">${esc(g.emoji || "•")} ${esc(g.name)}</button>`).join("")}
    <button class="fchip ${homeFilter === "none" ? "on" : ""}" data-filter="none">Just friends</button>
  </div>` : "";

  return `
  ${inviteBanner}
  <div class="section-head"><h2>Upcoming</h2><button class="btn primary small" data-go="#/new">＋ New event</button></div>
  ${filterBar}
  <div class="ev-grid">${upcoming.length ? upcoming.map(eventCard).join("") : emptyState("🗓️", "No plans yet", "Create your first event — pick a theme and invite the crew.")}</div>
  ${past.length ? `<div class="section-head" style="margin-top:26px"><h2>Past</h2></div><div class="ev-grid dim">${past.map(eventCard).join("")}</div>` : ""}`;
}
function emptyState(emoji, title, sub) { return `<div class="card empty"><div class="big">${emoji}</div><b>${esc(title)}</b><p class="muted">${esc(sub)}</p></div>`; }

function eventCard(ev) {
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
    </div>
  </a>`;
}
function wireHome() {
  document.querySelectorAll("[data-ev]").forEach(a => a.onclick = e => { e.preventDefault(); go("#/e/" + a.dataset.ev); });
  document.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { homeFilter = b.dataset.filter; render(); });
  document.querySelectorAll("[data-accept]").forEach(b => b.onclick = () => acceptInvite(b.dataset.accept));
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
    <div style="flex:1;min-width:0"><b>${esc(g.name)}</b><div class="muted sm">${n} member${n === 1 ? "" : "s"}${g.ownerId === myUid() ? " · you host" : ""}</div></div>
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
  return `
  <button class="link-back" data-go="#/groups">‹ Groups</button>
  <div class="group-hero"><span class="ge xl" style="background:${g.color || "#FFE0B2"}">${esc(g.emoji || "🎉")}</span>
    <div><h1>${esc(g.name)}</h1><div class="muted">${members.length} member${members.length === 1 ? "" : "s"}</div></div></div>
  <div class="btnrow">
    <button class="btn primary" data-go="#/new">＋ Plan for this group</button>
    ${owner ? `<button class="btn" id="inviteBtn">Invite by email</button>` : ""}
  </div>
  <div class="section-head" style="margin-top:22px"><h2>Members</h2></div>
  <div class="card">${members.map(m => `<div class="member-row">${avatar(m.uid, "lg")}
    <div style="flex:1;min-width:0"><b>${esc(m.name || "Member")}${m.uid === myUid() ? " (you)" : ""}${m.uid === g.ownerId ? " · host" : ""}</b>
    ${m.venmo ? `<div class="muted sm mono">${esc(m.venmo)}</div>` : ""}</div></div>`).join("")}</div>
  ${(g.invitedEmails || []).length ? `<div class="section-head" style="margin-top:18px"><h2>Invited</h2></div>
    <div class="card">${g.invitedEmails.map(e => `<div class="member-row"><span class="avatar lg" style="background:#CBB;opacity:.6">✉︎</span><div style="flex:1"><b class="mono sm">${esc(e)}</b><div class="muted sm">Hasn't joined yet</div></div>${owner ? `<button class="btn ghost small" data-uninvite="${esc(e)}">✕</button>` : ""}</div>`).join("")}</div>` : ""}
  <div class="btnrow" style="margin-top:20px">
    ${owner ? `<button class="btn danger-ghost" id="delGroup">Delete group</button>` : `<button class="btn danger-ghost" id="leaveGroup">Leave group</button>`}
  </div>`;
}
function wireGroupPage() {
  const g = S.groups.get(S.route.id); if (!g) { document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go)); return; }
  if (el("inviteBtn")) el("inviteBtn").onclick = () => openInviteDialog(g);
  if (el("delGroup")) el("delGroup").onclick = () => deleteGroup(g);
  if (el("leaveGroup")) el("leaveGroup").onclick = () => leaveGroup(g);
  document.querySelectorAll("[data-uninvite]").forEach(b => b.onclick = () => uninvite(g, b.dataset.uninvite));
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
      closeDialog(); go("#/g/" + id); toast("Group created" + (emails.length ? " — invites sent" : ""));
    });
  document.querySelectorAll("#gEmoji button").forEach(b => b.onclick = () => { document.querySelectorAll("#gEmoji button").forEach(x => x.classList.remove("on")); b.classList.add("on"); });
}
function openInviteDialog(g) {
  const chosen = new Set(); // uids of known contacts to add directly
  const hasPicker = ("contacts" in navigator && "ContactsManager" in window);
  dialog(`<h3>Invite to ${esc(g.name)}</h3>
    <span class="field-label">Add from your friends</span>
    <input class="inv-search" id="invSearch" placeholder="Search by name or phone…" autocomplete="off">
    <div class="inv-chosen" id="invChosen"></div>
    <div class="inv-results" id="invResults"></div>
    ${hasPicker ? `<button type="button" class="btn small" id="invPick" style="margin-bottom:12px">📇 Pick from phone contacts</button>` : ""}
    <label class="field"><span>Or invite by email</span><input id="invEmails" placeholder="alex@example.com, jo@example.com"></label>
    <p class="muted sm" style="margin-top:-4px">Emailed folks connect automatically when they sign in with that address.${!hasPicker ? " (Reading your phone's contacts isn't available in this browser — on iPhone that needs the native app.)" : ""}</p>`,
    "Send invites", async () => {
      const emails = el("invEmails").value.split(",").map(s => s.trim().toLowerCase()).filter(x => x.includes("@"));
      const existingE = new Set([...(g.invitedEmails || [])]);
      const addE = emails.filter(e => !existingE.has(e));
      const updates = {};
      if (addE.length) updates.invitedEmails = [...(g.invitedEmails || []), ...addE];
      if (chosen.size) {
        updates.memberUids = [...new Set([...(g.memberUids || []), ...chosen])];
        for (const uid of chosen) { const info = S.contacts.get(uid) || {}; updates[`members.${uid}`] = { name: info.name || "Friend", venmo: info.venmo || "", phone: info.phone || "" }; }
      }
      if (!Object.keys(updates).length) return toast("Pick someone or add an email.");
      try { await updateDoc(doc(db, "groups", g.id), updates); closeDialog(); toast("Invites sent"); } catch (e) { toast(e.message); }
    });
  const known = [...S.contacts.entries()].filter(([u]) => u !== myUid() && !(g.memberUids || []).includes(u));
  const renderChosen = () => el("invChosen").innerHTML = [...chosen].map(u => `<span class="inv-tag">${avatar(u, "sm")}${esc(first(nameOf(u)))}<button data-unchoose="${u}">✕</button></span>`).join("");
  const renderResults = q => {
    const ql = q.toLowerCase();
    const hits = known.filter(([u, i]) => !chosen.has(u) && ((i.name || "").toLowerCase().includes(ql) || (i.phone || "").replace(/\D/g, "").includes(ql.replace(/\D/g, "")) && ql.replace(/\D/g, "")));
    el("invResults").innerHTML = hits.slice(0, 8).map(([u, i]) => `<div class="inv-hit" data-choose="${u}">${avatar(u)}<div><b>${esc(i.name || "Friend")}</b>${i.phone ? `<div class="muted sm mono">${esc(i.phone)}</div>` : ""}</div><span class="add">Add</span></div>`).join("") || (q ? `<p class="muted sm">No matches among your friends. Invite them by email below.</p>` : "");
  };
  renderResults("");
  el("invSearch").oninput = e => renderResults(e.target.value);
  el("invResults").onclick = e => { const h = e.target.closest("[data-choose]"); if (h) { chosen.add(h.dataset.choose); renderChosen(); renderResults(el("invSearch").value); } };
  el("invChosen").onclick = e => { const b = e.target.closest("[data-unchoose]"); if (b) { chosen.delete(b.dataset.unchoose); renderChosen(); renderResults(el("invSearch").value); } };
  if (el("invPick")) el("invPick").onclick = async () => {
    try {
      const picked = await navigator.contacts.select(["name", "email"], { multiple: true });
      const emails = picked.flatMap(p => p.email || []).filter(Boolean);
      if (emails.length) { el("invEmails").value = [el("invEmails").value, ...emails].filter(Boolean).join(", "); toast(emails.length + " added from contacts"); }
      else toast("No emails on those contacts — try inviting by phone soon.");
    } catch { toast("Contact picking was cancelled."); }
  };
}
async function acceptInvite(gid) {
  const g = S.pendingInvites.get(gid); if (!g) return;
  try {
    await updateDoc(doc(db, "groups", gid), {
      memberUids: [...(g.memberUids || []), myUid()],
      invitedEmails: (g.invitedEmails || []).filter(e => e !== (S.user.email || "").toLowerCase()),
      [`members.${myUid()}`]: { name: S.profile.name, venmo: S.profile.venmo || "", phone: S.profile.phone || "" }
    });
    toast("You're in! Welcome to " + g.name);
  } catch (e) { toast("Couldn't join: " + e.message); }
}
async function uninvite(g, email) { try { await updateDoc(doc(db, "groups", g.id), { invitedEmails: (g.invitedEmails || []).filter(e => e !== email) }); } catch (e) { toast(e.message); } }
async function deleteGroup(g) { if (!confirm(`Delete “${g.name}”? Its events stay, but the group is removed.`)) return; try { await deleteDoc(doc(db, "groups", g.id)); go("#/groups"); toast("Group deleted"); } catch (e) { toast(e.message); } }
async function leaveGroup(g) {
  if (!confirm(`Leave “${g.name}”?`)) return;
  try {
    const members = { ...(g.members || {}) }; delete members[myUid()];
    await updateDoc(doc(db, "groups", g.id), { memberUids: (g.memberUids || []).filter(u => u !== myUid()), members });
    go("#/groups"); toast("You left " + g.name);
  } catch (e) { toast(e.message); }
}

// ---------- COMPOSE (create event) ----------
const compose = { theme: DEFAULT_THEME, emoji: "🎉", cover: null, coverTab: "emoji",
  title: "", date: "", time: "", end: "", where: "", notes: "", cap: "", approval: false,
  questions: [], invitees: new Set(), cohosts: new Set(), groupId: "" };
function resetCompose() { Object.assign(compose, { theme: DEFAULT_THEME, emoji: "🎉", cover: null, coverTab: "emoji", title: "", date: "", time: "", end: "", where: "", notes: "", cap: "", approval: false, questions: [], invitees: new Set(), cohosts: new Set(), groupId: "" }); }
function composeBody() {
  const emojis = ["🎉", "🍕", "🌮", "🍻", "🎂", "🎬", "🎮", "🏖️", "🥾", "⚽", "🎲", "🍜", "🎃", "🎄", "🕺", "🔥"];
  const groups = [...S.groups.values()];
  const th = themeOf(compose.theme);
  return `
  <button class="link-back" data-go="#/">‹ Cancel</button>
  <div class="compose">
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

    <div class="form-card card">
      <label class="field"><span>What's the plan?</span><input id="cTitle" maxlength="80" value="${esc(compose.title)}" placeholder="Rooftop taco night"></label>
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
    </div>

    <div class="section-head"><h2>Who's invited</h2></div>
    <div class="form-card card">
      ${groups.length ? `<label class="field"><span>Invite a whole group</span>
        <select id="cGroup"><option value="">Hand-pick friends instead</option>${groups.map(g => `<option value="${g.id}" ${compose.groupId === g.id ? "selected" : ""}>${esc(g.emoji || "")} ${esc(g.name)} (${(g.memberUids || []).length})</option>`).join("")}</select></label>` : `<p class="muted">You're not in any groups yet. <a data-go="#/groups">Create one</a> to invite people, or invite friends you already share a group with below.</p>`}
      <div id="cPickWrap" class="${compose.groupId ? "hidden" : ""}">
        <span class="field-label">Friends</span>
        <div class="check-grid" id="cInvitees">${contactChecks("inv", compose.invitees)}</div>
      </div>
      <details class="adv"><summary>Co-hosts &amp; approval</summary>
        <span class="field-label" style="margin-top:10px">Co-hosts (can edit &amp; manage)</span>
        <div class="check-grid" id="cCohosts">${contactChecks("coh", compose.cohosts)}</div>
        <label class="switch"><input type="checkbox" id="cApproval"><span>Approve guests before they're in</span></label>
      </details>
    </div>

    <div class="section-head"><h2>RSVP questions <span class="muted sm">optional</span></h2></div>
    <div class="form-card card">
      <div id="qList" class="stack">${compose.questions.map(q => qRow(q)).join("")}</div>
      <button class="btn ghost small" id="addQ">＋ Add a question</button>
      <p class="muted sm" style="margin:8px 0 0">e.g. “What are you bringing?” · “Any dietary restrictions?”</p>
    </div>

    <button class="btn primary lg full" id="createEventBtn">Create event &amp; send invites</button>
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
  if (!others.length) return `<span class="muted sm">No friends yet — invite people to a group first.</span>`;
  return others.map(([u, info]) => `<label class="cbox"><input type="checkbox" name="${name}" value="${u}" ${set.has(u) ? "checked" : ""}>${avatar(u)} ${esc(first(info.name))}</label>`).join("");
}
function syncCompose() {
  compose.title = el("cTitle").value; compose.date = el("cDate").value; compose.time = el("cTime").value;
  compose.end = el("cEnd").value; compose.where = el("cWhere").value; compose.notes = el("cNotes").value;
  compose.cap = el("cCap").value; if (el("cApproval")) compose.approval = el("cApproval").checked;
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
  wireCover();
  document.querySelectorAll("[data-theme]").forEach(b => b.onclick = () => { syncCompose(); compose.theme = b.dataset.theme; render(); });
  const gsel = el("cGroup"); if (gsel) gsel.onchange = () => { compose.groupId = gsel.value; el("cPickWrap").classList.toggle("hidden", !!compose.groupId); };
  el("addQ").onclick = () => { compose.questions.push({ id: newId().slice(0, 6), q: "" }); el("qList").insertAdjacentHTML("beforeend", qRow(compose.questions[compose.questions.length - 1])); wireQ(); };
  wireQ();
  el("createEventBtn").onclick = createEvent;
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
  if (el("coverDrop")) el("coverDrop").onclick = async () => { const f = await pickFile(); if (!f) return; el("coverDrop").textContent = "Processing…"; try { compose.cover = await compressImage(f, 1100, 0.74); refreshCoverUI(); } catch { toast("Couldn't read that image."); el("coverDrop").textContent = "📷 Tap to upload a photo"; } };
  if (el("aiGo")) el("aiGo").onclick = async () => {
    const p = el("aiPrompt").value.trim(); if (!p) return toast("Describe the vibe first.");
    el("coverPanel").innerHTML = `<div class="cover-spin"><div class="spinner"></div>Painting your cover…</div>`;
    try { compose.cover = await generateCover(p); refreshCoverUI(); toast("Fresh cover, made for you ✨"); }
    catch (e) { toast(e.message || "Generator busy — try again."); compose.coverTab = "ai"; refreshCoverUI(); }
  };
}
let composeStop = () => {};
function wireQ() {
  document.querySelectorAll("[data-qdel]").forEach(b => b.onclick = () => { compose.questions = compose.questions.filter(q => q.id !== b.dataset.qdel); $(`.q-row[data-q="${b.dataset.qdel}"]`)?.remove(); });
  document.querySelectorAll("[data-qedit]").forEach(i => i.oninput = () => { const q = compose.questions.find(q => q.id === i.dataset.qedit); if (q) q.q = i.value; });
}
async function createEvent() {
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
    title, emoji: compose.emoji, theme: compose.theme, cover: compose.cover || "",
    date, time: el("cTime").value || "", endTime: el("cEnd").value || "",
    location: el("cWhere").value.trim(), notes: el("cNotes").value.trim(),
    capacity: Number(el("cCap").value) || 0, approval: !!el("cApproval").checked,
    questions, rsvps: { [myUid()]: "going" }, plusOnes: {}, hypes: {}, answers: {},
    createdAt: Date.now()
  };
  try {
    el("createEventBtn").disabled = true; el("createEventBtn").textContent = "Creating…";
    await setDoc(doc(db, "events", id), ev);
    composeStop(); resetCompose();
    go("#/e/" + id); toast("Event created — invites are live");
  } catch (e) { toast("Couldn't create: " + e.message); el("createEventBtn").disabled = false; el("createEventBtn").textContent = "Create event & send invites"; }
}

// ---------- EVENT PAGE (the themed invite) ----------
let eventBgStop = () => {};
function cleanupEvent() { S.evSubs.forEach(fn => fn()); S.evSubs = []; eventBgStop(); eventBgStop = () => {}; }
function renderEventPage(root, id) {
  cleanupEvent();
  const ev = S.events.get(id);
  if (!ev) { root.innerHTML = shell(`<div class="card empty"><b>Loading event…</b><p class="muted">If this stays, you may not have access.</p><button class="btn" data-go="#/">Home</button></div>`); wireShell(); getDoc(doc(db, "events", id)).then(d => { if (d.exists()) { S.events.set(id, { id, ...d.data() }); render(); } }); return; }
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
  const sub = (name, fn) => S.evSubs.push(onSnapshot(collection(db, "events", id, name), snap => fn(snap.docs.map(d => ({ id: d.id, ...d.data() })))));
  sub("comments", rows => { S.comments = rows.sort((a, b) => a.createdAt - b.createdAt); const b = el("wall"); if (b) { b.innerHTML = wallInner(ev); wireWall(ev); } });
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
      <button data-plus="-1" ${myPlus <= 0 ? "disabled" : ""}>−</button><b>+${myPlus}</b><button data-plus="1">＋</button></div>` : ""}
    ${myR === "pending" ? `<p class="pending-note">⏳ Waiting for the host to approve you.</p>` : ""}
    ${full && myR !== "going" ? `<p class="full-note">This event is full — RSVP to join the waitlist.</p>` : ""}
    ${questionsBlock(ev, me, myR)}` : `<p class="not-invited">You're viewing this event but aren't on the guest list.</p>`;

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
    ${ev.location ? `<div class="ev-where">📍 ${esc(ev.location)}</div>` : ""}
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
  </div>

  <div class="ev-card-glass" id="pollsCard">${pollsInner(ev)}</div>
  <div class="ev-card-glass" id="playlistCard">${playlistInner(ev)}</div>
  <div class="ev-card-glass" id="photosCard">${photosInner(ev)}</div>
  <div class="ev-card-glass" id="wall">${wallInner(ev)}</div>

  <div class="ev-actions">
    <button class="btn-th" data-share>Share invite</button>
    <button class="btn-th" data-cal>Add to calendar</button>
    <button class="btn-th" data-expense>${cost ? fmt$(cost) + " · " : ""}Expenses</button>
    ${manage ? `<button class="btn-th" data-edit>Edit</button><button class="btn-th danger" data-del>Delete</button>` : ""}
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
function wallInner(ev) {
  const cs = S.comments;
  return `<div class="glass-head">Party wall <span>${cs.length}</span></div>
    <div class="wall-list">${cs.length ? cs.map(c => `<div class="wall-msg">${avatar(c.authorId, "sm")}<div><div class="wall-who">${esc(first(c.authorName || nameOf(c.authorId)))} <i>${ago(c.createdAt)}</i></div><div class="wall-text">${esc(c.text)}</div></div>${c.authorId === myUid() ? `<button class="wall-del" data-delc="${c.id}">✕</button>` : ""}</div>`).join("") : `<p class="muted-th">Be the first to say something 👋</p>`}</div>
    <form class="wall-form" id="wallForm"><input id="wallInput" maxlength="300" placeholder="Post to the wall…" autocomplete="off"><button class="btn-th accent small">Post</button></form>`;
}
function wireEventPage(ev) {
  const id = ev.id;
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  document.querySelectorAll("[data-rsvp]").forEach(b => b.onclick = () => setRsvp(ev, b.dataset.rsvp));
  document.querySelectorAll("[data-plus]").forEach(b => b.onclick = () => setPlus(ev, Number(b.dataset.plus)));
  document.querySelectorAll("[data-hype]").forEach(b => b.onclick = () => setHype(ev, b.dataset.hype));
  document.querySelectorAll("[data-approve]").forEach(b => b.onclick = () => hostSetRsvp(ev, b.dataset.approve, "going"));
  document.querySelectorAll("[data-promote]").forEach(b => b.onclick = () => hostSetRsvp(ev, b.dataset.promote, "going"));
  if (el("saveAnswers")) el("saveAnswers").onclick = () => saveAnswers(ev);
  if (el("viewAnswers")) el("viewAnswers").onclick = () => showAnswers(ev);
  const share = $("[data-share]"); if (share) share.onclick = () => shareEvent(ev);
  const cal = $("[data-cal]"); if (cal) cal.onclick = () => downloadIcs(ev);
  const exp = $("[data-expense]"); if (exp) exp.onclick = () => openExpense(ev.id, ev.invitedUids);
  const edit = $("[data-edit]"); if (edit) edit.onclick = () => editEvent(ev);
  const del = $("[data-del]"); if (del) del.onclick = () => delEvent(ev);
  wireWall(ev);
}
function wireWall(ev) {
  const f = el("wallForm"); if (f) f.onsubmit = e => { e.preventDefault(); postComment(ev); };
  document.querySelectorAll("[data-delc]").forEach(b => b.onclick = () => deleteComment(ev, b.dataset.delc));
}

// ----- Polls -----
function pollsInner(ev) {
  const me = myUid(); const manage = canManage(ev);
  const list = S.polls.map(p => {
    const total = Object.keys(p.votes || {}).length || 0;
    const mine = (p.votes || {})[me];
    return `<div class="poll"><div class="poll-q">${esc(p.q)}</div>${(p.options || []).map((o, i) => {
      const n = Object.values(p.votes || {}).filter(v => v === i).length;
      const pct = total ? Math.round(n / total * 100) : 0;
      return `<div class="poll-opt ${mine === i ? "mine" : ""}" data-vote="${p.id}|${i}"><div class="poll-bar" style="transform:scaleX(${total ? n / total : 0})"></div><div class="poll-opt-in"><span>${esc(o)}</span><span>${pct}%</span></div></div>`;
    }).join("")}<div class="muted-th sm" style="margin-top:4px">${total} vote${total === 1 ? "" : "s"}${manage ? ` · <a data-delpoll="${p.id}">remove</a>` : ""}</div></div>`;
  }).join("");
  return `<div class="glass-head">Polls${manage ? ` <a class="btn-th ghost small" id="addPoll">＋ Add</a>` : `<span>${S.polls.length}</span>`}</div>${list || `<p class="muted-th">${manage ? "Add a poll to help decide — food, time, theme." : "No polls yet."}</p>`}`;
}
function wirePolls(ev) {
  document.querySelectorAll("[data-vote]").forEach(b => b.onclick = () => { const [pid, i] = b.dataset.vote.split("|"); votePoll(ev, pid, +i); });
  if (el("addPoll")) el("addPoll").onclick = () => addPollDialog(ev);
  document.querySelectorAll("[data-delpoll]").forEach(b => b.onclick = () => deleteDoc(doc(db, "events", ev.id, "polls", b.dataset.delpoll)).catch(e => toast(e.message)));
}
async function votePoll(ev, pid, i) { try { await updateDoc(doc(db, "events", ev.id, "polls", pid), { [`votes.${myUid()}`]: i }); } catch (e) { toast(e.message); } }
function addPollDialog(ev) {
  dialog(`<h3>New poll</h3><label class="field"><span>Question</span><input id="pq" placeholder="What should we eat?"></label>
    <label class="field"><span>Options (one per line)</span><textarea id="popts" placeholder="Tacos\nPizza\nSushi"></textarea></label>`,
    "Add poll", async () => {
      const q = el("pq").value.trim(); const opts = el("popts").value.split("\n").map(s => s.trim()).filter(Boolean);
      if (!q || opts.length < 2) return toast("Add a question and at least two options.");
      try { await addDoc(collection(db, "events", ev.id, "polls"), { q, options: opts, votes: {}, authorId: myUid(), createdAt: Date.now() }); closeDialog(); } catch (e) { toast(e.message); }
    });
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
  return `<div class="glass-head">Playlist <a class="btn-th ghost small" id="addSong">＋ Add song</a></div>${list || `<p class="muted-th">Build the vibe — add songs, upvote favorites.</p>`}`;
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
  const tiles = S.photos.map(p => `<img src="${p.img}" data-photo="${p.id}" alt="" loading="lazy">`).join("");
  return `<div class="glass-head">Photos <span>${S.photos.length}</span></div><div class="photo-grid"><button class="photo-add" id="addPhoto">＋</button>${tiles || ""}</div>${S.photos.length ? "" : `<p class="muted-th" style="margin-top:8px">Share pics from the night.</p>`}`;
}
function wirePhotos(ev) {
  if (el("addPhoto")) el("addPhoto").onclick = async () => {
    const f = await pickFile(); if (!f) return; toast("Uploading photo…");
    try { const img = await compressImage(f, 900, 0.68); await addDoc(collection(db, "events", ev.id, "photos"), { img, addedBy: myUid(), createdAt: Date.now() }); }
    catch (e) { toast("Couldn't add photo: " + e.message); }
  };
  document.querySelectorAll("[data-photo]").forEach(im => im.onclick = () => { const box = document.createElement("div"); box.className = "lightbox"; box.innerHTML = `<img src="${im.src}" alt="">`; box.onclick = () => box.remove(); document.body.appendChild(box); });
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
  const rows = (ev.invitedUids || []).filter(u => (ev.answers || {})[u]).map(u => `<div class="ans-block"><b>${esc(nameOf(u))}</b>${ev.questions.map(q => `<div class="ans"><span>${esc(q.q)}</span> ${esc((ev.answers[u] || {})[q.id] || "—")}</div>`).join("")}</div>`).join("");
  dialog(`<h3>RSVP answers</h3>${rows || `<p class="muted">No answers yet.</p>`}`, null, null);
}
async function postComment(ev) {
  const input = el("wallInput"); const text = input.value.trim(); if (!text) return;
  input.value = "";
  try { await addDoc(collection(db, "events", ev.id, "comments"), { authorId: myUid(), authorName: S.profile.name, text, createdAt: Date.now() }); }
  catch (e) { toast("Couldn't post: " + e.message); }
}
async function deleteComment(ev, cid) { try { await deleteDoc(doc(db, "events", ev.id, "comments", cid)); } catch (e) { toast(e.message); } }
function shareEvent(ev) {
  const url = location.origin + location.pathname + "#/e/" + ev.id;
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
async function delEvent(ev) { if (!confirm(`Delete “${ev.title}”?`)) return; try { await deleteDoc(doc(db, "events", ev.id)); go("#/"); toast("Event deleted"); } catch (e) { toast(e.message); } }
function editEvent(ev) {
  dialog(`<h3>Edit event</h3>
    <label class="field"><span>Title</span><input id="eTitle" value="${esc(ev.title)}"></label>
    <div class="two"><label class="field"><span>Date</span><input id="eDate" type="date" value="${ev.date}"></label>
    <label class="field"><span>Start</span><input id="eTime" type="time" value="${ev.time || ""}"></label></div>
    <label class="field"><span>Where</span><input id="eWhere" value="${esc(ev.location || "")}"></label>
    <label class="field"><span>Details</span><textarea id="eNotes">${esc(ev.notes || "")}</textarea></label>`,
    "Save", async () => {
      try { await updateDoc(doc(db, "events", ev.id), { title: el("eTitle").value.trim(), date: el("eDate").value, time: el("eTime").value, location: el("eWhere").value.trim(), notes: el("eNotes").value.trim() }); closeDialog(); toast("Saved"); } catch (e) { toast(e.message); }
    });
}

// ---------- MONEY ----------
function pairwise() {
  const owes = {};
  const add = (d, c, cents) => { if (d === c || !cents) return; (owes[d] = owes[d] || {})[c] = (owes[d][c] || 0) + cents; };
  for (const x of S.expenses.values()) {
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
  const mine = pairs.filter(p => p.from === me || p.to === me);
  const rows = [...[...S.expenses.values()].map(x => ({ ...x, kind: "e" })), ...[...S.settlements.values()].map(s => ({ ...s, kind: "s" }))].sort((a, b) => b.createdAt - a.createdAt);
  return `
  <div class="section-head"><h2>Money</h2><button class="btn primary small" id="addExpense">＋ Expense</button></div>
  <div class="tiles"><div class="card tile owe"><span class="muted sm">You owe</span><div class="amt">${fmt$(iOwe)}</div></div>
    <div class="card tile owed"><span class="muted sm">Owed to you</span><div class="amt">${fmt$(owed)}</div></div></div>
  ${mine.length ? `<div class="section-head"><h2>Settle up</h2></div><div class="stack">${mine.map(p => {
    const other = S.contacts.get(p.from === me ? p.to : p.from) || {};
    let pay = "";
    if (p.from === me) { if (other.venmo) pay += `<button class="btn small venmo" data-venmo="${p.to}" data-amt="${p.amount}">Venmo</button>`; if (other.phone) pay += `<button class="btn small apple" data-apple="${p.to}" data-amt="${p.amount}"> Cash</button>`; }
    else if (other.venmo) pay = `<button class="btn small venmo" data-request="${p.from}" data-amt="${p.amount}">Request</button>`;
    return `<div class="card settle-row">${avatar(p.from)}<div style="flex:1"><b>${p.from === me ? "You owe " + esc(nameOf(p.to)) : esc(nameOf(p.from)) + " owes you"}</b></div><span class="amt sm">${fmt$(p.amount)}</span>${pay}<button class="btn small" data-record="${p.from}|${p.to}|${p.amount}">Record</button></div>`;
  }).join("")}</div>` : ""}
  <div class="section-head"><h2>Activity</h2></div>
  <div class="card">${rows.length ? rows.map(r => {
    if (r.kind === "s") return `<div class="ledger"><div class="li pay">⤴</div><div style="flex:1"><b>${esc(nameOf(r.from))} paid ${esc(nameOf(r.to))}</b><div class="muted sm">${r.note ? esc(r.note) + " · " : ""}${new Date(r.createdAt).toLocaleDateString()}</div></div><span class="amt sm">${fmt$(r.amountCents)}</span>${r.addedBy === me ? `<button class="btn ghost small" data-dels="${r.id}">✕</button>` : ""}</div>`;
    const n = (r.split || []).length || 1;
    return `<div class="ledger"><div class="li">🧾</div><div style="flex:1"><b>${esc(r.desc)}</b><div class="muted sm">${esc(nameOf(r.paidBy))} paid · split ${n} way${n > 1 ? "s" : ""} · ${new Date(r.createdAt).toLocaleDateString()}</div></div><span class="amt sm">${fmt$(r.amountCents)}</span>${r.addedBy === me ? `<button class="btn ghost small" data-dele="${r.id}">✕</button>` : ""}</div>`;
  }).join("") : emptyState("💸", "No shared costs yet", "Add an expense after your next hangout.")}</div>`;
}
function wireMoney() {
  el("addExpense").onclick = () => openExpense(null, null);
  document.querySelectorAll("[data-venmo]").forEach(b => b.onclick = () => payVenmo(b.dataset.venmo, +b.dataset.amt, "pay"));
  document.querySelectorAll("[data-request]").forEach(b => b.onclick = () => payVenmo(b.dataset.request, +b.dataset.amt, "charge"));
  document.querySelectorAll("[data-apple]").forEach(b => b.onclick = () => payApple(b.dataset.apple, +b.dataset.amt));
  document.querySelectorAll("[data-record]").forEach(b => b.onclick = () => { const [f, t, a] = b.dataset.record.split("|"); openSettle(f, t, +a); });
  document.querySelectorAll("[data-dele]").forEach(b => b.onclick = () => deleteDoc(doc(db, "expenses", b.dataset.dele)).catch(e => toast(e.message)));
  document.querySelectorAll("[data-dels]").forEach(b => b.onclick = () => deleteDoc(doc(db, "settlements", b.dataset.dels)).catch(e => toast(e.message)));
}
function payVenmo(uid, cents, txn) { const v = (S.contacts.get(uid) || {}).venmo; if (!v) return; window.open(`https://venmo.com/${encodeURIComponent(v.replace(/^@/, ""))}?txn=${txn}&amount=${(cents / 100).toFixed(2)}&note=${encodeURIComponent("Friendly 🤝")}`, "_blank"); toast("Finish in Venmo, then tap Record."); }
function payApple(uid, cents) { const p = (S.contacts.get(uid) || {}).phone; if (!p) return; const sep = /iPhone|iPad|Mac/.test(navigator.userAgent) ? "&" : "?"; location.href = "sms:" + p.replace(/[^+\d]/g, "") + sep + "body=" + encodeURIComponent(`Sending $${(cents / 100).toFixed(2)} Apple Cash for our Friendly tab 🤝`); toast("Attach Apple Cash in Messages, then Record."); }
function openExpense(eventId, restrict) {
  const people = [...S.contacts.entries()];
  dialog(`<h3>Add expense</h3>
    <label class="field"><span>What was it?</span><input id="xDesc" maxlength="80" placeholder="Pizza & drinks"></label>
    <div class="two"><label class="field"><span>Amount ($)</span><input id="xAmt" inputmode="decimal" placeholder="42.50"></label>
    <label class="field"><span>Paid by</span><select id="xPayer">${people.map(([u, i]) => `<option value="${u}" ${u === myUid() ? "selected" : ""}>${esc(first(i.name))}</option>`).join("")}</select></label></label></div>
    <span class="field-label">Split between</span><div class="check-grid" id="xSplit">${people.map(([u, i]) => `<label class="cbox"><input type="checkbox" name="spl" value="${u}" ${!restrict || restrict.includes(u) ? "checked" : ""}>${esc(first(i.name))}</label>`).join("")}</div>`,
    "Add expense", async () => {
      const amount = parseAmount(el("xAmt").value); if (!amount) return toast("Enter a valid amount.");
      const split = [...document.querySelectorAll('input[name=spl]:checked')].map(i => i.value); if (!split.length) return toast("Pick who splits it.");
      const paidBy = el("xPayer").value; const involved = [...new Set([...split, paidBy])];
      try { await setDoc(doc(db, "expenses", newId()), { desc: el("xDesc").value.trim(), amountCents: amount, paidBy, split, involved, eventId: eventId || null, groupId: null, addedBy: myUid(), createdAt: Date.now() }); closeDialog(); toast("Expense added"); } catch (e) { toast(e.message); }
    });
}
function openSettle(from, to, amount) {
  const people = [...S.contacts.entries()];
  const opts = sel => people.map(([u, i]) => `<option value="${u}" ${u === sel ? "selected" : ""}>${esc(first(i.name))}</option>`).join("");
  dialog(`<h3>Record a payment</h3><p class="muted" style="margin-top:-6px">Log a payback so balances update.</p>
    <div class="two"><label class="field"><span>From</span><select id="sFrom">${opts(from || myUid())}</select></label>
    <label class="field"><span>To</span><select id="sTo">${opts(to)}</select></label></div>
    <label class="field"><span>Amount ($)</span><input id="sAmt" inputmode="decimal" value="${amount ? (amount / 100).toFixed(2) : ""}"></label>`,
    "Record it", async () => {
      const amt = parseAmount(el("sAmt").value); if (!amt) return toast("Enter a valid amount.");
      const f = el("sFrom").value, t = el("sTo").value; if (f === t) return toast("Pick two people.");
      try { await setDoc(doc(db, "settlements", newId()), { from: f, to: t, amountCents: amt, involved: [f, t], note: "", addedBy: myUid(), createdAt: Date.now() }); closeDialog(); toast("Payment recorded"); } catch (e) { toast(e.message); }
    });
}

// ---------- PROFILE ----------
function profileBody() {
  const p = S.profile;
  return `
  <button class="link-back" data-go="#/">‹ Back</button>
  <div class="profile-hero">${avatar(myUid(), "xxl")}<div><h1>${esc(p.name)}</h1><div class="muted mono">${esc(p.email || "")}</div></div></div>
  <div class="form-card card">
    <label class="field"><span>Name</span><input id="pName" value="${esc(p.name)}" maxlength="40"></label>
    <div class="two"><label class="field"><span>Venmo</span><input id="pVenmo" value="${esc(p.venmo || "")}" placeholder="@sam-rivera"></label>
    <label class="field"><span>Phone (Apple Cash)</span><input id="pPhone" value="${esc(p.phone || "")}" placeholder="+1 555 123 4567"></label></div>
    <p class="muted sm">Your Venmo and phone are shared only with people in your groups, so they can pay you back.</p>
    <button class="btn primary" id="saveProfile">Save profile</button>
  </div>
  <button class="btn danger-ghost" id="signOut" style="margin-top:20px">Sign out</button>`;
}
function wireProfile() {
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  el("saveProfile").onclick = async () => {
    const name = el("pName").value.trim(); if (!name) return toast("Name can't be empty.");
    const venmo = el("pVenmo").value.trim(), phone = el("pPhone").value.trim();
    try {
      await updateDoc(doc(db, "users", myUid()), { name, venmo, phone });
      // propagate name/contact into each group's denormalized members map
      for (const g of S.groups.values()) if ((g.memberUids || []).includes(myUid())) await updateDoc(doc(db, "groups", g.id), { [`members.${myUid()}`]: { name, venmo, phone } }).catch(() => {});
      toast("Profile saved");
    } catch (e) { toast(e.message); }
  };
  el("signOut").onclick = () => signOut(auth);
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
