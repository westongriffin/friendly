// Friendly: app (Firebase Auth + Firestore). Real accounts, groups with
// server-enforced privacy, expressive themed events, RSVP + guest management,
// and shared money. Hosted static on GitHub Pages; no build step.
import { initializeApp, onLog } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signInWithCustomToken, signOut, deleteUser, reauthenticateWithCredential, EmailAuthProvider,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  verifyPasswordResetCode, confirmPasswordReset
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentSingleTabManager, terminate, clearIndexedDbPersistence, doc, getDoc, setDoc, updateDoc, deleteDoc, collection,
  query, where, onSnapshot, addDoc, arrayUnion, arrayRemove, deleteField, orderBy, limit, getDocs, FieldPath
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { firebaseConfig, mapsKey, adminUids, vapidPublicKey, giphyKey } from "./firebase-config.js";
import { THEMES, themeOf, applyTheme, startParticles, DEFAULT_THEME, CUSTOM_FONTS, CUSTOM_PARTICLES, makeCustomTheme } from "./themes.js";

const APP_V = (() => { try { return new URL(import.meta.url).searchParams.get("v") || "dev"; } catch { return "?"; } })();
// ---- Device storage and the watchdog thread ----
// On iPhone, writing localStorage is a blocking call into WebKit's storage process, and that call can deadlock
// against a Firestore database transaction that is waiting on this same page: the page freezes for good (taps
// dead, the system swipe-back still works). So after startup the page never writes web storage. Everything the
// app keeps on the device goes through LS: reads come from a memory copy; writes update the copy at once and are
// handed to a worker thread, which keeps them in its own small IndexedDB. The same worker is the watchdog: the page
// pings it every second, and if the page stops answering for six seconds while on screen the worker reports that
// to the server itself (a page iOS kills takes the worker with it, so such a report means a hang, not a kill).
const HANG_URL = "https://us-central1-friendly-6992a.cloudfunctions.net/hang";
let dog = null, prevTrace = null, prevCt = null, prevOlder = null, bootDiagResolve = null;
const bootDiag = new Promise(r => { bootDiagResolve = r; });
function dogSay(m) { try { if (dog) dog.postMessage(m); } catch {} }
const LS = { m: new Map(), touched: new Set(), ok: false,
  get(k) { return this.m.has(k) ? this.m.get(k) : null; },
  set(k, v) { v = String(v); this.m.set(k, v); this.touched.add(k); dogSay({ kv: [k, v] }); },
  remove(k) { this.m.delete(k); this.touched.add(k); dogSay({ kv: [k, null] }); } };
// First start on this version: what the old code kept in localStorage moves over (one read, at startup, is safe).
let migrateLS = false;
try { migrateLS = localStorage.getItem("friendlyLS") !== "1"; if (migrateLS) { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k !== "friendlyV") LS.m.set(k, localStorage.getItem(k)); } localStorage.setItem("friendlyLS", "1"); } } catch {}
try {
  dog = new Worker("./diag-worker.js?v=" + encodeURIComponent(APP_V));
  dog.onerror = e => console.warn("storage worker error:", (e && e.message) || e);
  dog.onmessage = e => { const d = e.data || {}; if (!d.prev) return;
    LS.ok = !!d.prev.ok;
    for (const [k, v] of Object.entries(d.prev.kv || {})) if (!LS.touched.has(k)) LS.m.set(k, v);
    if (migrateLS && LS.ok) for (const [k, v] of LS.m) dogSay({ kv: [k, v] });
    prevTrace = d.prev.trace || null; prevCt = d.prev.ct || null; prevOlder = d.prev.older || null; bootDiagResolve(true); };
  dog.postMessage({ vis: document.visibilityState === "visible" });
  setTimeout(() => { if (typeof S !== "undefined" && S && !S._authKnown) { S._authKnown = true; if (typeof openPendingNotif === "function") openPendingNotif(); } }, 3000);
} catch (e) { console.warn("storage worker unavailable:", e.message); }
setTimeout(() => bootDiagResolve(false), 10000);   // a cold start with a busy database can take a while to answer
bootDiag.then(ok => { if (!ok) console.warn("storage worker did not answer; device settings will not persist this session"); });
if (/^\d+$/.test(APP_V)) LS.set("friendlyV", APP_V);   // read by index.html at the next start (see there)

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
// Keep a copy of the account's data on the device, so the app opens from it instantly and
// freshens up in the background, instead of waiting on the network every launch.
let db; try { db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager(undefined) }) }); } catch (e) { console.warn("device cache unavailable:", e.message); db = getFirestore(fb); }
// Firestore falls back to a memory-only cache (quietly, with a warning) when the device's database can't be
// opened; a write made in that state lives only until the page goes away. Keep the warning for the reports.
window.__cacheNote = ""; try { onLog(l => { const m = String((l && l.message) || ""); if (/memory cache|persistence|IndexedDB|indexeddb/i.test(m) && !window.__cacheNote) window.__cacheNote = m.slice(0, 160); }, { level: "warn" }); } catch {}
// On sign-out or account deletion, the device copy goes too.
// Every step has a time limit and the page always reloads: on iPhone, clearing a large device copy could hang
// forever (the delete waits on a database connection that never closes), which left the app frozen on
// sign-out. An unfinished wipe is retried at the next launch, before anything reads the copy.
const WIPE_KEY = "friendlyWipePending";
const within = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise(r => setTimeout(r, ms))]);
async function wipeLocalData() {
  try { LS.set(WIPE_KEY, "1"); } catch {}
  const hard = setTimeout(() => location.reload(), 5000);
  let done = false;
  await within(terminate(db), 2000);
  await within(clearIndexedDbPersistence(db).then(() => { done = true; }), 2500);
  if (done) try { LS.remove(WIPE_KEY); } catch {}
  clearTimeout(hard); location.reload();
}
bootDiag.then(() => { try { if (LS.get(WIPE_KEY)) clearIndexedDbPersistence(db).then(() => LS.remove(WIPE_KEY)).catch(() => {}); } catch {} });



// Native bridge (present only inside the Capacitor iOS/Android app). All of
// this degrades to web behavior when window.Capacitor is absent.
const CAP = window.Capacitor || null;
const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
dogSay({ v: APP_V + " / " + (NATIVE ? "native" : "web") });

// Public demo (wes-griffin.com "Try the demo" and ?demo=1): a dedicated
// sandbox account, seeded and nightly-reset server-side (functions/index.js).
// isDemo() gates a few things that would either cost real money at unlimited
// public volume, contact a real stranger, or wreck the shared account for
// whoever else is looking at it right now; everything else (RSVPs, chat,
// polls, photos, new events, profile edits) is fully live and left alone.
const DEMO_UID = "demo-riley", DEMO_GROUP = "demo-squad", DEMO_EVENTS = ["demo-evt-1", "demo-evt-2", "demo-evt-3"];
const isDemo = () => !!(S.user && S.user.uid === DEMO_UID);
let demoAutoTried = false;
async function demoSignIn() {
  try {
    const r = await fetch(FN_BASE + "/demoLogin");
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.token) await signInWithCustomToken(auth, j.token); else throw new Error("no token");
  } catch (e) { S.ready = true; render(); toast("Couldn't open the demo right now -- try again in a moment."); }
}
// The iOS shell already keeps the web view below the status bar and above the
// home indicator, so the CSS safe-area padding would double up there.
if (NATIVE) document.documentElement.classList.add("native");

// A password-reset link (mailed to the user, opened from wherever their inbox
// is) has to keep working in a plain mobile browser -- there's no native deep
// link for it -- so it's exempt from the App Store block below.
const RESET_PARAMS = new URLSearchParams(location.search);
const RESET_OOB = RESET_PARAMS.get("mode") === "resetPassword" ? RESET_PARAMS.get("oobCode") : null;
// Invite links as Universal Links use the query form (https://officialfriendly.com/?p=<eventId>),
// since iOS matches app links on path + query, not on a #hash. Turn it into the app's route.
if (/^[a-f0-9]{8,64}$/i.test(RESET_PARAMS.get("p") || "")) history.replaceState(null, "", location.pathname + "#/e/" + RESET_PARAMS.get("p"));
if (/^[A-Za-z0-9_-]{8,64}$/.test(RESET_PARAMS.get("g") || "")) history.replaceState(null, "", location.pathname + "#/join/" + RESET_PARAMS.get("g"));

// A phone hitting the plain web site (not the native app -- NATIVE covers that,
// since the app shell also loads this same origin) belongs in the App Store,
// not the mobile web build. Full-screen block, no way to continue in browser.
const APP_STORE_URL = "https://apps.apple.com/app/id6810875052";
const IS_ANDROID = /Android/i.test(navigator.userAgent);
// Flip PLAY_LIVE to true once the Google Play listing is published; until then Android phones use the website.
const PLAY_LIVE = true, PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.officialfriendly.app";
// The public demo (?demo=1 from wes-griffin.com) stays on the web on phones too.
const BLOCKED_MOBILE_WEB = !NATIVE && !RESET_OOB && !RESET_PARAMS.get("demo") && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (IS_ANDROID && PLAY_LIVE));
// iOS slides the page up behind a dialog to make room for the keyboard and leaves it there afterwards.
// Remember where the page was when a dialog field takes focus and put it back once the keyboard is gone.
let kbSavedY = null;
const isField = el => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(checkbox|radio|range|button|submit)$/.test(el.type || "");
document.addEventListener("focusin", e => { if (isField(e.target) && e.target.closest("dialog") && kbSavedY === null) kbSavedY = window.scrollY; });
document.addEventListener("focusout", () => setTimeout(() => {
  if (kbSavedY === null || isField(document.activeElement)) return;
  const y = kbSavedY; kbSavedY = null; window.scrollTo(0, y);
}, 60));
// Inside the native app the layout is fixed: no pinch or focus zoom, so nothing can knock it out of place.
if (NATIVE) { const vp = document.querySelector('meta[name="viewport"]'); if (vp) vp.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no"); }
// The logo's letters as drawn shapes (Bricolage Grotesque 700, traced the way the CSS set them), so it looks the
// same on every device before the font loads. Ink follows the text color; the tilted "l" is coral (.wm-l).
// The big sign-in logo uses the font's 44px optical cut, which is a little tighter, like the text it replaces.
const WORDMARK = `<svg class="wordmark" viewBox="0 -950 3713 1240" role="img" aria-label="Friendly"><g transform="scale(1,-1)"><path d="M70 0V660H213V0ZM138 247V365H518V247ZM138 537V660H555V537ZM601 0V257V525H721V341H739Q746 410 765.5 453Q785 496 819 516.5Q853 537 903 537Q913 537 924.5 536Q936 535 951 531L945 378Q928 385 910 388Q892 391 878 391Q840 391 812 373Q784 355 767.5 320.5Q751 286 745 237V0ZM999 0V525H1143V0ZM1071 600Q1029 600 1006.5 617.5Q984 635 984 669Q984 704 1006.5 721.5Q1029 739 1071 739Q1114 739 1136.5 721.5Q1159 704 1159 669Q1159 635 1136.5 617.5Q1114 600 1071 600ZM1483 -14Q1417 -14 1367 4.5Q1317 23 1282 57.5Q1247 92 1229 141.5Q1211 191 1211 253Q1211 315 1228.5 367Q1246 419 1279.5 458Q1313 497 1362 518Q1411 539 1473 539Q1534 539 1580.5 519Q1627 499 1658 460Q1689 421 1703.5 365Q1718 309 1713 236L1304 233V312L1627 315L1580 274Q1586 327 1573 360.5Q1560 394 1533.5 410.5Q1507 427 1474 427Q1436 427 1408 406.5Q1380 386 1364.5 348Q1349 310 1349 256Q1349 172 1385.5 132Q1422 92 1483 92Q1511 92 1530.5 99.5Q1550 107 1562.5 119Q1575 131 1582 146.5Q1589 162 1593 178L1719 153Q1712 116 1695 85.5Q1678 55 1649 33Q1620 11 1579.5 -1.5Q1539 -14 1483 -14ZM1784 0V314V525H1902L1901 360H1919Q1932 420 1955.5 460Q1979 500 2015.5 519.5Q2052 539 2103 539Q2193 539 2240 475.5Q2287 412 2287 278V0H2143V262Q2143 343 2119 380.5Q2095 418 2049 418Q2009 418 1982.5 393.5Q1956 369 1942 326.5Q1928 284 1928 231V0ZM2567 -14Q2502 -14 2453.5 19.5Q2405 53 2378 115Q2351 177 2351 264Q2351 345 2375 406.5Q2399 468 2445.5 503Q2492 538 2561 538Q2611 538 2646 518.5Q2681 499 2703.5 462Q2726 425 2739 371H2760Q2754 404 2748.5 435.5Q2743 467 2739.5 495Q2736 523 2736 544V712H2881V250V0H2760L2761 154H2742Q2731 97 2708 60Q2685 23 2650 4.5Q2615 -14 2567 -14ZM2616 104Q2647 104 2670 117.5Q2693 131 2707.5 153.5Q2722 176 2729.5 202.5Q2737 229 2737 254V271Q2737 291 2731.5 312Q2726 333 2716 352.5Q2706 372 2691 387.5Q2676 403 2656.5 412Q2637 421 2613 421Q2578 421 2553 401Q2528 381 2514.5 345Q2501 309 2501 262Q2501 215 2515 179Q2529 143 2555 123.5Q2581 104 2616 104ZM3409 -178Q3370 -178 3329 -171Q3288 -164 3252 -149Q3216 -134 3190 -111L3230 15Q3262 -18 3309.5 -34.5Q3357 -51 3403 -51Q3456 -51 3491.5 -29.5Q3527 -8 3545 36Q3563 80 3566 146L3571 238H3551Q3542 171 3519.5 128.5Q3497 86 3462 66.5Q3427 47 3381 47Q3323 47 3284.5 76Q3246 105 3226.5 162.5Q3207 220 3207 306V525H3351V341Q3351 248 3372 207Q3393 166 3436 166Q3459 166 3478 178.5Q3497 191 3510 215Q3523 239 3530.5 274Q3538 309 3538 353V525H3682V140Q3682 79 3671 28.5Q3660 -22 3638.5 -60.5Q3617 -99 3584.5 -125.5Q3552 -152 3508.5 -165Q3465 -178 3409 -178Z"/><path class="wm-l" d="M3029.5 -6.8 2918.1 696.4 3058.3 718.6 3169.7 15.4Z"/></g></svg>`;
const WORDMARK_XL = `<svg class="wordmark" viewBox="0 -950 3593 1240" role="img" aria-label="Friendly"><g transform="scale(1,-1)"><path d="M62 0V660H206V0ZM131 246V364H500V246ZM131 538V660H537V538ZM573 0V262V525H695L694 332H709Q716 405 735 450Q754 495 786.5 516Q819 537 864 537Q876 537 889.5 535Q903 533 919 527L912 372Q895 381 876.5 384.5Q858 388 843 388Q806 388 779 369.5Q752 351 737 314.5Q722 278 717 226V0ZM960 0V525H1104V0ZM1033 591Q991 591 968.5 609Q946 627 946 661Q946 695 968.5 713Q991 731 1033 731Q1076 731 1098 713Q1120 695 1120 661Q1120 627 1098 609Q1076 591 1033 591ZM1432 -14Q1365 -14 1314.5 5Q1264 24 1230.5 59.5Q1197 95 1180 144Q1163 193 1163 253Q1163 313 1179.5 365.5Q1196 418 1229 457Q1262 496 1310.5 517.5Q1359 539 1422 539Q1484 539 1531 518.5Q1578 498 1608 458.5Q1638 419 1651 363.5Q1664 308 1658 238L1255 234V314L1565 318L1526 275Q1532 326 1519.5 359.5Q1507 393 1482 409.5Q1457 426 1423 426Q1384 426 1357 406Q1330 386 1315.5 348Q1301 310 1301 257Q1301 173 1336 133Q1371 93 1432 93Q1460 93 1479 100.5Q1498 108 1510.5 120.5Q1523 133 1529.5 149Q1536 165 1538 182L1666 162Q1661 126 1646 94Q1631 62 1603 38Q1575 14 1533 0Q1491 -14 1432 -14ZM1722 0V306V525H1842L1840 344H1856Q1866 410 1888.5 453Q1911 496 1948.5 517.5Q1986 539 2038 539Q2128 539 2173.5 477Q2219 415 2219 285V0H2075V269Q2075 345 2052.5 381Q2030 417 1985 417Q1947 417 1920.5 392.5Q1894 368 1880.5 323Q1867 278 1866 216V0ZM2486 -14Q2423 -14 2375 18.5Q2327 51 2300 113.5Q2273 176 2273 265Q2273 349 2297.5 410Q2322 471 2368 504.5Q2414 538 2480 538Q2530 538 2565 518.5Q2600 499 2622.5 460.5Q2645 422 2657 365H2675Q2669 399 2663.5 431Q2658 463 2655 491.5Q2652 520 2652 543V707H2797V235V0H2674L2675 157H2660Q2648 100 2625 62Q2602 24 2567.5 5Q2533 -14 2486 -14ZM2534 103Q2563 103 2585.5 116.5Q2608 130 2622.5 152Q2637 174 2645 200.5Q2653 227 2653 255V269Q2653 291 2647.5 313Q2642 335 2632 354Q2622 373 2607 388Q2592 403 2573.5 411.5Q2555 420 2532 420Q2497 420 2472.5 399.5Q2448 379 2435.5 343Q2423 307 2423 261Q2423 215 2436 179Q2449 143 2474.5 123Q2500 103 2534 103ZM3296 -172Q3259 -172 3219.5 -165Q3180 -158 3144 -143.5Q3108 -129 3081 -107L3121 23Q3154 -11 3200.5 -27Q3247 -43 3290 -43Q3343 -43 3378 -21Q3413 1 3431 44Q3449 87 3450 150L3455 243H3438Q3431 175 3408.5 132Q3386 89 3351 69Q3316 49 3270 49Q3212 49 3173.5 78Q3135 107 3116 164.5Q3097 222 3097 307V525H3241V342Q3241 251 3261.5 210.5Q3282 170 3325 170Q3348 170 3366.5 182Q3385 194 3398 218Q3411 242 3418 277Q3425 312 3426 357V525H3569V144Q3569 86 3558.5 37Q3548 -12 3527 -50.5Q3506 -89 3473.5 -116.5Q3441 -144 3397 -158Q3353 -172 3296 -172Z"/><path class="wm-l" d="M2931.5 -7 2820.9 691.3 2962.1 713.7 3072.7 15.4Z"/></g></svg>`;
if (BLOCKED_MOBILE_WEB) {
  document.getElementById("app").innerHTML = `
  <div class="auth-wrap">
    <div class="auth-bg"></div>
    <div class="auth-card card">
      <div class="brand xl">${WORDMARK_XL}</div>
      <p class="auth-lede">Friendly is best on the app. Taking you to ${IS_ANDROID ? "Google Play" : "the App Store"}…</p>
      <a class="btn primary lg" href="${IS_ANDROID ? PLAY_STORE_URL : APP_STORE_URL}">Get the Friendly app</a>
    </div>
  </div>`;
  location.href = IS_ANDROID ? PLAY_STORE_URL : APP_STORE_URL;
}
// Native plugins: the shell loads this site remotely, so no bundled JS registers the
// plugins. Capacitor.Plugins is empty until registerPlugin() is called for a plugin
// the native side reports as available.
const plugin = n => {
  if (!CAP) return null;
  if (CAP.Plugins && CAP.Plugins[n]) return CAP.Plugins[n];
  try { if (CAP.isPluginAvailable && CAP.isPluginAvailable(n) && CAP.registerPlugin) { const p = CAP.registerPlugin(n); if (CAP.Plugins) CAP.Plugins[n] = p; return p; } } catch {}
  return null;
};
// Inside the native app, a tapped Universal Link arrives here instead of as a page load.
function wireAppLinks() {
  const AppPlugin = plugin("App"); if (!AppPlugin || !AppPlugin.addListener) return;
  AppPlugin.addListener("appUrlOpen", ({ url }) => {
    try {
      const u = new URL(url); const p = u.searchParams.get("p"), g = u.searchParams.get("g");
      if (p) location.hash = "#/e/" + p;
      else if (g) location.hash = "#/join/" + g;
      else if (u.searchParams.get("mode") === "resetPassword") location.href = url;
      else if (u.hash && u.hash.length > 1) location.hash = u.hash;
    } catch {}
  });
}
if (NATIVE) wireAppLinks();
// Android's back button/gesture: close an open dialog or tour first, then go back a page, and only leave the app from Events.
if (NATIVE && IS_ANDROID) { const AppPlugin = plugin("App"); if (AppPlugin && AppPlugin.addListener) AppPlugin.addListener("backButton", () => {
  if (typeof tourStep !== "undefined" && tourStep >= 0) return endTour();
  if (document.querySelector("#appDialog[open], dialog[open]")) return closeDialog();
  if (location.hash && location.hash !== "#/" && location.hash !== "#") return history.length > 1 ? history.back() : go("#/");
  if (AppPlugin.exitApp) AppPlugin.exitApp();
}); }
// ---------- "We've updated the app" banner (native only) ----------
// Each launch compares the installed version with what the App Store lists
// (Apple's public lookup API, CORS-enabled). A phone with no App plugin is on
// 1.0.1 or older, which is behind anything Apple lists from here on.
let updateAvail = null, updateDismissed = false;
const verCmp = (a, b) => { const A = String(a).split(".").map(Number), B = String(b).split(".").map(Number); for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d; } return 0; };
async function checkForUpdate() {
  if (!NATIVE || IS_ANDROID) return;   // Google Play updates apps on its own
  try {
    const AppPlugin = plugin("App"); let installed = "";
    if (AppPlugin && AppPlugin.getInfo) { try { installed = (await AppPlugin.getInfo()).version || ""; } catch {} }
    const r = await fetch("https://itunes.apple.com/lookup?id=6810875052&t=" + Date.now());
    const j = await r.json(); const store = j && j.results && j.results[0] && j.results[0].version; if (!store) return;
    const inst = installed || "1.0.1";   // builds before 1.0.2 can't report a version; they are 1.0.1 or older
    if (verCmp(store, inst) > 0) { updateAvail = { store, installed: inst }; render(); }
  } catch {}
}
if (NATIVE) checkForUpdate();
// The installed app's version. Features that need a newer native build (the microphone permission
// arrived in iOS 1.0.3 / Android 1.0.4) stay hidden on older installs: touching the mic there crashes the app.
let nativeVersion = NATIVE ? null : "web";
if (NATIVE) (async () => { await null; await new Promise(r => setTimeout(r, 0)); try { const A = plugin("App"); nativeVersion = (A && A.getInfo && (await A.getInfo()).version) || "1.0.1"; } catch { nativeVersion = "1.0.1"; } try { if (S.route && S.route.name === "dm") render(); } catch {} })();
const canRecordVoice = () => nativeVersion === "web" ? !!(navigator.mediaDevices && window.MediaRecorder) : !!nativeVersion && verCmp(nativeVersion, IS_ANDROID ? "1.0.4" : "1.0.3") >= 0;
function updateBanner() {
  if (!updateAvail || updateDismissed) return "";
  return `<div class="card notif-card update-bar" id="updateBar" role="button"><span class="li ${window.Blip ? "blip-li" : ""}">${window.Blip ? window.Blip.svg({ mood: "party", size: 44 }) : "🎉"}</span><div style="flex:1;min-width:0"><b>Friendly just got better!</b><div class="muted sm">Version ${esc(updateAvail.store)} is ready. Tap to update.</div></div><button type="button" class="btn ghost small" id="updateLater" title="Not now">✕</button></div>`;
}
function wireUpdateBanner() {
  const bar = el("updateBar"); if (!bar) return;
  bar.onclick = () => { location.href = "itms-apps://apps.apple.com/app/id6810875052"; };
  el("updateLater").onclick = e => { e.stopPropagation(); updateDismissed = true; render(); };
}
async function registerPush(uid) {
  const Push = plugin("PushNotifications"); if (!Push) return;
  try {
    let perm = await Push.checkPermissions();
    if (perm.receive !== "granted") perm = await Push.requestPermissions();
    if (perm.receive !== "granted") return;
    Push.addListener("registration", async t => { try { await updateDoc(doc(db, "users", uid), { pushTokens: arrayUnion(t.value) }); } catch {} });
    // A tap that starts the app cold arrives before sign-in is known. Going to the screen right then renders it
    // signed-out first (the public preview, with its background animation) and again a moment later; the tap is
    // held until auth answers (a few hundred ms), then the screen is opened once.
    Push.addListener("pushNotificationActionPerformed", a => { S._notifTapAt = Date.now(); try { fz.add("notification tap"); if (endReplay) endReplay(true); } catch {} const url = a && a.notification && a.notification.data && a.notification.data.url; if (!url) return;
      if (!S._authKnown) { S._pendingNotif = url; fz.add("notification tap held until sign-in is known"); return; }
      location.hash = routeTail(url); focusRoute(); });
    await Push.register();
  } catch {}
}

// ---------- web push (installed PWA / browsers) ----------
// iPhone only delivers web push to apps added to the Home Screen.
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
// Which phone this app runs on, recorded on the profile and each group's members entry (and copied onto expenses by
// onUserPhone) so the app knows who can use Apple Cash. The website leaves it alone: it can't tell which phone you carry.
const MY_OS = NATIVE ? (IOS ? "ios" : IS_ANDROID ? "android" : "") : "";
const myOs = () => MY_OS || (S.profile && S.profile.os) || "";
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
// "Sixty Vines Plano, Dallas Parkway, Plano, TX, USA" -> "Sixty Vines Plano" for tiles and cards.
const placeName = loc => { const s = String(loc || "").trim(), p = s.split(",")[0].trim(); return p.length >= 3 ? p : s; };
const initials = n => (n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join("");
const first = n => (n || "Someone").split(" ")[0];
const fmt$ = c => (c < 0 ? "−" : "") + "$" + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Dot, the mascot (blip.js). Small helpers so call sites stay short; both degrade to nothing/emoji if blip.js failed to load.
const dot = (mood, size = 72) => window.Blip ? window.Blip.svg({ mood, size }) : "";
const dotHat = (size = 52) => window.Blip ? window.Blip.hat(size) : "🎂";
// Coral, Dot's best friend and the fun one: she shows up for the good moments (everyone paid, a birthday, a milestone).
const coral = (mood = "happy", size = 72) => window.Blip ? window.Blip.svg({ mood, size, coral: true }) : "";
const mascot = (mood, size) => /^coral:/.test(mood || "") ? coral(mood.slice(6), size) : dot(mood, size);
// A celebration: Coral bursts in with confetti and a line, then gets out of the way (tap, or 4.5 seconds).
function coralCheer(title, sub, onTap) {
  const old = el("cheer"); if (old) old.remove();
  const c = document.createElement("div"); c.id = "cheer"; c.className = "cheer";
  c.innerHTML = `<div class="cheer-card" role="status">${coral("party", 112)}<b>${esc(title)}</b>${sub ? `<p>${esc(sub)}</p>` : ""}</div>`;
  document.body.appendChild(c); requestAnimationFrame(() => c.classList.add("in"));
  const gone = () => { c.classList.remove("in"); setTimeout(() => c.remove(), 350); };
  c.onclick = () => { gone(); if (onTap) onTap(); }; setTimeout(gone, 4500);
}
// Toasts carry Dot with a mood: pass one explicitly, or errors are detected from the wording.
function toast(msg, action, onAction, mood) {
  const t = el("toast"); t.textContent = "";
  const m = mood || (/couldn|can['’]t|fail|error|invalid|unable|permission|denied|network|offline|too many|try again|not allowed|wrong/i.test(msg) ? "oops" : "idle");
  if (window.Blip) { const w = document.createElement("span"); w.className = "toast-dot"; w.innerHTML = mascot(m, 30); t.appendChild(w); }
  t.appendChild(document.createTextNode(msg));
  if (action) { const b = document.createElement("button"); b.type = "button"; b.className = "toast-act"; b.textContent = action; b.onclick = () => { t.classList.remove("show"); onAction(); }; t.appendChild(b); }
  t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), action ? 7000 : 3400);
}
// Tap the yellow dot in the logo: Dot drops out of it with a one-line tip, then climbs back in.
const LOGO_TIPS = {
  home: [
    "Tap a group chip up top to see just that crew's plans.",
    "Tap Calendar to see the month; tap a day to see what's on it.",
    "The Today card shows up on the morning of anything you're going to.",
    "Past events keep their photos and their wall. Scroll down to revisit them.",
    "Search finds events, places, notes, groups, and expenses in one box.",
    "The bell shows what's new: RSVPs, comments, invites, and reminders.",
    "Tap me at the bottom corner to start an event, a meeting, or an expense.",
    "Meetings are the plain tiles: title, time, place, calendar invite. No theme needed.",
    "Copy an old event to plan the next one: open it and tap Duplicate.",
    "Add a friend's birthday and I'll bring it up a month out, with a Plan it button.",
    "Turn on notifications in your profile and I'll buzz you when plans change.",
    "Friends who join through your link land in your Activity feed."
  ],
  event: [
    "Tap a guest's name to see their Venmo, so settling up is one tap.",
    "Add a bring list and I'll tell you when everything's covered.",
    "Hosts can nudge everyone who hasn't answered, in one tap.",
    "Share the link: anyone who joins shows up in your Activity feed.",
    "Bringing someone? Set your plus-ones and add their names so the host knows.",
    "Add a poll with dates and the winning date can become the plan in one tap.",
    "Offer a ride under Carpool and people can grab a seat.",
    "On the day, tap On my way or Running late so the host isn't guessing.",
    "Drop photos on the wall during the party; they stay with the event forever.",
    "Add songs to the playlist and the host gets one list to play.",
    "Hype the event to show the host you're excited before you can commit.",
    "Cap the guest list and I'll run a waitlist for you.",
    "Ask RSVP questions, like dietary needs, and read the answers in one place.",
    "Tap Add to calendar once and I'll keep the calendar entry updated.",
    "Hosts can paint a new cover any time: Edit, then Paint a cover."
  ],
  groups: [
    "Plan from inside a group and everyone's invited automatically.",
    "Group members see each other's birthdays a month out.",
    "The Crew tab shows what the group has spent together and who owes whom.",
    "Group chat is for the ongoing thread; event walls are for the night itself.",
    "Add people by phone number; they get a text with the link to join.",
    "Anyone in the group can add a poll to help decide the next plan.",
    "Give a group an emoji and a color so its events are easy to spot on the home screen.",
    "Filter the home screen by group with the chips under Upcoming.",
    "Hosts can remove someone from a group; they lose access to its events too.",
    "Leaving a group keeps the events you already RSVP'd to.",
    "Add your own birthday in your profile so your groups can celebrate you."
  ],
  money: [
    "Fewest payments combines debts so fewer people have to pay.",
    "Snap a receipt and I'll read the total for you.",
    "Split an expense unevenly by picking who was in on it.",
    "Mark as paid logs a payback and updates the balances; you can undo it right after.",
    "Tap Pay and Venmo opens with the amount and the person already filled in.",
    "Add your Venmo in your profile so friends can pay you in one tap.",
    "Expenses can live on an event or on a group, whichever fits.",
    "The You owe and Owed to you tiles net everything out across all your friends.",
    "Photos of receipts stay attached to the expense for later.",
    "Settling in cash? Mark it paid here so the balance clears for both of you.",
    "When everything's squared up, I'll say so."
  ]
};
let logoTipTimer = null;
let dotTapped = false, dotHopped = false, dotCurrent = null, dotLastId = null, dotIntroPending = false;
// custom: a plain line to say. sug: a suggestion {id, kind, text, label, run} (see dotSuggestions). Neither: the next rotating tip,
// unless a suggestion is waiting, which always comes first.
function showLogoTip(custom, sug) {
  if (!window.Blip || document.getElementById("logoTip")) return;
  const dotEl = el("brandDot"); if (!dotEl) return;
  dotTapped = true;
  if (!custom && !sug && dotCurrent) sug = dotCurrent;
  const key = ["event", "groups", "money"].includes(S.route.name) ? S.route.name : "home";
  let tip = custom || (sug && sug.text);
  if (!tip) { const list = LOGO_TIPS[key]; let i = 0; try { i = (parseInt(LS.get("friendlyTip:" + key) || "0", 10) || 0); LS.set("friendlyTip:" + key, String(i + 1)); } catch {} tip = list[i % list.length]; }
  const r = dotEl.getBoundingClientRect();
  const wrap = document.createElement("div"); wrap.id = "logoTip";
  wrap.style.left = r.left + "px"; wrap.style.top = r.top + "px";
  wrap.innerHTML = `<div class="logo-tip-dot">${dot(sug ? "thinking" : "happy", 56)}</div><div class="logo-tip-bubble">${esc(tip)}${sug ? `<div class="tip-actions"><button type="button" class="btn primary small" id="tipDo">${esc(sug.label)}</button><button type="button" class="btn small" id="tipSkip">Not now</button></div>` : ""}</div>`;
  document.body.appendChild(wrap);
  document.body.classList.add("dot-out");
  requestAnimationFrame(() => wrap.classList.add("out"));
  let acted = false, dismissed = false;
  const hide = e => {
    if (e && wrap.contains(e.target)) return;                       // taps inside the bubble are for its buttons
    if (e) dismissed = true;                                        // a tap away is a dismissal; a timeout is not
    clearTimeout(logoTipTimer); document.removeEventListener("click", hide, true);
    wrap.classList.remove("out"); wrap.classList.add("back");
    setTimeout(() => { wrap.remove(); document.body.classList.remove("dot-out"); }, 420);
    if (sug) { dotMarkSeen(sug, dismissed && !acted); dotCurrent = null; const d = el("brandDot"); if (d) d.classList.remove("has-tip"); }
  };
  if (sug) {
    el("tipDo").onclick = ev => { ev.stopPropagation(); acted = true; hide(); try { sug.run(); } catch (e2) { toast(e2.message); } };
    el("tipSkip").onclick = ev => { ev.stopPropagation(); dismissed = true; hide(); };
  }
  logoTipTimer = setTimeout(() => hide(), sug ? 14000 : 8500);
  setTimeout(() => document.addEventListener("click", hide, true), 250);
}

// ---- Dot's suggestions: moments the app can already see, offered through the logo dot.
// Loud kinds may speak unprompted (at most one a day); quiet kinds only put a ring on the dot and wait for a tap.
// Every suggestion shows once per subject; a kind dismissed twice is dropped for that device.
const DOT_KINDS = { invite: "loud", address: "loud", nudge: "loud", venmo: "loud", request: "quiet", bring: "quiet", calendar: "quiet", birthday: "quiet", cover: "quiet" };
function dotStore(k) { try { return JSON.parse(LS.get(k) || "{}"); } catch { return {}; } }
function dotSave(k, v) { try { LS.set(k, JSON.stringify(v)); } catch {} }
function dotMarkSeen(sug, dismissed) {
  const seen = dotStore("friendlyDotSeen"); seen[sug.id] = Date.now(); dotSave("friendlyDotSeen", seen);
  if (dismissed) { const m = dotStore("friendlyDotMute"); m[sug.kind] = (m[sug.kind] || 0) + 1; dotSave("friendlyDotMute", m); }
}
function dotSuggestions() {
  if (!S.profile || !S.ready) return [];
  const me = myUid(), now = Date.now(), today = todayStr(), out = [];
  const seen = dotStore("friendlyDotSeen"), mute = dotStore("friendlyDotMute");
  const push = (kind, subj, text, label, run) => { const id = kind + ":" + subj; if (seen[id] || (mute[kind] || 0) >= 2) return; out.push({ id, kind, tier: DOT_KINDS[kind], text, label, run }); };
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const daysTo = e => Math.round((evDate(e) - midnight) / 864e5);
  const pendingOf = e => (e.invitedUids || []).filter(u => u !== me && !(e.rsvps || {})[u]);
  const route = S.route;
  try {
    for (const e of S.events.values()) {
      if (!e.date || e.date < today) continue;
      const mine = canManage(e), n = (e.invitedUids || []).length, age = now - (e.createdAt || 0);
      if (e.hostId === me && n <= 1 && !(e.invitedPhones || []).length && age > 60e3 && age < 3 * 864e5)
        push("invite", e.id, `Nobody's on “${e.title}” yet. Want a hand inviting people?`, "Add people", () => { go("#/e/" + e.id); setTimeout(() => { const x = S.events.get(e.id); if (x) openEventInviteDialog(x); }, 500); });
      if (mine && e.date === today && !e.location && e.kind !== "meeting")
        push("address", e.id, `“${e.title}” is today and has no address. Add one so people can tap for directions.`, "Add location", () => editEvent(e));
      if (e.hostId === me && daysTo(e) <= 3 && pendingOf(e).length >= 2)
        push("nudge", e.id, `${pendingOf(e).length} people haven't answered for “${e.title}”. Want me to nudge them?`, "Nudge them", () => nudge(e));
      if (route.name === "event" && route.id === e.id && mine && e.kind !== "meeting") {
        if (n >= 6 && !typed("bring").length) push("bring", e.id, "Big group. A bring list keeps it from being all chips.", "Start a list", () => { const b = el("addBring"); if (b) b.click(); });
        if (!e.cover) push("cover", e.id, "Want me to paint a cover for this one?", "Paint it", () => editEvent(e));
      }
    }
    if ([...S.expenses.values()].some(x => x.paidBy === me) && !(S.profile.venmo || S.profile.zelle || S.profile.cashapp || "").trim())
      push("venmo", "me", "Add a way to get paid back (Venmo, Zelle, or Cash App) so friends can settle in one tap.", "Add it", () => go("#/profile"));
    if (S.expenses.size) for (const p of pairwise()) { if (p.to === me && payInfoOf(p.from).venmo && p.amount >= 500) { push("request", p.from, `${first(nameOf(p.from))} owes you ${fmt$(p.amount)}. One tap to request it.`, "Request", () => payVenmo(p.from, p.amount, "charge")); break; } }
    const hosted = [...S.events.values()].filter(e => e.hostId === me);
    if (hosted.length >= 2 && !S.profile.calToken)
      push("calendar", "me", "Connect your calendar and every plan lands on it automatically.", "Connect", () => openCalendarDialog(hosted.find(e => e.date >= today) || hosted[0]));
    if (S.groups.size && !S.profile.birthday)
      push("birthday", "me", "Add your birthday and your friends get a nudge a month out.", "Add it", () => go("#/profile"));
  } catch (e) { /* a suggestion is never worth an error */ }
  const rank = { loud: 0, quiet: 1 };
  return out.sort((a, b) => rank[a.tier] - rank[b.tier]);
}
// Runs after every shell render: ring the dot if something is waiting, hop when it is new, speak up for loud ones (once a day).
function dotWatch() {
  const d = el("brandDot"); if (!d || !window.Blip) return;
  const sug = dotSuggestions()[0] || null; dotCurrent = sug;
  d.classList.toggle("has-tip", !!sug);
  if (!sug) return;
  if (sug.id !== dotLastId) { dotLastId = sug.id; d.classList.add("hop"); setTimeout(() => d.classList.remove("hop"), 1400); }
  let loudDay = ""; try { loudDay = LS.get("friendlyDotLoudDay") || ""; } catch {}
  if (sug.tier === "loud" && loudDay !== todayStr() && !document.getElementById("logoTip") && !dotIntroPending) {
    try { LS.set("friendlyDotLoudDay", todayStr()); } catch {}
    setTimeout(() => { if (dotCurrent && dotCurrent.id === sug.id) showLogoTip(null, sug); }, 1500);
  }
}
// ---- First-run tour: Dot walks a new person through the app, one spotlight at a time.
// Shown once to accounts under two weeks old on their first home view; "Take the tour" on the profile replays it.
const TOUR = [
  { target: null, title: "Hi, I'm Dot!", text: "I'm the little helper in Friendly. Want a 30-second tour?", ok: "Show me", skip: "Maybe later" },
  { target: ".hd-greet", title: "Home base", text: "Your next plan, what needs you, who owes who, and my picks for the week, all in one place.", tab: "#/" },
  { target: '[data-go="#/new"]', title: "Make a plan", text: "Tap here to plan something. Pick a date, invite people, and the invites go out for you.", tab: "#/plans" },
  { target: "#edgeDot", title: "I'm always right here", text: "Tap me on any page and just tell me the plan, like “tacos Friday at 7 with the crew.” I'll fill it all in.", tab: "#/" },
  { target: ".topbar-right", title: "Up top", text: "Search, everyone's photos, your friends and messages, and your alerts.", tab: "#/" },
  { target: '.tabs [data-go="#/curate"]', title: "Need an idea?", text: "Curate finds real things to do near you, paired with a place to eat.", tab: "#/" },
  { target: '.tabs [data-go="#/groups"]', title: "Your crews", text: "Groups keep your regulars together, with chat, polls, and photos.", tab: "#/" },
  { target: '.tabs [data-go="#/money"]', title: "Settle up", text: "Split a bill here. I'll keep track of who owes who, and you can pay by Venmo, Zelle, Cash App, or Apple Cash.", tab: "#/" },
  { target: null, coral: true, title: "Meet Coral", text: "My best friend, and the fun one. She shows up when there's something to celebrate: everyone paid, a birthday, a milestone.", ok: "Hi, Coral!", tab: "#/" },
  { target: "#brandDot", title: "One more thing", text: "Tap my little dot up here anytime for a tip.", ok: "Let's go", tab: "#/" }
];
let tourStep = -1;
function tourDone() { try { if (LS.get("friendlyTourDone")) return true; } catch {} return !!(S.profile && S.profile.tourDone); }
function wantsTour() { const c = (S.profile && S.profile.createdAt) || 0; return !tourDone() && c && Date.now() - c < 14 * 864e5; }
function endTour() {
  tourStep = -1; const o = el("tourLayer"); if (o) o.remove(); window.removeEventListener("resize", placeTour); document.querySelectorAll(".tour-peek").forEach(n => n.classList.remove("tour-peek"));
  try { LS.set("friendlyTourDone", "1"); LS.set("friendlyDotHello", "1"); } catch {}
  if (S.profile && !S.profile.tourDone) updateDoc(doc(db, "users", myUid()), { tourDone: true }).catch(() => {});
}
function startTour() { if (!window.Blip) return; if (location.hash !== "#/" && location.hash !== "") go("#/"); tourStep = 0; setTimeout(showTourStep, 350); }
function showTourStep() {
  const st = TOUR[tourStep]; if (!st) return endTour();
  let o = el("tourLayer");
  if (!o) { o = document.createElement("div"); o.id = "tourLayer"; o.innerHTML = `<div class="tour-hole" id="tourHole"></div><div class="tour-card" id="tourCard" role="dialog" aria-live="polite"></div>`; document.body.appendChild(o); window.addEventListener("resize", placeTour); }
  const last = tourStep === TOUR.length - 1, first = tourStep === 0;
  el("tourCard").innerHTML = `<div class="tour-top">${window.Blip.svg({ mood: first || last || st.coral ? "happy" : "idle", size: 56, wave: first || last || st.coral, coral: !!st.coral })}<div><b>${esc(st.title)}</b><p>${esc(st.text)}</p></div></div>
    <div class="tour-foot"><span class="tour-dots">${TOUR.slice(1).map((_, i) => `<i class="${i + 1 === tourStep ? "on" : ""}"></i>`).join("")}</span>
    <span class="btnrow" style="gap:6px">${last ? "" : `<button type="button" class="btn ghost small" id="tourSkip">${st.skip || "Skip"}</button>`}<button type="button" class="btn primary small" id="tourNext">${st.ok || "Next"}</button></span></div>`;
  el("tourNext").onclick = () => { tourStep++; if (tourStep >= TOUR.length) endTour(); else showTourStep(); };
  if (el("tourSkip")) el("tourSkip").onclick = endTour;
  placeTour();
}
function placeTour() {
  const st = TOUR[tourStep], hole = el("tourHole"), card = el("tourCard"); if (!st || !hole || !card) return;
  const t = st.target && document.querySelector(st.target);
  card.classList.remove("in"); void card.offsetWidth; card.classList.add("in");
  if (!t) { hole.className = "tour-hole none"; card.style.cssText = "left:50%;top:50%;transform:translate(-50%,-50%)"; return; }
  if (st.target === "#edgeDot" && !t.classList.contains("tour-peek")) { t.classList.add("tour-peek"); setTimeout(placeTour, 420); }   // measure once Dot has slid out
  document.querySelectorAll(".tour-peek").forEach(n => { if (n !== t) n.classList.remove("tour-peek"); });
  const r = t.getBoundingClientRect(), pad = 8, vw = innerWidth, vh = innerHeight;
  hole.className = "tour-hole";
  Object.assign(hole.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px" });
  const cw = Math.min(340, vw - 32), below = r.bottom + pad + 14, fitsBelow = below + 190 < vh;
  const left = Math.max(16, Math.min(vw - cw - 16, r.left + r.width / 2 - cw / 2));
  card.style.cssText = `left:${left}px;width:${cw}px;` + (fitsBelow ? `top:${below}px` : `bottom:${vh - r.top + pad + 14}px`);
}
// So people learn the dot is Dot: one hello per device the first time home renders, and a
// small silent hop once per session if the dot hasn't been tapped yet. Never an unprompted tip after that.
function dotIntro() {
  if (!window.Blip || !el("brandDot")) return;
  if (tourStep >= 0) return;
  if (wantsTour()) { dotHopped = true; tourStep = 0; setTimeout(() => { if (S.route.name === "home" && tourStep === 0) showTourStep(); }, 900); return; }
  let seen = false; try { seen = !!LS.get("friendlyDotHello"); } catch {}
  if (!seen) {
    try { LS.set("friendlyDotHello", "1"); } catch {}
    dotIntroPending = true;
    setTimeout(() => { if (S.route.name === "home" && el("brandDot")) showLogoTip("Hi, I'm Dot. Tap me down in the corner and I'll plan things for you. Tap me up here for a tip."); setTimeout(() => { dotIntroPending = false; dotWatch(); }, 8000); }, 1600);
    dotHopped = true; return;
  }
  if (!dotHopped) { dotHopped = true; setTimeout(dotWave, 1400); }
}
// Dot grows out of the logo dot, smiles and waves, then goes back in. Once a session.
function dotWave() {
  const dotEl = el("brandDot"); if (!dotEl || !window.Blip || document.getElementById("logoTip") || document.getElementById("logoWave")) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = dotEl.getBoundingClientRect();
  const w = document.createElement("div"); w.id = "logoWave"; w.style.left = r.left + "px"; w.style.top = r.top + "px";
  w.innerHTML = window.Blip.svg({ mood: "happy", size: 64, wave: true });
  document.body.appendChild(w); document.body.classList.add("dot-out");
  requestAnimationFrame(() => w.classList.add("out"));
  setTimeout(() => { w.classList.remove("out"); w.classList.add("back"); setTimeout(() => { w.remove(); document.body.classList.remove("dot-out"); }, 450); }, 2300);
}
document.addEventListener("click", () => { const x = el("edgeDot"); if (x && x.classList.contains("in")) { x.classList.remove("in"); x.querySelector(".edge-art").innerHTML = dot("idle", 66); } });
window.addEventListener("offline", () => toast("You're offline. Changes will send when you're back.", null, null, "oops"));
window.addEventListener("online", () => toast("Back online.", null, null, "happy"));
function todayStr() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function evDate(ev) { const [y, m, d] = (ev.date || "2000-01-01").split("-").map(Number); return new Date(y, m - 1, d); }
function fmtTime(t) { if (!t) return ""; const [h, mi] = t.split(":").map(Number); const d = new Date(); d.setHours(h, mi); return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function fmtWhen(ev) {
  const d = evDate(ev);
  if (ev.endDate && ev.endDate > ev.date) return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} to ${evDate({ date: ev.endDate }).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
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
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => rej(new Error("this photo couldn't be opened")); i.src = src; }); }
// A picked photo opens straight from the file (object URL). Reading it as one base64 string first made a
// 24–48 MP iPhone photo into 30 MB+ of text, which the iPhone app's web view could choke on.
async function loadPicked(file) {
  if (typeof file === "string") return loadImg(file);
  const url = URL.createObjectURL(file);
  try { const img = await loadImg(url); if (img.decode) await img.decode().catch(() => {}); return img; }
  catch (e) { try { return await loadImg(await blobToURL(file)); } catch { throw e; } }   // last resort: the old way
  finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}
function blobToURL(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); }); }
// Crop dialog: drag to pan, slider to zoom, "cover" fit so there's never empty
// space around the frame. Defaults to a square/circular profile-photo crop;
// pass opts for a rectangular crop (e.g. a 16:9 event cover). Resolves to a
// data URL, or null if the person cancels.
function openCropDialog(file, opts = {}) {
  const { shape = "circle", ratio = 1, outW = 600, outH = 600, title = "Crop your photo", quality = 0.92 } = opts;
  return new Promise(async resolve => {
    let img; try { img = await loadPicked(file); } catch (e) { toast("Couldn't read that image: " + e.message); return resolve(null); }
    const W = 280, H = Math.round(280 / ratio);
    dialog(`<h3>${esc(title)}</h3>
      <p class="muted" style="margin-top:-6px">Drag to reposition, use the slider to zoom.</p>
      <div class="crop-wrap ${shape === "rect" ? "rect" : ""}" style="width:${W}px;height:${H}px"><canvas id="cropCanvas" width="${W}" height="${H}"></canvas></div>
      <input type="range" id="cropZoom" min="100" max="320" value="100" style="width:100%;margin-top:10px">`,
      "Use photo", () => { const out = finish(); closeDialog(); resolve(out); });
    let cancelled = true;
    const cancelBtn = el("dlgCancel"); if (cancelBtn) cancelBtn.addEventListener("click", () => { if (cancelled) resolve(null); }, { once: true });
    const canvas = el("cropCanvas"); const ctx = canvas.getContext("2d");
    const cover = Math.max(W / img.width, H / img.height);
    let scale = cover; const minScale = cover;
    let ox = (W - img.width * scale) / 2, oy = (H - img.height * scale) / 2;
    const clamp = () => { const w = img.width * scale, h = img.height * scale; ox = Math.min(0, Math.max(W - w, ox)); oy = Math.min(0, Math.max(H - h, oy)); };
    const draw = () => { ctx.clearRect(0, 0, W, H); ctx.drawImage(img, ox, oy, img.width * scale, img.height * scale); };
    clamp(); draw();
    let dragging = false, lastX = 0, lastY = 0;
    canvas.style.touchAction = "none";
    canvas.onpointerdown = e => { dragging = true; lastX = e.offsetX; lastY = e.offsetY; canvas.setPointerCapture(e.pointerId); };
    canvas.onpointermove = e => { if (!dragging) return; ox += e.offsetX - lastX; oy += e.offsetY - lastY; lastX = e.offsetX; lastY = e.offsetY; clamp(); draw(); };
    canvas.onpointerup = () => { dragging = false; }; canvas.onpointerleave = () => { dragging = false; };
    el("cropZoom").oninput = e => {
      const cx = W / 2, cy = H / 2, imgX = (cx - ox) / scale, imgY = (cy - oy) / scale;
      scale = minScale * (e.target.value / 100);
      ox = cx - imgX * scale; oy = cy - imgY * scale; clamp(); draw();
    };
    function finish() {
      cancelled = false;
      const out = document.createElement("canvas"); out.width = outW; out.height = outH;
      const k = outW / W;
      out.getContext("2d").drawImage(img, ox * k, oy * k, img.width * scale * k, img.height * scale * k);
      return out.toDataURL("image/jpeg", quality);
    }
  });
}
// The small copy of my photo that goes into groups and friendships (everyone downloads those on every
// sign-in, so they carry a 160px version; the 320px original stays on my own profile).
const myPhotoSm = () => (S.profile && (S.profile.photoSm || S.profile.photo)) || "";
async function compressImage(src, maxDim = 1400, quality = 0.8, maxBytes = 720000) {
  const img = await loadPicked(src);
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
// Looks for AI covers. "Surprise me" picks one at random each time, so covers don't all come out alike.
const COVER_STYLES = [
  ["surprise", "🎲 Surprise me", ""],
  ["photo", "📷 Photo", "realistic candid photograph, natural light, shallow depth of field, true-to-life colors"],
  ["illustration", "🖍️ Illustration", "detailed editorial illustration, considered color palette, textured brushwork"],
  ["watercolor", "🎨 Watercolor", "loose watercolor painting on textured paper, soft washes, gentle palette"],
  ["retro", "📺 Retro poster", "vintage 1970s screen-printed poster art, limited color palette, paper grain"],
  ["minimal", "◻️ Minimal", "minimalist graphic composition, lots of negative space, two or three colors"],
  ["film", "🎞️ Film", "35mm film photograph, visible grain, slightly faded colors, nostalgic mood"]
];
const coverStylePrompt = k => { const pool = COVER_STYLES.filter(s => s[2]); const s = COVER_STYLES.find(x => x[0] === k && x[2]) || pool[Math.floor(Math.random() * pool.length)]; return s[2]; };
async function generateCover(prompt, opts = {}) {
  // Primary: a Gemini image model on Vertex, driven through a Firestore trigger.
  // We write a request doc; the Cloud Function generates the image and writes
  // it back. Keeps the function off the public internet and needs no key in
  // the app. Falls back to a free generator if it doesn't land -- and the
  // public demo account always uses that free path, so unlimited demo
  // traffic never bills the paid one.
  if (!isDemo()) {
    // The server's message is written for people (why Google said no, or that it's busy), so it goes straight to them.
    const image = await imagenViaFirestore(prompt, opts.aspect);
    return compressImage(image, 1024, 0.8);
  }
  const seed = Math.floor(Math.random() * 1e6);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + ". High quality, no text, no words, no numbers, no dates")}?width=1024&height=640&nologo=true&model=flux&seed=${seed}`;
  const res = await fetch(url); if (!res.ok) throw new Error("Generator busy, try again");
  return compressImage(await blobToURL(await res.blob()), 1024, 0.74);
}
// Write coverRequests/{id}, wait for the function to fill in image/status.
function imagenViaFirestore(prompt, aspect) {
  return new Promise(async (resolve, reject) => {
    const uid = S.user && S.user.uid; if (!uid) return reject(new Error("signed out"));
    const id = newId(), ref = doc(db, "coverRequests", id);
    let unsub = null, timer = null;
    const done = (fn, arg) => { if (timer) clearTimeout(timer); if (unsub) unsub(); deleteDoc(ref).catch(() => {}); fn(arg); };
    try {
      await setDoc(ref, { uid, prompt: String(prompt).slice(0, 700), ...(aspect ? { aspect } : {}), status: "pending", createdAt: Date.now() });
    } catch (e) { return reject(e); }
    timer = setTimeout(() => done(reject, new Error("Dot took too long on that one. Try again?")), 170000);
    unsub = onSnapshot(ref, s => {
      const d = s.data(); if (!d) return;
      if (d.status === "done" && d.image) done(resolve, d.image);
      else if (d.status === "error") done(reject, new Error(d.error || "generation failed"));
    }, err => done(reject, err));
  });
}
// `what` names the flow (receipt, wall photo, ...) for the freeze trace, and a marker stays in storage while the
// camera or photo picker is open: iOS can kill the page behind the camera, and the reload then picks the flow back up.
const pickerMark = (what, stage) => { try { if (what) LS.set("friendlyPicker", JSON.stringify({ what, stage, route: location.hash, t: Date.now() })); else LS.remove("friendlyPicker"); } catch {} };
// The input lives in the page (hidden) while the picker is up: a detached one can be garbage-collected on iOS
// while the person is still choosing, and its photo then never arrives.
function pickFile(accept = "image/*", what = "photo") { return new Promise(res => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(i); window.__picker = i;
  const finish = f => { if (window.__picker === i) window.__picker = null; setTimeout(() => i.remove(), 1000); res(f); };
  pickerMark(what, "picker open"); fz.add(`photo picker opened (${what})`); fz.save();
  i.onchange = () => { const f = i.files[0] || null; fz.add(f ? `photo picked (${what}, ${Math.round(f.size / 1024)} KB)` : `photo picker closed (${what})`); fz.save(); if (f) { pickerMark(what, "processing"); setTimeout(() => pickerMark(null), 30000); } else pickerMark(null); finish(f); };
  i.oncancel = () => { fz.add(`photo picker cancelled (${what})`); fz.save(); pickerMark(null); finish(null); };
  i.click(); }); }
// Comments/polls live under events by default; groups and expenses reuse the
// same components by passing a pseudo-event with `_col: ["groups", id]` etc.
function subCol(ev, name) { return collection(db, ...(ev._col || ["events", ev.id]), name); }
// Compose a text in the phone's Messages app (iOS wants "&" before body).
// Phone numbers as +15551234567 so the same person matches whether typed with dashes or spaces.
const toE164 = p => { const d = String(p || "").trim(); if (!d) return ""; const n = d.replace(/\D/g, ""); if (d.startsWith("+")) return "+" + n; if (n.length === 10) return "+1" + n; if (n.length === 11 && n[0] === "1") return "+" + n; return n ? "+" + n : ""; };
// Firebase's email/password provider is the only one that supports a password
// at all, so a phone number becomes its sign-in "email" by pattern -- never
// shown to anyone, never used to send mail. The real, human email (for
// calendar invites) lives in the profile's separate `email` field instead.
// One-way key for a phone number, stored on events as phoneKeys.<uid> so a host's
// "Add people" can tell a typed number is already a guest without the event
// exposing anyone's actual number to the other guests.
async function phoneKey(e164) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("friendly:" + e164)); return [...new Uint8Array(b)].slice(0, 12).map(x => x.toString(16).padStart(2, "0")).join(""); }
const phoneAuthEmail = e164 => e164.replace(/[^0-9]/g, "") + "@phone.officialfriendly.com";
// The phone this account signs in with. Prefer the profile's phoneE164; fall back to
// the digits baked into a phone-style sign-in identifier, so a profile whose phone
// field was left blank or cleared never loses its number for invites and joins.
function myPhoneE164() {
  if (S.profile && S.profile.phoneE164) return S.profile.phoneE164;
  const m = /^(\d{7,15})@phone\.officialfriendly\.com$/.exec((S.user && S.user.email) || "");
  return m ? "+" + m[1] : "";
}
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
  const list = upcomingBirthdays(30); let dismissed = []; try { dismissed = JSON.parse(LS.get("friendlyBdayDismissed") || "[]"); } catch {}
  const b = list.find(x => !dismissed.includes(x.uid + ":" + x.date)); if (!b) return "";
  const today = b.days === 0;
  return `<div class="card notif-card ${today ? "bday-today" : ""}"><span class="notif-ico dot-ico">${window.Blip ? window.Blip.hat(52, "party", today) : "🎂"}</span><div class="nc-text" style="flex:1"><b>${today ? `It's ${esc(first(b.name))}'s birthday today! 🎉` : `${esc(first(b.name))}'s birthday is ${b.days === 1 ? "tomorrow" : "in " + b.days + " days"}`}</b><div class="muted sm">${esc(fmtDay({ date: b.date }))}. A month out is the sweet spot to plan something.</div></div><span class="btnrow nc-btns" style="gap:6px"><button class="btn primary small" data-bplan="${b.uid}">Plan something</button><button class="btn ghost small" data-bdismiss="${b.uid}:${b.date}">Later</button></span></div>`;
}
// +12145551234 -> (214) 555-1234 for US numbers; anything else is shown as stored.
const fmtPhone = p => { const m = String(p || "").match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(p || ""); };
const FRIEND_TEXT = "Hey! I'm on Friendly, our crew's home base for plans and settling up. Add me there so we can message: https://officialfriendly.com (free). Sign up with this number and my friend request will be waiting.";
// My texted friend invites still waiting on someone to join, newest first, one per number.
function invitedByText() { const seen = new Set(); return (S.textInvites || []).filter(r => r.status === "notOnFriendly").sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).filter(r => !seen.has(r.phone) && seen.add(r.phone)); }
function smsLink(numbers, body) { const sep = /iPhone|iPad|Mac/.test(navigator.userAgent) ? "&" : "?"; return "sms:" + numbers.map(n => n.replace(/[^+\d]/g, "")).join(",") + sep + "body=" + encodeURIComponent(body); }
// Address autocomplete via Google Places (New). Active only once `mapsKey` is
// set in firebase-config.js; without it the field stays a plain text box.
function attachPlaces(input, opts = {}) {
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
        const hits = await placeSuggestions(q, opts.cities); if (my !== seq) return;
        if (!hits.length) return hide();
        list.innerHTML = hits.map(p => { const f = p.structuredFormat || {}; return `<button type="button" data-place="${esc(opts.cities ? cityLabel(f) : p.text.text)}"><b>${esc((f.mainText || {}).text || p.text.text)}</b><span>${esc((f.secondaryText || {}).text || "")}</span></button>`; }).join("");
        list.hidden = false;
      } catch { hide(); }
    }, 250);
  });
  list.addEventListener("mousedown", e => {
    const b = e.target.closest("[data-place]"); if (!b) return; e.preventDefault();
    input._picked = true; input.value = b.dataset.place; input.dataset.picked = b.dataset.place; input.dispatchEvent(new Event("input", { bubbles: true })); hide();
  });
  input.addEventListener("blur", () => setTimeout(hide, 150));
}

async function placeSuggestions(q, cities) {
  const body = { input: q, includedRegionCodes: ["us"], languageCode: "en" }; if (cities) body.includedPrimaryTypes = ["(cities)"];
  const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": mapsKey }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("places " + r.status);
  const j = await r.json(); return (j.suggestions || []).map(s => s.placePrediction).filter(Boolean).slice(0, 5);
}
// Cities are saved the same way every time ("Frisco, TX"), so every spelling of a place shares one set of nights.
const US_STATES = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR" };
function cityLabel(f) {
  const main = (f.mainText || {}).text || "", parts = ((f.secondaryText || {}).text || "").split(",").map(x => x.trim()).filter(Boolean);
  const region = (parts.length && parts[parts.length - 1] === "USA" ? parts.slice(0, -1) : parts).map(x => US_STATES[x.toLowerCase()] || x).join(", ");
  return (region ? main + ", " + region : main).slice(0, 60);
}
// Whatever was typed becomes a real city: the one picked from the list, otherwise the closest match.
// null = no such city. If the lookup itself fails (offline, no key), keep what they typed rather than block them.
async function resolveCity(input) {
  const typed = String((input && input.value) || "").trim(); if (!typed) return "";
  if (input.dataset.picked === typed || typed === (S.profile.city || "")) return typed;
  if (!mapsKey) return typed;
  try { const hits = await placeSuggestions(typed, true); return hits.length ? cityLabel(hits[0].structuredFormat || {}) : null; } catch { return typed; }
}
// ---------- state ----------
// The intro is a flat 6 seconds, every time.
const BOOT_AT = Date.now(), SPLASH_MIN = 6000, SPLASH_MAX = 6000; let splashTimer = null, splashHold = false;
// Dot's intro plays on every fresh launch (the app was closed), and when the app comes back from the background
// after 10 minutes or more; a quicker switch back goes straight in.
const AWAY_FOR_INTRO = 10 * 60 * 1000;
const markSeen = () => { try { LS.set("friendlyLastSeen", String(Date.now())); } catch {} };
markSeen(); setInterval(() => { if (!document.hidden) markSeen(); }, 30000);
window.addEventListener("pagehide", markSeen);
const S = {
  user: null, profile: null, ready: false,
  groups: new Map(), pendingInvites: new Map(), events: new Map(),
  expenses: new Map(), settlements: new Map(),
  contacts: new Map(),           // uid -> {name, venmo, phone}
  route: parseRoute(),
  subs: [], eventSubKey: "", commentUnsub: null, comments: [],
  evSubs: [], photos: [], polls: [], songs: [],
  friends: new Map(), dms: new Map()   // friendships/{a_b} and dms/{a_b} that include me
};

// A link can point inside a screen: #/e/<id>?to=<section id>&c=<message id> (see focusRoute).
function parseRoute() {
  const [path, qs] = (location.hash || "#/").replace(/^#/, "").split("?");
  const r = routeFromPath(path);
  r.q = {}; try { new URLSearchParams(qs || "").forEach((v, k) => { r.q[k] = v; }); } catch {}
  if (r.name === "messages" && r.q.to === "reqCard") r.tab = "friends";   // friend requests live on the Friends tab (older notifications point at Messages)
  return r;
}
function routeFromPath(h) {
  const p = h.split("/").filter(Boolean);
  if (!p.length) return { name: "home" };
  if (p[0] === "plans") return { name: "plans" };
  if (p[0] === "e") return { name: "event", id: p[1] };
  if (p[0] === "g") return { name: "group", id: p[1] };
  if (p[0] === "join") return { name: "join", id: p[1] };
  if (p[0] === "x") return { name: "expense", id: p[1] };
  if (p[0] === "pick") return { name: "pick", id: p[1] };
  if (p[0] === "activity") return { name: "activity" };
  if (p[0] === "messages" || p[0] === "friends" || p[0] === "invited") return { name: "messages", tab: p[0] };
  if (p[0] === "drafts") return { name: "drafts" };
  if (p[0] === "m") return { name: "dm", id: p[1] };
  if (p[0] === "fs") return { name: "friendship", id: p[1] };
  if (p[0] === "photos") return { name: "photos" };
  if (p[0] === "year") return { name: "year", y: p[1] };
  if (p[0] === "search") return { name: "search" };
  if (p[0] === "new") return { name: "new" };
  if (p[0] === "money") return { name: "money" };
  if (p[0] === "curate") return { name: "curate" };
  if (p[0] === "groups") return { name: "groups" };
  if (p[0] === "profile") return { name: "profile" };
  return { name: "home" };
}
// New screen, start at the top (the SPA otherwise keeps the old scroll position,
// so an event page could open at the party wall instead of the cover).
window.addEventListener("hashchange", () => { S.route = parseRoute(); window.scrollTo(0, 0); render(); focusRoute(); });
// The "#/..." part of any url (activity items and pushes carry "/#/e/<id>"), with or without a query.
const routeTail = url => { const s = String(url || ""); const i = s.indexOf("#"); return i < 0 ? "#/" : s.slice(i); };
const tailOf = url => routeTail(url).split("?")[0];
// Notifications and Activity rows open the exact spot: scroll to the message (?c=) or the
// section (?to=) and flash it. Waits for sign-in and for the data to arrive, since a
// tapped notification can cold-start the app.
let focusKey = "";
function focusRoute() {
  const q = S.route.q || {}; if (!q.to && !q.c && !q.photo && !q.who && !q.pair && !q.night && !q.pay) return;
  const key = location.hash; if (focusKey === key) return; focusKey = key;
  let tries = 0;
  const tick = () => {
    if (location.hash !== key) return;
    if (!S.user || !S.ready || document.querySelector(".splash")) { if (tries++ < 400) setTimeout(tick, 250); return; }
    tries++;
    if (q.photo) { const ev = S.events.get(S.route.id), p = (S.photos || []).find(x => x.id === q.photo); if (ev && p) { openPhoto(ev, p); if (q.c) flashWhenFound(() => document.querySelector(`#pvComments [data-cmsg="${CSS.escape(q.c)}"]`)); return; } if (tries < 60) setTimeout(tick, 250); return; }
    const msg = q.c && document.querySelector(`[data-cmsg="${CSS.escape(q.c)}"]`);
    const sec = q.to && document.getElementById(q.to);
    // The specific thing behind the alert: a person's row on an expense, a request, a guest's chip, a settle-up row.
    const who = q.who && whoTarget(q.who, sec), pair = q.pair && document.querySelector(`[data-pair="${CSS.escape(q.pair)}"]`);
    const night = q.night && document.querySelector(`[data-nk="${CSS.escape(q.night)}"]`);
    const pay = q.pay && document.querySelector(`[data-srow="${CSS.escape(q.pay)}"]`);
    const specific = msg || who || pair || night || pay;
    const target = specific || ((!q.c && !q.who && !q.pair && !q.night && !q.pay || tries > 16) && sec);   // give the specific thing 4 seconds to load, then settle for its section
    if (!target) { if (tries < 60) setTimeout(tick, 250); return; }
    target.scrollIntoView({ block: "center" });
    target.classList.add("focus-flash"); setTimeout(() => target.classList.remove("focus-flash"), 2400);
  };
  tick();
}
// A person as the page shows them: an expense row, a friend request, a guest chip, else any avatar of theirs in the section.
function whoTarget(uid, sec) {
  const esc1 = CSS.escape(uid);
  const direct = document.querySelector(`[data-xperson="${esc1}"]`); if (direct) return direct;
  const req = document.querySelector(`#reqCard [data-friendaccept*="${esc1}"]`); if (req) return req.closest(".member-row") || req;
  const chip = document.querySelector(`.guest-chip [data-viewprofile="${esc1}"]`); if (chip) return chip.closest(".guest-chip") || chip;
  const pf = (sec || document).querySelector(`[data-pf="${esc1}"]`); if (pf) return pf.closest(".member-row, .guest-chip, .settle-row, .ledger") || pf;
  return null;
}
// Flash something that is still loading (comments inside the photo viewer): look for it a few times, then give up.
function flashWhenFound(find, tries = 20) { const t = find(); if (t) { t.scrollIntoView({ block: "center" }); t.classList.add("focus-flash"); setTimeout(() => t.classList.remove("focus-flash"), 2400); return; } if (tries > 0) setTimeout(() => flashWhenFound(find, tries - 1), 250); }
window.go = path => { location.hash = path; };
// iPhone's text-size setting: the system body size is measured (a hidden span set in -apple-system-body; 17pt is
// the default) and the page's rem scale follows it, so Larger Text makes Friendly's text larger too.
function followTextSize() {
  if (!(NATIVE || IOS)) return;
  try { const sp = document.createElement("span"); sp.style.cssText = "position:absolute;visibility:hidden;font:-apple-system-body"; sp.textContent = "a"; document.body.appendChild(sp);
    const px = parseFloat(getComputedStyle(sp).fontSize) || 17; sp.remove(); const scale = Math.min(1.6, Math.max(.9, px / 17));
    document.documentElement.style.fontSize = Math.abs(scale - 1) < .02 ? "" : (16 * scale).toFixed(2) + "px"; } catch {}
}
followTextSize(); document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") followTextSize(); });
// Rows that act as buttons answer to Enter and Space, like real buttons.
document.addEventListener("keydown", e => { const t = e.target; if ((e.key === "Enter" || e.key === " ") && t && t.matches && t.matches('[role="button"], [data-go]:not(a):not(button)') && !t.matches("input,textarea,select,a,button")) { e.preventDefault(); t.click(); } });
// Tapping the logo goes Home from any page; on Home it scrolls back to the top. Caught at the document so it
// works on every page and every redraw.
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest(".brand-home"); if (!a) return;
  e.preventDefault();
  if ((location.hash || "#/").split("?")[0].replace(/^#\/?$/, "") === "") window.scrollTo({ top: 0, behavior: "smooth" }); else go("#/");
}, true);

// ---------- auth ----------
const openPendingNotif = () => { const url = S._pendingNotif; if (!url) return; S._pendingNotif = null; fz.add("opening the held notification"); setTimeout(() => { location.hash = routeTail(url); focusRoute(); }, 0); };
onAuthStateChanged(auth, async u => {
  dogSay({ uid: (u && u.uid) || "" });
  S._authKnown = true; setTimeout(openPendingNotif, 0);
  if (u) { try { LS.set("friendlyKnown", "1"); } catch {} }
  S.subs.forEach(fn => fn()); S.subs = [];
  S.user = u;
  if (!u) {
    S.profile = null;
    if (!demoAutoTried && new URLSearchParams(location.search).get("demo")) { demoAutoTried = true; demoSignIn(); return; }
    S.ready = true; render(); return;
  }
  const uref = doc(db, "users", u.uid);
  // Ensure a profile doc exists (created at sign-up; guard for older accounts).
  // Start listening right away (the device copy answers first); make sure a profile exists in the background.
  subscribeAll(u);
  getDoc(uref).then(snap => { if (!snap.exists()) return setDoc(uref, { name: u.displayName || first(u.email), email: u.email, venmo: "", phone: "", createdAt: Date.now() }); }).catch(() => {});
  // Open on Events. Only top-level tabs are redirected; a link to an event,
  // group, expense, or invite still goes where it points.
  let pendingJoin = ""; try { pendingJoin = LS.get("friendlyJoin") || ""; LS.remove("friendlyJoin"); } catch {}
  if (pendingJoin) location.hash = "#/join/" + pendingJoin;
  else if (/^(#\/?|#\/(money|groups|activity|photos|search|profile))$/.test(location.hash)) location.hash = "#/";
  if (NATIVE) registerPush(u.uid);
  setTimeout(reportContactsTrace, 4000); setTimeout(reportFreezeTrace, 4500); setTimeout(resumePayAsk, 3000);
});

function subscribeAll(u) {
  const add = fn => S.subs.push(fn);
  // Every core listener gets a named error handler, so a denied query shows
  // in the console as what it is instead of an "uncaught" mystery.
  const on = (name, q, cb) => onSnapshot(q, cb, err => console.warn("listener " + name + ":", err.code || err.message));
  // Groups that invited this phone number. S.profile (and its phoneE164) isn't known
  // until this very listener's first snapshot arrives, so the invitesPhone query has to
  // be (re)started reactively from here rather than read once when subscribeAll runs --
  // reading it once always saw an empty phoneE164 and silently never subscribed, which
  // meant a freshly texted invitee could sign up and never see their group invite.
  S.pendingInvitesPhone = new Map();
  let invitesPhoneUnsub = null, invitesPhoneKey = null, phoneEventsUnsub = null; S.phoneEvents = new Map();
  add(on("profile", doc(db, "users", u.uid), d => {
    S.profile = d.data(); rebuildContacts(); S.ready = true; syncMyOs();
    // Backfill a missing phoneE164 from the sign-in identifier (once), so phone
    // invites and joins match for accounts whose profile phone was left blank.
    if (S.profile && !S.profile.phoneE164 && myPhoneE164() && !S._phoneHealed) { S._phoneHealed = true; updateDoc(doc(db, "users", u.uid), { phoneE164: myPhoneE164() }).catch(() => {}); }
    const pk = (S.profile && S.profile.phoneE164) || "";
    if (pk && pk !== invitesPhoneKey) {
      invitesPhoneKey = pk;
      if (invitesPhoneUnsub) invitesPhoneUnsub();
      invitesPhoneUnsub = on("invitesPhone", query(collection(db, "groups"), where("invitedPhones", "array-contains", pk)), snap => {
        S.pendingInvitesPhone = new Map(snap.docs.map(d2 => ({ id: d2.id, ...d2.data() })).filter(g => !(g.memberUids || []).includes(u.uid)).map(g => [g.id, g])); renderSoon();
      });
      add(invitesPhoneUnsub);
      // Events someone invited this phone number to by text, not joined yet: shown on Events with a "tap to join" veil.
      if (phoneEventsUnsub) phoneEventsUnsub();
      phoneEventsUnsub = on("phoneEvents", query(collection(db, "events"), where("invitedPhones", "array-contains", pk), where("openLink", "==", true)), snap => {
        S.phoneEvents = new Map(snap.docs.map(d2 => ({ id: d2.id, ...d2.data(), _unjoined: true })).filter(e => !(e.invitedUids || []).includes(u.uid)).map(e => [e.id, e])); renderSoon();
      });
      add(phoneEventsUnsub);
    }
    renderSoon();
  }));

  add(on("groups", query(collection(db, "groups"), where("memberUids", "array-contains", u.uid)), snap => {
    S.groups = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    rebuildContacts(); resubscribeEvents(u); renderSoon(); syncMyOs();
  }));

  add(on("invites", query(collection(db, "groups"), where("invitedEmails", "array-contains", (u.email || "").toLowerCase())), snap => {
    // Build plain docs first, then key the Map by id. (An earlier version mapped
    // to [id, doc] pairs before filtering, so every invite lost its fields and
    // Join looked up an undefined key: the "Join does nothing" bug.)
    S.pendingInvites = new Map(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(g => !(g.memberUids || []).includes(u.uid)).map(g => [g.id, g]));
    renderSoon();
  }));

  add(on("expenses", query(collection(db, "expenses"), where("involved", "array-contains", u.uid)), snap => {
    const before = S._expInit ? S.expenses : null;
    S.expenses = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    if (before) for (const x of S.expenses.values()) { const was = before.get(x.id); if (was && x.paidBy === u.uid && !allPaidBack(was) && allPaidBack(x)) coralCheer("Everyone paid you back!", `${x.desc || "That one"} is all settled.`, () => go("#/x/" + x.id)); }
    S._expInit = true;
    S.nameHints = S.nameHints || new Map(); for (const x of S.expenses.values()) for (const [k, n] of Object.entries(x.guestNames || {})) if (n) S.nameHints.set(k, n);
    refreshEvMoney(); renderSoon();
  }));
  // "Up for it?" posts I can see (my friends' and my groups')
  add(on("asks", query(collection(db, "asks"), where("uids", "array-contains", u.uid)), snap => { S.asks = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }])); renderSoon(); }));
  add(on("settlements", query(collection(db, "settlements"), where("involved", "array-contains", u.uid)), snap => {
    const before = S._setInit ? S.settlements : null;
    S.settlements = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }])); S._setInit = true; renderSoon();
    // Money just arrived: Coral says so, with a tap to react.
    if (before) for (const x of S.settlements.values()) if (!before.has(x.id) && x.to === u.uid && x.addedBy !== u.uid && Date.now() - (x.createdAt || 0) < 120e3)
      toast(`${first(nameOf(x.from))} paid you ${fmt$(x.amountCents)}`, "React", () => go("#/money?pay=" + x.id), "coral:party");
  }));

  // saved event drafts (users/{uid}/drafts), newest first
  add(on("drafts", query(collection(db, "users", u.uid, "drafts"), orderBy("updatedAt", "desc"), limit(50)), snap => {
    S.drafts = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderSoon();
  }));
  // friends (requests both ways + accepted) and private conversations
  add(on("friends", query(collection(db, "friendships"), where("uids", "array-contains", u.uid)), snap => {
    S.msgsReady = true;   // Messages appear only once the server side (rules) answers; until then nothing half-works
    S.friends = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }])); rebuildContacts(); renderSoon();
  }));
  // Friend invites I texted to numbers that weren't on Friendly yet: listed under "Invited by text" in Messages.
  // When the person signs up with that number the server turns the invite into a real friend request.
  add(on("textInvites", query(collection(db, "friendRequests"), where("from", "==", u.uid)), snap => {
    S.textInvites = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderSoon();
  }));
  add(on("dms", query(collection(db, "dms"), where("uids", "array-contains", u.uid)), snap => {
    S.dms = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }])); renderSoon();
  }));
  // Shared receipts I'm on (Pick your items): the list on Money and the live pick page. While the pick page is
  // open, a change redraws only that page so taps from everyone show up without the screen jumping.
  add(on("receiptSplits", query(collection(db, "receiptSplits"), where("uids", "array-contains", u.uid)), snap => {
    const was = S._splitsKey, beforeSplits = S.splitsReady ? S.splits : null; S.splits = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }])); S.splitsReady = true;
    if (beforeSplits) for (const t of S.splits.values()) { const b = beforeSplits.get(t.id); if (b && t.createdBy === u.uid && t.status === "open" && !allPicked(b) && allPicked(t)) coralCheer("Everyone picked their items!", `${t.desc || "The receipt"}: hand out anything left, then tap Finish.`, () => go("#/pick/" + t.id)); }
    S._splitsKey = [...S.splits.values()].map(t => t.id + ":" + t.status).sort().join(); refreshEvMoney();
    if (S.route.name === "pick" && el("pickRoot")) patchPick(); else if (S.route.name === "pick" || S.route.name === "money" || was !== S._splitsKey) renderSoon();
  }));
  // activity feed (written by Cloud Functions for everything I'd be notified about)
  add(on("activity", query(collection(db, "activity"), where("uids", "array-contains", u.uid), orderBy("createdAt", "desc"), limit(60)), snap => {
    S.activity = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderSoon();
  }));

  // events where I'm directly invited: upcoming ones now, past ones a moment after everything else is in
  S.evSrc = new Map(); S.events = new Map(); S.evCut = todayStr(); S.pastOn = false; S.pastLoaded = false; S.pastOpen = false;
  clearTimeout(S._pastTimer); S._pastTimer = setTimeout(startPast, 8000);
  const invUp = (full) => add(onSnapshot(full ? query(collection(db, "events"), where("invitedUids", "array-contains", u.uid))
    : query(collection(db, "events"), where("invitedUids", "array-contains", u.uid), where("date", ">=", S.evCut)), snap => {
    takeEvents("inv", snap); if (full) S.pastLoaded = true;
    renderSoon(); if (!snap.metadata.fromCache) schedulePast();
  }, err => {
    // Without its index (just deployed, still building) the dated query fails: fall back to loading everything.
    console.warn("listener events:", err.code || err.message);
    if (!full && err.code === "failed-precondition") { S.pastOn = true; invUp(true); }
  }));
  invUp(false);
}
// Events reach us through several listeners (invited/group × upcoming/past). Each keeps its own set and
// S.events is their union, so one listener dropping an event (say its date moved into the past) can't erase
// what another one holds.
function takeEvents(src, snap) {
  if (!S.evSrc) S.evSrc = new Map();
  const m = S.evSrc.get(src) || new Map(); S.evSrc.set(src, m);
  snap.docChanges().forEach(c => { if (c.type === "removed") m.delete(c.doc.id); else { const ev = { id: c.doc.id, ...c.doc.data() }; m.set(ev.id, ev); noteNames(ev); } });
  mergeEvents();
}
function dropEvents(src) { if (S.evSrc && S.evSrc.delete(src)) mergeEvents(); }
function mergeEvents() { const all = new Map(); for (const m of S.evSrc.values()) for (const [id, ev] of m) all.set(id, ev); S.events = all; }
// Past events load in the background once the upcoming ones are in (or right away when something needs them:
// opening the Past section, the calendar view, or a link to a past event).
function schedulePast() { if (!S.pastOn && !S._pastSoon) S._pastSoon = setTimeout(() => { S._pastSoon = null; startPast(); }, 1500); }
function startPast() {
  if (S.pastOn || !S.user) return;
  S.pastOn = true; clearTimeout(S._pastTimer);
  const u = S.user;
  S.subs.push(onSnapshot(query(collection(db, "events"), where("invitedUids", "array-contains", u.uid), where("date", "<", S.evCut)), snap => {
    takeEvents("invPast", snap); S.pastLoaded = true; renderSoon();
  }, err => { console.warn("listener past events:", err.code || err.message); S.pastLoaded = true; renderSoon(); }));
  resubscribeEvents(u);
}
// Tear down every listener before signing out; otherwise the SDK re-sends
// them without auth and logs a burst of permission-denied errors.
function stopListening() { S.subs.forEach(fn => fn()); S.subs = []; cleanupEvent(); }
// Remember the guest names an event carries, for guests outside my groups.
function noteNames(ev) { S.nameHints = S.nameHints || new Map(); for (const [uid, n] of Object.entries(ev.names || {})) if (n) S.nameHints.set(uid, n); if (ev.hostId && ev.hostName && !S.nameHints.get(ev.hostId)) S.nameHints.set(ev.hostId, ev.hostName); }

// events tied to any of my groups (re-subscribed when the group set changes, or when past events switch on)
function resubscribeEvents(u) {
  const gids = [...S.groups.keys()].slice(0, 30);
  const key = gids.slice().sort().join(",") + "|" + (S.pastOn ? "all" : "up");
  if (key === S.eventSubKey) return;
  S.eventSubKey = key;
  (S._groupEventsUnsubs || []).forEach(fn => fn()); S._groupEventsUnsubs = [];
  dropEvents("grp"); dropEvents("grpPast");
  if (!gids.length) return;
  const subscribe = (src, q, attempt, onFail) => {
    let unsub = null;
    unsub = onSnapshot(q, snap => { takeEvents(src, snap); renderSoon(); }, err => {
      // Right after creating or joining a group, the local groups snapshot fires before the server has the
      // membership write, so the rule check for this query can fail once. A dead listener would hide every
      // group event, so retry a few times.
      if (err && err.code === "failed-precondition" && onFail) return onFail();
      if (attempt < 4 && S.eventSubKey === key) setTimeout(() => { if (S.eventSubKey === key) subscribe(src, q, attempt + 1, onFail); }, 1500 * (attempt + 1));
      else console.warn("group events listener failed:", err && err.message);
    });
    S._groupEventsUnsubs.push(() => unsub && unsub());
  };
  const base = collection(db, "events");
  const fullQ = query(base, where("groupId", "in", gids));
  subscribe("grp", query(base, where("groupId", "in", gids), where("date", ">=", S.evCut || todayStr())), 0, () => subscribe("grp", fullQ, 0));
  if (S.pastOn) subscribe("grpPast", query(base, where("groupId", "in", gids), where("date", "<", S.evCut || todayStr())), 0, () => {});
  if (!S._groupEventsHooked) { S._groupEventsHooked = true; S.subs.push(() => { (S._groupEventsUnsubs || []).forEach(fn => fn()); S._groupEventsUnsubs = []; S.eventSubKey = null; S._groupEventsHooked = false; }); }
}

// Write this phone's type (MY_OS) to the profile and to my entry in each group, once per session per place, so
// friends' apps can tell whether Apple Cash works for me. Existing members pick it up the next time they open the app.
const osSynced = new Set();
function syncMyOs() {
  if (!MY_OS || !S.user || !S.profile) return; const me = S.user.uid;
  if (S.profile.os !== MY_OS && !osSynced.has("me")) { osSynced.add("me"); updateDoc(doc(db, "users", me), { os: MY_OS }).catch(() => {}); }
  for (const g of S.groups.values()) { const m = (g.members || {})[me];
    if (m && m.os !== MY_OS && (g.memberUids || []).includes(me) && !osSynced.has(g.id)) { osSynced.add(g.id); updateDoc(doc(db, "groups", g.id), { [`members.${me}.os`]: MY_OS }).catch(() => {}); } }
}
function rebuildContacts() {
  const m = new Map();
  if (S.user && S.profile) m.set(S.user.uid, { name: S.profile.name, venmo: S.profile.venmo, phone: S.profile.phone, zelle: S.profile.zelle || "", cashapp: S.profile.cashapp || "", payPref: S.profile.payPref || "", photo: S.profile.photo || "", os: myOs() });
  for (const g of S.groups.values())
    for (const [uid, info] of Object.entries(g.members || {})) if (!m.has(uid)) m.set(uid, info);
  // Friends you don't share a group with are known by the name and photo their friendship carries.
  for (const f of (S.friends || new Map()).values())
    for (const [uid, info] of Object.entries(f.people || {})) if (!m.has(uid)) m.set(uid, { name: info.name, photo: info.photo || "" });
  S.contacts = m;
}
// Someone's pay handles: the freshest copy an expense you share with them carries (the server keeps those in
// step with their profile), else what a shared group recorded when they joined.
// People who aren't on Friendly can still be on an expense: they're keyed by phone ("ph:+15551234567") and
// named on the expense (guestNames). Balances count anyone with a name: a contact, an event guest, or one of these.
const isGuest = u => typeof u === "string" && u.startsWith("ph:");
const knownPerson = u => S.contacts.has(u) || !!nameHint(u);
function payInfoOf(uid) {
  if (isGuest(uid)) return { name: nameOf(uid), phone: uid.slice(3), venmo: "", zelle: "", cashapp: "", payPref: "" };
  const base = S.contacts.get(uid) || {}; let best = null, when = -1;
  for (const x of S.expenses.values()) { const p = x.pay && x.pay[uid]; if (p && (x.createdAt || 0) > when) { best = p; when = x.createdAt || 0; } }
  if (!best) return base;
  const o = { ...base }; for (const k of ["venmo", "zelle", "cashapp", "payPref", "phone", "os"]) if (best[k]) o[k] = best[k]; else if (!o[k]) o[k] = "";
  return o;
}
// Names come from shared groups (contacts); guests who joined an event by link
// are only known by the names the event carries (see noteNames).
const nameHint = uid => (S.nameHints && S.nameHints.get(uid)) || hostNameHint(uid) || "";
// Last resort for a host you don't know: any loaded event they host carries their name.
function hostNameHint(uid) { if (!uid || !S.events) return ""; for (const ev of S.events.values()) { if (ev.hostId === uid && ev.hostName) { (S.nameHints = S.nameHints || new Map()).set(uid, ev.hostName); return ev.hostName; } if (ev.names && ev.names[uid]) { (S.nameHints = S.nameHints || new Map()).set(uid, ev.names[uid]); return ev.names[uid]; } } return ""; }
const nameOf = uid => (S.contacts.get(uid) || {}).name || nameHint(uid) || "Someone";
// data-pf: tapping anyone's picture opens their profile (see the capture listener below).
function avatar(uid, cls = "") { const info = S.contacts.get(uid) || {}; const name = info.name || nameHint(uid); const pf = uid ? ` data-pf="${esc(uid)}"` : ""; if (info.photo) return `<span class="avatar ${cls} has-img"${pf}><img src="${esc(info.photo)}" alt=""></span>`; return `<span class="avatar ${cls}" style="background:${colorFor(uid)}"${pf}>${esc(/\bxs\b/.test(cls) ? initials(name || "?").slice(0, 1) : initials(name || "?"))}</span>`; }
// Any profile picture opens that person's profile (with Add friend / Accept / Message), including event
// guests you don't share a group with. Runs in the capture phase so a tap on a picture inside a row
// that links elsewhere opens the profile instead. Skipped inside pickers, dialogs, and your own chip.
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest("[data-pf]"); if (!a || !S.user) return;
  if (a.closest("#appDialog, .inv-hit, label.cbox, .me-chip, .topbar, [data-choose], .tour-card, .mini-guests, .dm-row, .pk-people, .pk-item, .split-who")) return;
  const uid = a.dataset.pf; if (!uid || uid === S.user.uid) return;
  e.preventDefault(); e.stopPropagation(); openProfileDialog(uid);
}, true);

// ---------- render root ----------
// Every live listener re-renders by replacing innerHTML, which would drop
// whatever the person is typing (an RSVP answer, a wall post, their profile)
// the moment anyone else's activity lands. Snapshot the focused text field
// before a re-render and put its value, caret and focus back afterwards.
function withInputKept(fn) {
  const a = document.activeElement; let snap = null;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && !["checkbox", "radio", "file", "submit", "button"].includes(a.type) && !a.closest("dialog")) {
    const data = [...a.attributes].find(x => x.name.startsWith("data-"));
    const key = a.id ? "#" + CSS.escape(a.id) : data ? `${a.tagName.toLowerCase()}[${data.name}="${CSS.escape(data.value)}"]` : null;
    if (key) snap = { key, value: a.value, s: a.selectionStart, e: a.selectionEnd };
  }
  fn();
  if (!snap) return;
  const n = document.querySelector(snap.key); if (!n) return;
  if (n.value !== snap.value) n.value = snap.value;
  n.focus({ preventScroll: true });
  try { if (snap.s != null) n.setSelectionRange(snap.s, snap.e); } catch {}
}
// Freeze black box (every user; steps and timings only, no personal data). A ring of recent steps (redraws with route and time taken, visibility changes) plus a
// heartbeat, saved every second. When the page's code stalls 3+ seconds while on screen, that's logged; the next
// sign-in reports any session that stalled, so a freeze on a phone tells us what was running.
const FZ_KEY = "friendlyFreezeTrace";

const deviceLine = () => { const m = /OS (\d+[_.]\d+(?:[_.]\d+)?)/.exec(navigator.userAgent || ""); return (m ? "iOS " + m[1].replace(/_/g, ".") : (navigator.userAgent || "").slice(0, 60)) + " · " + (window.screen ? screen.width + "x" + screen.height : ""); };
const fz = { log: [], tick: Date.now(), stalled: false,
  add(s) { const line = new Date().toTimeString().slice(0, 8) + " " + s; this.log.push(line); if (this.log.length > 50) this.log.shift(); dogSay({ step: line }); },
  save() { dogSay({ route: location.hash, stalled: this.stalled ? 1 : 0 }); } };
// iOS kills the page to get memory back (in the background, or when a system screen like the contacts permission
// comes up); the app reloads it at once. Telling that reload apart from a fresh launch: per-session storage lives
// with the web view, so it survives a kill-and-reload and is empty after a force-quit and relaunch; a fresh launch
// also always starts at the root with no screen address. The native app (from the build after 1.0.3) stamps
// window.__killedReloadAt as well. A reload that boots within seconds of the dead page's last heartbeat is a kill.
let KILLED_RELOAD = false, killedAfterS = 0, sameView = false, KILL_PICKER = null;
try { sameView = sessionStorage.getItem("friendlyView") === "1"; sessionStorage.setItem("friendlyView", "1"); } catch {}
if (typeof window.__killedReloadAt === "number" && Date.now() - window.__killedReloadAt < 60000) KILLED_RELOAD = true;
fz.add((KILLED_RELOAD ? "boot after iOS killed the page " : "boot ") + (location.hash || "#/").slice(0, 60) + (document.visibilityState === "visible" ? "" : " (page " + document.visibilityState + ")")); fz.save();
// The camera covers the page, so the page's last word before such a kill is "app hidden" (which otherwise means a
// normal trip to the background): the picker marker tells the two apart. The flow resumes once signed in.
bootDiag.then(() => {
  try {
    const p = prevTrace, log = (p && p.log) || [], last = String(log.slice(-1)[0] || "");
    if (p && p.hb) { killedAfterS = Math.round((Date.now() - p.hb) / 1000); const deepHash = !!location.hash && location.hash !== "#/"; if ((sameView || deepHash) && killedAfterS < 10 && !/ (app hidden|page closed)$/.test(last)) KILLED_RELOAD = true; }
    const pk = JSON.parse(LS.get("friendlyPicker") || "null"); LS.remove("friendlyPicker");
    if (pk && sameView) {
      const i = log.map(s => / photo picker opened /.test(s)).lastIndexOf(true), age = Date.now() - (pk.t || 0);
      const quiet = i >= 0 && log.slice(i + 1).every(s => / (app hidden|app visible|photo picked .*|redraw .*|STALL .*)$/.test(s));
      if (quiet && age < (pk.stage === "picker open" ? 15 * 60000 : 45000)) { KILL_PICKER = pk; KILLED_RELOAD = true; }
    }
    if (KILLED_RELOAD) { fz.add(KILL_PICKER ? "this is a reload after iOS killed the page under the camera" : "this is a reload after iOS killed the page"); if (S && S.user) S._introOver = true; }
  } catch {}
});
let consoleLoopSeen = 0;
setInterval(() => { const now = Date.now(), gap = now - fz.tick; fz.tick = now; if (gap > 3000 && gap < 90000 && !document.hidden) { fz.stalled = true; fz.add(`STALL ${Math.round(gap / 100) / 10}s on ${location.hash || "#/"}`); }
  if ((window.__consoleLoop || 0) > consoleLoopSeen) { if (consoleLoopSeen === 0 || window.__consoleLoop > consoleLoopSeen * 10) fz.add(`console bridge loop stopped (${window.__consoleLoop}x): ${window.__consoleLoopMsg || "?"}`); consoleLoopSeen = window.__consoleLoop; }
  fz.save(); dogSay({ beat: 1 }); }, 1000);
document.addEventListener("visibilitychange", () => { fz.tick = Date.now(); fz.add("app " + document.visibilityState); fz.save(); dogSay({ vis: document.visibilityState === "visible" }); });
window.addEventListener("hashchange", () => fz.add("go " + location.hash.slice(0, 60)));
window.addEventListener("pagehide", () => { fz.add("page closed"); fz.save(); });
// Reports wait for the worker's copy of the previous session and only confirm it as handled once a signed-in
// session has had the chance to report it; a trace an earlier boot never got to report comes along too.
async function reportFreezeTrace() {
  await bootDiag;
  if (!myUid()) return;
  if (prevOlder && prevOlder.log) { const o = prevOlder; prevOlder = null; addDoc(collection(db, "bugs"), { uid: myUid(), name: "diag", text: `freeze trace, reported late (an earlier session; its next launch did not get to report it), last heartbeat ${new Date(o.hb).toTimeString().slice(0, 8)}, ${deviceLine()}:\n` + o.log.join("\n"), route: o.route, version: o.v, platform: NATIVE ? (IS_ANDROID ? "android" : "ios") : "web", status: "open", diag: true, createdAt: Date.now(), tracedAt: o.hb }).catch(() => {}); }
  const tr = prevTrace; prevTrace = null;
  try { if (tr) reportFreezeTraceOf(tr); } finally { dogSay({ ackPrev: 1 }); }
}
function reportFreezeTraceOf(tr) {
  // Report a session that stalled, or one that ended while on screen (its last step isn't going to the background
  // or closing): that's a force-quit during a hang, or a crash.
  const lastStep = String((tr && tr.log && tr.log[tr.log.length - 1]) || "");
  const endedOnScreen = tr && tr.log && tr.log.length && !/ (app hidden|page closed)$/.test(lastStep);
  if (!tr || !myUid()) return;
  if (KILL_PICKER) {
    addDoc(collection(db, "bugs"), { uid: myUid(), name: "diag", text: `page killed by iOS while the camera/photo picker was open (${KILL_PICKER.what}, ${KILL_PICKER.stage}, ${Math.round((Date.now() - KILL_PICKER.t) / 1000)}s after it opened, ${deviceLine()}), on ${KILL_PICKER.route || "?"}; last steps:\n` + (tr.log || []).slice(-8).join("\n"), route: KILL_PICKER.route, version: tr.v, platform: NATIVE ? (IS_ANDROID ? "android" : "ios") : "web", status: "open", diag: true, createdAt: Date.now(), tracedAt: tr.hb }).catch(() => {});
    const m = /^#\/e\/([^?]+)/.exec(KILL_PICKER.route || "");
    toast("Friendly had to reload while the camera was open. Please take that photo again.");
    if (KILL_PICKER.what === "receipt" && m) setTimeout(() => { if (location.hash.split("?")[0] === "#/e/" + m[1] && !el("appDialog") && S.events.get(m[1])) openExpense(m[1]); }, 1200);
    return;
  }
  if (KILLED_RELOAD) { addDoc(collection(db, "bugs"), { uid: myUid(), name: "diag", text: `page killed by iOS and reloaded ${killedAfterS}s after its last heartbeat (${deviceLine()}), on ${tr.route || "?"}; last steps:\n` + (tr.log || []).slice(-8).join("\n"), route: tr.route, version: tr.v, platform: NATIVE ? (IS_ANDROID ? "android" : "ios") : "web", status: "open", diag: true, createdAt: Date.now(), tracedAt: tr.hb }).catch(() => {}); return; }
  if (!tr.stalled) return;   // closing the app while it's on screen is normal, not a freeze
  addDoc(collection(db, "bugs"), { uid: myUid(), name: "diag", text: `freeze trace (previous session ${tr.stalled ? "stalled" : "ended while on screen"}, last heartbeat ${new Date(tr.hb).toTimeString().slice(0, 8)}, ${deviceLine()}, worker store ${LS.ok ? "ok" : "NOT answering"}):\n` + tr.log.join("\n"), route: tr.route, version: tr.v, platform: NATIVE ? (IS_ANDROID ? "android" : "ios") : "web", status: "open", diag: true, createdAt: Date.now(), tracedAt: tr.hb }).catch(() => {});
}
function render() {
  clearTimeout(renderTimer); renderTimer = 0;
  const fzT0 = performance.now();
  // Background data never rebuilds a screen you're filling in or chatting on: the New event form (its draft
  // autosave answers back as a snapshot, and the rebuild closed sections and jumped the form) and a message
  // thread (its own listener paints new messages).
  if (S._bgRender && S.route && ((S.route.name === "new" && el("cTitle")) || (S.route.name === "dm" && el("dmList")))) { try { syncBadge(); } catch {} return; }
  // Expandable sections you opened stay open through a redraw (keyed by id, else by their summary text).
  const openKeys = new Set([...document.querySelectorAll("#app details[open]")].map(detailsKey));
  withInputKept(renderNow); restoreKept();
  if (openKeys.size) document.querySelectorAll("#app details").forEach(d => { if (openKeys.has(detailsKey(d))) d.open = true; });
  try { syncBadge(); } catch {}
  const fzMs = performance.now() - fzT0; if (fzMs > 40) fz.add(`redraw ${(S.route && S.route.name) || "?"} ${Math.round(fzMs)}ms${S._bgRender ? " (background)" : ""}`);
}
const detailsKey = d => d.id || (location.hash.split("?")[0] + "|" + ((d.querySelector("summary") || {}).textContent || "").trim());
// Data arriving from the server redraws through here: a burst of snapshots (a dozen listeners, each answering
// from the device copy and then the server) becomes one redraw, and an open event page skips redraws that
// don't touch it. Rebuilding the whole screen for every snapshot left iPhones half-painted and stalling.
let renderTimer = 0;
function renderSoon() { if (renderTimer) return; renderTimer = setTimeout(() => { renderTimer = 0; S._bgRender = true; try { render(); } finally { S._bgRender = false; } }, 80); }
// Forms marked data-keep (sign-up details, profile) hold what you typed even when something else
// redraws the screen, like adding a photo (it saves at once, and the redraw used to empty every field).
const keptInputs = new Map();
document.addEventListener("input", e => { const t = e.target; if (t && t.id && t.closest && t.closest("[data-keep]")) keptInputs.set(t.id, t.type === "checkbox" ? t.checked : t.value); }, true);
document.addEventListener("change", e => { const t = e.target; if (t && t.id && t.closest && t.closest("[data-keep]")) keptInputs.set(t.id, t.type === "checkbox" ? t.checked : t.value); }, true);
window.addEventListener("hashchange", () => keptInputs.clear());
function restoreKept() { for (const [id, v] of keptInputs) { const n = document.getElementById(id); if (!n || !n.closest("[data-keep]")) continue; if (n.type === "checkbox") n.checked = !!v; else if (n.value !== v) n.value = v; } }
// The loading screen: the wordmark flows into Blip (blip.js), then Blip idles until the app is ready.
let splashStop = null;
function splashInner(msg) { return window.Blip ? `<svg class="splash-blip"></svg><div class="splash-say" aria-hidden="true"><b>Hi, I'm Dot!</b> Let's get everyone together.</div>` : `<div class="brand splash-brand">${WORDMARK}</div>`; }
function mountSplash(root, msg) {
  const cur = root.querySelector(".splash");
  if (cur && cur.querySelector(".splash-blip")) return;
  root.innerHTML = `<div class="splash">${splashInner(msg)}</div>`;
  if (splashStop) { splashStop(); splashStop = null; }
  const svg = root.querySelector(".splash-blip");
  if (svg && window.Blip) { splashHold = true; splashStop = window.Blip.play(svg, { dur: 1.7, delay: 1.65, onDone: () => { splashHold = false; }, align: NATIVE && IOS ? g => alignToLaunchImage(svg, g) : null }); }
}
// The iPhone launch image (Splash.imageset, 2732px square, shown scaled to fill the screen) has the logo at fixed
// spots: its F starts at x 991.6 and the yellow dot sits at (1707.46, 1281.6). The intro's stage scales with the
// screen's width instead, so on its own it starts a few points off (and further off on shorter phones). Move and
// scale the stage so its F and dot land on the image's, and the hand-off from the launch image doesn't jump.
// (The F's left edge is 0.07em into its glyph box; the stage draws the logo at 112px.)
function alignToLaunchImage(svg, g) {
  const W = innerWidth, H = innerHeight, Sq = Math.max(W, H), k = Sq / 2732, ox = (W - Sq) / 2, oy = (H - Sq) / 2;
  const nF = ox + 991.6 * k, nX = ox + 1707.46 * k, nY = oy + 1281.6 * k;
  const r = svg.getBoundingClientRect(), sc = r.width / 720; if (!sc) return;
  const iF = r.left + (g.fx + 7.84) * sc, iX = r.left + g.dx * sc, iY = r.top + g.dy * sc;
  const f = (nX - nF) / (iX - iF); if (!(f > .5 && f < 2)) return;
  svg.style.transformOrigin = `${g.dx * sc}px ${g.dy * sc}px`;
  svg.style.transform = `translate(${(nX - iX).toFixed(2)}px, ${(nY - iY).toFixed(2)}px) scale(${f.toFixed(4)})`;
}
// The intro plays again whenever the app comes back to the foreground after being away a while, as an overlay on top of the live app.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); markSeen(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0; markSeen();
  if (away >= AWAY_FOR_INTRO && S.ready && window.Blip && !document.querySelector(".splash")) replaySplash();   // away 10 minutes or more
});
// While it plays, the app underneath is hidden and its animations pause (body.replaying), so only Dot is moving:
// replaying over a busy event page (theme animations, particles, a burst of updates) stalled iPhones. A tapped
// notification ends it at once, since you asked to go somewhere.
let endReplay = null;
function replaySplash() {
  if (S._notifTapAt && Date.now() - S._notifTapAt < 4000) return;
  const o = document.createElement("div"); o.className = "splash splash-replay"; o.innerHTML = splashInner("Getting everyone here…"); document.body.appendChild(o);
  const svg = o.querySelector(".splash-blip"); if (!svg) { o.remove(); return; }
  document.body.classList.add("replaying"); fz.add("intro replay start");
  let stop = () => {}; try { stop = window.Blip.play(svg, { dur: 1.7, delay: 1.65 }); } catch {}
  let ended = false;
  endReplay = fast => {
    if (ended) return; ended = true; endReplay = null;
    document.body.classList.remove("replaying"); fz.add("intro replay end" + (fast ? " (notification)" : ""));
    o.classList.add("out"); setTimeout(() => { try { stop(); } catch {} o.remove(); }, fast ? 200 : 450);
  };
  setTimeout(() => endReplay && endReplay(false), 6000);   // same flat 6 seconds as the opening intro
}
// What shows while the account is still loading: the real header and tabs, with soft placeholder cards.
function loadingShell() {
  return `<header class="topbar"><div class="brand has-dot"><a class="brand-home" href="#/" aria-label="Friendly home">${WORDMARK}</a><span class="brand-dot" aria-hidden="true"></span></div><div class="topbar-right"><span class="skel skel-chip"></span></div></header>
  <nav class="tabs"><button class="tab on" type="button">Events</button><button class="tab" type="button">Groups</button><button class="tab" type="button">Money</button><button class="tab" type="button"><span class="curate-lbl">${CURATE_LABEL}<i class="spark">✦</i></span></button></nav>
  <main class="wrap boot-skel" aria-busy="true" aria-label="Loading"><div class="skel skel-banner"></div><div class="skel skel-line"></div><div class="skel-grid"><div class="skel skel-tile"></div><div class="skel skel-tile"></div><div class="skel skel-tile"></div><div class="skel skel-tile"></div></div></main>`;
}
function renderNow() {
  if (BLOCKED_MOBILE_WEB) return;
  const root = el("app");
  // The intro runs its own course (logo, Dot forms, a beat of rest) and then always gets out of the way.
  // It never waits on data: if the account hasn't loaded yet, the app appears with placeholders instead.
  // A page iOS killed comes straight back to where it was; the intro is for a real start.
  if (KILLED_RELOAD) S._introOver = true;
  if (!S._introOver && Date.now() - BOOT_AT < SPLASH_MIN) {
    if (!splashTimer) splashTimer = setTimeout(() => { splashTimer = null; render(); }, SPLASH_MIN - (Date.now() - BOOT_AT) + 20);
    mountSplash(root, "Getting everyone here…"); return; }
  S._introOver = true;
  // Leaving the intro: lift the splash out of the page and fade it away over the app instead of cutting.
  const leaving = root.querySelector(".splash");
  if (leaving) {
    const stop = splashStop; splashStop = null;
    document.body.appendChild(leaving); leaving.classList.add("splash-leave");
    void leaving.offsetWidth; leaving.classList.add("out");   // force a style flush so the fade runs from full opacity
    setTimeout(() => { leaving.remove(); if (stop) stop(); }, 700);
  } else if (splashStop) { splashStop(); splashStop = null; }
  if (RESET_OOB) { renderResetPassword(root); return; }
  if (!S.ready) { if (!root.querySelector(".boot-skel")) root.innerHTML = loadingShell(); return; }
  if (!S.user) { if (S.route.name === "event") { renderPreview(root, S.route.id); return; } if (S.route.name === "join") { try { LS.set("friendlyJoin", S.route.id); } catch {} } renderAuth(root); return; }
  if (!S.profile) { if (!root.querySelector(".boot-skel")) root.innerHTML = loadingShell(); return; }
  if (S.profile.onboarded === false) { root.innerHTML = onboardingBody(); wireOnboarding(); return; }
  const r = S.route;
  if (r.name === "event") return renderEventPage(root, r.id);
  cleanupEvent();
  if (r.name !== "dm") stopDmSub();
  root.innerHTML = shell(routeBody(r));
  watchTabs();
  wireShell();
}

// ---------- onboarding (right after creating a phone+password account) ----------
function onboardingBody() {
  const p = S.profile;
  return `
  <div class="auth-wrap">
    <canvas id="authbg" class="auth-bg"></canvas>
    <div class="auth-card card">
      <div class="brand xl">${WORDMARK_XL}</div>
      ${window.Blip ? `<div class="dot-say">${dot("happy", 60)}<div class="say-bubble">Hi ${esc(first(p.name))}, I'm Dot. Let's finish setting up your profile. After that I'll be up in the logo if you ever want a tip.</div></div>` : `<p class="auth-lede">Welcome, ${esc(p.name)}! Let's finish setting up your profile.</p>`}
      <p class="pic-cta">✨ Select a profile pic! ✨</p>
      <button type="button" class="avatar-edit pulse" id="obPhotoBtn" title="Add a photo" style="margin:0 auto 14px;display:block">${avatar(myUid(), "xxl")}<span class="cam">📷</span></button>
      <form id="onboardForm" class="stack" data-keep>
        <label class="field"><span>Email <span class="muted">for calendar invites</span></span>
          <input id="obEmail" type="email" placeholder="sam@example.com" autocomplete="email"></label>
        <label class="field"><span>Venmo</span>
          <input id="obVenmo" placeholder="@sam-rivera" autocomplete="off"></label>
        ${IS_ANDROID ? "" : `<label class="field"><span>Apple Cash number</span>
          <input id="obApple" type="tel" placeholder="+1 555 123 4567" value="${IOS ? esc(p.phone || "") : ""}" autocomplete="tel"></label>`}
        <div class="two"><label class="field"><span>Zelle <span class="muted">(phone or email)</span></span>
          <input id="obZelle" placeholder="+1 555 123 4567" autocomplete="off"></label>
        <label class="field"><span>Cash App</span>
          <input id="obCashapp" placeholder="$samrivera" autocomplete="off"></label></div>
        <label class="field"><span>Preferred way to get paid back</span><select id="obPayPref">${payPrefOptions("")}</select></label>
        <p class="muted sm" style="margin:-4px 0 10px">Payment handles are shared only with people in your groups, so they can pay you back. All optional.</p>
        <label class="field"><span>Birthday <span class="muted">(so friends get a heads-up a month out)</span></span>
          <input id="obBday" type="date" autocomplete="bday"></label>
        <button class="btn primary lg" type="submit">Done</button>
      </form>
      <p class="auth-foot"><a id="obSkip">Skip for now</a></p>
    </div>
  </div>`;
}
function wireOnboarding() {
  startParticles(el("authbg"), "confetti");
  const finish = async () => {
    const email = el("obEmail").value.trim(), venmo = el("obVenmo").value.trim(), apple = el("obApple") ? el("obApple").value.trim() : (S.profile.phone || ""), birthday = el("obBday") ? el("obBday").value : "";
    const zelle = ((el("obZelle") || {}).value || "").trim(), cashapp = ((el("obCashapp") || {}).value || "").trim();
    let payPref = (el("obPayPref") || {}).value || ""; if (payPref && !{ venmo, apple, zelle, cashapp }[payPref]) payPref = "";
    try {
      await updateDoc(doc(db, "users", myUid()), { email: email.toLowerCase(), venmo, zelle, cashapp, payPref, phone: apple, phoneE164: toE164(apple) || myPhoneE164(), ...(birthday ? { birthday } : {}), onboarded: true });
      keptInputs.clear();
    } catch (e) { toast(e.message); }
  };
  el("onboardForm").onsubmit = e => { e.preventDefault(); finish(); };
  el("obSkip").onclick = () => updateDoc(doc(db, "users", myUid()), { onboarded: true }).catch(e => toast(e.message));
  el("obPhotoBtn").onclick = async () => {
    const f = await pickFile("image/*", "profile photo"); if (!f) return;
    const cropped = await openCropDialog(f); if (!cropped) return;
    toast("Updating photo…");
    try { const photo = await compressImage(cropped, 320, 0.82), photoSm = await compressImage(cropped, 160, 0.8); await updateDoc(doc(db, "users", myUid()), { photo, photoSm }); toast("Photo updated"); }
    catch (e) { toast(e.message); }
  };
}

// ---------- auth screen ----------
// First time on this device: open on Create account. Anyone who has signed in here before gets Sign in.
let authMode = (() => { try { return LS.get("friendlyKnown") ? "in" : "up"; } catch { return "in"; } })();
function renderAuth(root) {
  root.innerHTML = `
  <div class="auth-wrap">
    <canvas id="authbg" class="auth-bg"></canvas>
    <div class="auth-card card">
      <div class="brand xl">${WORDMARK_XL}</div>
      <div class="auth-dot">${window.Blip ? window.Blip.svg({ mood: "happy", size: 64, wave: true }) : ""}<div class="say-bubble">${authMode === "in"
        ? `<b>Hi, I'm Dot!</b> Welcome back. Sign in and I'll catch you up on what your friends are planning.`
        : `<b>Hi, I'm Dot!</b> I help your crew plan nights out, send invites, and settle up. Make an account and I'll show you around.`}</div></div>
      <p class="auth-lede">Your friend group's home base for plans, invites, photos, and settling up.</p>
      <div class="seg">
        <button id="segIn" class="${authMode === "in" ? "on" : ""}">Sign in</button>
        <button id="segUp" class="${authMode === "up" ? "on" : ""}">Create account</button>
      </div>
      ${NATIVE ? "" : `<button type="button" class="btn lg demo-btn" id="demoBtn">Try the demo, no account needed</button>`}
      <form id="authForm" class="stack">
        <label class="field ${authMode === "in" ? "hidden" : ""}" id="nameField"><span>Your name</span>
          <input id="aName" maxlength="40" placeholder="Sam Rivera" autocomplete="name"></label>
        <label class="field"><span id="aPhoneLabel">Phone number</span>
          <input id="aPhone" name="username" type="tel" required inputmode="tel" placeholder="+1 555 123 4567" autocomplete="${authMode === "in" ? "username" : "tel"}"></label>
        <label class="field"><span>Password</span>
          <input id="aPass" name="password" type="password" required minlength="6" placeholder="At least 6 characters" autocomplete="${authMode === "in" ? "current-password" : "new-password"}" ${authMode === "in" ? "" : `passwordrules="minlength: 10; required: lower; required: upper; required: digit; allowed: [-().&@?'#,/&quot;+];"`}></label>
        <button class="btn primary lg" type="submit">${authMode === "in" ? "Sign in" : "Create account"}</button>
        ${authMode === "up" ? `<label class="cbox terms-box" for="aTerms"><input type="checkbox" id="aTerms"><span class="sm">I agree to the <a href="./terms.html" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">Terms of Use</a> and <a href="./privacy.html" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">Privacy Policy</a>. No harassment or objectionable content; accounts that post it are removed.</span></label>` : ""}
      </form>
      ${authMode === "in" ? `<p class="auth-foot" style="margin-top:8px"><a id="forgotPass">Forgot password?</a></p>` : ""}
      <p class="auth-foot">${authMode === "in" ? "New here?" : "Already have an account?"}
        <a id="authSwap">${authMode === "in" ? "Create an account" : "Sign in"}</a></p>
    </div>
  </div>`;
  startParticles(el("authbg"), "confetti");
  // The phone keypad on iPhone has no "@", so a long-press (or double-tap) on
  // the "Phone number" label quietly switches the field to an email keyboard.
  const lbl = el("aPhoneLabel");
  if (lbl) {
    const toEmailMode = () => { const i = el("aPhone"); if (!i || i.type === "email") return; i.type = "email"; i.inputMode = "email"; i.placeholder = "you@example.com"; i.autocomplete = "username"; i.value = ""; i.focus(); };
    let hold = null;
    lbl.addEventListener("pointerdown", e => { e.preventDefault(); hold = setTimeout(toEmailMode, 600); });
    ["pointerup", "pointercancel", "pointerleave"].forEach(ev => lbl.addEventListener(ev, () => clearTimeout(hold)));
    lbl.addEventListener("dblclick", e => { e.preventDefault(); toEmailMode(); });
  }
  el("segIn").onclick = () => { authMode = "in"; renderAuth(root); };
  el("segUp").onclick = () => { authMode = "up"; renderAuth(root); };
  if (el("demoBtn")) el("demoBtn").onclick = () => { el("demoBtn").disabled = true; el("demoBtn").textContent = "Opening the demo…"; demoSignIn(); };
  el("authSwap").onclick = () => { authMode = authMode === "in" ? "up" : "in"; renderAuth(root); };
  if (el("forgotPass")) el("forgotPass").onclick = () => {
    dialog(`<h3>Reset your password</h3><p class="muted" style="margin-top:-6px">Enter the phone number on your account. If it has an email on file, we'll send a reset link there.</p>
      <label class="field"><span>Phone number</span><input id="rpPhone" type="tel" inputmode="tel" placeholder="+1 555 123 4567" value="${esc(el("aPhone") ? el("aPhone").value.trim() : "")}"></label>`, "Send reset link", async () => {
      const e164 = toE164(el("rpPhone").value.trim()); if (!e164) return toast("Enter a valid phone number.");
      const btn = el("dlgOk"); btn.disabled = true; btn.textContent = "Sending…";
      try {
        await fetch(FN_BASE + "/requestPasswordReset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phoneE164: e164 }) });
        closeDialog();
        toast("If that number has an account with an email on file, a reset link is on its way.");
      } catch { btn.disabled = false; btn.textContent = "Send reset link"; toast("Couldn't send that right now, try again."); }
    });
  };
  el("authForm").onsubmit = async e => {
    e.preventDefault();
    const phone = el("aPhone").value.trim(), pass = el("aPass").value, name = el("aName").value.trim();
    // Unadvertised: accounts from before phone sign-in still have their real
    // email as the Firebase identifier. Typing that email (instead of a phone
    // number) signs them in directly, even if their profile has no phone saved.
    if (authMode === "in" && phone.includes("@")) {
      try { await signInWithEmailAndPassword(auth, phone.toLowerCase(), pass); } catch (err) { toast(authError(err)); }
      return;
    }
    const e164 = toE164(phone); if (!e164) return toast("Enter a valid phone number.");
    const authEmail = phoneAuthEmail(e164);
    try {
      if (authMode === "up") {
        if (!name) return toast("Add your name so friends recognize you.");
        if (!el("aTerms") || !el("aTerms").checked) return toast("Please agree to the Terms of Use to create an account.");
        const cred = await createUserWithEmailAndPassword(auth, authEmail, pass);
        await setDoc(doc(db, "users", cred.user.uid), { name, phone, phoneE164: e164, email: "", venmo: "", onboarded: false, createdAt: Date.now() });
      } else {
        try { await signInWithEmailAndPassword(auth, authEmail, pass); }
        catch (err) {
          // Not a phone-based account under that number -- might be one of the
          // accounts from before phone sign-in existed. Ask the server to look
          // it up by phone and verify the password itself; it hands back a
          // one-time token instead of ever revealing the account's real email.
          if (!["auth/user-not-found", "auth/invalid-credential", "auth/wrong-password"].includes(err.code)) throw err;
          const r = await fetch(FN_BASE + "/phoneSignIn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phoneE164: e164, password: pass }) });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.token) await signInWithCustomToken(auth, j.token); else throw err;
        }
      }
    } catch (err) { toast(authError(err)); }
  };
}
function authError(err) {
  const c = (err && err.code) || "";
  if (c.includes("email-already-in-use")) return "That phone number already has an account. Sign in instead.";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Phone number or password is incorrect.";
  if (c.includes("weak-password")) return "Password needs at least 6 characters.";
  if (c.includes("invalid-email")) return "That doesn't look like a valid phone number.";
  return "Couldn't do that: " + (err.message || c);
}

// ---------- password reset (from the emailed link, ?mode=resetPassword&oobCode=...) ----------
let resetState = "checking"; // "checking" | "ready" | "invalid" | "done"
function renderResetPassword(root) {
  if (resetState === "checking" && !renderResetPassword._started) {
    renderResetPassword._started = true;
    verifyPasswordResetCode(auth, RESET_OOB).then(() => { resetState = "ready"; render(); })
      .catch(() => { resetState = "invalid"; render(); });
  }
  const goHome = () => { location.href = location.origin + location.pathname; };
  const shell = inner => `<div class="auth-wrap"><canvas id="authbg" class="auth-bg"></canvas><div class="auth-card card"><div class="brand xl">${WORDMARK_XL}</div>${inner}</div></div>`;
  if (resetState === "checking") { root.innerHTML = shell(`<p class="auth-lede">Checking your reset link…</p>`); startParticles(el("authbg"), "confetti"); return; }
  if (resetState === "invalid") {
    root.innerHTML = shell(`<div style="display:flex;justify-content:center">${dot("oops", 72)}</div><p class="auth-lede">This reset link is invalid or has expired. Request a new one from the sign-in screen.</p><button class="btn primary lg" id="resetBack">Back to sign in</button>`);
    startParticles(el("authbg"), "confetti"); el("resetBack").onclick = goHome; return;
  }
  if (resetState === "done") {
    root.innerHTML = shell(`<p class="auth-lede">Password updated. Sign in with your new password.</p><button class="btn primary lg" id="resetBack">Sign in</button>`);
    startParticles(el("authbg"), "confetti"); el("resetBack").onclick = goHome; return;
  }
  root.innerHTML = shell(`<p class="auth-lede">Choose a new password.</p>
    <form id="resetForm" class="stack">
      <label class="field"><span>New password</span><input id="rNewPass" type="password" required minlength="6" placeholder="At least 6 characters" autocomplete="new-password"></label>
      <button class="btn primary lg" type="submit">Save new password</button>
    </form>`);
  startParticles(el("authbg"), "confetti");
  el("resetForm").onsubmit = async e => {
    e.preventDefault();
    const pass = el("rNewPass").value;
    try { await confirmPasswordReset(auth, RESET_OOB, pass); resetState = "done"; render(); }
    catch (err) { toast(authError(err)); }
  };
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
      ${groupIcon(g)}
      <div style="flex:1;min-width:0"><b>${esc(g.name)}</b><div class="muted sm">${esc(host)} invited you to this group</div></div>
      <button class="btn small primary" data-accept="${g.id}">Join</button>
    </div>`; }).join("")}</div>`;
}
// The tab bar only needs its status-bar backdrop while it's pinned; a sentinel
// just above it tells us when that is (CSS has no "stuck" state).
let tabsObserver = null;
function watchTabs() {
  if (tabsObserver) { tabsObserver.disconnect(); tabsObserver = null; }
  const sentinel = $(".tabs-sentinel"), tabs = $(".tabs"); if (!sentinel || !tabs || !("IntersectionObserver" in window)) return;
  tabsObserver = new IntersectionObserver(([en]) => tabs.classList.toggle("stuck", !en.isIntersecting && en.boundingClientRect.top < 0), { threshold: 0 });
  tabsObserver.observe(sentinel);
}
// Header buttons are pebbles: Dot's body shape in a flat brand color with Dot's gloss, each tilted a little
// (brand guide: Search sage, Memories sun, Friends coral, Alerts ink). The icon sits on top of the pebble.
const PEB_PATH = "M-1.5,-10.2 C2.5,-11 6.5,-9 8.2,-6.5 C10,-4 11,1 10.2,4.5 C9.4,8 6,11 1,10.6 C-3.5,10.2 -6,9.5 -8,7.5 C-10.2,5.3 -11,0 -10.4,-3.5 C-9.8,-7 -5.5,-9.6 -1.5,-10.2 Z";
const PEB_INK = "#2A2019", PEB_SUN = "#FFC145";
const PEB_FILL = { sage: "#7CC79B", sun: PEB_SUN, coral: "#FF6B57", ink: PEB_INK };
const pebIcon = inner => `<svg class="peb-ic" viewBox="0 0 28 28" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const pebStroke = (c, w = 2.3) => `stroke="${c}" stroke-width="${w}"`;
const PEB_ICONS = {
  search: c => pebIcon(`<circle cx="12.4" cy="12.4" r="6.6" ${pebStroke(c, 2.5)}/><path d="M17.4 17.4 L22 22" ${pebStroke(c, 3)}/><path d="M9.6 11 A3.2 3.2 0 0 1 11.6 9.1" ${pebStroke(c, 1.8)} opacity=".55"/>`),
  // Two polaroids: outlines only, so the pebble shows through; the front one is filled with the pebble color to hide the back one.
  memories: (c, bg) => pebIcon(`<g transform="rotate(13 17 12)"><rect x="10.5" y="3.5" width="13" height="15.5" rx="1.8" ${pebStroke(c, 2)} opacity=".6"/></g><g transform="rotate(-9 11.5 15.5)"><rect x="4.5" y="7" width="14" height="16.5" rx="1.8" fill="${bg}" ${pebStroke(c)}/><rect x="7.2" y="9.7" width="8.6" height="8.2" rx="1" fill="${c}"/><circle cx="13.4" cy="12" r="1.5" fill="${c === PEB_INK ? PEB_SUN : PEB_INK}"/></g>`),
  friends: c => pebIcon(`<circle cx="18.6" cy="9" r="3.3" ${pebStroke(c, 2.2)} opacity=".6"/><path d="M15.8 15.4 C16.6 15 17.6 14.8 18.6 14.8 C21.4 14.8 23.4 16.7 24 20.4" ${pebStroke(c, 2.2)} opacity=".6"/><circle cx="10.6" cy="10.2" r="3.9" ${pebStroke(c)}/><path d="M3.8 22.4 C4.6 18.4 7.2 16.4 10.6 16.4 C14 16.4 16.6 18.4 17.4 22.4" ${pebStroke(c)}/>`),
  bell: c => pebIcon(`<path d="M8.2 18.4 V13.2 A5.8 5.8 0 0 1 19.8 13.2 V18.4 L21.6 20.4 H6.4 Z" ${pebStroke(c, 2.4)}/><path d="M12.2 23.2 A2 2 0 0 0 15.8 23.2" ${pebStroke(c === PEB_INK ? c : PEB_SUN, 2.4)}/>`)
};
function pebble(icon, color, tilt) {
  const fill = PEB_FILL[color], ic = color === "ink" ? "#FFFEFC" : PEB_INK;
  return `<svg class="peb" viewBox="-12 -12 24 24" style="transform:rotate(${tilt}deg)" aria-hidden="true"><path transform="scale(1.05)" d="${PEB_PATH}" fill="${fill}"/><ellipse cx="-4.6" cy="-5.8" rx="3.4" ry="1.9" fill="#fff" opacity="${color === "ink" ? ".16" : ".45"}" transform="rotate(-35 -4.6 -5.8)"/></svg>${PEB_ICONS[icon](ic, fill)}`;
}
function shell(body) {
  const p = S.profile;
  const tab = S.route.name;
  const T = (name, label, path) => `<button class="tab ${tab === name ? "on" : ""}" data-go="${path}">${label}</button>`;
  return `
  ${isDemo() ? `<div class="demo-bar">${dot("happy", 26)}<span>Demo mode -- this is Riley, a shared public sandbox account. Explore freely; changes are visible to other visitors and reset nightly.</span></div>` : ""}
  <header class="topbar">
    <div class="brand has-dot"><a class="brand-home" href="#/" aria-label="Friendly home">${WORDMARK}</a><button type="button" class="brand-dot" id="brandDot" aria-label="A tip from Dot"></button></div>
    <div class="topbar-right"><button class="bell" data-go="#/search" title="Search" aria-label="Search">${pebble("search", "sage", -9)}</button><button class="bell ${tab === "photos" ? "on" : ""}" data-go="#/photos" title="Memories" aria-label="Memories">${pebble("memories", "sun", 7)}</button>${S.msgsReady ? `<button class="bell peb-coral ${tab === "messages" ? "on" : ""}" data-go="${dmUnread() && !incomingRequests().length ? "#/messages" : "#/friends"}" title="Friends" aria-label="Friends">${pebble("friends", "coral", -5)}${msgBadge() ? `<span class="badge">${msgBadge()}</span>` : ""}</button>` : ""}<button class="bell" data-go="#/activity" title="Activity" aria-label="Activity">${pebble("bell", "ink", 10)}${unreadCount() ? `<span class="badge">${unreadCount()}</span>` : ""}</button>
    <button class="me-chip" data-go="#/profile">${avatar(S.user.uid)}<span>${esc(first(p.name))}</span></button></div>
  </header>
  <div class="tabs-sentinel"></div>
  <nav class="tabs">
    ${T("home", "Home", "#/")}
    ${T("plans", "Plans", "#/plans")}
    ${T("groups", "Groups", "#/groups")}
    ${T("money", "Money", "#/money")}
    ${curateTab(tab === "curate")}
  </nav>
  <main class="wrap">${updateBanner()}${inviteBanner()}${body}</main>
  ${S.route.name === "pick" ? "" : edgeDotHtml()}`;
}
// ---- Dot at the edge: the same spot on every page. What Dot offers depends on where you are.
function edgeMenu() {
  const r = S.route, gate = window.Blip;
  if (!gate) return null;
  const item = (k, label, cls = "") => `<button type="button" data-make="${k}" ${cls ? `class="${cls}"` : ""}>${label}</button>`;
  if (r.name === "event") {
    const ev = S.events.get(r.id); if (!ev) return null;
    const mine = canManage(ev), items = [];
    if (mine) items.push(item("edit", "✨ Change something. Just tell me.", "plan-btn"));
    items.push(item("expense-here", "💸 An expense for this"));
    if (!mine) items.push(item("plan", "✨ Let me plan something new", "plan-btn"));
    items.push(item("event", "🎉 A new event"));
    items.push(item("ask", "💬 Ask me anything"));
    return { title: mine ? "What should I do?" : "What are we making?", items };
  }
  if (r.name === "group") {
    const g = S.groups.get(r.id); if (!g) return null;
    return { title: `For ${esc(g.name)}`, items: [item("plan", "✨ Let me plan it. Just tell me.", "plan-btn"), item("event", "🎉 An event for this group"), item("meeting", "📅 A meeting"), item("expense", "💸 An expense for this group"), item("ask", "💬 Ask me anything")] };
  }
  if (r.name === "groups") return { title: "What are we making?", items: [item("group", "👥 A new group"), item("plan", "✨ Let me plan something", "plan-btn"), item("event", "🎉 An event"), item("ask", "💬 Ask me anything")] };
  return { title: "What are we making?", items: [item("plan", "✨ Let me plan it. Just tell me.", "plan-btn"), item("night", "🌆 Build me a night out"), item("event", "🎉 An event"), item("meeting", "📅 A meeting"), item("expense", "💸 An expense"), item("ask", "💬 Ask me anything")] };
}
function edgeDotHtml() {
  if (S.route.name === "dm") return "";   // the chat's message box owns the bottom of the screen
  const m = edgeMenu();
  if (!m) return window.Blip ? "" : `<div class="fab-scrim"></div><button class="fab" id="fabBtn" title="Create event">＋</button>`;
  return `<div class="fab-scrim"></div><div class="edge-dot" id="edgeDot" role="button" aria-label="Make something"><div class="edge-menu"><b>${m.title}</b>${m.items.join("")}</div><span class="edge-art">${dot("idle", 66)}</span></div>`;
}
function wireEdgeDot() {
  if (el("fabBtn")) el("fabBtn").onclick = () => go("#/new");
  const ed = el("edgeDot"); if (!ed) return;
  const setMood = m => { ed.querySelector(".edge-art").innerHTML = dot(m, 66); };
  ed.onclick = e => { e.stopPropagation(); const open = !ed.classList.contains("in"); ed.classList.toggle("in", open); setMood(open ? "happy" : "idle"); };
  ed.querySelectorAll("[data-make]").forEach(b => b.onclick = e => {
    e.stopPropagation(); ed.classList.remove("in"); setMood("idle");
    const k = b.dataset.make, r = S.route;
    const gid = r.name === "group" ? r.id : "";
    if (k === "plan") openPlanDialog("event", { groupId: gid });
    else if (k === "event") { resetCompose(); if (gid) compose.groupId = gid; go("#/new"); }
    else if (k === "meeting") { resetCompose(); compose.kind = "meeting"; if (gid) compose.groupId = gid; go("#/new"); }
    else if (k === "expense") openExpense(null, null, gid || null);
    else if (k === "expense-here") { const ev = S.events.get(r.id); openExpense(r.id, ev ? ev.invitedUids : null, ev ? ev.groupId : null); }
    else if (k === "edit") { const ev = S.events.get(r.id); if (ev) openPlanDialog("edit", { ev }); }
    else if (k === "group") openGroupDialog();
    else if (k === "ask") openAskDialog();
    else if (k === "night") openNightBuilder();
  });
}
function wireShell() {
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  document.querySelectorAll('[role="button"]:not([tabindex]), [data-go]:not(a):not(button):not(input):not([tabindex])').forEach(e => { e.tabIndex = 0; });   // keyboard and screen-reader reachable
  if (el("brandDot")) el("brandDot").onclick = e => { e.stopPropagation(); showLogoTip(); };
  wireEdgeDot();
  wireUpdateBanner();
  document.querySelectorAll("[data-accept]").forEach(b => b.onclick = () => acceptInvite(b.dataset.accept, b));
  if (S.route.name === "home") { wireHomeDash(); dotIntro(); }
  if (S.route.name === "plans") wirePlans();
  dotWatch();
  if (S.route.name === "new") wireCompose();
  if (S.route.name === "groups") wireGroups();
  if (S.route.name === "group") wireGroupPage();
  if (S.route.name === "money") wireMoney();
  if (S.route.name === "curate") wireCurate();
  if (S.route.name === "expense") wireExpensePage();
  if (S.route.name === "pick") wirePick(S.route.id);
  if (S.route.name === "activity") wireActivity();
  if (S.route.name === "drafts") wireDrafts();
  if (S.route.name === "messages" && S.msgsReady) wireMessages();
  if (S.route.name === "dm" && S.msgsReady) wireDm(S.route.id);
  if (S.route.name === "friendship") wireFriendship(S.route.id);
  if (S.route.name === "photos") wirePhotosPage();
  if (S.route.name === "year") wireYear();
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
    await updateDoc(doc(db, "groups", gid), { memberUids: arrayUnion(myUid()), invitedPhones: arrayRemove(S.profile.phoneE164 || "-"), invitedEmails: arrayRemove((S.user.email || "").toLowerCase()), [`members.${myUid()}`]: { name: S.profile.name, venmo: S.profile.venmo || "", phone: S.profile.phone || "", os: myOs(), photo: myPhotoSm(), birthday: S.profile.birthday || "" } });
    toast("You're in! 🎉"); go("#/g/" + gid);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "Join the group"; }
    if (!quiet) toast("This group hasn't got you on its list yet. Ask whoever invited you to add you from their Friendly app, then tap Join again.");
  }
}
function routeBody(r) {
  if (r.name === "home") return homeBody();
  if (r.name === "plans") return plansBody();
  if (r.name === "new") return composeBody();
  if (r.name === "groups") return groupsBody();
  if (r.name === "group") return `<div class="group-page">${groupPageBody(r.id)}</div>`;
  if (r.name === "join") return joinBody(r.id);
  if (r.name === "money") return moneyBody();
  if (r.name === "curate") return curateBody();
  if (r.name === "expense") return expenseBody(r.id);
  if (r.name === "pick") return pickBody(r.id);
  if (r.name === "activity") return activityBody();
  if (r.name === "drafts") return draftsBody();
  if (r.name === "messages" && S.msgsReady) return messagesBody(r.tab);
  if (r.name === "dm" && S.msgsReady) return dmBody(r.id);
  if (r.name === "friendship") return friendshipBody(r.id);
  if (r.name === "photos") return photosPageBody();
  if (r.name === "year") return yearBody(r.y);
  if (r.name === "search") return searchBody();
  if (r.name === "profile") return profileBody();
  return homeBody();
}

// ---------- helpers for events visibility/counts ----------
const myUid = () => S.user.uid;
const phoneStatus = (ev, p) => ((ev.phoneRsvps || {})[p] || {}).status || "";
const phonePlus = (ev, p) => Number(((ev.phoneRsvps || {})[p] || {}).plus) || 0;
// Texted invitees a host has answered for sit in the guest list with everyone else; the "Not on Friendly yet" card keeps only the unanswered.
const phonesWith = (ev, k) => (ev.invitedPhones || []).filter(p => phoneStatus(ev, p) === k);
const unansweredPhones = ev => (ev.invitedPhones || []).filter(p => !phoneStatus(ev, p));
const phoneName = (ev, p) => (ev.invitedPhoneNames || {})[p] || p;
function phoneChip(ev, p, manage) {
  return `<span class="guest-chip texted" title="${esc(p)} · not on Friendly yet"><span style="display:inline-flex;align-items:center;gap:4px"><span class="avatar texted-av">💬</span>${esc(first(phoneName(ev, p)))}</span>${phonePlus(ev, p) ? `<i class="plusone">+${phonePlus(ev, p)}</i>` : ""}<i class="texted-tag">by text</i>
    ${manage ? `<button class="approve setrsvp" data-setphone="${esc(p)}" title="Mark their RSVP" aria-label="Mark ${esc(first(phoneName(ev, p)))}'s RSVP">✎</button><button class="approve remove" data-uninvitephone="${esc(p)}" title="Remove">✕</button>` : ""}</span>`;
}
// +1s: events allow them unless the host turned it off; meetings only when the host turned it on.
const plusAllowed = ev => ev.kind === "meeting" ? ev.allowPlus === true : ev.allowPlus !== false;
const plusFields = (pre, on, max) => `<div class="plus-opts"><label class="switch"><input type="checkbox" id="${pre}PlusOn" ${on ? "checked" : ""}><span>Guests can bring a +1</span></label>
  <div class="${on ? "" : "hidden"}" id="${pre}PlusMaxWrap" style="margin-top:6px"><label class="field"><span>How many each</span><select id="${pre}PlusMax">${(() => { const m = Number(max || 0), custom = m > 3; return [[1, "1 guest"], [2, "Up to 2"], [3, "Up to 3"], ["custom", "Custom number…"], [0, "No limit"]].map(([v, l]) => `<option value="${v}" ${(custom ? v === "custom" : m === v) ? "selected" : ""}>${l}</option>`).join(""); })()}</select></label>
  <label class="field ${Number(max || 0) > 3 ? "" : "hidden"}" id="${pre}PlusCustomWrap" style="margin-top:6px"><span>Up to how many each</span><input id="${pre}PlusCustom" type="number" inputmode="numeric" min="1" max="99" value="${Number(max || 0) > 3 ? Number(max) : 4}"></label></div></div>`;
// The +1 limit as a number (0 = no limit), reading the custom box when "Custom number…" is picked.
const plusMaxVal = pre => { const s = el(pre + "PlusMax"); if (!s) return 0; if (s.value !== "custom") return Number(s.value) || 0; const n = Math.round(Number((el(pre + "PlusCustom") || {}).value)); return n > 0 ? Math.min(n, 99) : 0; };
const wirePlusFields = pre => {
  const c = el(pre + "PlusOn"); if (c) c.onchange = () => { el(pre + "PlusMaxWrap").classList.toggle("hidden", !c.checked); if (pre === "c") compose.plusOn = c.checked; };
  const m = el(pre + "PlusMax"), box = el(pre + "PlusCustom");
  const keep = () => { if (pre === "c") { compose.plusMax = plusMaxVal("c"); saveDraft(); } };
  if (m) m.onchange = () => { el(pre + "PlusCustomWrap").classList.toggle("hidden", m.value !== "custom"); if (m.value === "custom" && box) box.focus(); keep(); };
  if (box) box.oninput = keep;
};
// The faces on a tile are the people its count names: who's going (or, before anyone has answered, who's
// invited), so "+2 · 5 going" adds up. Faces stay private until you've answered.
function tileFaces(ev, word = "going") {
  const r = ev.rsvps || {}, inv = ev.invitedUids || [], goers = inv.filter(u => r[u] === "going");
  const going = ev.kind === "meeting" ? goers.length : goingCount(ev), byInvite = !going && inv.length > 0;
  const pool = byInvite ? inv : goers, shown = canSeeGuests(ev) ? pool.slice(0, 3) : [], more = (byInvite ? inv.length : going) - shown.length;
  return { faces: shown.map(u => avatar(u, "xs")).join("") + (shown.length && more > 0 ? `<span class="more">+${more}</span>` : ""),
    label: byInvite ? `${inv.length} invited` : `${going} ${word}${ev.capacity > 0 ? " / " + ev.capacity : ""}` };
}
function goingCount(ev) { return (ev.invitedUids || []).reduce((t, u) => (ev.rsvps || {})[u] === "going" ? t + 1 + (((ev.plusOnes || {})[u]) || 0) : t, 0) + (ev.invitedPhones || []).filter(p => phoneStatus(ev, p) === "going").reduce((t, p) => t + 1 + phonePlus(ev, p), 0); }
function isFull(ev) { return ev.capacity > 0 && goingCount(ev) >= ev.capacity; }
function canManage(ev) { if (ev._manage != null) return ev._manage; return ev.hostId === myUid() || (ev.cohostUids || []).includes(myUid()); }
// An event belongs on a group's page when it was planned for that group, or when every member
// of the group is on its invite list (hand-picked, or planned for a bigger group that includes them).
function evInGroup(e, g) {
  if (!g) return false;
  if (e.groupId === g.id) return true;
  const mem = g.memberUids || [], inv = new Set(e.invitedUids || []);
  return mem.length >= 2 && mem.every(u => inv.has(u));
}
function myEvents() {
  return [...S.events.values()].filter(ev => (ev.invitedUids || []).includes(myUid()) || (ev.groupId && S.groups.has(ev.groupId)));
}

// ---------- HOME ----------
let homeFilter = "all";
let homeView = "cards"; try { homeView = LS.get("friendlyHomeView") || "cards"; } catch {} // "cards" | "calendar"
bootDiag.then(() => { homeView = LS.get("friendlyHomeView") || homeView; if (LS.get("friendlyKnown")) authMode = "in"; });
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
// Upcoming events I was texted an invite to but haven't joined (see the phoneEvents listener).
const unjoinedEvents = () => [...((S.phoneEvents || new Map()).values())].filter(e => e.date >= todayStr() && !S.events.has(e.id) && !(e.invitedUids || []).includes(myUid()));

// ---------- HOME (the dashboard) ----------
// What's next, what needs you, money at a glance, Dot's picks, the week, memories, the latest, and your crews.
const inDaysWord = ev => { const d = daysUntil(ev); return d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`; };
const hdFaces = ev => { const g = (ev.invitedUids || []).filter(u => (ev.rsvps || {})[u] === "going"); if (!canSeeGuests(ev) || !g.length) return ""; return `<span class="hd-faces">${g.slice(0, 3).map(u => avatar(u, "xs")).join("")}${g.length > 3 ? `<span class="more">+${g.length - 3}</span>` : ""}</span>`; };
function homeBody() {
  const me = myUid(), t = todayStr();
  const evs = [...myEvents(), ...unjoinedEvents()];
  const upcoming = evs.filter(e => e.date >= t).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  let hiddenToday = []; try { hiddenToday = JSON.parse(LS.get("friendlyTodayHidden") || "[]"); } catch {}
  const todayEvs = upcoming.filter(e => e.date === t && !hiddenToday.includes(e.id + "|" + e.date)).slice(0, 2);
  const todayHero = todayEvs.find(e => !liveWindow(e).phase) || null;
  const todayCards = todayEvs.filter(e => e !== todayHero).map(e => liveWindow(e).phase ? liveCard(e) : `<div class="card notif-card today-card" data-ev="${e.id}" role="button"><button type="button" class="today-x" data-hide-today="${e.id}|${e.date}" aria-label="Hide this">✕</button>${dotHat(56)}<div style="flex:1;min-width:0"><div class="eyebrow-sm">Today</div><b>${esc(e.title)}${e.time ? " · " + fmtTime(e.time) : ""}</b><div class="muted sm">${e.kind === "meeting" ? (e.invitedUids || []).filter(u => (e.rsvps || {})[u] === "going").length + " accepted" : goingCount(e) + " going"}${evStops(e).length ? " · " + evStops(e).length + " stops" : e.location ? " · " + esc(placeName(e.location)) : ""}</div></div><span class="chev">›</span></div>`).join("");
  if ((S.profile.city || "").trim()) ensureCurated();
  const mine = upcoming.filter(e => !e._unjoined), weekEnd = addDays(t, (7 - new Date().getDay()) % 7);
  const hero = todayHero || mine.find(e => !todayEvs.includes(e) && !hiddenToday.includes(e.id + "|" + e.date)) || null;
  const rest = mine.filter(e => e !== hero && !todayEvs.includes(e));
  const inWeek = rest.filter(e => e.date <= weekEnd), week = (inWeek.length ? inWeek : rest).slice(0, 3), weekLabel = inWeek.length ? "This week" : "Coming up";
  const weekCount = mine.filter(e => e.date <= weekEnd).length;
  const hour = new Date().getHours(), dow = new Date().getDay(), weekend = dow >= 5 || dow === 0;
  const greet = hour < 4 ? "Up late" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const dateLine = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const plansLine = weekCount ? `${weekCount} plan${weekCount === 1 ? "" : "s"} this week` : "nothing on the calendar this week";
  // Weekends are Coral's: she takes the greeting.
  const head = weekend ? `<div><h1>It's ${new Date().toLocaleDateString("en-US", { weekday: "long" })}, ${esc(first(S.profile.name))}.</h1><p class="muted sm">What are we doing? · ${plansLine}</p></div>${coral("happy", 54)}`
    : `<div><h1>${greet}, ${esc(first(S.profile.name))}</h1><p class="muted sm">${dateLine} · ${plansLine}</p></div>${dot("happy", 54)}`;
  return `
  <header class="hd-greet">${head}</header>
  ${weekDigest(mine)}
  ${notifCard()}${hero && hero.date === t ? heroCard(hero) : ""}${todayCards}${afterCard()}${birthdayCard()}
  ${askBox()}${asksSection()}
  ${hero && hero.date !== t ? heroCard(hero) : hero || mine.length || todayEvs.length ? "" : `<div class="card empty">${dot("sleepy", 84)}<b>No plans yet</b><p class="muted">Tell Dot what you're thinking, or start one from scratch.</p><div class="btnrow" style="justify-content:center"><button class="btn primary" id="homeTell">Tell Dot</button><button class="btn" data-go="#/new">New event</button></div></div>`}
  ${needsYou()}
  ${moneyGlance()}
  ${curateTray(upcoming, false)}
  ${week.length ? `<div class="hd-h"><h3>${weekLabel}</h3><a class="hd-link" data-go="#/plans">All plans ›</a></div><div class="card hd-list">${week.map(ev => `<a class="hd-ev" data-ev="${ev.id}"><span class="hd-date"><b>${ev.date === t ? "Today" : evDate(ev).toLocaleDateString("en-US", { weekday: "short" })}</b><span>${evDate(ev).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span></span><span class="hd-evt"><b>${esc(ev.emoji || "")} ${esc(ev.title)}</b><span class="muted sm">${esc(fmtTime(ev.time))}${placeName(ev.location) ? " · " + esc(placeName(ev.location)) : ""}</span></span>${hdFaces(ev)}</a>`).join("")}</div>` : ""}
  ${memoriesStrip()}${yearCard()}
  ${latestList()}
  ${crewsRow()}`;
}
// ---------- A YEAR WITH THE CREW (the recap page: #/year or #/year/2025) ----------
function yearData(y) {
  const me = myUid(), t = todayStr(), year = String(y || new Date().getFullYear());
  const mine = ev => ev.kind !== "meeting" && ev.date && ev.date.startsWith(year) && ev.date <= t && (ev.invitedUids || []).includes(me) && (ev.hostId === me || (ev.rsvps || {})[me] === "going");
  const plans = [...S.events.values()].filter(mine).sort((a, b) => a.date.localeCompare(b.date));
  const going = ev => [...new Set([ev.hostId, ...(ev.invitedUids || []).filter(u => (ev.rsvps || {})[u] === "going")])].filter(u => u && u !== me);
  const count = (list, key) => { const m = new Map(); list.forEach(x => { const k = key(x); if (k) m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const people = count(plans.flatMap(going), u => u), spots = count(plans, ev => evStops(ev).length ? (evStops(ev)[0].name || evStops(ev)[0].place) : placeName(ev.location)), months = count(plans, ev => ev.date.slice(5, 7)), crews = count(plans, ev => ev.groupId);
  const photos = plans.flatMap(ev => (S.memories.get(ev.id) || []).filter(p => p.img).map(p => ({ p, ev }))), shooters = count(photos, x => x.p.addedBy);
  const xs = [...S.expenses.values()].filter(x => (x.involved || []).includes(me) && x.createdAt && new Date(x.createdAt).getFullYear() === +year), spent = xs.reduce((n, x) => n + (x.amountCents || 0), 0);
  const biggest = plans.slice().sort((a, b) => goingCount(b) - goingCount(a))[0], hosted = plans.filter(ev => ev.hostId === me).length;
  return { year, plans, photos, spent, friends: people.length, people, spots, months, crews, shooters, biggest, hosted, xs };
}
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function yearBody(y) {
  const d = yearData(y), me = myUid();
  if (!d.plans.length) return `<button class="link-back" data-go="#/">‹ Back</button><div class="card empty">${dot("sleepy", 84)}<b>Nothing to recap yet</b><p class="muted">Plans you went to in ${esc(d.year)} will show up here.</p></div>`;
  if (!S._yearMem) { S._yearMem = true; loadMemories(false).then(() => { if (S.route.name === "year") render(); }); }
  const top = d.people[0], spot = d.spots[0], month = d.months[0], crew = d.crews[0] && S.groups.get(d.crews[0][0]), shooter = d.shooters[0];
  const stat = (n, l) => `<div class="yr-stat"><b>${n}</b><span>${l}</span></div>`;
  const tile = (k, v, s, go) => `<${go ? "a" : "div"} class="card yr-tile" ${go ? `data-go="${esc(go)}"` : ""}><span class="muted sm">${k}</span><b>${v}</b><span class="muted sm">${s}</span></${go ? "a" : "div"}>`;
  const when = ev => evDate(ev).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const firsts = [["🥇", "First plan of the year", `${esc(d.plans[0].title)} · ${when(d.plans[0])}`, d.plans[0].id]];
  if (d.biggest && goingCount(d.biggest) >= 3) firsts.push(["🎉", "Biggest crowd", `${esc(d.biggest.title)} · ${goingCount(d.biggest)} people`, d.biggest.id]);
  const hostedFirst = d.plans.find(ev => ev.hostId === me); if (hostedFirst) firsts.push(["🏠", "First one you hosted", `${esc(hostedFirst.title)} · ${when(hostedFirst)}`, hostedFirst.id]);
  const priciest = d.xs.slice().sort((a, b) => (b.amountCents || 0) - (a.amountCents || 0))[0]; if (priciest) firsts.push(["🧾", "Biggest tab", `${esc(priciest.desc || "Expense")} · ${fmt$(priciest.amountCents)}`, "x:" + priciest.id]);
  const latest = d.plans[d.plans.length - 1]; if (latest !== d.plans[0]) firsts.push(["🗓️", "Most recent", `${esc(latest.title)} · ${when(latest)}`, latest.id]);
  const pics = d.photos.slice().sort(() => 0.5 - Math.random()).slice(0, 9);
  return `<button class="link-back" data-go="#/">‹ Back</button>
  <div class="yr-hero"><div class="yr-k">YOUR ${esc(d.year)}</div><h1>A year with the crew</h1><div class="yr-pair">${dot("party", 64)}${coral("party", 64)}</div><p>${d.plans.length} plan${d.plans.length === 1 ? "" : "s"}. ${d.photos.length} photo${d.photos.length === 1 ? "" : "s"}. ${d.friends ? `${d.friends} friend${d.friends === 1 ? "" : "s"} along for the ride.` : "Just getting started."}</p></div>
  <div class="yr-stats">${stat(d.plans.length, "plans")}${stat(d.photos.length, "photos")}${stat(d.spent ? fmt$(d.spent).replace(/\.00$/, "") : "$0", "split, zero fights")}${stat(d.friends, "friends along")}</div>
  ${top ? `<a class="card yr-top" data-go="#/fs/${esc(top[0])}">${avatar(top[0], "lg")}<div style="flex:1;min-width:0"><span class="muted sm">Most plans with</span><b>${esc(nameOf(top[0]))} · ${top[1]} together</b><span class="hd-link">Our Friendlyship ›</span></div></a>` : ""}
  <div class="yr-two">${spot ? tile("Your spot", esc(spot[0]), spot[1] === 1 ? "Once. So far." : `${spot[1]} times. They know your order.`) : ""}${month ? tile("Busiest month", MONTH_NAMES[+month[0] - 1], `${month[1]} plan${month[1] === 1 ? "" : "s"}.`) : ""}</div>
  <div class="yr-two">${crew ? tile("Top crew", `${groupMini(crew)} ${esc(crew.name)}`, `${d.crews[0][1]} plan${d.crews[0][1] === 1 ? "" : "s"}`, "#/g/" + crew.id) : ""}${shooter ? tile("Camera roll MVP", esc(shooter[0] === me ? "You" : first(nameOf(shooter[0]))), `${shooter[1]} photo${shooter[1] === 1 ? "" : "s"} added`) : d.hosted ? tile("You hosted", d.hosted + (d.hosted === 1 ? " plan" : " plans"), "The crew owes you one.") : ""}</div>
  <div class="hd-h"><h3>Firsts and bests</h3></div><div class="card hd-list">${firsts.map(([i, k, v, id]) => `<a class="member-row" data-go="${id.startsWith("x:") ? "#/x/" + esc(id.slice(2)) : "#/e/" + esc(id)}"><span class="li">${i}</span><div style="flex:1;min-width:0"><div class="muted sm">${k}</div><b>${v}</b></div><span class="chev">›</span></a>`).join("")}</div>
  ${pics.length ? `<div class="hd-h"><h3>The year in pictures</h3><a class="hd-link" data-go="#/photos">All memories ›</a></div><div class="yr-grid">${pics.map(x => `<img src="${esc(x.p.img)}" data-ymem="${esc(x.ev.id)}|${esc(x.p.id)}" alt="" loading="lazy">`).join("")}</div>` : S._memLoading ? `<p class="muted sm">Gathering photos…</p>` : ""}
  <div class="btnrow" style="margin-top:18px;justify-content:center"><button class="btn primary" id="yrShare">Share the recap</button></div>
  <p class="muted sm" style="text-align:center;margin-top:10px">Counts plans you went to, photos on their walls, and tabs you were on.</p>`;
}
function wireYear() {
  document.querySelectorAll("[data-ymem]").forEach(im => im.onclick = () => { const [eid, pid] = im.dataset.ymem.split("|"); const ev = S.events.get(eid), p = (S.memories.get(eid) || []).find(x => x.id === pid); if (ev && p) openPhoto(ev, p); });
  if (el("yrShare")) el("yrShare").onclick = () => shareYearCard(S.route.y);
}
// Draws a share card (stats on cream, with a strip of the year's photos) and hands it to the share sheet.
async function shareYearCard(y) {
  const d = yearData(y), W = 1080, H = 1350, c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
  g.fillStyle = "#FFFEFC"; g.fillRect(0, 0, W, H); g.fillStyle = "#7CC79B"; g.fillRect(0, 0, W, 300);
  g.fillStyle = "#2A2019"; g.font = "700 34px -apple-system, Instrument Sans, sans-serif"; g.fillText("YOUR " + d.year + " ON FRIENDLY", 72, 110);
  g.font = "800 88px -apple-system, Bricolage Grotesque, sans-serif"; g.fillText("A year with the crew", 72, 215);
  const stats = [[d.plans.length, "plans"], [d.photos.length, "photos"], [d.spent ? fmt$(d.spent).replace(/\.00$/, "") : "$0", "split, zero fights"], [d.friends, "friends along"]];
  stats.forEach(([n, l], i) => { const x = 72 + (i % 2) * 480, yy = 400 + Math.floor(i / 2) * 210; g.fillStyle = "#FFFFFF"; g.beginPath(); g.roundRect(x, yy, 440, 170, 28); g.fill(); g.fillStyle = "#2A2019"; g.font = "800 72px -apple-system, Bricolage Grotesque, sans-serif"; g.fillText(String(n), x + 32, yy + 92); g.fillStyle = "#7A6B5F"; g.font = "600 30px -apple-system, Instrument Sans, sans-serif"; g.fillText(l, x + 32, yy + 140); });
  const lines = []; if (d.people[0]) lines.push(`Most plans with ${first(nameOf(d.people[0][0]))} · ${d.people[0][1]} together`); if (d.spots[0]) lines.push(`Your spot: ${d.spots[0][0]}`); if (d.months[0]) lines.push(`Busiest month: ${MONTH_NAMES[+d.months[0][0] - 1]}`);
  g.fillStyle = "#2A2019"; g.font = "600 36px -apple-system, Instrument Sans, sans-serif"; lines.forEach((l, i) => g.fillText(l, 72, 880 + i * 56));
  const pics = d.photos.slice(0, 4); let x = 72; for (const { p } of pics) { try { const im = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = p.img; }); const s = 220, r = Math.max(s / im.width, s / im.height); g.save(); g.beginPath(); g.roundRect(x, 1070, s, s, 24); g.clip(); g.drawImage(im, x + (s - im.width * r) / 2, 1070 + (s - im.height * r) / 2, im.width * r, im.height * r); g.restore(); x += s + 24; } catch {} }
  g.fillStyle = "#FF6B57"; g.font = "800 30px -apple-system, Instrument Sans, sans-serif"; g.fillText("officialfriendly.com", 72, 1318);
  const blob = await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.9)); if (!blob) return toast("Couldn't make the card.");
  const file = new File([blob], `friendly-${d.year}.jpg`, { type: "image/jpeg" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: `My ${d.year} with the crew` }); return; } catch (e) { if (e.name === "AbortError") return; } }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); toast("Saved the recap card.");
}
// A nudge toward the recap in December and the first two weeks of January.
function yearCard() {
  const m = new Date().getMonth(), day = new Date().getDate(); if (!(m === 11 || (m === 0 && day <= 15))) return "";
  const y = m === 0 ? new Date().getFullYear() - 1 : new Date().getFullYear(); let hidden = ""; try { hidden = LS.get("friendlyYearHidden") || ""; } catch {}
  if (hidden === String(y)) return ""; const d = yearData(y); if (d.plans.length < 3) return "";
  return `<a class="card yr-link" data-go="#/year/${y}"><button type="button" class="today-x" data-hide-year="${y}" aria-label="Hide this">✕</button>${dot("party", 34)}${coral("party", 34)}<span style="flex:1;min-width:0"><b>Your ${y} with the crew</b><span class="muted sm">${d.plans.length} plans, ${d.photos.length} photos. See the recap.</span></span><span class="chev">›</span></a>`;
}
// ---------- YOUR WEEK (the Sunday-night rundown; Dot also sends one push at 6 PM) ----------
// Shows from Sunday 6 PM through Monday for the week starting Monday. ✕ hides that week's digest on this phone.
function digestWeek() {
  const now = new Date(), dow = now.getDay(), t = todayStr();
  if (!((dow === 0 && now.getHours() >= 18) || dow === 1)) return null;
  const mon = dow === 0 ? addDays(t, 1) : t; return { mon, sun: addDays(mon, 6) };
}
function weekDigest(mine) {
  const wk = digestWeek(); if (!wk) return "";
  let hidden = ""; try { hidden = LS.get("friendlyDigestHidden") || ""; } catch {}
  if (hidden === wk.mon) return "";
  const me = myUid(), rows = [];
  const dateChip = d => `<span class="hd-date"><b>${evDate({ date: d }).toLocaleDateString("en-US", { weekday: "short" })}</b><span>${evDate({ date: d }).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span></span>`;
  for (const ev of mine.filter(e => e.date >= wk.mon && e.date <= wk.sun && (e.rsvps || {})[me] !== "no").slice(0, 5)) {
    const noAnswer = ev.hostId !== me && !(ev.rsvps || {})[me];
    rows.push({ date: ev.date, html: `<div class="wk-row">${dateChip(ev.date)}<div class="hd-evt"><b>${esc(ev.emoji || "")} ${esc(ev.title)}</b><span class="muted sm">${esc(fmtTime(ev.time) || "")}${noAnswer ? (ev.time ? " · " : "") + "you haven't answered" : ev.hostId === me ? (ev.time ? " · " : "") + "you're hosting" : ""}</span></div>${noAnswer ? `<a class="btn primary small" data-go="#/e/${esc(ev.id)}?to=rsvpCard">RSVP</a>` : hdFaces(ev)}</div>` });
  }
  for (const b of upcomingBirthdays(8).filter(b => b.date >= wk.mon && b.date <= wk.sun).slice(0, 2)) {
    rows.push({ date: b.date, html: `<div class="wk-row">${dateChip(b.date)}<div class="hd-evt"><b>🎂 ${esc(first(b.name))}'s birthday</b><span class="muted sm">Plan something?</span></div><a class="btn small" data-go="#/new">Plan</a></div>` });
  }
  for (const a of [...(S.asks || new Map()).values()].filter(a => a.status === "open" && (a.expiresAt || 0) > Date.now() && a.by !== me && a.date >= wk.mon && a.date <= wk.sun).slice(0, 2)) {
    const ins = (a.ins || []).filter(u => u !== a.by), im = ins.includes(me);
    rows.push({ date: a.date, html: `<div class="wk-row">${dateChip(a.date)}<div class="hd-evt"><b>${esc(first(nameOf(a.by)))} is free ${esc(a.whenLabel || "")}</b><span class="muted sm">${a.text ? esc(a.text) + " · " : ""}Up for it${ins.length ? ", " + ins.length + " in" : ""}</span></div>${im ? `<span class="pill ok">You're in</span>` : `<button type="button" class="btn small" data-askin="${esc(a.id)}">I'm in</button>`}</div>` });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const pairs = pairwise(), owe = pairs.filter(p => p.from === me), owed = pairs.filter(p => p.to === me);
  const iOwe = owe.reduce((n, p) => n + p.amount, 0), toMe = owed.reduce((n, p) => n + p.amount, 0);
  const money = iOwe || toMe ? `<a class="wk-money" data-go="#/money?to=settleCard"><span>💸</span><div style="flex:1;min-width:0">${toMe ? `<b>${owed.length === 1 ? esc(first(nameOf(owed[0].from))) + " owes you " + fmt$(toMe) : owed.length + " friends owe you " + fmt$(toMe)}</b>` : ""}${toMe && iOwe ? " · " : ""}${iOwe ? `<span class="${toMe ? "muted sm" : ""}">you owe ${owe.length === 1 ? esc(first(nameOf(owe[0].to))) + " " : ""}${fmt$(iOwe)}</span>` : toMe ? `<span class="muted sm">you owe nobody</span>` : ""}</div><span class="btn small">${iOwe ? "Settle up" : "Remind"}</span></a>` : "";
  const picks = [...(S.splits || new Map()).values()].filter(x => x.status === "open" && ((x.uids || []).includes(me) || x.paidBy === me)).slice(0, 2).map(x => { const left = (x.people || []).filter(u => !(x.done || {})[u]).length, meDone = !!(x.done || {})[me] || x.paidBy === me; return `<a class="wk-money" data-go="#/pick/${esc(x.id)}"><span>🧾</span><div style="flex:1;min-width:0"><b>${esc(x.desc || x.merchant || "Receipt")}</b> · <span class="muted sm">${meDone ? `${left} ${left === 1 ? "person hasn't" : "people haven't"} picked yet` : "you haven't picked yet"}</span></div><span class="btn small">${meDone ? "Open" : "Pick"}</span></a>`; }).join("");
  if (!rows.length && !money && !picks) return "";
  const range = `${evDate({ date: wk.mon }).toLocaleDateString("en-US", { month: "short", day: "numeric" })} to ${evDate({ date: wk.sun }).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return `<div class="card wk-card" id="digestCard"><button type="button" class="today-x" data-hide-digest="${esc(wk.mon)}" aria-label="Hide this week's rundown">✕</button>
    <div class="wk-head">${dot("happy", 40)}<div><b>Your week</b><div class="muted sm">Sunday night rundown · ${range}</div></div></div>
    ${rows.length ? `<div class="wk-list">${rows.map(r => r.html).join("")}</div>` : `<p class="muted sm" style="margin:8px 0 0">Nothing on the calendar yet. Post an Up for it and see who bites.</p>`}
    ${money}${picks}
    <p class="muted sm wk-foot">Dot sends this every Sunday at 6 PM. <a class="hd-link" data-go="#/profile?to=notifPrefs">Change</a></p></div>`;
}
function wireDigest() {
  document.querySelectorAll("[data-hide-year]").forEach(b => b.onclick = e => { e.stopPropagation(); e.preventDefault(); try { LS.set("friendlyYearHidden", b.dataset.hideYear); } catch {} render(); });
  document.querySelectorAll("[data-hide-digest]").forEach(b => b.onclick = e => { e.stopPropagation(); try { LS.set("friendlyDigestHidden", b.dataset.hideDigest); } catch {} render(); });
}
// ---------- LIVE LAYER (the hours around a plan: statuses, who's where, the morning after) ----------
// Statuses are the day-of card's status comments (kind "status": omw | late | here | clear, late carries mins).
function liveWindow(ev) {
  if (!ev || !ev.date) return { phase: null };
  const [y, m, d] = ev.date.split("-").map(Number), [sh, sm] = (ev.time || "09:00").split(":").map(Number);
  const start = new Date(y, m - 1, d, sh, sm).getTime();
  const end = ev.endTime ? new Date(y, m - 1, d, ...ev.endTime.split(":").map(Number)).getTime() : start + 4 * 3600e3;
  const now = Date.now(), H = 3600e3;
  const phase = now < start - 3 * H ? null : now < start ? "soon" : now <= end ? "now" : now <= end + 20 * H ? "after" : null;
  return { start, end, phase };
}
const LIVE_LABEL = { omw: "On my way", late: "Running late", here: "I'm here" }, LIVE_ICON = { omw: "🚗", late: "⏰", here: "📍" };
const liveLatest = rows => { const latest = {}; (rows || []).forEach(c => { if (c.kind !== "status") return; if (!latest[c.authorId] || latest[c.authorId].createdAt < c.createdAt) latest[c.authorId] = c; });
  return Object.fromEntries(Object.entries(latest).filter(([, c]) => c.status !== "clear" && Date.now() - c.createdAt < 18 * 3600e3)); };
const lateWord = c => c.status === "late" ? (c.mins ? `running ${c.mins} min late` : "running late") : c.status === "here" ? "here" : "on the way";
// Home keeps one small listener on today's plan so Who's where stays current without opening the event.
function ensureLiveSub(ev) {
  if (S._live && S._live.id === ev.id) return;
  if (S._liveUnsub) { S._liveUnsub(); S._liveUnsub = null; }
  S._live = { id: ev.id, rows: [] };
  try { S._liveUnsub = onSnapshot(query(subCol(ev, "comments"), where("kind", "==", "status")), snap => { S._live = { id: ev.id, rows: snap.docs.map(d => ({ id: d.id, ...d.data() })) }; if (S.route.name === "home") renderSoon(); }, () => {}); S.subs.push(() => S._liveUnsub && S._liveUnsub()); } catch {}
}
function liveCard(ev) {
  ensureLiveSub(ev);
  const me = myUid(), { start, phase } = liveWindow(ev), host = ev.hostId, iHost = host === me;
  const latest = liveLatest((S._live && S._live.id === ev.id) ? S._live.rows : []), mine = latest[me];
  const mins = Math.max(1, Math.round((start - Date.now()) / 60000));
  const when = phase === "now" ? "Happening now" : mins < 60 ? `in ${mins} min` : `in ${Math.round(mins / 60)}h`;
  const people = [...new Set([host, ...(ev.invitedUids || []).filter(u => (ev.rsvps || {})[u] === "going")])];
  const here = people.filter(u => (latest[u] && latest[u].status === "here") || (u === host && !latest[u]));
  const way = people.filter(u => latest[u] && (latest[u].status === "omw" || latest[u].status === "late"));
  const notYet = people.filter(u => !here.includes(u) && !way.includes(u));
  const hostName = first(nameOf(host)), hostPhone = !iHost && (payInfoOf(host).phone || "");
  const where = evStops(ev).length ? evStops(ev)[0] : null, dir = where ? stopMapUrl(where) : ev.location && !/zoom|meet\.google|teams|http|online|call/i.test(ev.location) ? "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(ev.location) : "";
  const line = mine ? (mine.status === "here" ? "You're here 🎉" : `You're ${lateWord(mine)}. ${iHost ? "Your guests" : hostName} can see that.`) : iHost ? "Tap one and your guests will know." : `Tap one so ${hostName} isn't guessing.`;
  const row = (label, list, extra = "") => list.length ? `<div class="lv-row"><b>${label} (${list.length})</b><span class="hd-faces">${list.slice(0, 6).map(u => avatar(u, "xs")).join("")}${list.length > 6 ? `<span class="more">+${list.length - 6}</span>` : ""}</span>${extra}</div>` : "";
  const lateNotes = way.filter(u => latest[u].status === "late").map(u => `${first(nameOf(u))} ${latest[u].mins ? latest[u].mins + " min" : "late"}`).join(" · ");
  return `<div class="card lv-card" data-live="${esc(ev.id)}">
    <div class="lv-head"><span class="hd-chip dark">${phase === "now" ? "Now" : "Today"}${ev.time ? " · " + fmtTime(ev.time) : ""}</span><span class="muted sm">${when}</span><button type="button" class="today-x" data-hide-today="${esc(ev.id)}|${esc(ev.date)}" aria-label="Hide this">✕</button></div>
    <h2 class="lv-title" data-ev="${esc(ev.id)}">${ev.emoji ? esc(ev.emoji) + " " : ""}${esc(ev.title)}</h2>
    <div class="muted sm">${where ? esc(where.name || where.place || "") : ev.location ? esc(ev.location) : (goingCount(ev) + " going")}</div>
    <div class="lv-status">${["omw", "late", "here"].map(k => `<button type="button" class="lv-st ${mine && mine.status === k ? "on" : ""}" data-lstatus="${k}" data-lev="${esc(ev.id)}" aria-pressed="${mine && mine.status === k ? "true" : "false"}">${LIVE_ICON[k]} ${LIVE_LABEL[k]}</button>`).join("")}</div>
    <div class="muted sm lv-line">${line}</div>
    <div class="lv-who">${row("Here", here)}${row("On the way", way, lateNotes ? `<span class="muted sm lv-late">${esc(lateNotes)}</span>` : "")}${row("Not yet", notYet)}</div>
    <div class="lv-btns">${dir ? `<a class="btn small" href="${esc(dir)}" target="_blank" rel="noopener">Directions</a>` : ""}${hostPhone ? `<a class="btn small" href="${esc(smsLink([hostPhone], `Hey ${hostName}! `))}">Text ${esc(hostName)}</a>` : ""}<a class="btn primary small" data-go="#/e/${esc(ev.id)}">Open</a></div></div>`;
}
// Post a status from anywhere (Home live card or the event's Day-of card). Tapping the one you're on clears it.
async function postStatus(ev, status, current) {
  const me = myUid(), post = async (st, mins) => { await addDoc(subCol(ev, "comments"), { kind: "status", status: st, ...(mins ? { mins } : {}), authorId: me, authorName: S.profile.name, text: "", createdAt: Date.now() });
    toast(st === "clear" ? "Status cleared" : st === "late" ? "Everyone can see you're running late" : st === "here" ? "You made it 🎉" : "Everyone can see you're on the way", null, null, st === "here" ? "coral:party" : undefined); };
  if (current === status) return post("clear");
  if (status !== "late") return post(status);
  dialog(`<h3>Running late</h3><p class="muted" style="margin-top:-6px">About how long?</p><div class="chiprow" id="lateMins" style="flex-wrap:wrap;overflow:visible">${[10, 20, 30, 45].map(m => `<button type="button" class="fchip" data-lm="${m}">${m} min</button>`).join("")}<button type="button" class="fchip" data-lm="0">Not sure</button></div>`, null);
  document.querySelectorAll("[data-lm]").forEach(b => b.onclick = async () => { closeDialog(); try { await post("late", +b.dataset.lm || 0); } catch (e) { toast(e.message); } });
}
function wireLive() {
  document.querySelectorAll("[data-lstatus]").forEach(b => b.onclick = async () => { const ev = S.events.get(b.dataset.lev); if (!ev) return; const cur = (liveLatest((S._live || {}).rows)[myUid()] || {}).status || ""; b.disabled = true; try { await postStatus(ev, b.dataset.lstatus, cur); } catch (e) { toast(e.message); } b.disabled = false; });
  document.querySelectorAll(".lv-title[data-ev]").forEach(a => a.onclick = () => go("#/e/" + a.dataset.ev));
  document.querySelectorAll("[data-hide-after]").forEach(b => b.onclick = e => { e.stopPropagation(); let h = []; try { h = JSON.parse(LS.get("friendlyAfterHidden") || "[]"); } catch {} h = [...h, b.dataset.hideAfter].slice(-30); try { LS.set("friendlyAfterHidden", JSON.stringify(h)); } catch {} render(); });
}
// The morning after: one card for the plan that just ended, with photos and the tab.
function afterCard() {
  const me = myUid(); let hidden = []; try { hidden = JSON.parse(LS.get("friendlyAfterHidden") || "[]"); } catch {}
  const ev = myEvents().filter(e => liveWindow(e).phase === "after" && !hidden.includes(e.id) && (e.rsvps || {})[me] !== "no").sort((a, b) => liveWindow(b).end - liveWindow(a).end)[0];
  if (!ev) return "";
  const pics = S.memories.get(ev.id) || [], others = [...new Set(pics.map(p => p.addedBy).filter(u => u && u !== me))];
  const evening = parseInt((ev.time || "12:00").split(":")[0], 10) >= 17;
  const owe = [...S.expenses.values()].filter(x => x.eventId === ev.id && x.paidBy !== me && !(x.paid || {})[me]).reduce((n, x) => n + (x.shares ? (x.shares[me] || 0) : ((x.split || []).includes(me) ? Math.round(x.amountCents / x.split.length) : 0)), 0);
  return `<div class="card lv-after"><button type="button" class="today-x" data-hide-after="${esc(ev.id)}" aria-label="Hide this">✕</button><div class="lv-after-h">${coral("party", 46)}<div style="flex:1;min-width:0"><b>${evening ? "Last night was a good one." : "That was a good one."}</b><div class="muted sm">Add your photos from ${esc(ev.title)}.${others.length ? ` ${esc(andNames(others.map(u => first(nameOf(u)))))} already added ${pics.length}.` : ""}</div></div></div>
    ${pics.length ? `<div class="hd-scroll hd-mems lv-after-pics">${pics.filter(p => p.img).slice(0, 6).map(p => `<img src="${esc(p.img)}" data-hdmem="${esc(ev.id)}|${esc(p.id)}" alt="" loading="lazy">`).join("")}</div>` : ""}
    <div class="lv-btns"><a class="btn primary small" data-go="#/e/${esc(ev.id)}?to=photosCard">Add photos</a>${owe ? `<a class="btn small" data-go="#/money?to=settleCard">Settle up ${fmt$(owe)}</a>` : `<a class="btn small" data-go="#/e/${esc(ev.id)}?to=wall">Say thanks</a>`}</div></div>`;
}
// ---------- UP FOR IT? (low-stakes "I'm free Thursday, who's in?" posts) ----------
// asks/{id}: by, text, date, part (morning|afternoon|evening|any), whenLabel, audience ("friends" or a group id),
// uids (who can see it), ins (who's in), expiresAt. Two "I'm in" taps and the server turns it into a plan.
const myFriendUids = () => [...S.friends.values()].filter(f => f.status === "accepted").map(otherIn).filter(Boolean);
const askOpen = a => a.status === "open" && (a.expiresAt || 0) > Date.now();
const askPart = { morning: "morning", afternoon: "afternoon", evening: "night", any: "" };
function askBox() {
  if (isDemo() && !myFriendUids().length && !S.groups.size) return "";
  if (!myFriendUids().length && !S.groups.size) return "";
  return `<button type="button" class="uf-ask" id="askBox"><span class="uf-ask-av">${avatar(myUid(), "sm")}</span><span class="uf-ask-text">Free sometime? Ask the crew…</span><span class="uf-ask-chips"><span class="fchip">Tonight</span><span class="fchip">Weekend</span></span></button>`;
}
function asksSection() {
  const me = myUid(), all = [...(S.asks || new Map()).values()];
  const open = all.filter(askOpen).sort((a, b) => (a.date || "").localeCompare(b.date || "") || b.createdAt - a.createdAt);
  const planned = all.filter(a => a.status === "planned" && Date.now() - (a.plannedAt || 0) < 36 * 3600e3);
  if (!open.length && !planned.length) return "";
  return `<div class="hd-h" id="asksCard"><h3>Up for it?</h3><span class="hd-count">${open.length}</span></div><div class="card hd-list uf-list">${open.map(askCard).join("")}${planned.map(a => `<a class="uf-post done" data-go="#/e/${esc(a.planId)}"><div class="uf-post-h">${coral("party", 36)}<div><b>${esc(a.planTitle || a.text)}</b> became a plan 🎉<div class="muted sm">${esc(andNames((a.ins || []).map(u => u === me ? "you" : first(nameOf(u)))))} ${(a.ins || []).length === 1 ? "is" : "are"} in. Dot set it up.</div></div><span class="btn small">Open</span></div></a>`).join("")}</div>`;
}
const andNames = ns => ns.length <= 1 ? (ns[0] || "") : ns.length === 2 ? ns.join(" and ") : ns.length === 3 ? `${ns[0]}, ${ns[1]}, and ${ns[2]}` : `${ns[0]}, ${ns[1]}, and ${ns.length - 2} others`;
function askCard(a) {
  const me = myUid(), mine = a.by === me, ins = (a.ins || []).filter(u => u !== a.by), im = ins.includes(me);
  const left = Math.max(1, Math.round(((a.expiresAt || 0) - Date.now()) / 3600e3)), ends = left >= 24 ? `ends ${a.date === addDays(todayStr(), 1) ? "tomorrow" : "in " + Math.round(left / 24) + "d"}` : `ends in ${left}h`;
  return `<div class="uf-post" data-ask="${esc(a.id)}"><div class="uf-post-h">${avatar(a.by, "lg")}<div style="flex:1;min-width:0"><b>${mine ? "You're" : esc(first(nameOf(a.by))) + " is"} free ${esc(a.whenLabel || "")}</b><div class="muted sm">${a.text ? "“" + esc(a.text) + "” · " : ""}${ends}</div></div>${mine ? `<button type="button" class="btn ghost small" data-askdel="${esc(a.id)}" aria-label="Take this down">✕</button>` : ""}</div>
    <div class="uf-post-f">${ins.length ? `<span class="hd-faces">${ins.slice(0, 4).map(u => avatar(u, "xs")).join("")}</span><span class="muted sm">${esc(andNames(ins.map(u => u === me ? "you" : first(nameOf(u)))))} ${ins.length === 1 && !im ? "is" : "are"} in</span>` : `<span class="muted sm">${mine ? "Waiting for the first yes." : "Nobody's in yet. Be the first."}</span>`}
      ${mine ? (ins.length ? `<button type="button" class="btn primary small" data-askplan="${esc(a.id)}">Make it a plan</button>` : "") : `<button type="button" class="btn ${im ? "" : "primary"} small" data-askin="${esc(a.id)}">${im ? "✓ You're in" : "I'm in"}</button>`}</div></div>`;
}
function openAskSheet() {
  const t = todayStr(), dow = new Date().getDay();
  const dayName = d => evDate({ date: d }).toLocaleDateString("en-US", { weekday: "long" });
  const sat = addDays(t, (6 - dow + 7) % 7 || 7), days = [1, 2, 3, 4].map(n => addDays(t, n));
  const when = [["Tonight", t], ["Tomorrow", addDays(t, 1)], ...days.slice(1).map(d => [dayName(d).slice(0, 3), d]), ["This weekend", sat]];
  const groups = [...S.groups.values()];
  let pick = { date: t, label: "Tonight", part: "evening", aud: "friends" };
  dialog(`<h3>Up for it?</h3>
    <div class="muted sm" style="margin:0 0 6px">When</div><div class="chiprow" id="askWhen">${when.map(([l, d]) => `<button type="button" class="fchip ${d === t ? "on" : ""}" data-askd="${d}" data-askl="${esc(l)}">${esc(l)}</button>`).join("")}<button type="button" class="fchip" id="askPickDay">Pick a day</button></div>
    <input type="date" id="askDate" class="hidden" min="${t}" style="margin-top:6px">
    <div class="chiprow" id="askPart" style="margin-top:8px">${[["morning", "Morning"], ["afternoon", "Afternoon"], ["evening", "Evening"], ["any", "Any time"]].map(([k, l]) => `<button type="button" class="fchip ${k === "evening" ? "on" : ""}" data-askp="${k}">${l}</button>`).join("")}</div>
    <div class="muted sm" style="margin:12px 0 6px">Who sees it</div><div class="chiprow" id="askAud"><button type="button" class="fchip on" data-aska="friends">All friends (${myFriendUids().length})</button>${groups.map(g => `<button type="button" class="fchip" data-aska="${esc(g.id)}">${groupMini(g)} ${esc(g.name)} (${(g.memberUids || []).length})</button>`).join("")}</div>
    <label class="field" style="margin-top:12px"><span>What are you thinking? (optional)</span><input id="askText" maxlength="140" placeholder="Tacos and a margarita somewhere? Low key."></label>
    <p class="muted sm" style="margin:10px 0 0">It disappears after that day. Two “I'm in” taps and Dot turns it into a plan with everyone who's in.</p>`,
    "Post it", async () => {
      const text = el("askText").value.trim();
      const uids = pick.aud === "friends" ? myFriendUids() : ((S.groups.get(pick.aud) || {}).memberUids || []).filter(u => u !== myUid());
      if (!uids.length) return toast("Nobody to ask yet. Add friends or a group first.");
      const end = new Date(evDate({ date: pick.date })); end.setHours(23, 59, 0, 0); if (pick.label === "This weekend") end.setDate(end.getDate() + 1);
      const label = pick.label === "This weekend" ? "this weekend" : `${pick.date === t ? "tonight" : pick.date === addDays(t, 1) ? "tomorrow" : dayName(pick.date)}${pick.date === t && pick.part === "evening" ? "" : askPart[pick.part] ? " " + askPart[pick.part] : ""}`;
      try { await setDoc(doc(db, "asks", newId()), { by: myUid(), byName: S.profile.name, text, date: pick.date, part: pick.part, whenLabel: label, audience: pick.aud, audienceName: pick.aud === "friends" ? "friends" : (S.groups.get(pick.aud) || {}).name || "", uids: [...new Set([myUid(), ...uids])], ins: [], status: "open", expiresAt: end.getTime(), createdAt: Date.now() }); closeDialog(); toast("Posted. You'll hear when someone's in.", null, null, "coral:happy"); }
      catch (e) { toast(e.message); }
    });
  document.querySelectorAll("#askWhen [data-askd]").forEach(b => b.onclick = () => { document.querySelectorAll("#askWhen .fchip").forEach(x => x.classList.remove("on")); b.classList.add("on"); el("askDate").classList.add("hidden"); pick.date = b.dataset.askd; pick.label = b.dataset.askl; });
  el("askPickDay").onclick = () => { document.querySelectorAll("#askWhen .fchip").forEach(x => x.classList.remove("on")); el("askPickDay").classList.add("on"); el("askDate").classList.remove("hidden"); el("askDate").focus(); };
  el("askDate").onchange = () => { if (el("askDate").value) { pick.date = el("askDate").value; pick.label = dayName(pick.date); } };
  document.querySelectorAll("[data-askp]").forEach(b => b.onclick = () => { document.querySelectorAll("[data-askp]").forEach(x => x.classList.remove("on")); b.classList.add("on"); pick.part = b.dataset.askp; });
  document.querySelectorAll("[data-aska]").forEach(b => b.onclick = () => { document.querySelectorAll("[data-aska]").forEach(x => x.classList.remove("on")); b.classList.add("on"); pick.aud = b.dataset.aska; });
}
function wireAsks() {
  if (el("askBox")) el("askBox").onclick = openAskSheet;
  document.querySelectorAll("[data-askin]").forEach(b => b.onclick = async () => { const a = S.asks.get(b.dataset.askin); if (!a) return; const me = myUid(), im = (a.ins || []).includes(me); b.disabled = true;
    try { await updateDoc(doc(db, "asks", a.id), { ins: im ? arrayRemove(me) : arrayUnion(me) }); if (!im) toast("You're in. " + first(nameOf(a.by)) + " will see.", null, null, "coral:happy"); } catch (e) { toast(e.message); b.disabled = false; } });
  document.querySelectorAll("[data-askdel]").forEach(b => b.onclick = () => { if (!confirm("Take this down?")) return; deleteDoc(doc(db, "asks", b.dataset.askdel)).catch(e => toast(e.message)); });
  document.querySelectorAll("[data-askplan]").forEach(b => b.onclick = async () => { b.disabled = true; try { await updateDoc(doc(db, "asks", b.dataset.askplan), { force: true }); toast("Dot's setting it up…", null, null, "thinking"); } catch (e) { toast(e.message); b.disabled = false; } });
}
function heroCard(ev) {
  const th = themeOf(ev.theme, ev.customTheme), myR = (ev.rsvps || {})[myUid()], tf = tileFaces(ev);
  const pill = myR ? `<span class="you-pill ${myR}">${{ going: "You're going", maybe: "Maybe", no: "Can't go", waitlist: "Waitlisted", pending: "Pending" }[myR] || ""}</span>` : (ev.invitedUids || []).includes(myUid()) && ev.hostId !== myUid() ? `<span class="you-pill rsvp">RSVP</span>` : "";
  const today = ev.date === todayStr();
  return `<a class="hd-hero t-${esc(th.id)} ${ev.cover ? "has-cover" : ""} ${today ? "today" : ""}" data-ev="${ev.id}" style="--th-accent:${esc(th.accent)};--th-ink:${esc(th.ink)};--th-on-accent:${esc(th.onAccent)}">
    ${ev.cover ? `<img class="cover-img" src="${esc(ev.cover)}" alt="">` : `<div class="ev-card-bg"></div>`}
    <div class="hd-hero-top">${today ? `<span class="hd-chip today">${dotHat(22)} Today${ev.time ? " · " + esc(fmtTime(ev.time)) : ""}</span>` : `<span class="hd-chip">Up next · ${inDaysWord(ev)}</span>`}${pill}</div>
    <div class="hd-hero-body"><div class="hd-emoji">${esc(ev.emoji || "📍")}</div><h2>${esc(ev.title)}</h2><div class="hd-sub">${esc(fmtWhen(ev))}${placeName(ev.location) ? " · " + esc(placeName(ev.location)) : ""}</div>
      <div class="hd-row"><span class="hd-faces">${tf.faces}</span><span class="hd-going">${esc(tf.label)}</span><span class="btn primary small">Open</span></div></div></a>`;
}
function needsYou() {
  const me = myUid(), t = todayStr(), items = [];
  [...S.events.values()].filter(e => e.date >= t && (e.invitedUids || []).includes(me) && e.hostId !== me && !(e.rsvps || {})[me]).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3)
    .forEach(e => items.push({ ic: e.emoji || "📅", t: `RSVP to ${e.title}`, s: `${(e.invitedUids || []).length} invited · ${evDate(e).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, cta: "Reply", go: `#/e/${e.id}?to=rsvpCard` }));
  [...(S.splits || new Map()).values()].filter(x => x.status === "open" && (x.uids || []).includes(me) && !(x.done || {})[me]).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 2)
    .forEach(x => { const total = (x.items || []).reduce((n, i) => n + (i.cents || 0), 0) + (x.tax || 0) + (x.fees || 0) + (x.tip || 0);
      items.push({ ic: "🧾", t: `Pick your items from ${x.desc || x.merchant || "the receipt"}`, s: `${first(nameOf(x.paidBy))} paid ${fmt$(total)} · ${Object.keys(x.done || {}).length} of ${(x.people || []).length} done`, cta: "Pick", go: "#/pick/" + x.id }); });
  const reqs = incomingRequests();
  if (reqs.length) items.push({ ic: "👋", t: reqs.length === 1 ? `${first(nameOf(reqs[0].requestedBy))} wants to be friends` : `${reqs.length} friend requests`, s: "Accept to message each other", cta: "See", go: "#/friends?to=reqCard" });
  if (!items.length) return "";
  return `<div class="hd-h"><h3>Needs you</h3><span class="hd-count">${items.length}</span></div><div class="hd-scroll">${items.map(n => `<a class="hd-need" data-go="${esc(n.go)}"><span class="li">${esc(n.ic)}</span><b>${esc(n.t)}</b><span class="muted sm">${esc(n.s)}</span><span class="btn primary small">${n.cta}</span></a>`).join("")}</div>`;
}
function moneyGlance() {
  const me = myUid(), pairs = pairwise();
  const owe = pairs.filter(p => p.from === me), owed = pairs.filter(p => p.to === me);
  const iOwe = owe.reduce((n, p) => n + p.amount, 0), toMe = owed.reduce((n, p) => n + p.amount, 0);
  if (!iOwe && !toMe) return "";
  const who = (ps, prep) => ps.length === 1 ? `${prep} ${first(nameOf(ps[0].from === me ? ps[0].to : ps[0].from))}` : `${prep} ${ps.length} friends`;
  return `<a class="card hd-money" data-go="#/money?to=settleCard"><div><span class="muted sm">You owe</span><b class="hd-amt owe">${fmt$(iOwe)}</b><span class="muted sm">${iOwe ? who(owe, "to") : "nobody"}</span></div><div><span class="muted sm">Owed to you</span><b class="hd-amt owed">${fmt$(toMe)}</b><span class="muted sm">${toMe ? who(owed, "from") : "all settled"}</span></div><span class="btn primary small">Settle up</span></a>`;
}
function memoriesStrip() {
  const pics = [...S.memories.entries()].flatMap(([eid, ps]) => ps.map(p => ({ eid, p }))).filter(x => x.p.img).sort((a, b) => (b.p.createdAt || 0) - (a.p.createdAt || 0)).slice(0, 8);
  if (!pics.length) return "";
  return `<div class="hd-h"><h3>Memories</h3><a class="hd-link" data-go="#/photos">See all ›</a></div><div class="hd-scroll hd-mems">${pics.map(x => `<img src="${esc(x.p.img)}" data-hdmem="${esc(x.eid)}|${esc(x.p.id)}" alt="" loading="lazy">`).join("")}</div>`;
}
function latestList() {
  const acts = (S.activity || []).slice(0, 4); if (!acts.length) return "";
  return `<div class="hd-h"><h3>Latest from your crew</h3><a class="hd-link" data-go="#/activity">Activity ›</a></div><div class="card hd-list">${acts.map(a => `<a class="hd-act" data-act="${esc(a.url || "#/")}"><span class="li">${actIcon(a)}</span><span class="hd-evt"><b>${esc(a.title)}</b><span class="muted sm">${esc(a.body || "")}</span></span><span class="muted sm">${ago(a.createdAt)}</span></a>`).join("")}</div>`;
}
function crewsRow() {
  const groups = [...S.groups.values()].slice(0, 8); if (!groups.length) return "";
  return `<div class="hd-h"><h3>Your crews</h3><a class="hd-link" data-go="#/groups">Groups ›</a></div><div class="hd-scroll hd-crews">${groups.map((g, i) => `<a class="hd-crew" data-go="#/g/${g.id}"><span class="hd-crew-ic" style="background:${esc(g.color || GROUP_COLORS[i % GROUP_COLORS.length])}">${groupMini(g)}</span><span>${esc(g.name)}</span></a>`).join("")}</div>`;
}
function wireHomeDash() {
  wireBanners(); wireAsks(); wireLive(); wireDigest();
  document.querySelectorAll("[data-ev]").forEach(a => a.onclick = e => { e.preventDefault(); go("#/e/" + a.dataset.ev); });
  document.querySelectorAll("[data-act]").forEach(a => a.onclick = e => { e.preventDefault(); location.hash = routeTail(a.dataset.act); });
  document.querySelectorAll("[data-hdmem]").forEach(im => im.onclick = () => { const [eid, pid] = im.dataset.hdmem.split("|"), ev = S.events.get(eid), p = (S.memories.get(eid) || []).find(x => x.id === pid); if (ev && p) openPhoto(ev, p); });
  // Memories come mostly from past plans, which load on request: ask for them, then gather photos for any plan we
  // haven't looked at yet (past plans arrive a moment after the first paint, so this runs again on that redraw).
  if (!S.pastOn) startPast();
  const unseen = [...S.events.keys()].filter(id => !S.memories.has(id));
  if (unseen.length && !S._hdMemLoading) { S._hdMemLoading = true; loadMemories(false).catch(() => {}).then(() => { S._hdMemLoading = false; if (S.route.name === "home") render(); }); }
}
function plansBody() {
  const evs = [...myEvents(), ...unjoinedEvents()];
  const t = todayStr();
  let upcoming = evs.filter(e => e.date >= t).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  let past = evs.filter(e => e.date < t).sort((a, b) => b.date.localeCompare(a.date));
  if (homeFilter !== "all") { const f = homeFilter === "none" ? e => !e.groupId && ![...S.groups.values()].some(g => evInGroup(e, g)) : e => evInGroup(e, S.groups.get(homeFilter)); upcoming = upcoming.filter(f); past = past.filter(f); }

  // Pending group invites render in shell(), so they show on every page.
  const groups = [...S.groups.values()];
  const filterBar = groups.length ? `<div class="chiprow">
    <button class="fchip ${homeFilter === "all" ? "on" : ""}" data-filter="all">All</button>
    ${groups.map(g => `<button class="fchip ${homeFilter === g.id ? "on" : ""}" data-filter="${g.id}">${groupMini(g)} ${esc(g.name)}</button>`).join("")}
    <button class="fchip ${homeFilter === "none" ? "on" : ""}" data-filter="none">Just friends</button>
  </div>` : "";

  return `
  ${askBox()}${asksSection()}
  <div class="section-head"><h2>${homeView === "calendar" ? "Calendar" : "Upcoming"}</h2><span class="btnrow head-tools"><button class="icon-btn" id="viewToggle" title="${homeView === "calendar" ? "Show as cards" : "Show as a calendar"}" aria-label="${homeView === "calendar" ? "Show as cards" : "Show as a calendar"}">${homeView === "calendar" ? "🗂" : "📅"}</button><button class="icon-btn" data-go="#/drafts" title="Drafts" aria-label="Drafts${(S.drafts || []).length ? ", " + S.drafts.length + " saved" : ""}">📝${(S.drafts || []).length ? `<span class="badge">${S.drafts.length}</span>` : ""}</button><button class="btn primary small" data-go="#/new">＋ New event</button></span></div>
  ${filterBar}
  ${homeView === "calendar" ? calendarBody([...upcoming, ...past]) : `<div class="ev-grid">${upcoming.length ? upcoming.map(eventCard).join("") : emptyState("🗓️", "No plans yet", "Create your first event: pick a theme and invite the crew.", "sleepy") + (window.Blip && !isDemo() ? `<div style="text-align:center;margin:-6px 0 14px"><button type="button" class="btn tell-dot inline" id="homeTell">${dot("happy", 26)} Or just tell Dot the plan</button></div>` : "")}</div>
  ${past.length || !S.pastLoaded ? `<button type="button" class="section-head past-head" id="pastToggle" aria-expanded="${!!S.pastOpen}"><h2>Past</h2><span class="muted sm">${S.pastLoaded ? past.length + (past.length === 1 ? " event" : " events") : ""}</span><span class="past-chev" aria-hidden="true">›</span></button>
  ${S.pastOpen ? (S.pastLoaded ? `<div class="ev-grid dim">${past.map(eventCard).join("")}</div>` : `<p class="muted sm" style="margin:6px 2px">Loading past events…</p>`) : ""}` : ""}`}`;
}
function emptyState(emoji, title, sub, mood) { const art = mood && window.Blip ? mascot(mood, 84) : `<div class="big">${emoji}</div>`; return `<div class="card empty">${art}<b>${esc(title)}</b><p class="muted">${esc(sub)}</p></div>`; }

function eventCard(ev) {
  if (ev.kind === "meeting") return meetingCard(ev);
  const th = themeOf(ev.theme, ev.customTheme);
  const d = evDate(ev);
  const tf = tileFaces(ev);
  const myR = (ev.rsvps || {})[myUid()];
  const rsvpDot = myR ? `<span class="you-pill ${myR}">${{ going: "You're going", maybe: "Maybe", no: "Can't go", waitlist: "Waitlisted", pending: "Pending" }[myR] || ""}</span>` : "";
  const pills = `${isNewEvent(ev) ? `<span class="new-pill">New</span>` : ""}${rsvpDot}`;
  return `
  <a class="ev-card t-${esc(th.id)} ${ev.cover ? "has-cover" : ""} ${ev._unjoined ? "unjoined" : ""}" data-ev="${ev.id}" style="--th-accent:${esc(th.accent)};--th-ink:${esc(th.ink)};--th-on-accent:${esc(th.onAccent)}">
    ${ev.cover ? `<img class="cover-img" src="${esc(ev.cover)}" alt="">` : `<div class="ev-card-bg"></div>`}
    <div class="ev-card-body">
      ${pills ? `<div class="ev-pills">${pills}</div>` : ""}
      ${ev.cover ? "" : `<div class="ev-card-emoji">${esc(ev.emoji || "🎉")}</div>`}
      <div class="ev-card-text">
        <div class="ev-card-title" style="font-family:${esc(th.font)},system-ui">${esc(ev.title)}</div>
        <div class="ev-card-date">${MONTHS[d.getMonth()]} ${d.getDate()}${ev.time ? " · " + fmtTime(ev.time) : ""}${evStops(ev).length ? ` · <span class="ev-route">${evStops(ev).slice(0, 4).map(x => esc(x.emoji || "📍")).join("<i>›</i>")}</span>` : ""}</div>
        <div class="ev-card-foot">
          <span class="mini-guests">${tf.faces}</span>
          <span class="count">${tf.label}</span>
        </div>
      </div>
    </div>
    ${ev._unjoined ? `<div class="unjoined-veil"><span class="uj-tag">✉️ You're invited</span><span class="uj-cta">Tap to join</span></div>` : ""}
  </a>`;
}
function wireBanners() {
  if (el("homeTell")) el("homeTell").onclick = () => openPlanDialog("event", {});
  document.querySelectorAll("[data-bplan]").forEach(b => b.onclick = () => { const x = upcomingBirthdays(400).find(y => y.uid === b.dataset.bplan); if (x) planBirthday(x); });
  document.querySelectorAll("[data-bdismiss]").forEach(b => b.onclick = () => { try { const d = JSON.parse(LS.get("friendlyBdayDismissed") || "[]"); d.push(b.dataset.bdismiss); LS.set("friendlyBdayDismissed", JSON.stringify(d.slice(-40))); } catch {} render(); });
  document.querySelectorAll("[data-hide-tray]").forEach(b => b.onclick = e => { e.stopPropagation(); LS.set("friendlyTrayHidden2", todayStr()); const c = b.closest(".cur-tray"); if (c) { c.classList.add("fade-away"); setTimeout(render, 350); } else render(); });
  { const tray = document.querySelector(".cur-tray.first"), tabc = document.querySelector(".tabs .tab-curate");   // the tray's pointer aims at the Curate tab
    if (tray && tabc) { const r = tabc.getBoundingClientRect(), tr = tray.getBoundingClientRect(); tray.style.setProperty("--ptr", Math.max(16, Math.round(tr.right - (r.left + r.width / 2) - 6)) + "px"); } }
  document.querySelectorAll("[data-hide-today]").forEach(b => b.onclick = e => { e.stopPropagation(); let h = []; try { h = JSON.parse(LS.get("friendlyTodayHidden") || "[]"); } catch {} h = [...h, b.dataset.hideToday].slice(-30); try { LS.set("friendlyTodayHidden", JSON.stringify(h)); } catch {} render(); });
  if (el("pushOn")) el("pushOn").onclick = enableWebPush;
  if (el("pushLater")) el("pushLater").onclick = () => { try { LS.set("friendlyPushDismissed", "1"); } catch {} render(); };
}
function wirePlans() {
  wireBanners(); wireAsks();
  document.querySelectorAll("[data-ev]").forEach(a => a.onclick = e => { e.preventDefault(); go("#/e/" + a.dataset.ev); });
  document.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { homeFilter = b.dataset.filter; calDay = null; render(); });
  if (el("pastToggle")) el("pastToggle").onclick = () => { S.pastOpen = !S.pastOpen; if (S.pastOpen) startPast(); render(); };
  if (homeView === "calendar") startPast();
  if (el("viewToggle")) el("viewToggle").onclick = () => { homeView = homeView === "calendar" ? "cards" : "calendar"; try { LS.set("friendlyHomeView", homeView); } catch {} render(); };
  if (el("calPrev")) el("calPrev").onclick = () => { calYM = { y: calYM.m === 0 ? calYM.y - 1 : calYM.y, m: (calYM.m + 11) % 12 }; calDay = null; render(); };
  if (el("calNext")) el("calNext").onclick = () => { calYM = { y: calYM.m === 11 ? calYM.y + 1 : calYM.y, m: (calYM.m + 1) % 12 }; calDay = null; render(); };
  if (el("calClear")) el("calClear").onclick = () => { calDay = null; render(); };
  document.querySelectorAll("[data-calday]").forEach(c => c.onclick = () => { calDay = calDay === c.dataset.calday ? null : c.dataset.calday; render(); });
}

// ---------- GROUPS ----------
function groupsBody() {
  const groups = [...S.groups.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return `
  <div class="section-head"><h2>Your groups</h2><button class="btn primary small" id="newGroupBtn">＋ New group</button></div>
  <p class="muted" style="margin:0 0 14px">Groups are your circles. Invite people once, then plan with them again and again. Everything in a group stays private to its members.</p>
  <div class="stack">${groups.length ? groups.map(groupRow).join("") : emptyState("👥", "No groups yet", "Where is everybody? Make a group and get the crew in here.", "coral:happy")}</div>`;
}
// ---------- a group's look: icon (emoji or picture) on its color, and a cover (photo, Dot's painting, or the color) ----------
const GROUP_COLORS = ["#FFE0B2", "#FFC2B3", "#FFE48A", "#BDEBD0", "#BFE0FF", "#D9CCFF", "#FFC9DE", "#E8DCCB"];
const GROUP_EMOJIS = ["🎉", "🍕", "🏖️", "⛰️", "🎮", "🏈", "⚽", "🎸", "🍻", "🍷", "☕", "🎬", "🏃", "🚴", "🧗", "🏕️", "🎲", "📚", "🐶", "💼", "🏠", "👨‍👩‍👧", "✈️", "🌮"];
function groupIcon(g, size = "") {
  const bg = esc(g.color || GROUP_COLORS[0]);
  return g.icon ? `<span class="ge ${size} has-img" style="background:${bg}"><img src="${esc(g.icon)}" alt=""></span>` : `<span class="ge ${size}" style="background:${bg}">${esc(g.emoji || "🎉")}</span>`;
}
// For one-line spots (chips, tags): a tiny picture, or the emoji.
const groupMini = g => g.icon ? `<img class="ge-mini" src="${esc(g.icon)}" alt="">` : esc(g.emoji || "•");
// The cover: the group's picture if it has one, else its color as a gradient scattered with its emoji.
function groupCoverHtml(g, cls, extra = "") {
  const c = g.color || GROUP_COLORS[0];
  if (g.cover) return `<div class="${cls}" style="background-image:url('${esc(g.cover)}')">${extra}</div>`;
  const spots = [[8, 18, -14], [26, 62, 10], [44, 14, 6], [62, 58, -8], [80, 20, 14], [92, 66, -4], [14, 84, 8], [70, 90, -12]];
  const glyph = g.icon ? "" : esc(g.emoji || "🎉");
  return `<div class="${cls} is-color" style="--gc:${esc(c)}">${glyph ? spots.map(([x, y, r]) => `<span class="gpat" style="left:${x}%;top:${y}%;--r:${r}deg">${glyph}</span>`).join("") : ""}${extra}</div>`;
}
// Square-crop a picture to `size` px (icons).
async function squareImage(src, size = 256) {
  const img = await loadPicked(src), s = Math.min(img.width, img.height), c = document.createElement("canvas"); c.width = c.height = size;
  const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL("image/jpeg", 0.86);
}
// Hosts: icon, color, and cover in one place, with a live preview.
function openGroupLookDialog(g) {
  const L = { emoji: g.emoji || "🎉", icon: g.icon || "", color: g.color || GROUP_COLORS[0], cover: g.cover || "", style: "surprise" };
  const preview = () => `${groupCoverHtml(L, "gl-cover")}<div class="gl-row">${groupIcon(L, "xl")}<b>${esc(g.name)}</b></div>`;
  dialog(`<h3>Group look</h3>
    <div class="gl-preview" id="glPreview">${preview()}</div>
    <div class="gl-label">Icon</div>
    <div class="emoji-pick gl-emojis" id="glEmojis">${GROUP_EMOJIS.map(e => `<button type="button" data-ge="${e}" class="${!L.icon && L.emoji === e ? "on" : ""}">${e}</button>`).join("")}</div>
    <div class="gl-actions"><input id="glAny" maxlength="8" placeholder="Any emoji" aria-label="Any emoji"><button type="button" class="btn small" id="glIconUp">📷 Picture</button><button type="button" class="btn small" id="glIconAi">✨ Dot makes one</button></div>
    <div class="gl-prompt hidden" id="glIconBox"><label class="field"><span>Tell Dot what to draw</span><textarea id="glIconText" rows="2" maxlength="300" placeholder="A pizza slice wearing sunglasses">A fun icon for ${esc(g.name)}</textarea></label>
      <div class="gl-actions"><button type="button" class="btn primary small" id="glIconGo">✨ Make it</button><button type="button" class="btn ghost small" id="glIconX">Never mind</button></div></div>
    <div class="gl-label">Color</div>
    <div class="gl-colors" id="glColors">${GROUP_COLORS.map(c => `<button type="button" data-gc="${c}" style="background:${c}" class="${L.color === c ? "on" : ""}" aria-label="Color ${c}"></button>`).join("")}</div>
    <div class="gl-label">Cover</div>
    <div class="gl-actions"><button type="button" class="btn small" id="glCoverUp">📷 Photo</button><button type="button" class="btn small" id="glCoverAi">✨ Dot paints one</button><button type="button" class="btn ghost small" id="glCoverOff">Use the color</button></div>
    <div class="gl-prompt hidden" id="glCoverBox"><label class="field"><span>Tell Dot what to paint</span><textarea id="glCoverText" rows="3" maxlength="400" placeholder="Our lake house dock at sunset, kayaks and string lights">A cozy scene that feels like ${esc(g.name)}</textarea></label>
      <div class="style-chips" id="glStyles">${COVER_STYLES.map(([k, l]) => `<button type="button" data-gs="${k}" class="${k === L.style ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="gl-actions"><button type="button" class="btn primary small" id="glCoverGo">🎨 Paint it</button><button type="button" class="btn ghost small" id="glCoverX">Never mind</button></div></div>`, "Save", async () => {
      try { await updateDoc(doc(db, "groups", g.id), { emoji: L.emoji, icon: L.icon, color: L.color, cover: L.cover }); closeDialog(); toast("Looking good ✨", null, null, "happy"); }
      catch (e) { toast(e.message); }
    });
  const redraw = () => { el("glPreview").innerHTML = preview(); document.querySelectorAll("#glEmojis [data-ge]").forEach(b => b.classList.toggle("on", !L.icon && b.dataset.ge === L.emoji)); document.querySelectorAll("#glColors [data-gc]").forEach(b => b.classList.toggle("on", b.dataset.gc === L.color)); };
  const busy = (b, on, label) => { b.disabled = on; if (label) b.textContent = label; };
  document.querySelectorAll("#glEmojis [data-ge]").forEach(b => b.onclick = () => { L.emoji = b.dataset.ge; L.icon = ""; redraw(); });
  el("glAny").oninput = () => { const v = el("glAny").value.trim(); if (v && !/[\p{L}\p{N}]/u.test(v)) { L.emoji = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(v)][0].segment; L.icon = ""; redraw(); } };
  document.querySelectorAll("#glColors [data-gc]").forEach(b => b.onclick = () => { L.color = b.dataset.gc; redraw(); });
  document.querySelectorAll("#glStyles [data-gs]").forEach(b => b.onclick = () => { L.style = b.dataset.gs; document.querySelectorAll("#glStyles [data-gs]").forEach(x => x.classList.toggle("on", x === b)); });
  el("glIconUp").onclick = async () => { const f = await pickFile("image/*", "group icon"); if (!f) return; const b = el("glIconUp"); busy(b, true); try { L.icon = await squareImage(f, 256); redraw(); } catch (e) { toast("Couldn't use that picture"); } busy(b, false); };
  el("glCoverUp").onclick = async () => { const f = await pickFile("image/*", "group cover"); if (!f) return; const b = el("glCoverUp"); busy(b, true); try { L.cover = await compressImage(f, 1200, 0.78, 260000); redraw(); } catch (e) { toast("Couldn't use that picture"); } busy(b, false); };
  el("glCoverOff").onclick = () => { L.cover = ""; redraw(); };
  // Dot's buttons open a box with an idea already written in, which you can change before Dot starts.
  const openBox = (id, ta) => { el(id).classList.remove("hidden"); const t = el(ta); t.focus(); t.setSelectionRange(t.value.length, t.value.length); };
  el("glIconAi").onclick = () => openBox("glIconBox", "glIconText");
  el("glIconX").onclick = () => el("glIconBox").classList.add("hidden");
  el("glCoverAi").onclick = () => openBox("glCoverBox", "glCoverText");
  el("glCoverX").onclick = () => el("glCoverBox").classList.add("hidden");
  el("glIconGo").onclick = async () => { const idea = el("glIconText").value.trim() || `A fun icon for ${g.name}`, b = el("glIconGo"); busy(b, true, "✨ Making…");
    try { const img = await generateCover(`${idea}. A square icon for a group: one clear subject, centered, easy to read at a small size.`, { aspect: "1:1" }); L.icon = await squareImage(img, 256); redraw(); el("glIconBox").classList.add("hidden"); }
    catch (e) { toast(e.message || "Dot couldn't make one just now. Try again?"); } busy(b, false, "✨ Make it"); };
  el("glCoverGo").onclick = async () => { const idea = el("glCoverText").value.trim() || `A cozy scene that feels like ${g.name}`, b = el("glCoverGo"); busy(b, true, "🎨 Painting…");
    try { L.cover = await generateCover(`A wide, inviting cover image: ${idea}. Style: ${coverStylePrompt(L.style)}. No text, no words, no letters.`); redraw(); el("glCoverBox").classList.add("hidden"); }
    catch (e) { toast(e.message || "Dot couldn't paint one just now. Try again?"); } busy(b, false, "🎨 Paint it"); };
}
function groupRow(g) {
  const n = (g.memberUids || []).length;
  const faces = (g.memberUids || []).slice(0, 4).map(u => avatar(u)).join("");
  return `<a class="card group-tile" data-group="${g.id}">
    ${groupCoverHtml(g, "gt-cover")}
    <div class="gt-body">${groupIcon(g, "lg")}
      <div class="gt-text"><b>${esc(g.name)}${newCountFor("#/g/" + g.id) ? `<span class="new-count">${newCountFor("#/g/" + g.id)} new</span>` : ""}</b><div class="muted sm">${n} member${n === 1 ? "" : "s"}${g.ownerId === myUid() ? " · you host" : ""}</div></div>
      <span class="gt-faces">${faces}</span></div></a>`;
}
function wireGroups() {
  el("newGroupBtn").onclick = openGroupDialog;
  document.querySelectorAll("[data-group]").forEach(a => a.onclick = e => { e.preventDefault(); go("#/g/" + a.dataset.group); });
}

function groupPageBody(gid) {
  const g = S.groups.get(gid);
  if (!g) return `<div class="card empty">${dot("oops", 72)}<b>Group not found</b><p class="muted">You may have left it or it was deleted.</p><button class="btn" data-go="#/groups">Back to groups</button></div>`;
  const members = (g.memberUids || []).map(u => ({ uid: u, ...(g.members || {})[u] }));
  const owner = g.ownerId === myUid();
  // Hosts: the owner plus anyone in hostUids. Hosts invite, manage, and promote; only the owner can delete.
  const hostUids = [g.ownerId, ...(g.hostUids || [])];
  const host = hostUids.includes(myUid());
  return `
  <button class="link-back" data-go="#/groups">‹ Groups</button>
  ${groupCoverHtml(g, "group-cover", host ? `<button type="button" class="cover-edit" id="editLook">🎨 Edit look</button>` : "")}
  <div class="group-hero">${groupIcon(g, "xl")}
    <div><h1>${esc(g.name)}</h1><div class="muted">${members.length} member${members.length === 1 ? "" : "s"}</div></div></div>
  <div class="btnrow">
    <button class="btn primary" data-go="#/new">＋ Plan for this group</button>
    ${host ? `<button class="btn" id="inviteBtn">＋ Add people</button>` : ""}
  </div>
  ${(() => { const t = todayStr(); const evs = myEvents().filter(e => evInGroup(e, g));
    const up = evs.filter(e => e.date >= t).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
    const past = evs.filter(e => e.date < t).sort((a, b) => b.date.localeCompare(a.date));
    return `<div class="section-head" style="margin-top:22px"><h2>Plans</h2>${evs.length ? `<button class="btn small" data-homefilter="${g.id}">Open in Events</button>` : ""}</div>
    <div class="card">${up.length ? up.map(planRow).join("") : `<p class="muted" style="padding:14px 16px;margin:0">Nothing planned yet. Tap “Plan for this group” to start one.</p>`}</div>
    ${past.length ? `<details class="adv" style="margin-top:8px"><summary>${past.length} past</summary><div class="card" style="margin-top:8px">${past.slice(0, 20).map(planRow).join("")}</div></details>` : ""}`; })()}
  ${(() => { const bs = upcomingBirthdays(90, g.id); const anySet = members.some(m => m.birthday); return `<div class="section-head" style="margin-top:22px"><h2>Birthdays</h2></div>
    <div class="card" id="bdayCard">${bs.length ? bs.map(b => `<div class="member-row">${avatar(b.uid, "lg")}<div style="flex:1;min-width:0"><b>${esc(first(b.name))}</b><div class="muted sm">${esc(fmtDay({ date: b.date }))} · ${b.days === 0 ? "today 🎉" : b.days === 1 ? "tomorrow" : "in " + b.days + " days"}</div></div>${b.days <= 45 ? `<button class="btn small ${b.days <= 30 ? "primary" : ""}" data-bplan="${b.uid}">Plan something</button>` : ""}</div>`).join("") : `<p class="muted sm" style="padding:14px 16px;margin:0">${anySet ? "No birthdays in the next 90 days." : "Nobody has added a birthday yet. Add yours on your profile and the group gets a heads-up a month before."}</p>`}</div>`; })()}
  <div class="section-head" style="margin-top:22px"><h2>Members</h2></div>
  <div class="card">${members.map(m => `<div class="member-row"><span class="member-click" data-viewprofile="${m.uid}" style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;cursor:pointer">${avatar(m.uid, "lg")}
    <div style="flex:1;min-width:0"><b>${esc(m.name || "Member")}${m.uid === myUid() ? " (you)" : ""}${hostUids.includes(m.uid) ? " · host" : ""}</b>
    ${m.venmo ? `<div class="muted sm mono">${esc(m.venmo)}</div>` : ""}</div></span>${host && m.uid !== g.ownerId && m.uid !== myUid() ? `<span class="btnrow" style="gap:6px"><button class="btn ghost small" data-mkhost="${m.uid}|${hostUids.includes(m.uid) ? 0 : 1}">${hostUids.includes(m.uid) ? "Remove host" : "Make host"}</button><button class="btn ghost small" data-kick="${m.uid}" title="Remove from group">✕</button></span>` : ""}</div>`).join("")}</div>
  <div class="section-head" style="margin-top:22px"><h2>Crew tab</h2><button class="btn small" id="gExpense">＋ Expense</button></div>
  ${groupTab(g)}
  ${((g.invitedEmails || []).length || (g.invitedPhones || []).length) ? `<div class="section-head" style="margin-top:18px"><h2>Invited</h2></div>
    <div class="card">${(g.invitedEmails || []).map(e => `<div class="member-row"><span class="avatar lg" style="background:#CBB;opacity:.6">✉︎</span><div style="flex:1"><b class="mono sm">${esc(e)}</b><div class="muted sm">Hasn't joined yet</div></div>${host ? `<button class="btn ghost small" data-uninvite="${esc(e)}">✕</button>` : ""}</div>`).join("")}
    ${(g.invitedPhones || []).map(p => { const nm = (g.invitedPhoneNames || {})[p]; return `<div class="member-row"><span class="avatar lg" style="background:#CBB;opacity:.6">💬</span><div style="flex:1;min-width:0"><b>${esc(nm || p)}</b><div class="muted sm">${nm ? esc(p) + " · " : ""}Hasn't joined yet</div></div>${host ? `<span class="btnrow" style="gap:6px"><button class="btn ghost small" data-textinvite="${esc(p)}">Text</button><button class="btn ghost small" data-uninvitephone="${esc(p)}">✕</button></span>` : ""}</div>`; }).join("")}</div>` : ""}
  <div class="card th-plain" id="wall" style="margin-top:22px"><p class="muted">Loading…</p></div>
  <div class="card th-plain" id="pollsCard" style="margin-top:14px"><p class="muted">Loading…</p></div>
  <div class="btnrow" style="margin-top:20px">
    <button class="btn danger-ghost" id="leaveGroup">Leave group</button>${owner ? `<button class="btn danger-ghost" id="delGroup">Delete group</button>` : ""}
  </div>`;
}
function wireGroupPage() {
  if (el("editLook")) el("editLook").onclick = () => { const g = S.groups.get(S.route.id); if (g) openGroupLookDialog(g); };
  const g = S.groups.get(S.route.id); if (!g) { document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go)); return; }
  markPeeked("#/g/" + g.id);
  if (el("inviteBtn")) el("inviteBtn").onclick = () => openInviteDialog(g);
  document.querySelectorAll("[data-viewprofile]").forEach(el2 => el2.onclick = () => openProfileDialog(el2.dataset.viewprofile));
  document.querySelectorAll("[data-ev]").forEach(a => a.onclick = e => { e.preventDefault(); go("#/e/" + a.dataset.ev); });
  document.querySelectorAll("[data-homefilter]").forEach(b => b.onclick = () => { homeFilter = b.dataset.homefilter; go("#/"); });
  document.querySelectorAll("[data-bplan]").forEach(b => b.onclick = () => { const x = upcomingBirthdays(400, g.id).find(y => y.uid === b.dataset.bplan); if (x) planBirthday(x); });
  document.querySelectorAll("[data-kick]").forEach(b => b.onclick = async () => {
    const uid = b.dataset.kick; if (!confirm(`Remove ${first(nameOf(uid))} from ${g.name}?`)) return;
    try { await updateDoc(doc(db, "groups", g.id), { memberUids: arrayRemove(uid), hostUids: arrayRemove(uid), [`members.${uid}`]: deleteField() }); toast(first(nameOf(uid)) + " removed"); }
    catch (e) { toast(e.message); }
  });
  document.querySelectorAll("[data-mkhost]").forEach(b => b.onclick = async () => {
    const [uid, add] = b.dataset.mkhost.split("|");
    try { await updateDoc(doc(db, "groups", g.id), { hostUids: add === "1" ? arrayUnion(uid) : arrayRemove(uid) }); toast(add === "1" ? first(nameOf(uid)) + " is now a host" : first(nameOf(uid)) + " is no longer a host"); }
    catch (e) { toast(e.message); }
  });
  if (el("gExpense")) el("gExpense").onclick = () => openExpense(null, g.memberUids, g.id);
  document.querySelectorAll("[data-xopen]").forEach(b => b.onclick = () => go("#/x/" + b.dataset.xopen));
  document.querySelectorAll("[data-xrow]").forEach(d => d.onclick = e => { if (e.target.closest("button,a")) return; go("#/x/" + d.dataset.xrow); });
  if (el("delGroup")) el("delGroup").onclick = () => deleteGroup(g);
  if (el("leaveGroup")) el("leaveGroup").onclick = () => leaveGroup(g);
  document.querySelectorAll("[data-uninvite]").forEach(b => b.onclick = () => uninvite(g, b.dataset.uninvite));
  document.querySelectorAll("[data-uninvitephone]").forEach(b => b.onclick = () => uninvitePhone(g, b.dataset.uninvitephone));
  document.querySelectorAll("[data-textinvite]").forEach(b => b.onclick = () => { location.href = smsLink([b.dataset.textinvite], groupInviteText(g)); });
  // Live group chat + polls, using the event-page components against groups/{id}/…
  // (S.evSubs is cleared on every render, so these never leak across pages.)
  // _manage mirrors the rules: only the owner/hosts may remove other people's polls.
  const pseudo = { id: g.id, _col: ["groups", g.id], _manage: g.ownerId === myUid() || (g.hostUids || []).includes(myUid()), title: g.name };
  S.comments = []; S.polls = [];
  const sub = (name, fn) => S.evSubs.push(onSnapshot(subCol(pseudo, name), snap => fn(snap.docs.map(d => ({ id: d.id, ...d.data() }))), e => toast(e.message)));
  sub("comments", rows => { S.comments = rows.sort((a, b) => a.createdAt - b.createdAt); const b = el("wall"); if (b) withInputKept(() => { b.innerHTML = wallInner(pseudo, "Group chat"); wireWall(pseudo); }); });
  sub("polls", rows => { S.polls = rows.sort((a, b) => a.createdAt - b.createdAt); const b = el("pollsCard"); if (b) { b.innerHTML = pollsInner(pseudo, "Poll the group: dates, places, ideas."); wirePolls(pseudo); } });
}

// group create / invite / membership
function openGroupDialog() {
  const emojis = ["🎉", "🍕", "🏕️", "🎮", "🏀", "🍻", "🎬", "🌮", "✈️", "🎨", "🎲", "🏖️"];
  dialog(`<h3>New group</h3>
    <label class="field"><span>Group name</span><input id="gName" maxlength="40" placeholder="Roommates, Book Club, The Crew"></label>
    <label class="field"><span>Icon</span><div class="emoji-pick" id="gEmoji">${emojis.map((e, i) => `<button type="button" class="${i === 0 ? "on" : ""}" data-e="${e}">${e}</button>`).join("")}</div></label>
    <p class="muted sm" style="margin:0">You'll add people by phone number right after, from the group page.</p>`,
    "Create group", async () => {
      const name = el("gName").value.trim(); if (!name) return toast("Give the group a name.");
      const emoji = $("#gEmoji .on")?.dataset.e || "🎉";
      const memberUids = [myUid()];
      // dedup: block a group whose member set already exists among mine
      const mySet = JSON.stringify([...memberUids].sort());
      for (const g of S.groups.values()) if (JSON.stringify([...(g.memberUids || [])].sort()) === mySet && !(g.invitedPhones || []).length)
        return toast("You already have a group with exactly these members.");
      const id = newId();
      await setDoc(doc(db, "groups", id), {
        name, emoji, color: "#FFE0B2", ownerId: myUid(), memberUids,
        members: { [myUid()]: { name: S.profile.name, venmo: S.profile.venmo || "", phone: S.profile.phone || "", os: myOs(), zelle: S.profile.zelle || "", cashapp: S.profile.cashapp || "", payPref: S.profile.payPref || "", birthday: S.profile.birthday || "" } },
        createdAt: Date.now()
      });
      closeDialog(); go("#/g/" + id); toast("Group created");
    });
  document.querySelectorAll("#gEmoji button").forEach(b => b.onclick = () => { document.querySelectorAll("#gEmoji button").forEach(x => x.classList.remove("on")); b.classList.add("on"); });
}
// Shared contact-picker used to invite people to a group, event, or meeting:
// pick from iPhone contacts or type name+phone. Friends already on Friendly
// are handed back as `direct` (with a uid); everyone else as `texted` (phone
// number only, to be added to a pending-invite list and texted a join link).
// Phone number is the one thing every contact reliably has, and the one thing
// the join/auto-add mechanisms actually match on.
// "Choose from contacts" black box (every user; taps on contacts are logged as "contact row", never a name or number). Every step and tap inside Add people is written to the
// device with a once-a-second heartbeat. Closing the dialog clears it, so a trace still there at the next
// launch means the app was force-closed mid-flow; it's reported as a diag row with where it stopped and
// whether the page's code was still running (heartbeat kept going) or had frozen (heartbeat stopped).
const CT_KEY = "friendlyContactsTrace";
const ctTrace = {
  t0: 0, steps: [], hb: null, last: 0,
  start(where) { this.t0 = Date.now(); this.steps = []; this.step("open " + where); clearInterval(this.hb); this.hb = setInterval(() => this.save(), 1000); },
  step(s) { if (!this.t0) return; this.last = Date.now(); this.steps.push(s + " @" + ((this.last - this.t0) / 1000).toFixed(1) + "s"); if (this.steps.length > 60) this.steps.splice(1, 1); this.save(); },
  save() { if (!this.t0) return; dogSay({ ct: { t0: this.t0, hb: Date.now(), last: this.last, steps: this.steps, route: location.hash, v: APP_V + " / " + (nativeVersion || "") } }); },
  end() { if (!this.t0) return; clearInterval(this.hb); this.hb = null; this.t0 = 0; dogSay({ ct: null }); }
};
document.addEventListener("visibilitychange", () => ctTrace.step(document.visibilityState));
async function reportContactsTrace() {
  await bootDiag; const tr = prevCt; prevCt = null;
  if (!tr || !myUid()) return;
  const alive = Math.round((tr.hb - tr.last) / 1000);
  // The page died while Add people was open and reloaded itself (the route survives a reload): put the person back
  // where they were. If it died under Apple's contacts permission screen, iOS has their answer by now, so the
  // contacts list loads straight away.
  if (KILLED_RELOAD && tr.route && tr.route === (location.hash || "").split("?")[0]) {
    addDoc(collection(db, "bugs"), { uid: myUid(), name: "diag", text: `contacts: iOS killed the page mid-flow (${deviceLine()}), reopened Add people on reload. Steps:\n` + (tr.steps || []).join("\n"), route: tr.route, version: tr.v, platform: NATIVE ? (IS_ANDROID ? "android" : "ios") : "web", status: "open", diag: true, createdAt: Date.now(), tracedAt: tr.t0 }).catch(() => {});
    resumeAddPeople(/showing Apple's permission screen|book load|asking iOS/.test(String((tr.steps || []).slice(-1)[0] || "")));
    return;
  }
  addDoc(collection(db, "bugs"), { uid: myUid(), name: "diag", text: `contacts trace (${deviceLine()}): app closed mid-flow. Code kept running ${alive}s after the last step${alive < 2 ? " (looks FROZEN)" : " (code alive, screen not responding?)"}.\n` + tr.steps.join("\n"), route: tr.route, version: tr.v, platform: NATIVE ? (IS_ANDROID ? "android" : "ios") : "web", status: "open", diag: true, createdAt: Date.now(), tracedAt: tr.t0 }).catch(() => {});
}
function resumeAddPeople(openContacts) {
  let tries = 0;
  const tick = () => {
    if (location.hash.split("?")[0] !== (S.route && S.route.name === "event" ? "#/e/" + S.route.id : S.route && S.route.name === "group" ? "#/g/" + S.route.id : "")) return;
    const ev = S.route.name === "event" && S.events.get(S.route.id), g = S.route.name === "group" && S.groups.get(S.route.id);
    if ((!ev && !g) || !el("addPeopleBtn")) { if (tries++ < 40) setTimeout(tick, 400); return; }
    if (el("appDialog")) return;
    if (ev) openEventInviteDialog(ev); else openInviteDialog(g);
    toast("Picking up where you left off", null, null, "happy");
    if (openContacts) setTimeout(() => { const b = el("invPick"); if (b) b.click(); }, 500);
  };
  tick();
}
// A contact as the phone's picker returns it: display name, and the first number that looks like one.
const nameOfContact = c => c.name ? (c.name.display || [c.name.given, c.name.family].filter(Boolean).join(" ")) : (c.displayName || "");
const phoneOfContact = c => { const raw = (c.phones || c.phoneNumbers || []).map(p => (p && p.number) || (typeof p === "string" ? p : "")).filter(Boolean); return raw.find(p => toE164(p)) || raw[0] || ""; };
function pickPeopleDialog({ title, blurb, exclude, excludeKeys = new Map(), pendingPhones = new Map(), submitLabel = "Add & send", knownLabel = "On Friendly · added right away", phoneLabel = "Gets a text with the join link", onSubmit }) {
  const me = myUid(); const picked = [];   // { name, phone, e164, uid|null }
  const nativeContacts = plugin("Contacts");
  const webPicker = !nativeContacts && ("contacts" in navigator && "ContactsManager" in window);
  const known = [...S.contacts.entries()].filter(([u]) => u !== me && !exclude.has(u));
  const byPhone = e164 => e164 && known.find(([, i]) => toE164(i.phone) === e164);
  // skipped: when several contacts come back at once, collect the reasons and say them in one message.
  const addPicked = async (name, phone, skipped) => {
    const say = msg => skipped ? skipped.push(msg) : toast(msg);
    const e164 = toE164(phone); if (!e164) return say(`Couldn't read a phone number for ${name || "that contact"}.`);
    if (picked.some(p => p.e164 === e164)) return;
    // Already invited by text (by any host) and hasn't joined Friendly yet: don't text them a second invite.
    if (pendingPhones.has(e164)) return say(`${first(pendingPhones.get(e164) || name || "") || "They"} already has an invite and hasn't joined yet.`);
    // Already on this event/group (the picker hides them, but a typed or address-book
    // number wouldn't otherwise be recognized and would text them a second invite).
    const dup = [...S.contacts.entries()].find(([u, i]) => exclude.has(u) && toE164(i.phone) === e164);
    if (dup) return say(`${first(dup[1].name || "") || "They"} ${dup[0] === me ? "-- that's you" : "is already on the list"}.`);
    // People the host doesn't share a group with (they joined by link) are known only by phone key.
    if (excludeKeys.size) { const k = await phoneKey(e164); if (excludeKeys.has(k)) return say(`${first(excludeKeys.get(k) || "") || "They"} is already on the list.`); }
    const hit = byPhone(e164); picked.push({ name: name || (hit ? hit[1].name : "") || "", phone, e164, uid: hit ? hit[0] : null }); renderPicked();
  };
  const renderPicked = () => {
    const box = el("invChosen"); if (!box) return;
    box.innerHTML = picked.length ? `<div class="inv-picked-head">✓ Adding ${picked.length} ${picked.length === 1 ? "person" : "people"}</div>` + picked.map((p, i) => `<div class="inv-hit picked"><span class="picked-check">✓</span><div style="flex:1;min-width:0"><b>${esc(p.name || p.e164)}</b><div class="muted sm">${p.uid ? knownLabel : phoneLabel}${p.e164 ? " · " + esc(p.e164) : ""}</div></div><button type="button" class="btn ghost small" data-unpick="${i}" aria-label="Remove">✕</button></div>`).join("") : `<p class="muted sm" style="margin:0">Nobody picked yet.</p>`;
    box.querySelectorAll("[data-unpick]").forEach(b => b.onclick = () => { const gone = picked.splice(+b.dataset.unpick, 1)[0]; renderPicked(); if (gone && el("invBook")) paintBook(el("invBookQ") ? el("invBookQ").value : ""); if (el("invResults") && el("invSearch")) el("invSearch").dispatchEvent(new Event("input")); });
  };
  dialog(`<h3>${esc(title)}</h3>
    <p class="muted" style="margin-top:-6px">${esc(blurb)}</p>
    ${isDemo() ? `<p class="muted sm">Inviting by phone number is off in the demo, so it never texts a real person -- add Jordan or Casey below instead.</p>` : nativeContacts || webPicker ? `<button type="button" class="btn primary" id="invPick" style="width:100%">📇 Choose from contacts</button>` : `<p class="muted sm">Picking from your address book works in the Friendly iPhone app. Here, type a name and number:</p>`}
    ${isDemo() ? "" : `<div class="inv-manual"><span class="field-label" style="margin:0 0 6px">Not in your contacts? Type them in</span><div class="two"><label class="field"><span>Name</span><input id="invName" placeholder="Jo Park" maxlength="40" autocomplete="off"></label><label class="field"><span>Phone</span><input id="invPhone" inputmode="tel" placeholder="+1 555 123 4567" autocomplete="off"></label></div>
    <button type="button" class="btn small" id="invAddManual">＋ Add to the list</button></div>`}
    <p class="muted sm" id="invNote" hidden style="margin:8px 0 0;color:var(--bad)"></p>
    <div class="inv-chosen inv-picked" id="invChosen" style="margin-top:12px"></div>
    ${known.length ? `<details class="adv" style="margin-top:12px"><summary>Friends from your other groups</summary><input class="inv-search" id="invSearch" placeholder="Search by name…" autocomplete="off" style="margin-top:8px"><div class="inv-results" id="invResults"></div></details>` : ""}`,
    submitLabel, async () => {
      const direct = picked.filter(p => p.uid); const texted = picked.filter(p => !p.uid);
      if (!direct.length && !texted.length) return toast("Pick someone first.");
      await onSubmit(direct, texted);
    });
  renderPicked();
  ctTrace.start(location.hash);
  { const dlg = el("appDialog"); if (dlg) dlg.addEventListener("pointerdown", e => { const t = e.target.closest("button,input,label,summary") || e.target; ctTrace.step("tap " + (t.dataset.book ? "contact checkbox" : t.closest(".book-row") ? "contact row" : t.closest(".inv-hit") ? "picked person" : t.id || (t.tagName === "BUTTON" ? t.textContent : t.tagName)).toString().trim().slice(0, 24)); }, true); }
  if (el("invAddManual")) el("invAddManual").onclick = () => { addPicked(el("invName").value.trim(), el("invPhone").value.trim()); el("invName").value = ""; el("invPhone").value = ""; };
  // "Choose from contacts": your address book as a searchable checklist right here in the dialog (check as many
  // as you like). It reads the contacts on the phone only to show this list; nothing is uploaded except the
  // people you pick. Apple's own picker sheet froze the iPhone app in multi-select mode, so it's only the
  // fallback now (one at a time) for when contacts access is declined.
  const knownE164 = new Map([...S.contacts.entries()].filter(([u, i]) => u !== me && i.phone).map(([u, i]) => [toE164(i.phone), u]));
  let book = null;
  const paintBook = q => {
    const box = el("invBook"); if (!box || !book) return;
    const ql = String(q || "").toLowerCase().trim(), digits = ql.replace(/\D/g, "");
    const hits = book.filter(c => !ql || c.name.toLowerCase().includes(ql) || (digits.length >= 3 && c.e164.includes(digits))).slice(0, 250);
    box.innerHTML = hits.length ? hits.map(c => { const on = picked.some(p => p.e164 === c.e164), friendly = knownE164.has(c.e164);
      return `<label class="book-row"><input type="checkbox" data-book="${esc(c.e164)}" ${on ? "checked" : ""}><span class="book-name"><b>${esc(c.name || c.phone)}</b><span class="muted sm">${esc(c.phone)}${friendly ? ` · <span class="book-on">On Friendly</span>` : ""}</span></span></label>`; }).join("")
      : `<p class="muted sm" style="padding:8px 4px;margin:0">${book.length ? "Nobody by that name." : "No contacts with phone numbers."}</p>`;
    box.querySelectorAll("[data-book]").forEach(cb => cb.onchange = async () => {
      const c = book.find(x => x.e164 === cb.dataset.book); if (!c) return;
      if (cb.checked) { const notes = []; await addPicked(c.name, c.phone, notes); if (notes.length) { cb.checked = false; bookNote(notes[0]); } }
      else { const i = picked.findIndex(p => p.e164 === c.e164); if (i >= 0) { picked.splice(i, 1); renderPicked(); } }
    });
  };
  const bookNote = t => { const n = el("invNote"); if (n) { n.textContent = t; n.hidden = !t; } };
  // Loads the phone's address book once per app session (cached), with a time limit on every step so the
  // button can't silently hang: it says what it's doing at once, and offers Try again if the phone is slow.
  const withTimeout = (pr, ms, what) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error(what + " took too long")), ms))]);
  const slowLog = (ms, n, err, permMs = 0) => { try { if (myUid() && (ms > 2500 || permMs > 5000 || err)) addDoc(collection(db, "bugs"), { uid: myUid(), name: "diag", text: `contacts: address book read took ${ms}ms for ${n} contacts; ${permMs}ms on the access check/permission screen before it${err ? "; error: " + err : ""}. Steps: ` + ctTrace.steps.join(" · "), route: location.hash, version: APP_V + " / " + (nativeVersion || ""), platform: NATIVE ? (IS_ANDROID ? "android" : "ios") : "web", status: "open", diag: true, createdAt: Date.now() }).catch(() => {}); } catch {} };
  async function openBook() {
    const C = nativeContacts, btn = el("invPick");
    if (btn) { btn.textContent = "Opening your contacts…"; btn.disabled = true; }
    ctTrace.step(window.__friendlyBook ? "book cached" : "book load");
    if (!window.__friendlyBook) {
      let perm = null; const tPerm = Date.now();
      try {
        ctTrace.step("asking iOS for access status");
        perm = await withTimeout(C.checkPermissions(), 6000, "Checking contacts access");
        ctTrace.step("status " + (perm && perm.contacts));
        if (perm && perm.contacts !== "granted" && perm.contacts !== "limited") { ctTrace.step("showing Apple's permission screen"); perm = await C.requestPermissions(); }
      } catch (e) { ctTrace.step("access check error " + String((e && e.message) || e).slice(0, 50)); }
      ctTrace.step("perm " + (perm && perm.contacts));
      if (!perm || (perm.contacts !== "granted" && perm.contacts !== "limited")) { if (btn) { btn.disabled = false; btn.textContent = "📇 Choose from contacts"; } return false; }
      // A big address book can take ten seconds or more on some phones; a ticking count shows it's alive.
      if (btn) btn.textContent = "Loading your contacts…";
      const t1 = Date.now(), tick = setInterval(() => { const b = el("invPick"); if (b) b.textContent = `Loading your contacts… ${Math.round((Date.now() - t1) / 1000)}s`; }, 1000);
      let r; try { r = await withTimeout(C.getContacts({ projection: { name: true, phones: true } }), 25000, "Loading your contacts"); } finally { clearInterval(tick); }
      ctTrace.step("got " + ((r && r.contacts) || []).length);
      const seen = new Set();
      window.__friendlyBook = ((r && r.contacts) || []).map(c => { const phone = phoneOfContact(c); return { name: nameOfContact(c).trim(), phone, e164: toE164(phone) }; })
        .filter(c => c.e164 && !seen.has(c.e164) && seen.add(c.e164)).sort((a, b) => (a.name || "~").localeCompare(b.name || "~"));
      slowLog(Date.now() - t1, window.__friendlyBook.length, null, t1 - tPerm);
    }
    book = window.__friendlyBook;
    const b2 = el("invPick"); if (!b2) return true;
    b2.outerHTML = `<div class="book"><input type="search" class="inv-search" id="invBookQ" placeholder="Search your contacts…" autocomplete="off"><div class="book-list" id="invBook"></div></div>`;
    el("invBookQ").oninput = e => paintBook(e.target.value);
    paintBook(""); ctTrace.step("list shown " + book.length); return true;
  }
  if (el("invPick")) el("invPick").onclick = async () => {
    bookNote("");
    try {
      if (nativeContacts) {
        if (nativeContacts.getContacts && await openBook()) return;
        // No contacts access: Apple's picker, one person at a time.
        const r = await nativeContacts.pickContact({ projection: { name: true, emails: true, phones: true } });
        const c = (r && (r.contact || (r.contacts && r.contacts[0]))) || (r && r.name ? r : null);
        if (!c) return bookNote("No contact came back from the picker.");
        const notes = []; await addPicked(nameOfContact(c), phoneOfContact(c), notes); if (notes.length) bookNote(notes.join(" "));
      }
      else { const rows = await navigator.contacts.select(["name", "tel"], { multiple: true }); const notes = []; for (const r of rows) await addPicked((r.name || [])[0] || "", (r.tel || [])[0] || "", notes); if (notes.length) bookNote(notes.join(" ")); }
    } catch (e) { const m = String((e && e.message) || e || ""); ctTrace.step("error " + m.slice(0, 60)); slowLog(0, 0, m); if (el("invPick")) { el("invPick").disabled = false; el("invPick").textContent = "📇 Try again"; } bookNote(/cancel/i.test(m) || !m ? "" : "Couldn't read your contacts: " + m); }
  };
  if (el("invSearch")) {
    const renderResults = q => { const ql = q.toLowerCase(); const hits = known.filter(([u, i]) => !picked.some(p => p.uid === u) && (i.name || "").toLowerCase().includes(ql)); el("invResults").innerHTML = hits.slice(0, 8).map(([u, i]) => `<div class="inv-hit" data-choose="${u}">${avatar(u)}<div><b>${esc(i.name || "Friend")}</b></div><span class="add">Add</span></div>`).join("") || `<p class="muted sm">No one else to add.</p>`; };
    renderResults(""); el("invSearch").oninput = e => renderResults(e.target.value);
    el("invResults").onclick = e => { const h = e.target.closest("[data-choose]"); if (h) { const i = S.contacts.get(h.dataset.choose) || {}; picked.push({ name: i.name || "Friend", phone: i.phone || "", e164: toE164(i.phone), uid: h.dataset.choose }); renderPicked(); renderResults(el("invSearch").value); } };
  }
}
function openInviteDialog(g) {
  pickPeopleDialog({
    title: `Add people to ${esc(g.name)}`,
    blurb: "Pick them from your contacts. Friends already on Friendly are added on the spot; everyone else gets a text from you with a join link.",
    exclude: new Set(g.memberUids || []),
    pendingPhones: new Map((g.invitedPhones || []).map(p => [p, (g.invitedPhoneNames || {})[p] || ""])),
    onSubmit: async (direct, texted) => {
      const updates = {};
      if (direct.length) { updates.memberUids = [...new Set([...(g.memberUids || []), ...direct.map(p => p.uid)])]; for (const p of direct) { const info = S.contacts.get(p.uid) || {}; updates[`members.${p.uid}`] = { name: info.name || p.name || "Friend", venmo: info.venmo || "", phone: info.phone || "", os: info.os || "", photo: info.photo || "", birthday: info.birthday || "" }; } }
      const addP = texted.map(p => p.e164).filter(n => !(g.invitedPhones || []).includes(n)); if (addP.length) updates.invitedPhones = [...(g.invitedPhones || []), ...addP];
      for (const p of texted) if (p.e164) updates[`invitedPhoneNames.${p.e164}`] = p.name || "";
      try {
        if (Object.keys(updates).length) await updateDoc(doc(db, "groups", g.id), updates);
        closeDialog(); toast(direct.length ? direct.length + " added" + (texted.length ? ", texting the rest" : "") : texted.length ? "Opening Messages…" : "Invites sent", null, null, "happy");
        if (texted.length === 1) setTimeout(() => { location.href = smsLink([texted[0].e164], groupInviteText(g)); }, 400);
        else if (texted.length > 1) setTimeout(() => openTextInviteDialog(texted, groupInviteText(g), "group"), 400);
      } catch (e) { toast(e.message); }
    }
  });
}
// The text an invitee gets. It comes from the inviter's own number via Messages.
// Links to Friendly's own preview page (a compact card with the group's name), not the App Store's tall screenshot card.
const groupInviteText = g => `Hey! I added you to our group "${g.name}" on Friendly, our crew's home base for plans, invites, photos, and settling up. Join here: ${FN_BASE}/share/g/${g.id} (free). Sign up with this phone number and you're in.`;
// iOS sometimes narrows a multi-recipient sms: link to an existing thread with just the
// first person, so with more than one new guest we let the host pick: one group text, or
// tap through each person.
// Guided one-after-another send: iOS won't let any app fire off several real
// texts with one tap (only the Messages app can actually send, and only with
// a person physically tapping Send there), so this is the closest thing to
// "one click, all individual invites go out" -- it opens Messages pre-filled
// for person 1, and the moment the person returns to Friendly (a real
// hidden->visible round trip, not just any visibilitychange fire) it opens
// person 2, and so on. The message itself is editable up front so there's one
// clear place to review it before anything goes out.
// Auto-send on iPhone: Friendly's "Friendly Invites" Shortcut takes {m: message, p: [numbers]}, texts each
// number from the user's own phone (one text per person), then opens Friendly again. Off until the
// Shortcut's iCloud link is set. Whether it's installed can't be detected, so a device remembers it
// after the first send that comes back.
const INVITES_SHORTCUT_URL = "https://www.icloud.com/shortcuts/96d0a800f5d6409c9cec3fe35f4125d8";
const AUTO_SEND = NATIVE && !IS_ANDROID && !!INVITES_SHORTCUT_URL;
const autoSendReady = v => { try { if (v === undefined) return LS.get("friendlyAutoSend") === "1"; if (v) LS.set("friendlyAutoSend", "1"); else LS.remove("friendlyAutoSend"); } catch { return false; } };
const shortcutRunUrl = (numbers, body) => "shortcuts://run-shortcut?name=" + encodeURIComponent("Friendly Invites") + "&input=text&text=" + encodeURIComponent(JSON.stringify({ m: body, p: numbers.map(n => n.replace(/[^+\d]/g, "")) }));
function openTextInviteDialog(texted, text, where = "event", title = "Text your invite") {
  let idx = -1, active = false, wasHidden = false;
  // auto-send states: "offer" (setup card), "added" (back from the Add Shortcut screen), "ready", "sent", "off"
  let auto = AUTO_SEND && texted.length > 1 ? (autoSendReady() ? "ready" : "offer") : "off", pending = null;
  const n = texted.length;
  const rowsHtml = () => texted.map((p, i) => `<div class="member-row" data-row="${i}"><div style="flex:1;min-width:0"><b>${esc(p.name)}</b><div class="muted sm">${esc(fmtPhone(p.e164))}</div></div>${i < idx ? `<span class="sent-ok">✓ Sent</span>` : i === idx && active ? `<span class="sm" style="font-weight:700;color:var(--accent)">Sending…</span>` : `<button type="button" class="btn small" data-textone="${i}">Text</button>`}</div>`).join("");
  const autoHtml = () => auto === "offer" ? `<div class="auto-card"><b>⚡ Send all ${n} at once</b><span class="new-tag">NEW</span>
      <p>Add Friendly's free iPhone Shortcut one time (about 5 seconds). After that, every invite goes out in one tap, from your number.</p>
      <button type="button" class="btn primary" id="autoSetup" style="width:100%">Set up auto-send</button>
      <button type="button" class="linkish" id="autoSkip">Not now</button></div>`
    : auto === "added" ? `<div class="auto-card"><b>Added it?</b>
      <p>Tap below and Shortcuts texts all ${n} from your number, then brings you back here. The first time, iPhone asks permission: tap Always Allow.</p>
      <button type="button" class="btn primary" id="autoRun" style="width:100%">⚡ Send all ${n} now</button>
      <button type="button" class="linkish" id="autoSetup">Open the setup again</button></div>`
    : auto === "ready" ? `<button type="button" class="btn primary" id="autoRun" style="width:100%;margin-top:10px">⚡ Send all ${n} at once</button>`
    : auto === "sent" ? `<div class="sent-banner">✓ Sent to all ${n} from your number</div><p class="muted sm" style="margin:6px 0 0">They're in your Messages too, so replies come straight to you. <button type="button" class="linkish" id="autoUndo">Didn't go through? Send one at a time</button></p>`
    : "";
  const oneAtATime = auto === "ready" || auto === "added" || auto === "offer";
  dialog(`<h3>${esc(title)}</h3>
    <p class="muted" style="margin-top:-6px">${auto === "off" ? "Edit the message if you want, then send it to everyone one at a time -- iPhone only lets you send from Messages yourself, so this walks you through each person: it opens Messages, you tap Send, and coming back here opens the next one." : "Edit the message if you want, then send it to everyone. The texts come from your own number."}</p>
    <label class="field"><span>Message</span><textarea id="txtMsg" maxlength="480">${esc(text)}</textarea></label>
    <div id="autoBox">${autoHtml()}</div>
    <button type="button" class="btn ${oneAtATime ? "" : "primary"}" id="textAll" style="width:100%;margin:10px 0 12px">💬 Send to all ${n}, one at a time${oneAtATime ? " instead" : ""}</button>
    <div class="stack" id="txtRows">${rowsHtml()}</div>
    <p class="muted sm" style="margin:10px 0 0">${{ expense: `You can text anyone again from the expense: tap <b>Text</b> next to their name.`, friends: `You can always come back and text stragglers from <b>Friends › Invited</b>.`, group: `You can always come back and text stragglers from the group's <b>Invited</b> list or <b>Friends › Invited</b>.`, event: `You can always come back and text stragglers from the event's <b>Guest list</b> or <b>Friends › Invited</b>.` }[where]}</p>`, null, null);
  const currentText = () => el("txtMsg").value;
  const renderRows = () => { const box = el("txtRows"); if (box) box.innerHTML = rowsHtml(); wireRowButtons(); };
  function renderAuto() {
    const box = el("autoBox"); if (!box) return; box.innerHTML = autoHtml();
    const all = el("textAll"); if (all) { all.style.display = auto === "sent" ? "none" : ""; all.classList.toggle("primary", auto === "off"); if (!active && idx < 0) all.textContent = `💬 Send to all ${n}, one at a time${auto === "off" ? "" : " instead"}`; }
    if (el("autoSetup")) el("autoSetup").onclick = () => { pending = "setup"; location.href = INVITES_SHORTCUT_URL; };
    if (el("autoSkip")) el("autoSkip").onclick = () => { auto = "off"; renderAuto(); };
    if (el("autoRun")) el("autoRun").onclick = () => { pending = "run"; location.href = shortcutRunUrl(texted.map(p => p.e164), currentText()); };
    if (el("autoUndo")) el("autoUndo").onclick = () => { autoSendReady(false); auto = "off"; idx = -1; renderRows(); renderAuto(); };
  }
  function wireRowButtons() { document.querySelectorAll("[data-textone]").forEach(b => b.onclick = () => { const p = texted[+b.dataset.textone]; location.href = smsLink([p.e164], currentText()); }); }
  function advance() {
    idx++;
    renderRows();
    if (idx >= texted.length) { active = false; el("textAll").textContent = "✓ Sent to everyone"; el("textAll").disabled = true; return; }
    setTimeout(() => { location.href = smsLink([texted[idx].e164], currentText()); }, 350);
  }
  const onVis = () => {
    if (document.visibilityState === "hidden") { if (active || pending) wasHidden = true; return; }
    if (document.visibilityState !== "visible" || !wasHidden) return;
    wasHidden = false;
    if (pending === "setup") { pending = null; auto = "added"; renderAuto(); return; }
    if (pending === "run") { pending = null; autoSendReady(true); auto = "sent"; idx = texted.length; renderRows(); renderAuto(); return; }
    if (active) advance();
  };
  document.addEventListener("visibilitychange", onVis);
  const cancelBtn = el("dlgCancel"); if (cancelBtn) cancelBtn.addEventListener("click", () => document.removeEventListener("visibilitychange", onVis), { once: true });
  el("textAll").onclick = () => { if (active) return; if (auto !== "off" && auto !== "sent") { auto = "off"; renderAuto(); } active = true; idx = -1; advance(); };
  wireRowButtons(); renderAuto();
}
async function acceptInvite(gid, btn) {
  const g = S.pendingInvites.get(gid) || (S.pendingInvitesPhone && S.pendingInvitesPhone.get(gid)); if (!g) return;
  if (btn) { btn.disabled = true; btn.textContent = "Joining…"; }
  try {
    await updateDoc(doc(db, "groups", gid), {
      memberUids: [...(g.memberUids || []), myUid()],
      invitedEmails: (g.invitedEmails || []).filter(e => e !== (S.user.email || "").toLowerCase()),
      invitedPhones: (g.invitedPhones || []).filter(p => p !== (S.profile.phoneE164 || "-")),
      [`invitedPhoneNames.${S.profile.phoneE164 || "-"}`]: deleteField(),
      [`members.${myUid()}`]: { name: S.profile.name, venmo: S.profile.venmo || "", phone: S.profile.phone || "", os: myOs(), zelle: S.profile.zelle || "", cashapp: S.profile.cashapp || "", payPref: S.profile.payPref || "", photo: myPhotoSm(), birthday: S.profile.birthday || "" }
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
async function uninvite(g, email) { try { await updateDoc(doc(db, "groups", g.id), { invitedEmails: (g.invitedEmails || []).filter(e => e !== email) }); } catch (e) { toast(e.message); } }
async function uninvitePhone(g, e164) { try { await updateDoc(doc(db, "groups", g.id), { invitedPhones: (g.invitedPhones || []).filter(p => p !== e164), [`invitedPhoneNames.${e164}`]: deleteField() }); } catch (e) { toast(e.message); } }
async function deleteGroup(g) { if (isDemo() && g.id === DEMO_GROUP) return toast("Deleting the demo group is off -- it resets nightly instead."); if (!confirm(`Delete “${g.name}”? Its events stay, but the group is removed.`)) return; try { await deleteDoc(doc(db, "groups", g.id)); go("#/groups"); toast("Group deleted"); } catch (e) { toast(e.message); } }
async function leaveGroup(g) {
  if (isDemo() && g.id === DEMO_GROUP) return toast("Leaving the demo group is off -- it resets nightly instead.");
  if (!confirm(`Leave “${g.name}”?`)) return;
  try {
    const members = { ...(g.members || {}) }; delete members[myUid()];
    const rest = (g.memberUids || []).filter(u => u !== myUid());
    if (g.ownerId === myUid() && !rest.length) { await deleteDoc(doc(db, "groups", g.id)); go("#/groups"); toast("Group deleted"); return; }
    const up = { memberUids: rest, hostUids: arrayRemove(myUid()), members };
    if (g.ownerId === myUid()) up.ownerId = (g.hostUids || []).find(u => rest.includes(u)) || rest[0];
    await updateDoc(doc(db, "groups", g.id), up);
    go("#/groups"); toast("You left " + g.name);
  } catch (e) { toast(e.message); }
}

// ---------- COMPOSE (create event) ----------
const compose = { theme: DEFAULT_THEME, customTheme: null, emoji: "🎉", cover: null, coverTab: "emoji",
  title: "", date: "", time: "", end: "", where: "", food: "", notes: "", cap: "", approval: false,
  questions: [], invitees: new Set(), phoneInvitees: [], cohosts: new Set(), groupId: "" };
function resetCompose() { Object.assign(compose, { theme: DEFAULT_THEME, customTheme: null, emoji: "🎉", cover: null, coverTab: "emoji", title: "", date: "", time: "", end: "", where: "", food: "", notes: "", cap: "", approval: false, questions: [], invitees: new Set(), phoneInvitees: [], cohosts: new Set(), groupId: "", kind: "event", endDate: "", repeat: "", stops: [], _restored: false, _fromDraft: false, _plan: null, _draftId: null, plusOn: null, plusMax: 0, bring: [], bringOn: true, carOn: true, drive: false, seats: 3 }); clearTimeout(draftTimer); }
// ---- "Let me plan it": say the plan, Dot drafts it, you review it in the composer. Nothing is created or sent until you tap Create.
function planContext(text, mode, ctx) {
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  const people = [...new Set([...S.contacts.values()].map(c => c && c.name).filter(Boolean))].filter(n => n !== S.profile.name).slice(0, 150);
  const groups = [...S.groups.values()].map(g => g.name).filter(Boolean).slice(0, 40);
  const base = { mode, text: text.slice(0, 1500), today: todayStr(), weekday: d.toLocaleDateString("en-US", { weekday: "long" }), now: pad(d.getHours()) + ":" + pad(d.getMinutes()), tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || ""), people, groups };
  if (mode === "event" && ctx.groupId) { const g = S.groups.get(ctx.groupId); if (g) base.groupHint = g.name; }
  if (mode === "edit" && ctx.ev) { const e = ctx.ev; base.current = { title: e.title, date: e.date, time: e.time || "", endTime: e.endTime || "", location: e.location || "", food: e.food || "", notes: e.notes || "", capacity: e.capacity || 0 }; }
  return base;
}
const PLAN_COPY = {
  event: { lead: "Tell me the plan like you'd text a friend: what, when, where, who, what to bring. I'll fill everything in, and you check it before anything sends.", label: "The plan", ph: "Taco night at my place next Friday at 7. Invite the Fruit Basket crew, everyone brings a side, cap it at 12.", ok: "Take it from here" },
  expense: { lead: "Tell me what it was, how much, who paid, and who's splitting it. I'll set it up and you check it.", label: "The expense", ph: "Dinner was 120, I paid, split with Sam and Alex.", ok: "Set it up" },
  edit: { lead: "Tell me what to change and I'll line it up. You still tap Save.", label: "The change", ph: "Move it to 8, and add that parking is on the street.", ok: "Line it up" }
};
function openPlanDialog(mode = "event", ctx = {}) {
  if (isDemo()) return toast("Talking to Dot is off in the demo -- try the regular buttons instead.");
  const c = PLAN_COPY[mode] || PLAN_COPY.event;
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micHint = (NATIVE || IOS) ? `Tap the mic on your keyboard to talk instead of type.` : Speech ? `<button type="button" class="btn small" id="planMic">🎤 Talk instead</button>` : "";
  const lead = mode === "edit" && ctx.ev ? `What should change about “${esc(ctx.ev.title)}”? ${c.lead}` : c.lead;
  dialog(`<div class="dot-say">${dot("happy", 56)}<div class="say-bubble">${lead}</div></div>
    <label class="field"><span>${c.label}</span><textarea id="planText" rows="5" maxlength="1500" placeholder="${esc(c.ph)}"></textarea></label>
    <p class="muted sm" style="margin:-2px 0 0">${micHint}</p>`, c.ok, async () => {
    const text = el("planText").value.trim(); if (text.length < (mode === "edit" ? 3 : 8)) return toast("Tell me a little more.");
    const ok = el("dlgOk"); ok.disabled = true; ok.textContent = "Working on it…";
    const box = document.querySelector("#appDialog .dot-say"); if (box) box.innerHTML = `${dot("thinking", 56)}<div class="say-bubble">Got it. Working out the details…</div>`;
    try {
      const res = await requestViaFirestore("planRequests", planContext(text, mode, ctx), 60000); closeDialog();
      if (mode === "expense") applyExpense(res.data || {}, ctx); else if (mode === "edit") applyEdit(res.data || {}, ctx.ev); else applyPlan(res.data || {}, text);
    }
    catch (e) { ok.disabled = false; ok.textContent = c.ok; if (box) box.innerHTML = `${dot("oops", 56)}<div class="say-bubble">Hmm, that didn't go through. Try again?</div>`; toast("I couldn't work that out: " + e.message); }
  });
  setTimeout(() => { const t = el("planText"); if (t) t.focus(); }, 60);
  const mic = el("planMic");
  if (mic && Speech) {
    const rec = new Speech(); rec.lang = navigator.language || "en-US"; rec.continuous = true; rec.interimResults = true; let on = false, base = "";
    mic.onclick = () => { if (on) { rec.stop(); return; } base = el("planText").value.trim(); try { rec.start(); on = true; mic.textContent = "■ Stop"; } catch {} };
    rec.onresult = ev => { let t = ""; for (const r of ev.results) t += r[0].transcript + " "; el("planText").value = (base + " " + t).trim(); };
    rec.onend = () => { on = false; mic.textContent = "🎤 Talk instead"; };
    rec.onerror = () => { on = false; mic.textContent = "🎤 Talk instead"; };
  }
}
// Names -> friends: a unique full-name match, else a unique first-name match. Anything else is reported, never guessed.
function matchFriends(names, extra) {
  const pool = new Map(S.contacts); for (const [u, i] of extra || []) if (!pool.has(u)) pool.set(u, i);
  const contacts = [...pool.entries()].filter(([uid, c]) => uid !== myUid() && c && c.name && c.name !== "Someone");
  const uids = [], unmatched = [];
  for (const raw of (names || []).slice(0, 30)) {
    const n = String(raw).trim().toLowerCase(); if (!n) continue;
    if (n === "me" || n === "i") { uids.push(myUid()); continue; }
    let hits = contacts.filter(([, c]) => c.name.trim().toLowerCase() === n);
    if (!hits.length) hits = contacts.filter(([, c]) => c.name.trim().toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]);
    if (hits.length === 1) uids.push(hits[0][0]); else unmatched.push(String(raw).trim());
  }
  return { uids, unmatched };
}
// ---- Curate: Dot finds real nights out near your city (server-side, web-grounded, cached nightly per city),
//      pairs each with a place to eat, and turns a pick into a plan, a poll, tickets or a table.
const CURATE_LABEL = "Curate";
const CURATE_FILTERS = [["weekend", "This weekend"], ["tonight", "Tonight"], ["late", "Late night"], ["date", "Date night"], ["group", "Group of 6+"], ["cheap", "Under $40"], ["family", "Family"]];
const CURATE_LEADS = { weekend: "A few nights worth leaving the house for this weekend. Tap one and I'll set it up.", tonight: "Short notice, still good.", date: "For just the two of you.", group: "Big group? These places handle it.", cheap: "Good nights that won't hurt.", family: "Kid-friendly, and you'll like it too." };
let curFilter = "weekend", curSub = null, curCoverSub = null, curKey = "";
const cityKeyOf = c => String(c || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const pad2 = n => String(n).padStart(2, "0");
const addDays = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); const x = new Date(y, m - 1, d + n); return x.getFullYear() + "-" + pad2(x.getMonth() + 1) + "-" + pad2(x.getDate()); };
function nowCtx() { const d = new Date(); return { today: todayStr(), weekday: d.toLocaleDateString("en-US", { weekday: "long" }), now: pad2(d.getHours()) + ":" + pad2(d.getMinutes()), tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || "") }; }
// How far out Dot looks. 25 miles keeps the plain city key (the nights already cached); other distances get their own ("frisco-tx--10mi").
const CURATE_MILES = [5, 10, 25, 50], DEFAULT_MILES = 25;
const myMiles = () => { const m = Number(S.profile && S.profile.curateMiles); return CURATE_MILES.includes(m) ? m : DEFAULT_MILES; };
const curatedKey = (city, miles) => { const k = cityKeyOf(city); return k && (miles === DEFAULT_MILES ? k : k + "--" + miles + "mi"); };
function registerCity(city, miles = myMiles()) { const key = curatedKey(city, miles); if (!key) return; setDoc(doc(db, "curateCities", key), { key, city, miles, tz: nowCtx().tz, updatedAt: Date.now() }, { merge: true }).catch(() => {}); }
const milesSelect = id => `<select id="${id}" class="btn small miles-sel" aria-label="How far to look" title="How far Dot looks from your city">${CURATE_MILES.map(m => `<option value="${m}" ${m === myMiles() ? "selected" : ""}>${m} mi</option>`).join("")}</select>`;
async function saveMiles(v) {
  const miles = CURATE_MILES.includes(Number(v)) ? Number(v) : DEFAULT_MILES; if (miles === myMiles()) return;
  const city = (S.profile.city || "").trim();
  try { await updateDoc(doc(db, "users", myUid()), { curateMiles: miles }); if (city) { registerCity(city, miles); toast(`Looking within ${miles} miles of ${city}…`, null, null, "thinking"); } } catch (e) { toast(e.message); }
}
// Subscribe to the city's cached nights; ask the server to build them if there are none for today yet.
function ensureCurated() {
  const city = (S.profile && S.profile.city || "").trim(), miles = myMiles(), key = curatedKey(city, miles); if (!key) return;
  if (curKey === key && curSub) return;
  if (curSub) curSub(); if (curCoverSub) curCoverSub(); curKey = key; S.curCovers = {}; S._curBuilding = false; S._curError = "";
  stampCitySeen(key);
  // Show the last nights this phone saw right away; the live copy replaces them when it arrives.
  S.curated = null; try { const c = JSON.parse(LS.get("friendlyCurated:" + key) || "null"); if (c && c.nights) S.curated = c; } catch {}

  curSub = onSnapshot(doc(db, "curated", key), snap => {
    const d = snap.exists() ? snap.data() : null;   // just the nights and which covers exist; the images load separately
    if (!d && snap.metadata.fromCache && S.curated) return;               // no local copy yet; keep showing the saved one
    S.curated = d; if (d) try { LS.set("friendlyCurated:" + key, JSON.stringify(d)); } catch {}
    if ((!d || (d.forDate || "") < addDays(todayStr(), -1) || (d.v || 1) < 4) && !S._curBuilding && !isDemo()) {   // v3 = four per filter, de-duplicated
      S._curBuilding = true;
      S._curPhase = "starting";
      requestViaFirestore("planRequests", { mode: "curate-city", city, miles, ...nowCtx() }, 280000, d => { if (d.phase && d.phase !== S._curPhase) { S._curPhase = d.phase; render(); } }).then(() => { S._curBuilding = false; }).catch(e => { S._curBuilding = false; S._curError = e.message; render(); });
    }
    render();
  }, err => { S._curError = err.message; render(); });
}
// Painted covers are served one image at a time (cached by the phone) instead of riding along with the nights list.
// Covers are painted on request: the nights on screen without one are asked for (once per session each), and
// the live curated doc brings the new ids back as they're painted.
let wantTimer = 0; const wantQueue = new Set(), wantSent = new Set();
function wantCovers(nights) {
  if (isDemo() || !curKey) return;
  const have = (S.curated && S.curated.coverIds) || [];
  nights.forEach(n => { const id = n && n.coverId; if (id && !have.includes(id) && !wantSent.has(curKey + id)) { wantSent.add(curKey + id); wantQueue.add(id); } });
  if (!wantQueue.size || wantTimer) return;
  wantTimer = setTimeout(() => { const ids = [...wantQueue].slice(0, 30); wantQueue.clear(); wantTimer = 0;
    setDoc(doc(db, "coverWants", curKey), { ids: arrayUnion(...ids), at: Date.now() }, { merge: true }).catch(e => console.warn("cover wants:", e.message)); }, 400);
}
// Once a day per phone: this city still has someone looking, so the nightly refresh keeps it.
function stampCitySeen(key) {
  const k = "friendlyCitySeen:" + key, t = todayStr(); if (isDemo() || LS.get(k) === t) return;
  LS.set(k, t); setDoc(doc(db, "curateCities", key), { seenAt: Date.now() }, { merge: true }).catch(() => {});
}
function coverUrl(n) { const ids = (S.curated && S.curated.coverIds) || []; return n && n.coverId && curKey && ids.includes(n.coverId) ? `${FN_BASE}/curateCover?c=${curKey}&id=${n.coverId}` : ""; }
function nightWhen(n) { const d = evDate({ date: n.date }); return `${d.toLocaleDateString("en-US", { weekday: "short" })} · ${MONTHS[d.getMonth()]} ${d.getDate()}${n.start ? " · " + fmtTime(n.start) : ""}`; }
// Nights saved before the server merged repeats can list one venue twice in a row; show it once.
const venueKey = v => String(v || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
// "Live Music at Palato" and "Palato Italian Kitchen and Lounge" are one place: compare the part after " at " too.
const atPart = v => { const m = / at (?:the )?(.+)$/i.exec(String(v || "")); return m ? venueKey(m[1]) : ""; };
const sameVenue = (a, b) => { const ka = venueKey(a), kb = venueKey(b); if (!ka || !kb) return false; if (ka === kb) return true;
  const starts = (x, y) => x.length >= 4 && (y === x || y.startsWith(x + " "));
  const aa = atPart(a), ab = atPart(b);
  return starts(aa, kb) || starts(ab, ka) || starts(kb, aa) || starts(ka, ab) || (aa && aa === ab); };
function mergeNightStops(n) {
  const out = [];
  for (const x of n.stops || []) { const prev = out[out.length - 1]; if (prev && sameVenue(prev.name, x.name)) { if (x.note && !(prev.note || "").includes(x.note)) prev.note = ((prev.note || "") + " " + x.note).trim(); if (!prev.url && x.url) prev.url = x.url; continue; } out.push({ ...x }); }
  return { ...n, stops: out };
}
// Nights you built (and ideas you saved) stay on this device for two weeks, newest first.
const builtStore = () => { try { return JSON.parse(LS.get("friendlyBuilt") || "[]"); } catch { return []; } };
function rememberBuilt(nights) {
  try { const keep = [...nights.map(n => ({ ...n, _at: Date.now() })), ...builtStore()].filter(n => Date.now() - (n._at || 0) < 14 * 864e5 && (!n.date || n.date >= todayStr())).slice(0, 30); LS.set("friendlyBuilt", JSON.stringify(keep)); } catch {}
}
const savedIdeas = () => { try { return JSON.parse(LS.get("friendlyIdeas") || "[]"); } catch { return []; } };
function nightCardHtml(n, id) {
  n = mergeNightStops(n);
  S._nightById = S._nightById || {}; S._nightById[id] = n;
  const eat = n.stops.find(x => x.kind === "eat"), tix = n.ticketUrl || (n.stops.find(x => x.kind === "do" && x.url) || {}).url;
  const th = themeOf(n.theme || "midnight"), cover = coverUrl(n);
  return `<div class="card night t-${esc(th.id)} ${cover ? "has-cover" : ""}" data-nk="${esc(nightKey(n))}">
    <div class="night-head" style="--th-ink:${cover ? "#fff" : esc(th.ink)};font-family:${esc(th.font)},system-ui">${cover ? `<img class="night-cover" src="${esc(cover)}" alt="">` : `<div class="ev-card-bg"></div>`}<div class="night-head-in"><span class="night-emoji">${esc(n.emojis || n.emoji || "🌆")}</span><div class="night-when">${esc(nightWhen(n))}</div><h3>${esc(n.title)}</h3></div></div>
    <div class="night-body">
    <div class="stops">${n.stops.map(x => `<div class="stop"><span class="t">${esc(x.time)}</span><span><b>${esc(x.name)}</b>${x.note ? `<small>${esc(x.note)}</small>` : ""}</span></div>`).join("")}</div>
    ${n.why ? `<p class="why">${esc(n.why)}</p>` : ""}
    <div class="meta">${[n.cost, n.size, n.parking].filter(Boolean).map(m => `<span>${esc(m)}</span>`).join("")}</div>
    <div class="acts"><button type="button" class="btn primary small" data-nplan="${id}">Make it a plan</button><button type="button" class="btn small" data-npoll="${id}">Poll the group</button>${tix ? `<a class="btn small" href="${esc(tix)}" target="_blank" rel="noopener">Get tickets</a>` : ""}${eat ? `<a class="btn small" href="https://www.opentable.com/s?term=${encodeURIComponent(eat.name + " " + (S.profile.city || ""))}" target="_blank" rel="noopener">Book a table</a>` : ""}</div>
    </div></div>`;
}
function wireNightCards(root = document) {
  root.querySelectorAll("[data-nplan]").forEach(b => b.onclick = e => { e.stopPropagation(); const n = S._nightById[b.dataset.nplan]; if (n) { closeDialog(); nightToPlan(n); } });
  root.querySelectorAll("[data-npoll]").forEach(b => b.onclick = e => { e.stopPropagation(); const n = S._nightById[b.dataset.npoll]; if (n) pollNights([n]); });
}
function nightToPlan(n) {
  resetCompose(); compose._restored = true;
  const eat = n.stops.find(x => x.kind === "eat"), main = n.stops.find(x => x.kind === "do") || n.stops[0];
  compose.title = n.title.slice(0, 80); compose.date = n.date; compose.time = n.start || ""; compose.emoji = n.emoji || [...(n.emojis || "🌆")][0] || "🌆"; compose.theme = THEMES.some(t => t.id === n.theme) ? n.theme : "midnight";
  const cover = coverUrl(n); if (cover) { compose.cover = cover; compose.coverTab = "upload"; }
  compose.where = ((main && main.name) || "").slice(0, 200); compose.food = eat ? eat.name.slice(0, 120) : "";
  // Curate's stops become the event's timeline ("5:30 PM" → "17:30"); their tips go in the details.
  const to24 = t => { const m = /^(\d{1,2})(?::(\d{2}))?\s*([AP]M)$/i.exec(String(t || "").trim()); if (!m) return ""; let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12; return String(h).padStart(2, "0") + ":" + (m[2] || "00"); };
  const kindEmoji = { eat: "🍽️", do: "🎟️", go: "🚶" }, city = (S.profile.city || "").trim();
  const st = sortStops(cleanStops(n.stops.map(x => ({ time: to24(x.time), emoji: kindEmoji[x.kind] || "📍", name: x.name, place: city, note: x.note || "" }))));
  if (st.length >= 2) { compose.stops = st; compose.time = st[0].time || compose.time; compose.where = st[0].name + (city ? ", " + city : ""); compose.food = ""; defaultWrapUp(); }
  compose.notes = [st.length >= 2 ? "" : n.stops.map(x => `${x.time} · ${x.name}${x.note ? " (" + x.note + ")" : ""}`).join("\n"), n.parking ? "Parking: " + n.parking : "", n.cost ? "Cost: " + n.cost : "", n.ticketUrl ? "Tickets: " + n.ticketUrl : ""].filter(Boolean).join("\n").slice(0, 1000);
  compose._plan = { summary: "Here's the night, set up: " + n.title + ". Add who's coming and it's ready.", missing: ["guests"], unmatched: [], bring: [], ideas: [] };
  openComposer();
}
async function pollNights(nights) {
  const groups = [...S.groups.values()]; if (!groups.length) return toast("Create a group first, then I can poll them.");
  const make = async gid => {
    const dates = {}; let q, options;
    if (nights.length === 1) { q = nights[0].title + " — " + nightWhen(nights[0]) + ". In?"; options = ["I'm in", "Maybe", "Can't make it"]; dates[0] = nights[0].date; }
    else { q = "Which night?"; options = nights.map((n, i) => { dates[i] = n.date; return `${n.title} (${nightWhen(n)})`.slice(0, 90); }); }
    try { await addDoc(collection(db, "groups", gid, "polls"), { q, options, dates, votes: {}, authorId: myUid(), createdAt: Date.now() }); closeDialog(); toast("Poll's up. The winner becomes the plan in one tap.", null, null, "party"); go("#/g/" + gid); } catch (e) { toast(e.message); }
  };
  if (groups.length === 1) return make(groups[0].id);
  dialog(`<h3>Which group?</h3><div class="stack">${groups.map(g => `<button type="button" class="btn" data-pg="${g.id}" style="text-align:left">${groupMini(g)} ${esc(g.name)}</button>`).join("")}</div>`, null, null);
  document.querySelectorAll("[data-pg]").forEach(b => b.onclick = () => make(b.dataset.pg));
}
// Resolve the city box and say so when it isn't a real place. allowEmpty: the profile may clear it.
async function pickedCity(input, allowEmpty) {
  // Say it right under the box: a toast would sit behind the keyboard.
  const say = msg => { if (!input) return toast(msg); const host = input.closest(".field, .city-wrap") || input; let p = host.parentElement.querySelector(".city-err");
    if (!p) { p = document.createElement("p"); p.className = "city-err"; host.insertAdjacentElement("afterend", p); } p.textContent = msg; input.focus();
    input.addEventListener("input", () => p.remove(), { once: true }); };
  const city = await resolveCity(input);
  if (city === "" && !allowEmpty) { say("Tell me a city, like Frisco, TX."); return null; }
  if (city === null) { say("I couldn't find that city. Start typing and pick it from the list."); return null; }
  if (input && city && input.value.trim() !== city) input.value = city;   // show what it matched to
  return city;
}
async function saveCity(city, milesIn) {
  city = String(city || "").trim().slice(0, 60); if (city.length < 2) return toast("Tell me a city, like Frisco, TX.");
  const miles = CURATE_MILES.includes(Number(milesIn)) ? Number(milesIn) : myMiles();
  try { await updateDoc(doc(db, "users", myUid()), miles === myMiles() ? { city, cityGuess: deleteField() } : { city, cityGuess: deleteField(), curateMiles: miles }); registerCity(city, miles); toast("Looking around " + city + "…", null, null, "thinking"); } catch (e) { toast(e.message); }
}
function openCityDialog() {
  dialog(`<h3>Where are you?</h3><label class="field"><span>City</span><input id="cityIn" value="${esc(S.profile.city || "")}" placeholder="Start typing a city" maxlength="60" autocomplete="off"></label><p class="muted sm">Pick your city from the list. Used only to find things nearby. No location tracking.</p>`, "Save", async () => { const city = await pickedCity(el("cityIn")); if (city) { closeDialog(); saveCity(city); } });
  attachPlaces(el("cityIn"), { cities: true });
}
function curateBody() {
  const city = (S.profile.city || "").trim();
  if (!city) return `<div class="section-head"><h2>${CURATE_LABEL}</h2></div>
    <div class="card empty">${dot("thinking", 72)}<b>Where are you?</b><p class="muted">Tell me your city and I'll find a few good nights out nearby, each with a place to eat and the timing worked out.</p><div class="btnrow" style="justify-content:center;gap:8px;flex-wrap:wrap"><div class="city-wrap"><input id="curCity" class="city-in" placeholder="Start typing a city" maxlength="60" autocomplete="off"></div>${milesSelect("curMiles0")}<button type="button" class="btn primary" id="curCitySave">Look around</button></div><p class="muted sm" style="margin-top:8px">No location tracking, just the city.</p></div>`;
  ensureCurated();
  // Nights that already started more than an hour ago drop off (a link straight to one still opens it).
  const d = S.curated, nights = upcomingNights();
  // Tonight and This weekend go by the actual date; the rest by what Dot tagged. Four per filter, the ones from that
  // filter's own search first, the rest behind "More ideas".
  const t = todayStr(), dow = new Date().getDay(), fri = addDays(t, dow === 6 ? -1 : dow === 0 ? -2 : 5 - dow), sun = addDays(fri, 2);
  // Once this weekend's nights are over (Sunday evening), "This weekend" means the coming one.
  let wkFrom = t > fri ? t : fri, wkTo = sun;
  if (dow === 0 && !nights.some(n => n.date >= wkFrom && n.date <= wkTo)) { wkFrom = addDays(fri, 7); wkTo = addDays(sun, 7); }
  const fits = n => curFilter === "tonight" ? n.date === t : curFilter === "weekend" ? n.date >= wkFrom && n.date <= wkTo : (n.tags || []).includes(curFilter);
  const filtered = nights.filter(fits).sort((a, b) => ((b.src === curFilter) - (a.src === curFilter)) || (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")));
  const all = filtered.length ? filtered : nights; let shown = S._curMore === curFilter ? all : all.slice(0, 4); const extra = all.length - shown.length;
  wantCovers(shown);
  const want = S.route.q && S.route.q.night, picked = want && ((d && d.nights) || []).find(n => nightKey(n) === want);
  if (picked && !shown.includes(picked)) shown = [picked, ...shown];
  if (d) markCuratedSeen();
  const phaseText = { starting: "Warming up", searching: "Searching what's on and pairing places to eat", sorting: "Sorting the good ones" }[S._curPhase] || "Looking around";
  const lead = !d && !S._curError ? `Give me a minute. ${phaseText} within ${myMiles()} miles of ${city}…` : S._curError ? "I couldn't look around just now (" + S._curError + "). Try again in a bit." : shown.length ? (filtered.length ? CURATE_LEADS[curFilter] : "Nothing tagged for that yet, so here's everything I found.") : "Nothing yet. Build your own and I'll go looking.";
  return `<div class="section-head cur-head"><h2>${CURATE_LABEL}</h2><span class="cur-loc"><button type="button" class="cur-loc-city" id="curCityBtn" aria-label="Change city">📍 <span>${esc(city)}</span></button>${milesSelect("curMiles")}</span></div>${S.profile.cityGuess ? `<p class="muted sm cur-guess">Dot guessed your city from your phone number. Tap 📍 to change it.</p>` : ""}
  <div class="dot-say cur-dot ${curFilter === "late" ? "coral-say" : ""}">${curFilter === "late" && d ? coral("party", 48) : dot(d ? "happy" : "thinking", 48)}<div class="say-bubble">${curFilter === "late" && d ? "Coral's picks. The night doesn't have to end at 10. Tap one and Dot will set it up." : esc(lead)}<div class="cur-acts"><button type="button" class="btn small primary" id="curBuild">✨ Build me a night</button><button type="button" class="btn small" id="curBrowse">🔎 Browse ideas</button></div></div></div>
  <div class="chiprow">${CURATE_FILTERS.map(([k, l]) => `<button type="button" class="fchip ${curFilter === k ? "on" : ""}" data-cf="${k}">${l}</button>`).join("")}</div>
  ${!d && !S._curError ? `<div class="card empty compact">${dot("thinking", 64)}<p class="muted" style="margin:6px 0 0">Searching what's on, pairing dinners, checking the times. About half a minute the first time.</p></div>` : ""}
  ${S._curError ? `<div style="text-align:center;margin-bottom:12px"><button type="button" class="btn" id="curRetry">Try again</button></div>` : ""}
  <div id="nights">${shown.map((n, i) => nightCardHtml(n, "c" + i)).join("")}</div>
  ${extra > 0 ? `<div style="text-align:center;margin:4px 0 12px"><button type="button" class="btn" id="curMore">More ideas (${extra})</button></div>` : ""}
  ${(() => { const b = builtStore().filter(n => !n.date || n.date >= todayStr()); return b.length ? `<details class="adv built-nights" ${S._builtOpen ? "open" : ""} id="builtNights"><summary>🗂️ Your built nights (${b.length})</summary>${b.map((n, i) => nightCardHtml(n, "s" + i)).join("")}<div style="text-align:right"><button type="button" class="btn ghost small" id="clearBuilt">Clear</button></div></details>` : ""; })()}
  ${(() => { const ideas = savedIdeas(); return ideas.length ? `<details class="adv built-nights" ${S._ideasOpen ? "open" : ""} id="savedIdeas"><summary>⭐ Saved ideas (${ideas.length})</summary>${ideas.map((x, i) => ideaCardHtml(x, "v" + i, true)).join("")}</details>` : ""; })()}
  ${d ? `<p class="muted sm" style="margin:6px 4px 0">Found by Dot with web search and refreshed nightly. Double-check times before you go; things change.</p>` : ""}`;
}
// ---- Browse ideas: single activities (not a sequenced night), by category or anything you type ("book a massage").
const IDEA_CATS = [["🍽️", "Food & drink"], ["🎶", "Live music"], ["🌳", "Outdoors"], ["🎭", "Arts & culture"], ["🎳", "Games & activities"], ["💆", "Wellness & spa"], ["🎨", "Classes & workshops"], ["🏟️", "Sports"], ["🌙", "Nightlife"], ["👨‍👩‍👧", "Family friendly"]];
function ideaCardHtml(x, id, saved) {
  S._ideaById = S._ideaById || {}; S._ideaById[id] = x;
  const when = x.date ? fmtDay({ date: x.date }) + (x.time ? " · " + fmtTime(x.time) : "") : "";
  return `<div class="card idea-card"><div class="idea-top"><span class="idea-em">${esc(x.emoji || "✨")}</span><div style="flex:1;min-width:0"><b>${esc(x.title)}</b><div class="muted sm">${esc([x.place, x.area].filter(Boolean).join(" · "))}</div>${when || x.price ? `<div class="muted sm">${esc([when, x.price].filter(Boolean).join(" · "))}</div>` : ""}</div></div>
    ${x.blurb ? `<p class="sm" style="margin:6px 0 8px">${esc(x.blurb)}</p>` : ""}
    <div class="btnrow" style="gap:6px;flex-wrap:wrap"><button type="button" class="btn primary small" data-iplan="${id}">Make it a plan</button>${saved ? `<button type="button" class="btn ghost small" data-iunsave="${id}">Remove</button>` : `<button type="button" class="btn small" data-isave="${id}">☆ Save</button>`}${x.url ? `<a class="btn small" href="${esc(x.url)}" target="_blank" rel="noopener">Website</a>` : ""}</div></div>`;
}
function ideaToPlan(x) {
  resetCompose(); compose._restored = true;
  compose.title = x.title.slice(0, 80); compose.emoji = [...(x.emoji || "✨")][0] || "✨";
  if (x.date) compose.date = x.date; if (x.time) compose.time = x.time;
  compose.where = [x.place, x.area].filter(Boolean).join(", ").slice(0, 200);
  compose.notes = [x.blurb, x.price ? "Cost: " + x.price : "", x.url ? "More: " + x.url : ""].filter(Boolean).join("\n").slice(0, 600);
  compose._plan = { summary: "Here's the plan, set up: " + x.title + ". Pick a day and who's coming.", missing: x.date ? ["guests"] : ["date", "guests"], unmatched: [], bring: [], ideas: [] };
  openComposer();
}
function wireIdeaCards(root = document) {
  root.querySelectorAll("[data-iplan]").forEach(b => b.onclick = () => { const x = S._ideaById[b.dataset.iplan]; if (x) { closeDialog(); ideaToPlan(x); } });
  root.querySelectorAll("[data-isave]").forEach(b => b.onclick = () => { const x = S._ideaById[b.dataset.isave]; if (!x) return; try { LS.set("friendlyIdeas", JSON.stringify([x, ...savedIdeas().filter(y => y.title !== x.title)].slice(0, 40))); } catch {} b.textContent = "★ Saved"; b.disabled = true; toast("Saved to Curate › Saved ideas"); });
  root.querySelectorAll("[data-iunsave]").forEach(b => b.onclick = () => { const x = S._ideaById[b.dataset.iunsave]; if (!x) return; try { LS.set("friendlyIdeas", JSON.stringify(savedIdeas().filter(y => y.title !== x.title))); } catch {} S._ideasOpen = true; render(); });
}
function openIdeasBrowser() {
  if (isDemo()) return toast("Browsing ideas is off in the demo.");
  const city = (S.profile.city || "").trim(); if (!city) { go("#/curate"); return; }
  let ask = null, list = [], loading = false;
  dialog(`<div id="ib"></div>`, null, null);
  const paint = () => {
    const box = el("ib"); if (!box) return;
    box.innerHTML = `<div class="dot-say">${dot(loading ? "painter" : "happy", 52)}<div class="say-bubble">${loading ? "Looking around " + esc(city) + "…" : ask ? `${list.length} ideas for ${esc(ask.label)}. Make one a plan, save it, or get more.` : "Browse single things to do, no full night needed. Pick a kind, or tell me exactly what you want."}</div></div>
      <div class="opts">${IDEA_CATS.map(([ic, l]) => `<button type="button" class="opt ${ask && ask.category === l ? "on" : ""}" data-icat="${esc(l)}"><span>${ic}</span>${esc(l)}</button>`).join("")}</div>
      <div class="ib-free"><input id="ibFree" class="inv-search" maxlength="120" placeholder="Something specific? Book a massage, pottery class…" value="${esc(ask && ask.free ? ask.free : "")}"><button type="button" class="btn small primary" id="ibGo">Find it</button></div>
      <div id="ibList">${list.map((x, i) => ideaCardHtml(x, "i" + i)).join("")}</div>
      ${loading ? `<div class="card empty compact">${dot("painter", 56)}<p class="muted" style="margin:6px 0 0">Searching real places nearby. About half a minute.</p></div>` : ""}
      ${!loading && list.length ? `<div style="text-align:center;margin:8px 0"><button type="button" class="btn" id="ibMore">＋ More ideas</button></div>` : ""}`;
    wireIdeaCards(box);
    box.querySelectorAll("[data-icat]").forEach(b => b.onclick = () => start({ category: b.dataset.icat, label: b.dataset.icat.toLowerCase() }));
    const go2 = () => { const v = el("ibFree").value.trim(); if (v.length < 3) return toast("Tell me a little more."); start({ free: v, label: "“" + v + "”" }); };
    el("ibGo").onclick = go2; el("ibFree").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); go2(); } };
    if (el("ibMore")) el("ibMore").onclick = () => fetchMore();
  };
  const fetchMore = async () => {
    if (loading || !ask) return; loading = true; paint();
    const t = todayStr();
    try {
      const res = await requestViaFirestore("planRequests", { mode: "ideas", city, miles: myMiles(), category: ask.category || "", free: ask.free || "", from: t, to: addDays(t, 14), avoid: list.map(x => x.title), ...nowCtx() }, 290000);
      const ideas = (res.data && res.data.ideas) || []; if (!ideas.length) throw new Error("nothing found");
      const n0 = list.length; list = [...list, ...ideas]; loading = false; paint();
      if (n0) { const c = el("ibList") && el("ibList").children[n0]; if (c) c.scrollIntoView({ block: "start" }); }
    } catch (e) { loading = false; paint(); toast("Couldn't find ideas: " + e.message); }
  };
  const start = a => { ask = a; list = []; fetchMore(); };
  paint();
}
function wireCurate() {
  if (el("curBrowse")) el("curBrowse").onclick = openIdeasBrowser;
  if (el("builtNights")) { wireNightCards(el("builtNights")); el("builtNights").ontoggle = e => { S._builtOpen = e.target.open; }; }
  if (el("savedIdeas")) { wireIdeaCards(el("savedIdeas")); el("savedIdeas").ontoggle = e => { S._ideasOpen = e.target.open; }; }
  if (el("clearBuilt")) el("clearBuilt").onclick = () => { try { LS.remove("friendlyBuilt"); } catch {} render(); };
  const firstMiles = () => (el("curMiles0") || {}).value;
  const firstSave = async () => { const city = await pickedCity(el("curCity")); if (city) saveCity(city, firstMiles()); };
  if (el("curCitySave")) el("curCitySave").onclick = firstSave;
  if (el("curCity")) { attachPlaces(el("curCity"), { cities: true }); el("curCity").onkeydown = e => { if (e.key === "Enter") firstSave(); }; }
  if (el("curCityBtn")) el("curCityBtn").onclick = openCityDialog;
  if (el("curMiles")) el("curMiles").onchange = e => { S._curMore = null; saveMiles(e.target.value); };
  if (el("curBuild")) el("curBuild").onclick = () => openNightBuilder();
  if (el("curRetry")) el("curRetry").onclick = () => { S._curError = ""; curKey = ""; if (curSub) { curSub(); curSub = null; } render(); };
  document.querySelectorAll("[data-cf]").forEach(b => b.onclick = () => { curFilter = b.dataset.cf; S._curMore = null; render(); });
  if (el("curMore")) el("curMore").onclick = () => { S._curMore = curFilter; render(); };
  wireNightCards();
}
// The row on the Events tab: shows up when the week ahead is empty, or from Thursday on for the weekend.
// Curate's picks as the rest of the app shows them: the tab carries the covers of the top picks and how many are new
// since you last looked; the Events tab gets a tray of them from Thursday on (or when the week ahead is empty).
const nightKey = n => (n.title || "") + "|" + (n.date || "");
// Nights still ahead: later days, or today's that haven't started yet (an hour's grace).
const upcomingNights = () => { const t = todayStr(), now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  return ((S.curated && S.curated.nights) || []).filter(n => !n.date || n.date > t || (n.date === t && (!/^\d{2}:\d{2}$/.test(n.start || "") || +n.start.slice(0, 2) * 60 + +n.start.slice(3) > mins - 60))); };
// Weekend picks first, then by date; ones with a painted cover ahead of the rest. `min` tops the list up with
// cover-less nights so the tray never shows fewer than that many (the tab only wants covers).
// Thursday to Sunday the weekend leads; Monday to Wednesday tonight leads, so a quiet weeknight gets a same-day idea.
function topPicks(max, min = 0) {
  const ns = upcomingNights(), t = todayStr(), dow = new Date().getDay(), weekendish = dow >= 4 || dow === 0;
  const wk = n => weekendish ? ((n.tags || []).includes("weekend") ? 0 : 1) : (n.date === t ? 0 : 1);
  const order = (a, b) => wk(a) - wk(b) || (a.date + (a.start || "")).localeCompare(b.date + (b.start || ""));
  return ns.slice().sort(order).slice(0, max);
}
const curSeen = () => { try { return new Set(JSON.parse(LS.get("friendlyCurSeen") || "[]")); } catch { return new Set(); } };
function markCuratedSeen() {
  const ns = upcomingNights(); if (!ns.length) return;
  const seen = curSeen(), before = seen.size; ns.forEach(n => seen.add(nightKey(n)));
  if (seen.size !== before) try { LS.set("friendlyCurSeen", JSON.stringify([...seen].slice(-120))); } catch {}
}
function curateTab(on) {
  const picks = topPicks(3), seen = curSeen(), fresh = upcomingNights().filter(n => !seen.has(nightKey(n))).length;
  const cov = picks.map(coverUrl).filter(Boolean);
  const stack = cov.length ? `<span class="cur-stack" aria-hidden="true">${cov.length > 2 ? `<img class="s0" src="${esc(cov[1])}" alt="">` : ""}${cov.length > 1 ? `<img class="s1" src="${esc(cov[cov.length > 2 ? 2 : 1])}" alt="">` : ""}<span class="cur-front">${cov.map((u, i) => `<img src="${esc(u)}" alt="" style="animation-delay:${-i * 3}s${cov.length === 1 ? ";animation:none" : ""}">`).join("")}</span>${fresh && !on ? `<span class="cur-new">${fresh > 9 ? "9+" : fresh}</span>` : ""}</span>` : "";
  return `<button class="tab tab-curate ${on ? "on" : ""} ${cov.length ? "has-picks" : ""}" data-go="#/curate" aria-label="${CURATE_LABEL}${fresh ? `, ${fresh} new pick${fresh > 1 ? "s" : ""}` : ""}">${stack}<span class="curate-lbl">${CURATE_LABEL}<i class="spark">✦</i></span>${fresh && !on && !cov.length ? `<span class="cur-new">${fresh > 9 ? "9+" : fresh}</span>` : ""}</button>`;
}
// "Today · 7 PM", "Tomorrow · 6:30 PM", "Sat · 8 PM" within the week, else "Oct 25 · 5 PM".
function shortWhen(n) {
  const t = todayStr(), d = evDate({ date: n.date }), days = Math.round((d - evDate({ date: t })) / 864e5);
  const day = n.date === t ? "Today" : days === 1 ? "Tomorrow" : days > 1 && days < 7 ? d.toLocaleDateString("en-US", { weekday: "short" }) : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (!/^\d{2}:\d{2}$/.test(n.start || "")) return day;
  let [h, m] = n.start.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${day} · ${h}${m ? ":" + String(m).padStart(2, "0") : ""} ${ap}`;
}
// The picks tray, every day: three picks with their covers, "See all", and a close that hides it until tomorrow.
// Weekends it leads with the weekend; weeknights it leads with tonight.
function curateTray(upcoming, first) {
  if (isDemo() || !(S.profile.city || "").trim()) return "";
  const t = todayStr(), dow = new Date().getDay(), weekendish = dow >= 4 || dow === 0;
  if (LS.get("friendlyTrayHidden2") === t) return "";
  const picks = topPicks(6); if (!picks.length) return needIdeaCard(upcoming);
  wantCovers(picks.slice(0, 4));
  const label = !weekendish && picks[0].date === t ? "tonight" : weekendish && picks.every(n => (n.tags || []).includes("weekend")) ? "this weekend" : "the week ahead";
  return `<section class="cur-tray ${first ? "first" : ""}" aria-label="Dot's picks"><span class="ptr" aria-hidden="true"></span>
    <div class="cur-tray-head">${dot("thinking", 22)}<b>Dot's picks for ${label}</b><button type="button" class="link-btn" data-go="#/curate">See all</button><button type="button" class="tray-x" data-hide-tray="1" aria-label="Hide until tomorrow">✕</button></div>
    <div class="cur-tray-row">${picks.map(n => `<button type="button" class="cur-pick" data-go="#/curate?night=${encodeURIComponent(nightKey(n))}">${coverUrl(n) ? `<img src="${esc(coverUrl(n))}" alt="" loading="lazy">` : `<span class="cp-emoji" aria-hidden="true">${esc([...String(n.emojis || n.emoji || "✨")].slice(0, 2).join(""))}</span>`}<span class="cp-txt"><b>${esc(n.title)}</b><span>${esc(shortWhen(n))}</span></span></button>`).join("")}</div></section>`;
}
function needIdeaCard(upcoming) {
  if (!window.Blip || isDemo()) return "";
  const t = todayStr(), soon = upcoming.some(e => e.date >= t && e.date <= addDays(t, 7)), dow = new Date().getDay(), weekendish = dow >= 4 || dow === 0;
  if (soon && !weekendish) return "";
  // A nudge, not a fixture: it shows for 30 seconds per visit to the app, then fades away.
  if (!S._ideaAt) { S._ideaAt = Date.now(); setTimeout(() => { const c = document.querySelector(".idea-row"); if (c) { c.classList.add("fade-away"); setTimeout(render, 500); } else render(); }, 30000); }
  if (Date.now() - S._ideaAt >= 30000) return "";
  const city = (S.profile.city || "").trim(), nights = upcomingNights();
  const n = nights.find(x => (x.tags || []).includes("weekend")) || nights[0];
  const text = n ? `${n.title} · ${nightWhen(n)}. Two more where that came from.` : city ? "I'm putting a few ideas together." : "Tell me your city and I'll find a few nights out.";
  return `<div class="card notif-card idea-row" role="button" data-go="#/curate">${dot("thinking", 48)}<div style="flex:1;min-width:0"><b>Need an idea for ${weekendish ? "the weekend" : "this week"}?</b><div class="muted sm">${esc(text)}</div></div><span class="chev">›</span></div>`;
}
// "Build me a night": Dot asks four quick questions with chips (or take free text), then brings back three.
function openNightBuilder() {
  if (isDemo()) return toast("Building nights is off in the demo.");
  const city = (S.profile.city || "").trim(); if (!city) { go("#/curate"); return; }
  const B = { vibe: "", who: "", when: "", date: "", budget: "", free: "" };
  const VIBES = [["🛋️", "Chill"], ["🎉", "Big night"], ["💛", "Date night"], ["🌳", "Outdoors"], ["🎭", "Something cultural"], ["🍽️", "Just a great dinner"], ["🎲", "Surprise me"]];
  const WHO = ["Just us two", "3–5 people", "6–10 people", "The whole group"], WHEN = ["Tonight", "Tomorrow", "This weekend", "Pick a date"], BUDGET = ["Under $30", "$30–75", "Splurge"];
  const opt = (k, list) => `<div class="opts">${list.map(o => { const v = Array.isArray(o) ? o[1] : o, ic = Array.isArray(o) ? o[0] : ""; return `<button type="button" class="opt ${B[k] === v ? "on" : ""}" data-k="${k}" data-v="${esc(v)}">${ic ? `<span>${ic}</span>` : ""}${esc(v)}</button>`; }).join("")}</div>`;
  const crumbs = () => B.freeOnly ? `“${B.free}”` : [B.vibe, B.who, B.when === "Pick a date" ? B.date : B.when, B.budget].filter(Boolean).join(" · ");
  const windowFor = () => { const t = todayStr(); if (B.when === "Tonight") return [t, t]; if (B.when === "Tomorrow") return [addDays(t, 1), addDays(t, 1)]; if (B.when === "Pick a date") return [B.date, B.date]; const dow = new Date().getDay(); const toFri = dow <= 5 ? 5 - dow : 6; const from = dow === 6 || dow === 0 ? t : addDays(t, toFri); const to = dow === 0 ? t : addDays(from, dow === 6 ? 1 : 2); return [from, to]; };
  dialog(`<div id="nb"></div>`, null, null);
  const draw = () => {
    const box = el("nb"); if (!box) return;
    let q, body;
    if (!B.vibe) { q = "Let's build one. What's the vibe?"; body = opt("vibe", VIBES) + `<label class="field" style="margin-top:10px"><span>Or just tell me</span><textarea id="nbFree0" rows="2" maxlength="300" placeholder="Something low-key for six, we've done tacos to death, under $40 a head">${esc(B.free)}</textarea></label><button type="button" class="btn small" id="nbFreeGo">Build from that</button><p class="muted sm" style="margin:12px 0 0">Just want to look around? <a id="nbBrowse" style="color:var(--accent);font-weight:600">Browse single ideas</a>, no full night needed.</p>`; }
    else if (!B.who) { q = "Who's coming?"; body = opt("who", WHO); }
    else if (!B.when) { q = "When?"; body = opt("when", WHEN); }
    else if (B.when === "Pick a date" && !B.date) { q = "Which day?"; body = `<label class="field"><span>Date</span><input type="date" id="nbDate" min="${todayStr()}"></label><button type="button" class="btn small" id="nbDateGo">That day</button>`; }
    else { q = B.budget ? "Anything else before I go looking?" : "Rough budget per person, all in?"; body = opt("budget", BUDGET) + `<label class="field" style="margin-top:10px"><span>Anything to include or avoid? <span class="muted">(optional)</span></span><textarea id="nbFree" rows="2" maxlength="300" placeholder="Near Plano · no sports · somewhere new">${esc(B.free)}</textarea></label><button type="button" class="btn primary" id="nbGo">Build it</button>`; }
    box.innerHTML = `<div class="dot-say">${dot("happy", 52)}<div class="say-bubble">${esc(q)}</div></div>${crumbs() ? `<p class="muted sm" style="margin:-4px 0 8px"><a id="nbBack" style="color:var(--accent);font-weight:600">‹ Back</a> · ${esc(crumbs())}</p>` : ""}${body}`;
    box.querySelectorAll(".opt").forEach(b => b.onclick = () => { B[b.dataset.k] = b.dataset.v; if (b.dataset.k === "when" && b.dataset.v !== "Pick a date") B.date = ""; draw(); });
    if (el("nbBack")) el("nbBack").onclick = () => { if (B.budget) B.budget = ""; else if (B.when === "Pick a date" && B.date) B.date = ""; else if (B.when) B.when = ""; else if (B.who) B.who = ""; else B.vibe = ""; draw(); };
    if (el("nbBrowse")) el("nbBrowse").onclick = () => { closeDialog(); openIdeasBrowser(); };
    if (el("nbFreeGo")) el("nbFreeGo").onclick = () => { B.free = el("nbFree0").value.trim(); if (B.free.length < 6) return toast("Tell me a little more."); B.freeOnly = true; B.vibe = "Surprise me"; B.who = B.who || "a few friends"; B.when = B.when || "This weekend"; B.budget = B.budget || "flexible"; run(); };
    if (el("nbDateGo")) el("nbDateGo").onclick = () => { const v = el("nbDate").value; if (!v) return toast("Pick a day."); B.date = v; draw(); };
    if (el("nbGo")) el("nbGo").onclick = () => { B.free = el("nbFree").value.trim(); if (!B.budget) B.budget = "flexible"; run(); };
  };
  // Every batch stays: "Try another three" adds three more under the ones you already have, and they're all
  // kept under "Your built nights" on the Curate page so you can come back to them.
  const built = []; const baseFree = B.free;
  const paintBuilt = loading => {
    const box = el("nb"); if (!box) return;
    box.innerHTML = `<div class="dot-say">${dot(loading ? "painter" : "happy", 52)}<div class="say-bubble">${loading ? (built.length ? "Three more coming up, different from these…" : "On it. Searching what's on, pairing a place to eat, checking the times. Give me half a minute.") : `${built.length} ways to do it. Pick one and I'll set it up, or poll the group.`}</div></div>
      ${built.length ? `<div class="btnrow" style="gap:6px;margin:0 0 10px;flex-wrap:wrap"><button type="button" class="btn primary small" id="nbPollAll">Poll the group with ${built.length <= 3 ? "all three" : "the newest three"}</button></div>` : `<p class="muted sm">${esc(crumbs())}</p>`}
      ${built.map((n, i) => nightCardHtml(n, "b" + i)).join("")}
      ${loading && built.length ? `<div class="card empty compact">${dot("painter", 56)}<p class="muted" style="margin:6px 0 0">Finding three more…</p></div>` : ""}
      ${!loading && built.length ? `<div style="text-align:center;margin:8px 0"><button type="button" class="btn" id="nbAgain">＋ Try another three</button></div>` : ""}`;
    wireNightCards(box);
    if (el("nbPollAll")) el("nbPollAll").onclick = () => pollNights(built.slice(-3));
    if (el("nbAgain")) el("nbAgain").onclick = () => run();
  };
  const run = async () => {
    if (!el("nb")) return;
    const [from, to] = windowFor();
    const free = [baseFree, built.length ? "Different from: " + built.map(n => n.title).join("; ") : ""].filter(Boolean).join(". ");
    paintBuilt(true);
    if (built.length) { const last = el("nb").querySelector(".card.empty.compact"); if (last) last.scrollIntoView({ block: "center" }); }
    try {
      const res = await requestViaFirestore("planRequests", { mode: "night", city, miles: myMiles(), vibe: B.vibe, who: B.who, budget: B.budget, free, from, to, ...nowCtx() }, 290000);
      const nights = (res.data && res.data.nights) || []; if (!nights.length) throw new Error("nothing found");
      const first0 = built.length; built.push(...nights); rememberBuilt(nights); paintBuilt(false);
      if (first0) { const c = el("nb").querySelectorAll(".card.night")[first0]; if (c) c.scrollIntoView({ block: "start" }); }
    } catch (e) {
      if (built.length) { paintBuilt(false); toast("Couldn't find three more: " + e.message); return; }
      const box = el("nb"); if (!box) return;
      box.innerHTML = `<div class="dot-say">${dot("oops", 52)}<div class="say-bubble">That didn't come together. Try again?</div></div><button type="button" class="btn" id="nbRetry">Try again</button>`; el("nbRetry").onclick = run; toast("Couldn't build that: " + e.message);
    }
  };
  draw();
}
// ---- Ask me anything: a question, answered from your own plans (titles, dates, counts, first names; never phone numbers or notes).
function askContext() {
  const me = myUid(), today = todayStr();
  const events = [...S.events.values()].filter(e => e.date >= today).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""))).slice(0, 15).map(e => ({
    id: e.id, title: e.title, date: e.date, time: e.time || "", location: e.location || "", kind: e.kind || "event",
    going: goingCount(e), invited: (e.invitedUids || []).length, unanswered: (e.invitedUids || []).filter(u => !(e.rsvps || {})[u]).length,
    me: (e.rsvps || {})[me] || "", host: first(e.hostName || nameOf(e.hostId)), mine: canManage(e)
  }));
  const groups = [...S.groups.values()].slice(0, 12).map(g => ({ id: g.id, name: g.name, members: (g.memberUids || []).length }));
  let money = {};
  try { const pairs = pairwise(); const iOwe = pairs.filter(p => p.from === me).reduce((t, p) => t + p.amount, 0), owed = pairs.filter(p => p.to === me).reduce((t, p) => t + p.amount, 0);
    money = { iOwe: fmt$(iOwe), owed: fmt$(owed), pairs: pairs.filter(p => p.from === me || p.to === me).slice(0, 8).map(p => `${p.from === me ? "I" : first(nameOf(p.from))} owe${p.from === me ? "" : "s"} ${p.to === me ? "me" : first(nameOf(p.to))} ${fmt$(p.amount)}`) }; } catch {}
  return { me: first(S.profile.name), events, groups, money };
}
function openAskDialog(prefill) {
  if (isDemo()) return toast("Asking Dot is off in the demo.");
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micHint = (NATIVE || IOS) ? `Tap the mic on your keyboard to talk instead of type.` : Speech ? `<button type="button" class="btn small" id="planMic">🎤 Talk instead</button>` : "";
  dialog(`<div class="dot-say">${dot("happy", 56)}<div class="say-bubble">Ask me anything about your plans, your groups, who owes what, or how something in Friendly works.</div></div>
    <label class="field"><span>Your question</span><textarea id="planText" rows="3" maxlength="600" placeholder="Who hasn't answered for Friendsgiving? · What do I owe? · How do I add a co-host?">${esc(prefill || "")}</textarea></label>
    <p class="muted sm" style="margin:-2px 0 0">${micHint}</p>`, "Ask", async () => {
    const text = el("planText").value.trim(); if (text.length < 2) return toast("Ask me something.");
    const ok = el("dlgOk"); ok.disabled = true; ok.textContent = "Thinking…";
    const box = document.querySelector("#appDialog .dot-say"); if (box) box.innerHTML = `${dot("thinking", 56)}<div class="say-bubble">Let me check…</div>`;
    try {
      const res = await requestViaFirestore("planRequests", { mode: "ask", text, today: todayStr(), weekday: new Date().toLocaleDateString("en-US", { weekday: "long" }), tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || ""), context: askContext() }, 60000);
      const a = res.data || {};
      const acts = (a.actions || []).map((x, i) => `<button type="button" class="btn small" data-ask-act="${i}">${esc(x.label)}</button>`).join("");
      const inner = document.querySelector("#appDialog .dlg-inner");
      if (inner) inner.innerHTML = `<div class="dot-say">${dot("happy", 56)}<div class="say-bubble"><b>${esc(a.answer || "I'm not sure about that one.")}</b>${acts ? `<div class="btnrow" style="margin-top:8px;gap:6px">${acts}</div>` : ""}</div></div>
        <p class="muted sm" style="margin:0 0 10px">You asked: “${esc(text)}”</p>
        <div class="dlg-actions"><button type="button" class="btn" id="askAgain">Ask another</button><button type="button" class="btn primary" id="askDone">Done</button></div>`;
      el("askDone").onclick = closeDialog; el("askAgain").onclick = () => openAskDialog();
      document.querySelectorAll("[data-ask-act]").forEach(b => b.onclick = () => { const x = (a.actions || [])[+b.dataset.askAct]; closeDialog(); if (!x) return;
        if (x.kind === "open_event") go("#/e/" + x.id); else if (x.kind === "plan") openPlanDialog("event", {}); else if (x.kind === "expense") openExpense(null, null, null); else if (x.kind === "money") go("#/money"); else if (x.kind === "groups") go("#/groups"); else if (x.kind === "profile") go("#/profile"); });
    }
    catch (e) { ok.disabled = false; ok.textContent = "Ask"; if (box) box.innerHTML = `${dot("oops", 56)}<div class="say-bubble">Hmm, that didn't go through. Try again?</div>`; toast("I couldn't answer that: " + e.message); }
  });
  setTimeout(() => { const t = el("planText"); if (t) t.focus(); }, 60);
  const mic = el("planMic");
  if (mic && Speech) {
    const rec = new Speech(); rec.lang = navigator.language || "en-US"; rec.continuous = true; rec.interimResults = true; let on = false, base = "";
    mic.onclick = () => { if (on) { rec.stop(); return; } base = el("planText").value.trim(); try { rec.start(); on = true; mic.textContent = "■ Stop"; } catch {} };
    rec.onresult = ev => { let t = ""; for (const r of ev.results) t += r[0].transcript + " "; el("planText").value = (base + " " + t).trim(); };
    rec.onend = () => { on = false; mic.textContent = "🎤 Talk instead"; };
    rec.onerror = () => { on = false; mic.textContent = "🎤 Talk instead"; };
  }
}
// Show the composer with what was just filled in. Going to #/new from #/new changes nothing, so redraw instead.
function openComposer() { if (location.hash === "#/new") { window.scrollTo(0, 0); render(); } else go("#/new"); }
function applyPlan(p, said) {
  resetCompose(); compose._restored = true;
  compose.kind = p.kind === "meeting" ? "meeting" : "event";
  compose.title = String(p.title || "").slice(0, 80);
  if (p.emoji) compose.emoji = String(p.emoji).slice(0, 4);
  if (p.theme && THEMES.some(t => t.id === p.theme)) compose.theme = p.theme;
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.date || "")) compose.date = p.date;
  if (/^\d{2}:\d{2}$/.test(p.time || "")) compose.time = p.time;
  if (/^\d{2}:\d{2}$/.test(p.endTime || "")) compose.end = p.endTime;
  compose.where = String(p.location || "").slice(0, 200); compose.food = String(p.food || "").slice(0, 120); compose.notes = String(p.notes || "").slice(0, 1000);
  if (p.capacity > 0) compose.cap = String(Math.min(500, p.capacity));
  { const st = sortStops(cleanStops(p.stops)); if (st.length >= 2) { compose.stops = st; compose.time = (st.find(x => x.time) || {}).time || compose.time; compose.where = st[0].place || compose.where; compose.food = ""; defaultWrapUp(); } }
  compose.questions = (p.questions || []).slice(0, 5).map(q => ({ id: newId().slice(0, 6), q: String(q).slice(0, 120) }));
  const gname = String(p.group || "").trim().toLowerCase();
  const g = gname && [...S.groups.values()].find(x => (x.name || "").trim().toLowerCase() === gname);
  if (g) compose.groupId = g.id;
  const { uids, unmatched } = matchFriends(p.guests);
  uids.filter(u => u !== myUid()).forEach(u => compose.invitees.add(u));
  compose._plan = {
    summary: String(p.summary || "Here's what I heard."),
    missing: (p.missing || []).filter(m => ["date", "time", "location", "guests"].includes(m)),
    unmatched, said,
    bring: (p.bring || []).slice(0, 12).map(b => ({ item: String(b.item || "").slice(0, 60), qty: String(b.qty || "").slice(0, 20) })).filter(b => b.item),
    ideas: (p.ideas || []).slice(0, 4).map(x => ({ label: String(x.label || "").slice(0, 60), kind: String(x.kind || ""), value: String(x.value || "").slice(0, 200) })).filter(x => x.label && x.value)
  };
  openComposer();
}
// One of Dot's ideas, applied to the draft with a tap.
function applyIdea(idx) {
  const p = compose._plan; if (!p) return; const idea = p.ideas[idx]; if (!idea) return;
  syncCompose();
  if (idea.kind === "question") compose.questions.push({ id: newId().slice(0, 6), q: idea.value.slice(0, 120) });
  else if (idea.kind === "bring") p.bring.push({ item: idea.value.slice(0, 60), qty: "" });
  else if (idea.kind === "note") compose.notes = (compose.notes ? compose.notes + "\n" : "") + idea.value;
  else if (idea.kind === "endTime" && /^\d{2}:\d{2}$/.test(idea.value)) compose.end = idea.value;
  else if (idea.kind === "capacity" && /^\d{1,3}$/.test(idea.value)) compose.cap = idea.value;
  p.ideas.splice(idx, 1); p.applied = (p.applied || 0) + 1;
  render(); toast("Added.", null, null, "happy");
}
function applyExpense(x, ctx) {
  openExpense(ctx.eventId || null, null, ctx.groupId || null);
  const notes = [];
  if (el("xDesc")) el("xDesc").value = x.desc || "";
  if (el("xAmt") && x.amount > 0) el("xAmt").value = String(x.amount);
  const payer = el("xPayer");
  const guests = ctx.eventId ? expensePeople(ctx.eventId, null).main : [];
  if (payer && x.paidBy) { const m = matchFriends([x.paidBy], guests); if (m.uids.length) payer.value = m.uids[0]; else notes.push(`I couldn't tell who "${x.paidBy}" is, so I left you as the payer.`); }
  if (!x.splitEveryone && (x.splitWith || []).length) {
    const m = matchFriends(x.splitWith, guests); const set = new Set([...m.uids, payer ? payer.value : myUid()]);
    document.querySelectorAll('#appDialog input[name=spl]').forEach(i => { i.checked = set.has(i.value); }); if (S._splitPaint) S._splitPaint();
    if (m.unmatched.length) notes.push(`I couldn't find ${m.unmatched.join(", ")} in your friends. Tap Edit under Split between if they're listed under another name.`);
  }
  const miss = { amount: "the amount", split: "who's splitting", payer: "who paid" };
  const missing = (x.missing || []).map(k => miss[k]).filter(Boolean); if (missing.length) notes.push(`I didn't catch ${missing.join(" or ")}. Fill that in.`);
  const form = document.querySelector("#appDialog .dlg-inner h3");
  if (form) form.insertAdjacentHTML("afterend", `<div class="dot-say">${dot(missing.length ? "thinking" : "happy", 52)}<div class="say-bubble"><b>${esc(x.summary || "Here's what I heard.")}</b>${notes.length ? `<div class="muted sm" style="margin-top:4px">${notes.map(esc).join(" ")}</div>` : ""}</div></div>`);
}
function applyEdit(d, ev) {
  if (!ev) return;
  editEvent(ev);
  const p = d.patch || {}, changed = [];
  const set = (id, v, label) => { const f = el(id); if (f && v != null && v !== "") { f.value = v; changed.push(label); } };
  set("eTitle", p.title, "title"); set("eDate", p.date, "date"); set("eTime", p.time, "time"); set("eWhere", p.location, "place"); set("eFood", p.food, "food"); set("eNotes", p.notes, "details");
  const extra = [];
  if (p.endTime) extra.push(`End time (${p.endTime}) isn't in this form; change it from the composer.`);
  if (p.capacity) extra.push(`Max spots (${p.capacity}) isn't in this form; change it from the composer.`);
  if (d.unclear) extra.push(d.unclear);
  if (!changed.length && !extra.length) extra.push("I didn't find anything to change in what you said.");
  const h = document.querySelector("#appDialog .dlg-inner h3");
  if (h) h.insertAdjacentHTML("afterend", `<div class="dot-say">${dot(changed.length ? "happy" : "thinking", 52)}<div class="say-bubble"><b>${esc(d.summary || "Here's what I'll change.")}</b>${extra.length ? `<div class="muted sm" style="margin-top:4px">${extra.map(esc).join(" ")}</div>` : ""}${changed.length ? `<div class="muted sm" style="margin-top:4px">Changed below: ${changed.join(", ")}. Check it and tap Save.</div>` : ""}</div></div>`);
}
function planCard() {
  const p = compose._plan, need = { date: "a date", time: "a time", location: "where it is", guests: "who's coming" };
  const miss = p.missing.map(m => need[m]).filter(Boolean), bits = [];
  if (miss.length) bits.push(`I didn't catch ${miss.join(" or ")}. Fill that in below.`);
  if (p.unmatched.length) bits.push(`I couldn't find ${p.unmatched.join(", ")} in your friends. Add them by phone under Who's invited.`);
  if (p.bring.length) bits.push(`I'll put ${p.bring.length === 1 ? p.bring[0].item : p.bring.length + " items"} on the bring list once it's created.`);
  const ideas = (p.ideas || []).length ? `<div class="idea-row"><span class="muted sm">Want me to…</span>${p.ideas.map((x, i) => `<button type="button" class="idea-chip" data-idea="${i}">＋ ${esc(x.label)}</button>`).join("")}</div>` : (p.applied ? `<div class="muted sm" style="margin-top:6px">That's everything I'd add. Looks good.</div>` : "");
  return `<div class="dot-say plan-card">${dot(miss.length ? "thinking" : "happy", 56)}<div class="say-bubble"><b>${esc(p.summary)}</b>${bits.length ? `<div class="muted sm" style="margin-top:4px">${bits.map(esc).join(" ")}</div>` : ""}${ideas}<div style="margin-top:6px"><a id="planRedo" style="color:var(--accent);font-weight:600">Say it again</a></div></div></div>`;
}
// ---- Repeats: Never / week / 2 weeks / month / Custom ("every 3 days", "every 2 months"), with an optional last date.
const REPEAT_UNITS = [["day", "days"], ["week", "weeks"], ["month", "months"]];
function repeatLabel(ev) {
  const r = ev || {}; if (!r.repeat) return "";
  let s = { weekly: "every week", biweekly: "every 2 weeks", monthly: "every month" }[r.repeat];
  if (r.repeat === "custom") { const n = Math.max(1, Math.min(30, parseInt(r.repeatEvery, 10) || 1)), u = REPEAT_UNITS.find(x => x[0] === r.repeatUnit) || REPEAT_UNITS[1]; s = n === 1 ? "every " + u[0] : `every ${n} ${u[1]}`; }
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(r.repeatUntil || "")) { const d = evDate({ date: r.repeatUntil }); s += ` until ${MONTHS[d.getMonth()]} ${d.getDate()}`; }
  return s;
}
function repeatFields(p, r) {
  r = r || {}; const v = r.repeat || "", custom = v === "custom", n = parseInt(r.repeatEvery, 10) || 1;
  return `<label class="field"><span>Repeats</span><select id="${p}Repeat">
      <option value="" ${!v ? "selected" : ""}>Never</option><option value="weekly" ${v === "weekly" ? "selected" : ""}>Every week</option>
      <option value="biweekly" ${v === "biweekly" ? "selected" : ""}>Every 2 weeks</option><option value="monthly" ${v === "monthly" ? "selected" : ""}>Every month</option>
      <option value="custom" ${custom ? "selected" : ""}>Custom…</option></select></label>
    <div class="repeat-custom ${custom ? "" : "hidden"}" id="${p}RepCustom"><span>Every</span><input id="${p}RepEvery" type="number" inputmode="numeric" min="1" max="30" value="${n}" aria-label="How many">
      <select id="${p}RepUnit" aria-label="Days, weeks, or months">${REPEAT_UNITS.map(([u, pl]) => `<option value="${u}" ${(r.repeatUnit || "week") === u ? "selected" : ""}>${n === 1 ? u : pl}</option>`).join("")}</select></div>
    <label class="field repeat-until ${v ? "" : "hidden"}" id="${p}RepUntilWrap"><span>Last date <span class="muted">(optional)</span></span><input id="${p}RepUntil" type="date" value="${esc(r.repeatUntil || "")}"></label>`;
}
function readRepeat(p) {
  const v = (el(p + "Repeat") || {}).value || "";
  if (!v) return { repeat: "", repeatEvery: 0, repeatUnit: "", repeatUntil: "" };
  const until = (el(p + "RepUntil") || {}).value || "";
  if (v !== "custom") return { repeat: v, repeatEvery: 0, repeatUnit: "", repeatUntil: until };
  return { repeat: "custom", repeatEvery: Math.max(1, Math.min(30, parseInt((el(p + "RepEvery") || {}).value, 10) || 1)), repeatUnit: (el(p + "RepUnit") || {}).value || "week", repeatUntil: until };
}
function wireRepeat(p, onChange) {
  const sel = el(p + "Repeat"); if (!sel) return;
  const sync = () => { el(p + "RepCustom").classList.toggle("hidden", sel.value !== "custom"); el(p + "RepUntilWrap").classList.toggle("hidden", !sel.value); if (onChange) onChange(); };
  sel.onchange = sync;
  const every = el(p + "RepEvery"), unit = el(p + "RepUnit");
  // "1 week" / "2 weeks": keep the unit names in step with the number
  const plural = () => { const n = parseInt(every.value, 10) || 1; [...unit.options].forEach((o, i) => o.textContent = n === 1 ? REPEAT_UNITS[i][0] : REPEAT_UNITS[i][1]); if (onChange) onChange(); };
  every.oninput = plural; unit.onchange = () => onChange && onChange(); el(p + "RepUntil").onchange = () => onChange && onChange();
}
// ---- The plan: one event, several stops (dinner, then bowling, then dessert) ----
// An event with 2+ stops carries ev.stops = [{ time "HH:MM", emoji, name, place }], kept in time order;
// ev.time and ev.location mirror the first stop so calendars, weather and the tiles keep working.
const STOP_CHIPS = [["🍽️", "Dinner"], ["🍸", "Drinks"], ["🎟️", "Show"], ["🎳", "Activity"], ["🍦", "Dessert"], ["✏️", ""]];   // "" = Custom
const MEETING_CHIPS = [["📋", "Session"], ["🗣️", "Discussion"], ["☕", "Break"], ["🍽️", "Lunch"], ["🤝", "Wrap-up"], ["✏️", ""]];   // "" = Custom: a blank item to name yourself
const isMeetingCtx = ctx => (ctx.h.kind || "") === "meeting";
const STOP_EMOJIS = ["🍽️", "🍔", "🌮", "🍕", "🍣", "🍸", "🍻", "🍷", "☕", "🎟️", "🎬", "🎤", "🎳", "⚾", "🏈", "🎮", "🛍️", "🌳", "🏖️", "🍦", "🎂", "🎉", "🚗", "📍"];
const stopMins = t => { if (!/^\d{2}:\d{2}$/.test(t || "")) return 99999; const [h, m] = t.split(":").map(Number); return (h < 5 ? h + 24 : h) * 60 + m; };   // 12:30 AM sorts after 10 PM
// Timed stops sort among themselves; a stop with no time yet stays where it is.
const sortStops = arr => { const slots = arr.map((x, i) => stopMins(x.time) < 99999 ? i : -1).filter(i => i >= 0); const timed = slots.map(i => arr[i]).map((x, k) => [x, k]).sort((a, b) => (stopMins(a[0].time) - stopMins(b[0].time)) || (a[1] - b[1])).map(p => p[0]); const out = arr.slice(); slots.forEach((i, k) => { out[i] = timed[k]; }); return out; };
const cleanStops = arr => (Array.isArray(arr) ? arr : []).slice(0, 24).map(x => ({ time: /^\d{2}:\d{2}$/.test((x && x.time) || "") ? x.time : "", emoji: String((x && x.emoji) || "📍").slice(0, 4), name: String((x && x.name) || "").trim().slice(0, 60), place: String((x && x.place) || "").trim().slice(0, 120), ...((x && x.note) ? { note: String(x.note).trim().slice(0, 160) } : {}), ...(/^\d{4}-\d{2}-\d{2}$/.test((x && x.day) || "") ? { day: x.day } : {}) })).filter(x => x.name || x.place);
const evStops = ev => { const st = cleanStops(ev && ev.stops); return st.length >= 2 ? sortStops(st) : []; };
const stopsText = ev => evStops(ev).map(x => `${x.time ? fmtTime(x.time) + " " : ""}${x.name || x.place}${x.name && x.place ? " at " + placeLine(x) : ""}`).join("\n");
// "Three Empires Brewing, Frisco, TX" under "Three Empires Brewing" reads as just "Frisco, TX".
const placeLine = x => x.name && x.place && x.place.startsWith(x.name + ", ") ? x.place.slice(x.name.length + 2) : x.place;
const cityOnly = p => /^[^,\d]+,\s*[A-Z]{2}$/.test(String(p || "").trim());
function defaultWrapUp() { const w = wrapUpFor(compose.stops || []); if (w && !compose.end) { compose.end = w; compose._endAuto = true; } }
const stopMapUrl = x => "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(x.place && x.name && cityOnly(x.place) ? x.name + ", " + x.place : (x.place || x.name));
// One stops editor serves the composer and the Edit event dialog; stopCtx says which one is on screen.
// h: the object holding { stops, time, where, emoji }; card/head: element ids; time/where: the plain Start/Where
// inputs the first stop mirrors; hide: class on the Start/Where fields that step aside once there are 2+ stops.
const composeStopCtx = { get h() { return compose; }, card: "stopsCard", head: "stopsHead", time: "cTime", where: "cWhere", end: "cEnd", endLbl: "cEndLbl", hide: "stops-hide", save: () => saveDraft(), before: () => syncCompose() };
let stopCtx = composeStopCtx;
function stopsEditor(ctx = stopCtx) {
  const st = ctx.h.stops || [];
  const chips = `<div class="chips stop-chips">${(isMeetingCtx(ctx) ? MEETING_CHIPS : STOP_CHIPS).map(([e, n]) => `<button type="button" class="chip ${n ? "" : "chip-custom"}" data-addstop="${n ? e : "📌"}|${n}">${e} ${n || "Custom"}</button>`).join("")}</div>`;
  if (st.length < 2) return `<p class="muted sm" style="margin:0 0 10px">${isMeetingCtx(ctx) ? "More than one part? Add the next item and it becomes an agenda." : "Doing more than one thing? Add the next stop and it becomes a timeline."}</p>${chips}`;
  return `<div class="tl tl-edit">${st.map((x, i) => `<div class="stop stop-edit" data-si="${i}">
      <div class="stop-top"><button type="button" class="st-emoji" data-semo="${i}" aria-label="Change emoji">${esc(x.emoji || "📍")}</button>
      <input class="st-name" data-sf="name" maxlength="60" value="${esc(x.name)}" placeholder="${i === 0 ? (isMeetingCtx(ctx) ? "First item, like Welcome" : "First stop, like Dinner") : isMeetingCtx(ctx) ? "Name this item" : "Then what?"}" aria-label="What">
      <button type="button" class="st-del" data-sdel="${i}" aria-label="Remove stop">✕</button></div>
      <div class="stop-bot"><label class="st-f st-f-time"><span>🕒 Time</span><input type="time" class="st-time" data-sf="time" value="${esc(x.time)}"></label>
      <label class="st-f st-f-place"><span>📍 Where</span><span class="st-place-wrap"><input class="st-place" data-sf="place" maxlength="120" value="${esc(x.place)}" placeholder="Venue or address" autocomplete="off"></span></label></div>
      ${x.note != null && x.note !== "" ? `<input class="st-note" data-sf="note" maxlength="160" value="${esc(x.note)}" placeholder="A tip for this stop" aria-label="Tip">` : ""}
      <div class="st-emo-pick hidden" data-epick="${i}">${STOP_EMOJIS.map(e => `<button type="button" data-pe="${e}">${e}</button>`).join("")}</div>
    </div>`).join("")}</div>
    <div class="stop-add"><span class="field-label" style="margin:12px 0 6px">${isMeetingCtx(ctx) ? "Add an item" : "Add a stop"}</span>${chips}</div>`;
}
function stopsHead(ctx = stopCtx) { const n = (ctx.h.stops || []).length, m = isMeetingCtx(ctx); return n >= 2 ? `${n} ${m ? "items" : "stops"} · in time order` : m ? "One part, or several" : "One stop, or several"; }
function refreshStops() { const c = el(stopCtx.card); if (!c) return; c.innerHTML = stopsEditor(); const h = el(stopCtx.head); if (h) h.textContent = stopsHead(); document.querySelectorAll("." + stopCtx.hide).forEach(n => n.classList.toggle("hidden", (stopCtx.h.stops || []).length >= 2)); if (stopCtx.endLbl && el(stopCtx.endLbl)) el(stopCtx.endLbl).textContent = (stopCtx.h.stops || []).length >= 2 ? "Wraps up" : "End"; wireStops(); }
// The first stop mirrors Start and Where, so the preview, weather and calendar stay right.
const lastStopTime = st => st.filter(x => stopMins(x.time) < 99999).reduce((m, x) => !m || stopMins(x.time) > stopMins(m) ? x.time : m, "");
const addMins = (t, mins) => { const [h, m] = t.split(":").map(Number); const v = (h * 60 + m + mins) % 1440; return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0"); };
// How long the last stop usually runs, from what it is: a movie or a ballgame takes hours, dessert doesn't.
const STOP_LENGTHS = [
  [180, /concert|live music|festival|\bfest\b|game\b|\bvs\.?\b|rangers|mavericks|mavs|stars\b|cowboys|fc dallas|stadium|arena|ballpark|🏈|⚾|🏀|⚽|🏒/i],
  [150, /movie|film|cinema|cinemark|\bamc\b|alamo|regal|theat(er|re)|musical|\bplay\b|opera|ballet|symphony|🎬|🎭/i],
  [120, /show|comedy|improv|karaoke|bowling|arcade|topgolf|golf|escape|axe|trivia|museum|zoo|aquarium|🎟️|🎤|🎳|🎮|⛳/i],
  [90, /dinner|brunch|lunch|restaurant|eatery|kitchen|grill|steak|sushi|tacos?|burger|pizza|bbq|🍽️|🍔|🌮|🍕|🍣|🍝/i],
  [90, /drinks?|bar\b|pub|brew|beer|wine|cocktail|happy hour|lounge|🍸|🍻|🍷|🍺/i],
  [45, /dessert|ice cream|gelato|froyo|pinkberry|cake|coffee|boba|donut|🍦|🍰|☕|🎂|🧋/i]
];
const stopLength = x => { const txt = [x.emoji, x.name, x.place].filter(Boolean).join(" "); const hit = STOP_LENGTHS.find(([, re]) => re.test(txt)); return hit ? hit[0] : 60; };
const lastStop = st => st.filter(x => stopMins(x.time) < 99999).reduce((m, x) => !m || stopMins(x.time) > stopMins(m.time) ? x : m, null);
const wrapUpFor = st => { const l = lastStop(st); return l ? addMins(l.time, stopLength(l)) : ""; };
function mirrorFirstStop() {
  const H = stopCtx.h, st = H.stops || []; if (st.length < 2) return;
  const ordered = sortStops(st), firstTimed = ordered.find(x => x.time); H.time = (firstTimed && firstTimed.time) || H.time; H.where = ordered[0].place || H.where;
  if (el(stopCtx.time)) el(stopCtx.time).value = H.time; if (el(stopCtx.where)) el(stopCtx.where).value = H.where;
  // "Wraps up" follows the last stop by however long that kind of stop runs, until the host picks their own time.
  const wrap = wrapUpFor(st), endEl = stopCtx.end && el(stopCtx.end);
  if (wrap && endEl && (!endEl.value || H._endAuto)) { endEl.value = wrap; H.end = wrap; H._endAuto = true; }
}
function wireStops() {
  const C = stopCtx, H = C.h, root = el(C.card); if (!root) return;
  root.querySelectorAll("[data-addstop]").forEach(b => b.onclick = () => {
    if (C.before) C.before(); const [emoji, name] = b.dataset.addstop.split("|");
    if ((H.stops || []).length < 2) H.stops = [{ time: (el(C.time) || {}).value || H.time || "", emoji: isMeetingCtx(C) ? "📅" : (H.emoji || "📍"), name: "", place: (el(C.where) || {}).value || H.where || "" }];
    if (H.stops.length >= 8) return toast("Eight stops is the most one event can hold.");
    H.stops.push({ time: "", emoji, name, place: "" }); C.save(); refreshStops();
    if (!name) { const rows = el(C.card).querySelectorAll(".stop-edit"), last = rows[rows.length - 1]; if (last) last.querySelector(".st-name").focus(); }   // Custom: straight to naming it
  });
  root.querySelectorAll(".stop-edit").forEach(row => {
    const i = +row.dataset.si;
    row.querySelectorAll("[data-sf]").forEach(inp => {
      inp.oninput = () => { H.stops[i][inp.dataset.sf] = inp.value; mirrorFirstStop(); C.save(); };
      // iOS reports a change every time the time wheel settles, so only store it then; re-sort (which redraws
      // the list and would close the picker) once the picker is dismissed with the check.
      if (inp.dataset.sf === "time") {
        inp.onchange = () => { H.stops[i].time = inp.value; mirrorFirstStop(); C.save(); };
        inp.onblur = () => { H.stops[i].time = inp.value; const sorted = sortStops(H.stops); if (sorted.some((x, k) => x !== H.stops[k])) { H.stops = sorted; mirrorFirstStop(); C.save(); refreshStops(); } };
      }
    });
    attachPlaces(row.querySelector(".st-place"));
  });
  root.querySelectorAll("[data-sdel]").forEach(b => b.onclick = () => {
    H.stops.splice(+b.dataset.sdel, 1);
    if (H.stops.length < 2) { const one = H.stops[0]; if (one) { H.time = one.time || H.time; H.where = one.place || H.where; if (el(C.time)) el(C.time).value = H.time; if (el(C.where)) el(C.where).value = H.where; } H.stops = []; }
    mirrorFirstStop(); C.save(); refreshStops();
  });
  root.querySelectorAll("[data-semo]").forEach(b => b.onclick = () => { const p = root.querySelector(`[data-epick="${b.dataset.semo}"]`); if (p) p.classList.toggle("hidden"); });
  root.querySelectorAll("[data-epick]").forEach(p => p.querySelectorAll("[data-pe]").forEach(b => b.onclick = () => { const i = +p.dataset.epick; H.stops[i].emoji = b.dataset.pe; C.save(); refreshStops(); }));
}
function composeBody() {
  restoreDraft(); stopCtx = composeStopCtx;
  const emojis = ["🎉", "🍕", "🌮", "🍻", "🎂", "🎬", "🎮", "🏖️", "🥾", "⚽", "🎲", "🍜", "🎃", "🎄", "🕺", "🔥"];
  const groups = [...S.groups.values()];
  const th = themeOf(compose.theme, compose.customTheme);
  return `
  <button class="link-back" data-go="#/">‹ Cancel</button>
  <div class="compose">
    <div class="seg kind-seg" id="kindSeg">
      <button type="button" class="${compose.kind !== "meeting" ? "on" : ""}" data-kind="event">🎉 Event</button>
      <button type="button" class="${compose.kind === "meeting" ? "on" : ""}" data-kind="meeting">📅 Meeting</button>
      <button type="button" class="${compose.kind === "trip" ? "on" : ""}" data-kind="trip">⛵ Trip</button>
    </div>
    ${!compose._draftId && (S.drafts || []).length ? `<p class="muted sm" style="margin:-4px 0 10px">You have ${S.drafts.length} saved draft${S.drafts.length === 1 ? "" : "s"} · <a data-go="#/drafts" style="color:var(--accent);font-weight:600">Open Drafts</a></p>` : ""}
    ${compose._fromDraft ? `<p class="muted sm" style="margin:-4px 0 10px">Restored your draft · <a id="discardDraft" style="color:var(--accent);font-weight:600">Discard</a></p>` : ""}
    ${compose._plan ? planCard() : (window.Blip && !isDemo() && !compose._fromDraft && !compose.title ? `<button type="button" class="btn tell-dot" id="composeTell">${dot("happy", 26)} Or just tell Dot: “Taco night Friday at 7, invite the crew, bring a side.”</button>` : "")}
    <p class="muted sm draft-status" id="draftStatus" style="margin:-4px 0 10px;min-height:1.4em"></p>
    ${compose.kind === "meeting" ? `<p class="muted sm" style="margin:-4px 0 12px">A plain calendar entry: title, time, place, who. Everyone gets a calendar invite by email.</p>` : compose.kind === "trip" ? `<p class="muted sm" style="margin:-4px 0 12px">A few days away. You get a day-by-day plan, where everyone's staying, rides, packing, and one running tab.</p>` : ""}
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
    <div class="theme-strip-wrap">
    <div class="theme-strip" id="themeStrip">
      <button type="button" class="theme-swatch t-custom ${compose.theme === "custom" ? "on" : ""}" id="customThemeBtn" title="Create your own" style="--th-accent:${(compose.customTheme || {}).accent || "#B388FF"}"><span class="theme-swatch-bg"></span><span class="theme-name" style="font-family:${(compose.customTheme || {}).font || "'Bricolage Grotesque'"},system-ui">🎨 ${compose.customTheme ? "Your Theme" : "Create your own"}</span></button>
      ${THEMES.map(t => `<button class="theme-swatch t-${t.id} ${t.id === compose.theme ? "on" : ""}" data-theme="${t.id}" title="${t.name}"><span class="theme-swatch-bg"></span><span class="theme-name" style="font-family:${t.font},system-ui">${esc(t.name)}</span></button>`).join("")}
    </div>
    </div>
    </div>

    <div class="form-card card">
      <label class="field"><span>${compose.kind === "meeting" ? "Meeting title" : "What's the plan?"}</span><input id="cTitle" maxlength="80" value="${esc(compose.title)}" placeholder="Rooftop taco night"></label>
      <div class="two">
        <label class="field"><span>${compose.kind === "trip" ? "First day" : "Date"}</span><input id="cDate" type="date" value="${compose.date || todayStr()}"></label>
        ${compose.kind === "trip" ? `<label class="field"><span>Last day</span><input id="cEndDate" type="date" value="${compose.endDate || addDays(compose.date || todayStr(), 2)}" min="${compose.date || todayStr()}"></label>` : ""}
        <label class="field stops-hide ${(compose.stops || []).length >= 2 ? "hidden" : ""}"><span>Start</span><input id="cTime" type="time" value="${compose.time}"></label>
      </div>
      <div class="two">
        <label class="field"><span id="cEndLbl">${(compose.stops || []).length >= 2 ? "Wraps up" : "End"}</span><input id="cEnd" type="time" value="${compose.end}"></label>
        <label class="field"><span>Max spots</span><input id="cCap" type="number" min="1" max="1000" value="${compose.cap}" placeholder="No limit"></label>
      </div>
      <label class="field stops-hide ${(compose.stops || []).length >= 2 ? "hidden" : ""}"><span>Where</span><input id="cWhere" maxlength="90" value="${esc(compose.where)}" placeholder="Address or vibe"></label>
      ${compose.kind === "meeting" ? "" : `<label class="field stops-hide ${(compose.stops || []).length >= 2 ? "hidden" : ""}"><span>Food &amp; drinks <span class="muted">(optional)</span></span><input id="cFood" maxlength="120" value="${esc(compose.food || "")}" placeholder="Tacos and margs · BYOB · we'll order pizza"></label>`}
      <label class="field"><span>The details</span><textarea id="cNotes" maxlength="600" placeholder="Dress code, what to bring, parking…">${esc(compose.notes)}</textarea></label>
      ${repeatFields("c", compose)}
      <p class="muted sm" style="margin:-4px 0 0">Guests get a calendar invite at their email on file.</p>
    </div>

    <div class="section-head"><h2>${compose.kind === "meeting" ? "Agenda" : "The plan"}</h2><span class="muted sm" id="stopsHead">${stopsHead()}</span></div>
    <div class="form-card card stops-card" id="stopsCard">${stopsEditor()}</div>
    ${compose.kind === "meeting" ? "" : `<div class="section-head"><h2>Day of</h2><span class="muted sm">what guests coordinate</span></div>
    <div class="form-card card" id="cDayCard">${composeDayInner()}</div>`}
    <div class="section-head"><h2>Who's invited</h2></div>
    <div class="form-card card">
      ${groups.length ? `<label class="field"><span>Invite a whole group</span>
        <select id="cGroup"><option value="">No group, just pick people</option>${groups.map(g => `<option value="${g.id}" ${compose.groupId === g.id ? "selected" : ""}>${esc(g.emoji || "")} ${esc(g.name)} (${(g.memberUids || []).length})</option>`).join("")}</select></label>` : `<p class="muted">You're not in any groups yet. <a data-go="#/groups">Create one</a> to invite people, or invite friends you already share a group with below.</p>`}
      <div id="cPickWrap">
        <span class="field-label" id="cPickLabel">${compose.groupId ? "Also invite (people outside the group)" : "Who's coming"}</span>
        <div class="inv-chosen" id="cInvChosen">${composePickedInner()}</div>
        <button type="button" class="btn small" id="cAddPeople">＋ Add people</button>
      </div>
      ${plusFields("c", compose.plusOn == null ? compose.kind !== "meeting" : compose.plusOn, compose.plusMax)}
      <div class="${compose.kind === "meeting" ? "hidden" : ""}">
      <details class="adv"><summary>Co-hosts &amp; approval</summary>
        <span class="field-label" style="margin-top:10px">Co-hosts (can edit &amp; manage)</span>
        <div class="check-grid" id="cCohosts">${contactChecks("coh", compose.cohosts)}</div>
        <label class="switch"><input type="checkbox" id="cApproval" ${compose.approval ? "checked" : ""}><span>Approve guests before they're in</span></label>
      </details>
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
    <button type="button" class="btn full" id="saveDraftBtn" style="margin-top:10px">📝 Save draft</button>
    <p class="muted sm" style="text-align:center;margin:6px 0 0">Drafts aren't sent to anyone. Find them under 📝 Drafts on the Events page.</p>
  </div>`;
}
function qRow(q) { return `<div class="q-row" data-q="${q.id}"><input value="${esc(q.q)}" data-qedit="${q.id}" maxlength="80" placeholder="Your question"><button class="btn ghost small" data-qdel="${q.id}">✕</button></div>`; }
const COVER_EMOJIS = ["🎉", "🍕", "🌮", "🍻", "🎂", "🎬", "🎮", "🏖️", "🥾", "⚽", "🎲", "🍜", "🎃", "🎄", "🕺", "🔥"];
function coverPanel() {
  if (compose.cover) return `<div class="cover-preview-img"><img src="${compose.cover}" alt="cover"><button type="button" class="rm" id="coverRemove">✕</button></div>`;
  if (compose.coverTab === "upload") return `<div class="cover-drop" id="coverDrop">📷 Tap to upload a photo</div>`;
  if (compose.coverTab === "ai") return `<div class="ai-row"><input id="aiPrompt" placeholder="e.g. rooftop taco party at sunset"><button type="button" class="btn primary" id="aiGo">Generate</button></div>
    <div class="style-chips" id="aiStyles">${COVER_STYLES.map(([k, l]) => `<button type="button" class="${(compose.coverStyle || "surprise") === k ? "on" : ""}" data-cstyle="${k}">${l}</button>`).join("")}</div>
    <p class="muted sm" style="margin:8px 0 0">Describe your vibe, pick a look, and AI makes a one-of-a-kind cover.</p>`;
  return `<div class="emoji-pick" id="cEmoji">${COVER_EMOJIS.map(e => `<button type="button" class="${e === compose.emoji ? "on" : ""}" data-e="${e}">${e}</button>`).join("")}</div>`;
}
const PARTICLE_LABELS = { confetti: "🎊 Confetti", petals: "🌸 Petals", stars: "✨ Stars", bubbles: "🫧 Bubbles", sparkles: "💫 Sparkles", embers: "🔥 Embers", none: "◯ None" };
function openCustomThemeDialog() {
  const cur = compose.customTheme;
  const accent = (cur && cur.accent) || "#B388FF";
  const font = (cur && cur.font) || "'Bricolage Grotesque'";
  const particles = (cur && cur.particles && cur.particles.kind) || "confetti";
  dialog(`<h3>Create your own theme</h3>
    <label class="field"><span>Accent color</span><input type="color" id="ctAccent" value="${accent}" style="width:100%;height:44px;padding:2px;border-radius:10px"></label>
    <span class="field-label">Font</span>
    <div class="check-grid">${CUSTOM_FONTS.map(f => `<label class="cbox"><input type="radio" name="ctFont" value="${esc(f.id)}" ${f.id === font ? "checked" : ""}><span style="font-family:${f.id},system-ui">${esc(f.name)}</span></label>`).join("")}</div>
    <span class="field-label" style="margin-top:10px">Background sparkle</span>
    <div class="check-grid">${CUSTOM_PARTICLES.map(p => `<label class="cbox"><input type="radio" name="ctParticles" value="${p}" ${p === particles ? "checked" : ""}><span>${PARTICLE_LABELS[p]}</span></label>`).join("")}</div>`,
    "Use this theme", () => {
      const pickedAccent = el("ctAccent").value;
      const pickedFont = (document.querySelector('input[name=ctFont]:checked') || {}).value || font;
      const pickedParticles = (document.querySelector('input[name=ctParticles]:checked') || {}).value || particles;
      compose.theme = "custom";
      compose.customTheme = makeCustomTheme(pickedAccent, pickedFont, pickedParticles);
      closeDialog(); syncCompose(); render();
    });
}
// Read-only look at someone you share a group with. S.contacts is exactly
// "people I'm in a group with" (built from each shared group's members map in
// rebuildContacts), so anyone wired to open this by uid is already fair game --
// no extra permission check needed beyond "we have their info to show at all".
function openProfileDialog(uid) {
  if (uid === myUid()) return go("#/profile");
  const info = S.contacts.get(uid) || { name: nameHint(uid) || "Friend" };
  dialog(`<div style="text-align:center">
    ${avatar(uid, "xxl")}
    <h2 style="margin:12px 0 2px">${esc(info.name || "Friend")}</h2>
    ${info.birthday ? `<p class="muted sm" style="margin:0">🎂 ${esc(fmtDay({ date: info.birthday }))}</p>` : ""}
    ${friendActions(uid) ? `<div class="btnrow" style="justify-content:center;margin-top:12px">${friendActions(uid)}</div>` : ""}
    ${S.contacts.has(uid) ? `<button type="button" class="btn fs-open" data-go="#/fs/${esc(uid)}">${fsPair(34, true)}<span>Our ${fsWord()}</span></button>` : ""}
  </div>
  ${info.venmo || (info.phone && appleCashFor(uid)) ? `<div class="form-card card" style="margin-top:14px">
    ${info.venmo ? `<div class="member-row"><span class="li">💸</span><div style="flex:1;min-width:0"><b>Venmo</b><div class="muted sm mono">${esc(info.venmo)}</div></div></div>` : ""}
    ${info.phone && appleCashFor(uid) ? `<div class="member-row"><span class="li">📱</span><div style="flex:1;min-width:0"><b>Apple Cash</b><div class="muted sm mono">${esc(info.phone)}</div></div></div>` : ""}
  </div>` : S.contacts.has(uid) ? `<p class="muted sm" style="text-align:center;margin-top:10px">${IS_ANDROID ? "No Venmo on file yet." : "No Venmo or Apple Cash on file yet."}</p>` : ""}`,
    null, null);
  wireFriendButtons(el("appDialog") || document);
  document.querySelectorAll("#appDialog [data-go]").forEach(b => b.onclick = () => { closeDialog(); go(b.dataset.go); });
}
function contactChecks(name, set) {
  const others = [...S.contacts.entries()].filter(([u]) => u !== myUid());
  if (!others.length) return `<span class="muted sm">No friends yet. Invite people to a group first.</span>`;
  return others.map(([u, info]) => `<label class="cbox"><input type="checkbox" name="${name}" value="${u}" ${set.has(u) ? "checked" : ""}>${avatar(u)} ${esc(first(info.name))}</label>`).join("");
}
// Picked-guest list for a not-yet-created event: known Friendly contacts (added
// straight to invitedUids on creation) plus phone-only picks (texted the join
// link right after creation). Mirrors the live event page's own picker/list.
function composePickedInner() {
  const rows = [
    ...[...compose.invitees].map(u => `<div class="inv-hit"><div style="flex:1;min-width:0"><b>${esc(nameOf(u))}</b><div class="muted sm">On Friendly · added right away</div></div><button type="button" class="btn ghost small" data-cunpick-u="${u}">✕</button></div>`),
    ...compose.phoneInvitees.map((p, i) => `<div class="inv-hit"><div style="flex:1;min-width:0"><b>${esc(p.name || p.e164)}</b><div class="muted sm">Gets a text with the join link · ${esc(p.e164)}</div></div><button type="button" class="btn ghost small" data-cunpick-p="${i}">✕</button></div>`)
  ];
  return rows.join("") || `<p class="muted sm">Nobody added yet.</p>`;
}
// Redraw just the Added list (a full render would close the open Co-hosts section).
function refreshComposePicked() {
  const box = el("cInvChosen"); if (!box) return;
  box.innerHTML = composePickedInner();
  box.querySelectorAll("[data-cunpick-u]").forEach(b => b.onclick = () => { compose.invitees.delete(b.dataset.cunpickU); syncCompose(); render(); });
  box.querySelectorAll("[data-cunpick-p]").forEach(b => b.onclick = () => { compose.phoneInvitees.splice(+b.dataset.cunpickP, 1); syncCompose(); render(); });
}
function openComposeInviteDialog() {
  pickPeopleDialog({
    title: "Add people",
    blurb: "Pick them from your contacts. Friends already on Friendly are added when you create the event; everyone else gets texted a join link right after.",
    exclude: new Set([...compose.invitees, myUid(), ...((compose.groupId && S.groups.get(compose.groupId) || {}).memberUids || [])]),
    submitLabel: "Add",
    onSubmit: async (direct, texted) => {
      for (const p of direct) compose.invitees.add(p.uid);
      for (const p of texted) if (p.e164 && !compose.phoneInvitees.some(x => x.e164 === p.e164)) compose.phoneInvitees.push({ name: p.name || "", e164: p.e164 });
      closeDialog(); syncCompose(); render();
    }
  });
}
function syncCompose() {
  compose.title = el("cTitle").value; compose.date = el("cDate").value; compose.time = el("cTime").value; if (el("cEndDate")) compose.endDate = el("cEndDate").value;
  compose.end = el("cEnd").value; compose.where = el("cWhere").value; compose.notes = el("cNotes").value; if (el("cFood")) compose.food = el("cFood").value;
  compose.cap = el("cCap").value; if (el("cApproval")) compose.approval = el("cApproval").checked;
  if (el("cRepeat")) Object.assign(compose, readRepeat("c"));
  // Co-host ticks live only in the DOM otherwise, so any re-render (picking a
  // theme, adding people) used to quietly clear them.
  if (document.querySelector("input[name=coh]")) compose.cohosts = new Set([...document.querySelectorAll("input[name=coh]:checked")].map(i => i.value));
  saveDraft();
}
function wireCompose() {
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  if (el("planRedo")) el("planRedo").onclick = () => openPlanDialog("event", {});
  if (el("composeTell")) el("composeTell").onclick = () => openPlanDialog("event", { groupId: compose.groupId });
  document.querySelectorAll("[data-idea]").forEach(b => b.onclick = () => applyIdea(+b.dataset.idea));
  composeStop = startParticles(el("cCanvas"), compose.theme, compose.customTheme);
  const upd = () => {
    el("cPvTitle").textContent = el("cTitle").value.trim() || "Your event";
    const dv = el("cDate").value, tv = el("cTime").value;
    el("cPvDate").textContent = dv ? evDate({ date: dv }).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) + (tv ? " · " + fmtTime(tv) : "") : "Pick a date";
  };
  ["cTitle", "cDate", "cTime", "cEnd", "cWhere", "cNotes", "cCap"].forEach(id => el(id).oninput = () => { if (id === "cEnd") compose._endAuto = false; syncCompose(); upd(); }); upd();
  document.querySelectorAll("#cApproval").forEach(i => i.onchange = syncCompose);
  // Ticking a co-host also puts them on the guest list (unticking leaves them invited; remove them there if needed).
  document.querySelectorAll("input[name=coh]").forEach(i => i.onchange = () => {
    const inGroup = ((compose.groupId && S.groups.get(compose.groupId) || {}).memberUids || []).includes(i.value);
    if (i.checked && !inGroup) compose.invitees.add(i.value);
    syncCompose(); refreshComposePicked();
  });
  wireRepeat("c", syncCompose);
  attachPlaces(el("cWhere"));
  wireStops();
  wireCover();
  document.querySelectorAll("[data-theme]").forEach(b => b.onclick = () => { syncCompose(); compose.theme = b.dataset.theme; render(); });
  if (el("customThemeBtn")) el("customThemeBtn").onclick = () => { syncCompose(); openCustomThemeDialog(); };
  const gsel = el("cGroup"); if (gsel) gsel.onchange = () => { compose.groupId = gsel.value; el("cPickLabel").textContent = compose.groupId ? "Also invite (people outside the group)" : "Who's coming"; syncCompose(); };
  if (el("cAddPeople")) el("cAddPeople").onclick = openComposeInviteDialog;
  document.querySelectorAll("[data-cunpick-u]").forEach(b => b.onclick = () => { compose.invitees.delete(b.dataset.cunpickU); syncCompose(); render(); });
  document.querySelectorAll("[data-cunpick-p]").forEach(b => b.onclick = () => { compose.phoneInvitees.splice(+b.dataset.cunpickP, 1); syncCompose(); render(); });
  el("addQ").onclick = () => { compose.questions.push({ id: newId().slice(0, 6), q: "" }); el("qList").insertAdjacentHTML("beforeend", qRow(compose.questions[compose.questions.length - 1])); wireQ(); };
  wireQ();
  el("createEventBtn").onclick = () => createEvent();
  if (el("saveDraftBtn")) el("saveDraftBtn").onclick = () => saveDraftToAccount();
  wirePlusFields("c"); wireComposeDay();
  document.querySelectorAll("[data-kind]").forEach(b => b.onclick = () => { syncCompose(); compose.kind = b.dataset.kind; render(); });
  if (el("discardDraft")) el("discardDraft").onclick = () => { try { LS.remove("friendlyDraft"); } catch {} resetCompose(); compose._restored = true; render(); };
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
  if (el("coverDrop")) el("coverDrop").onclick = async () => {
    const f = await pickFile("image/*", "cover"); if (!f) return;
    const cropped = await openCropDialog(f, { shape: "rect", ratio: 16 / 9, outW: 1280, outH: 720, title: "Crop your cover photo" }); if (!cropped) return;
    el("coverDrop").textContent = "Processing…";
    try { compose.cover = await compressImage(cropped, 1600, 0.82); refreshCoverUI(); } catch (e) { toast("Couldn't read that image: " + e.message); el("coverDrop").textContent = "📷 Tap to upload a photo"; }
  };
  document.querySelectorAll("[data-cstyle]").forEach(b => b.onclick = () => { compose.coverStyle = b.dataset.cstyle; document.querySelectorAll("[data-cstyle]").forEach(x => x.classList.toggle("on", x === b)); });
  if (el("aiGo")) el("aiGo").onclick = async () => {
    const p = el("aiPrompt").value.trim(); if (!p) return toast("Describe the vibe first.");
    el("coverPanel").innerHTML = `<div class="cover-spin">${dot("painter", 84) || `<div class="spinner"></div>`}Dot is painting your cover…</div>`;
    try { compose.cover = await generateCover(`${p}. Style: ${coverStylePrompt(compose.coverStyle || "surprise")}`); refreshCoverUI(); toast("Fresh cover, made for you ✨"); }
    catch (e) { toast(e.message || "Generator busy, try again."); compose.coverTab = "ai"; refreshCoverUI(); }
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
  let invitedUids, invitedPhones = [], invitedPhoneNames = {}, groupId = compose.groupId || null;
  // A group invites all its members; anyone picked individually (and every co-host) is invited too.
  const cohostPick = [...document.querySelectorAll('input[name=coh]:checked')].map(i => i.value);
  const g = groupId ? S.groups.get(groupId) : null;
  invitedUids = [...new Set([...((g && g.memberUids) || []), ...compose.invitees, ...cohostPick, myUid()])];
  invitedPhones = compose.phoneInvitees.map(p => p.e164);
  invitedPhoneNames = Object.fromEntries(compose.phoneInvitees.map(p => [p.e164, p.name || ""]));
  const phoneInviteesSnapshot = [...compose.phoneInvitees];
  const cohostUids = [...document.querySelectorAll('input[name=coh]:checked')].map(i => i.value).filter(u => u !== myUid());
  const questions = compose.questions.filter(q => q.q.trim());
  const stopsOut = (() => { const st = sortStops(cleanStops(compose.stops)); return st.length >= 2 ? st : []; })();
  if (stopsOut.length) { const last = lastStopTime(stopsOut), end = el("cEnd").value; if (last && end && stopMins(end) < stopMins(last)) return toast("“Wraps up” is before the last stop. Pick a later time.", null, null, "thinking"); }
  const id = newId();
  const ev = {
    hostId: myUid(), hostName: S.profile.name, cohostUids, groupId, invitedUids,
    // Guest names travel with the event so link-joined guests can see who's who.
    names: Object.fromEntries(invitedUids.map(u => [u, u === myUid() ? S.profile.name : nameOf(u)])),
    title, emoji: compose.emoji, theme: compose.theme, customTheme: compose.theme === "custom" ? compose.customTheme : null, cover: compose.cover || "",
    date, time: stopsOut.length ? ((stopsOut.find(x => x.time) || {}).time || el("cTime").value || "") : (el("cTime").value || ""), endTime: el("cEnd").value || "",
    location: stopsOut.length ? (stopsOut[0].place || el("cWhere").value.trim()) : el("cWhere").value.trim(), stops: stopsOut, food: stopsOut.length ? "" : el("cFood") ? el("cFood").value.trim() : "", notes: el("cNotes").value.trim(),
    capacity: Number(el("cCap").value) || 0, approval: !!el("cApproval").checked,
    tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })(),
    allowPlus: !!(el("cPlusOn") && el("cPlusOn").checked), plusMax: plusMaxVal("c"),
    ...(compose.kind === "meeting" ? {} : { dayBring: compose.bringOn !== false, dayCarpool: compose.carOn !== false }),
    questions, rsvps: { [myUid()]: "going" }, plusOnes: {}, hypes: {}, answers: {},
    // The event's own unguessable id is the access token behind the "add people" flow
    // (anyone with the link can open + join), so it's always on now.
    openLink: true,
    kind: compose.kind === "meeting" ? "meeting" : compose.kind === "trip" ? "trip" : "event", endDate: compose.kind === "trip" && el("cEndDate") && el("cEndDate").value > (el("cDate").value || "") ? el("cEndDate").value : "", ...readRepeat("c"),
    invitedPhones, invitedPhoneNames, guestEmails: [], sequence: 0,
    createdAt: Date.now()
  };
  try {
    el("createEventBtn").disabled = true; el("createEventBtn").textContent = "Creating…";
    await setDoc(doc(db, "events", id), ev);
    const planBring = [...(compose._plan ? compose._plan.bring : []), ...(compose.kind !== "meeting" && compose.bringOn !== false ? (compose.bring || []) : [])];
    const myRide = compose.kind !== "meeting" && compose.carOn !== false && compose.drive ? Number(compose.seats || 3) : 0;
    const fromDraft = compose._draftId;
    composeStop(); resetCompose(); try { LS.remove("friendlyDraft"); } catch {}
    if (fromDraft) deleteDoc(doc(db, "users", myUid(), "drafts", fromDraft)).catch(() => {});
    if (myRide) addDoc(collection(db, "events", id, "comments"), { kind: "ride", seats: myRide, from: "", note: "", authorId: myUid(), authorName: S.profile.name, text: "", createdAt: Date.now() }).catch(() => {});
    for (const b of planBring) { try { await addDoc(collection(db, "events", id, "comments"), { kind: "bring", item: b.item, qty: b.qty, authorId: myUid(), authorName: S.profile.name, text: "", createdAt: Date.now() }); } catch {} }
    go("#/e/" + id);
    const made = (ev.kind === "meeting" ? "Meeting" : "Event") + " created, invites are on their way";
    // Hosts with Calendar sync get it automatically; everyone else gets a one-tap add.
    if (S.profile && S.profile.calToken) toast(made); else toast(made, "Add to my calendar", () => openCalendarDialog({ ...ev, id }));
    if (phoneInviteesSnapshot.length) {
      const text = eventInviteText({ ...ev, id });
      setTimeout(() => {
        if (phoneInviteesSnapshot.length === 1) location.href = smsLink([phoneInviteesSnapshot[0].e164], text);
        else openTextInviteDialog(phoneInviteesSnapshot, text);
      }, 400);
    }
  } catch (e) { toast("Couldn't create: " + e.message); el("createEventBtn").disabled = false; el("createEventBtn").textContent = "Create event & send invites"; }
}

// ---------- EVENT PAGE (the themed invite) ----------
let eventBgStop = () => {};
function cleanupEvent() { S._evShown = null; S.evSubs.forEach(fn => fn()); S.evSubs = []; eventBgStop(); eventBgStop = () => {}; }
// The plan on the event page: a timeline of stops. On the day itself, the stop underway is marked Now,
// earlier ones fade, and the next one is marked Up next; every stop with a place opens directions.
function planCardHtml(ev, plain) {
  const st = evStops(ev); if (!st.length) return "";
  const meeting = ev.kind === "meeting";
  // Minutes since midnight of the event's own date, so 12:30 AM the night before isn't mistaken for the late part
  // of the party; the small hours after the event's date (until 5 AM) still count as that night.
  const nowM = (Date.now() - evDate(ev).getTime()) / 60000, today = nowM >= 0 && nowM < 29 * 60;
  let cur = -1; if (today) st.forEach((x, i) => { if (stopMins(x.time) <= nowM) cur = i; });
  if (today && ev.endTime && stopMins(ev.endTime) <= nowM) cur = st.length;
  return `<div class="${plain ? "card th-plain" : "ev-card-glass"} plan-card" id="planCard"><div class="glass-head">${meeting ? "Agenda" : "The plan"} <span>${st.length} ${meeting ? "items" : "stops"}</span></div>
    <div class="tl tl-ev">${st.map((x, i) => { const state = !today ? "" : i < cur ? "done" : i === cur ? "cur" : i === cur + 1 ? "next" : "";
      return `<div class="stop ${state}"><span class="t">${x.time ? esc(fmtTime(x.time)) : ""}</span><span class="e">${esc(x.emoji || "📍")}</span>
        <span class="stop-txt"><b>${esc(x.name || x.place)}${state === "cur" ? ` <span class="stop-pill now">Now</span>` : state === "next" ? ` <span class="stop-pill">Up next</span>` : ""}</b>${x.name && x.place ? `<small>${esc(placeLine(x))}</small>` : ""}${x.note ? `<small class="stop-note">${esc(x.note)}</small>` : ""}</span>
        ${(x.place || x.name) && state !== "done" ? `<a class="stop-dir" href="${esc(stopMapUrl(x))}" target="_blank" rel="noopener">Directions</a>` : ""}</div>`; }).join("")}</div></div>`;
}
// The event's money in one place: receipts people are still picking from, the event's expenses with your share,
// and Add expense. Refreshed in place when expenses or shared receipts change.
function evMoneyInner(ev) {
  const me = myUid(), picks = [...(S.splits || new Map()).values()].filter(t => t.eventId === ev.id && t.status === "open").sort((a, b) => b.createdAt - a.createdAt);
  const xs = [...S.expenses.values()].filter(x => x.eventId === ev.id).sort((a, b) => b.createdAt - a.createdAt), total = xs.reduce((n, x) => n + (x.amountCents || 0), 0);
  const shareOf = x => x.shares ? (x.shares[me] || 0) : ((x.split || []).includes(me) ? Math.round(x.amountCents / x.split.length) : 0);
  const row = (go, title, sub, amt) => `<button type="button" class="ev-x-row" data-evgo="${esc(go)}"><span class="ev-x-ico">🧾</span><span class="ev-x-main"><b>${esc(title)}</b><span class="muted-th sm">${sub}</span></span><span class="ev-x-amt">${amt}</span></button>`;
  return `<div class="glass-head">Expenses <span>${total ? fmt$(total) + " spent" : ""}</span></div>
    ${picks.map(t => { const boss = t.createdBy === me, left = pickLeft(t).length; return row("#/pick/" + t.id, t.desc || "Receipt", boss ? (left ? `${left} line${left === 1 ? "" : "s"} nobody has picked` : "Ready to finish") : (t.done || {})[me] ? "You're done · tap to change" : "<b>Pick what you had</b>", fmt$(splitTotal(t))); }).join("")}
    ${xs.map(x => row("#/x/" + x.id, x.desc || "Expense", (x.paidBy === me ? "You paid" : esc(first(nameOf(x.paidBy))) + " paid") + (x.paidBy !== me && shareOf(x) ? " · your share " + fmt$(shareOf(x)) : ""), fmt$(x.amountCents))).join("")}
    ${picks.length || xs.length ? "" : `<p class="muted-th sm" style="margin:0 0 10px">Nothing yet. Add what you spent and it splits with the crew, or scan the receipt and let everyone pick their own.</p>`}
    <button type="button" class="btn-th ev-x-add" data-expense>＋ Add expense</button>`;
}
function wireEvMoney(ev) {
  const card = el("moneyCard"); if (!card) return;
  card.querySelectorAll("[data-evgo]").forEach(b => b.onclick = () => go(b.dataset.evgo));
  const add = card.querySelector("[data-expense]"); if (add) add.onclick = () => openExpense(ev.id, ev.invitedUids, ev.groupId || null);
}
function refreshEvMoney() {
  if (S.route.name !== "event") return; const card = el("moneyCard"), ev = S.events.get(S.route.id); if (!card || !ev) return;
  card.innerHTML = evMoneyInner(ev); wireEvMoney(ev);
}
function renderEventPage(root, id) {
  const ev = S.events.get(id);
  // A background redraw with nothing new for this page: keep what's on screen (its own listeners keep the
  // wall, photos, polls and playlist current).
  if (S._bgRender && ev && S._evShown && S._evShown.id === id && S._evShown.ev === ev && S._evShown.profile === S.profile && el("evPage")) return;
  cleanupEvent();
  if (ev) noteNames(ev);   // the host's and guests' names ride on the event, for guests who don't know them
  S._evShown = ev ? { id, ev, profile: S.profile } : null;
  if (!ev) startPast();
  if (!ev) { root.innerHTML = shell(`<div class="card empty">${dot("thinking", 72)}<b>Loading event…</b><p class="muted">If this stays, you may not have access.</p><button class="btn" data-go="#/">Home</button></div>`); wireShell(); getDoc(doc(db, "events", id)).then(d => { if (d.exists()) { S.events.set(id, { id, ...d.data() }); render(); } }).catch(() => {}); return; }
  if (ev.kind === "meeting") { root.innerHTML = shell(meetingBody(ev)); wireShell(); wireMeeting(ev); return; }
  const th = themeOf(ev.theme, ev.customTheme);
  root.innerHTML = `<div class="event-page t-${esc(th.id)}" id="evPage" style="--th-font:${esc(th.font)},system-ui;--th-ink:${esc(th.ink)};--th-sub:${esc(th.sub)};--th-accent:${esc(th.accent)};--th-on-accent:${esc(th.onAccent)};--th-chip:${esc(th.chip)};--th-card:${esc(th.card)}">
    <canvas class="event-bg-canvas" id="evCanvas"></canvas>
    <div class="event-scroll">${eventInner(ev)}</div>
  </div>`;
  eventBgStop = startParticles(el("evCanvas"), ev.theme, ev.customTheme);
  wireEventPage(ev);
  root.insertAdjacentHTML("beforeend", edgeDotHtml()); wireEdgeDot();
  // live subcollections (comments, photos, polls, songs)
  S.evSubs.forEach(fn => fn()); S.evSubs = [];
  S.comments = []; S.photos = []; S.polls = []; S.songs = [];
  const sub = (name, fn) => S.evSubs.push(onSnapshot(collection(db, "events", id, name), snap => fn(snap.docs.map(d => ({ id: d.id, ...d.data() }))), err => console.warn("listener event/" + name + ":", err.code || err.message)));
  sub("comments", rows => { S.comments = rows.sort((a, b) => a.createdAt - b.createdAt); withInputKept(() => { const b = el("wall"); if (b) { b.innerHTML = wallInner(ev); wireWall(ev); } const dc = el("dayCard"); if (dc) { dc.innerHTML = dayInner(ev); wireDay(ev); } const tc = el("tripCard"); if (tc) { tc.innerHTML = tripInner(ev); wireTrip(ev); wireDay(ev); } }); });
  sub("photos", rows => { const seen = S._photoIds && S._photoIds.get(id); const fresh = seen ? rows.filter(p => !seen.has(p.id) && p.addedBy !== myUid() && Date.now() - (p.createdAt || 0) < 300e3) : [];
    (S._photoIds = S._photoIds || new Map()).set(id, new Set(rows.map(p => p.id)));
    if (fresh.length) { const who = first(nameOf(fresh[0].addedBy)); toast(`Ooh, ${who} just added ${fresh.length === 1 ? "a photo" : fresh.length + " photos"}!`, null, null, "coral:party"); }
    S.photos = rows.sort((a, b) => b.createdAt - a.createdAt); S.memories.set(id, S.photos.filter(visibleContent)); const b = el("photosCard"); if (b) { b.innerHTML = photosInner(ev); wirePhotos(ev); } });
  sub("polls", rows => { S.polls = rows.sort((a, b) => a.createdAt - b.createdAt); const b = el("pollsCard"); if (b) { b.innerHTML = pollsInner(ev); wirePolls(ev); } });
  sub("songs", rows => { S.songs = rows.sort((a, b) => (Object.keys(b.votes || {}).length - Object.keys(a.votes || {}).length) || a.createdAt - b.createdAt); const b = el("playlistCard"); if (b) { b.innerHTML = playlistInner(ev); wirePlaylist(ev); } });
}
// Guest lists stay private until you've answered: hosts always see them; guests once they've RSVP'd.
const RSVPD = ["going", "maybe", "no", "waitlist"];
const canSeeGuests = ev => canManage(ev) || RSVPD.includes((ev.rsvps || {})[myUid()]);
const collapsedOpen = (key, dflt) => { try { const v = LS.get(key); return v === null ? dflt : v === "1"; } catch { return dflt; } };
function statusGroups(ev) {
  const g = { going: [], maybe: [], no: [], waitlist: [], pending: [], none: [] };
  (ev.invitedUids || []).forEach(u => g[(ev.rsvps || {})[u] || "none"].push(u));
  return g;
}
function eventInner(ev) {
  const th = themeOf(ev.theme, ev.customTheme);
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
  }).join("")}</div>${reactWhoLine("hype:" + ev.id, HYPES.map(h => [h, Object.keys(ev.hypes || {}).filter(u => (ev.hypes || {})[u] === h)]))}`;

  const setBy = (ev.rsvpSetBy || {})[me];
  const rsvpBtns = (ev.invitedUids || []).includes(me) ? `
    ${myR && setBy && setBy.by !== me ? `<p class="muted-th sm" style="margin:0 0 8px">${esc(first(nameOf(setBy.by)))} marked you as ${esc({ going: "going", maybe: "maybe", no: "can't go", waitlist: "waitlisted", pending: "pending" }[myR] || myR)}. Change it below if that's not right.</p>` : ""}
    <div class="rsvp">
      <button class="rb going ${myR === "going" ? "on" : ""}" data-rsvp="going">Going</button>
      <button class="rb maybe ${myR === "maybe" ? "on" : ""}" data-rsvp="maybe">Maybe</button>
      <button class="rb no ${myR === "no" ? "on" : ""}" data-rsvp="no">Can't go</button>
    </div>
    ${(myR === "going" || myR === "waitlist") && plusAllowed(ev) ? `<div class="plus"><span>Bringing</span>
      <button data-plus="-1" ${myPlus <= 0 ? "disabled" : ""}>−</button><b>+${myPlus}</b><button data-plus="1" ${ev.plusMax && myPlus >= ev.plusMax ? "disabled" : ""}>＋</button></div>
    ${myPlus > 0 ? (() => {
      const raw = (ev.plusNames || {})[me]; const names = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      return Array.from({ length: myPlus }, (_, i) => `<input class="plus-name" data-plusidx="${i}" maxlength="40" placeholder="Guest ${i + 1}'s name" value="${esc(names[i] || "")}">`).join("");
    })() : ""}` : ""}
    ${myR === "pending" ? `<p class="pending-note">⏳ Waiting for the host to approve you.</p>` : ""}
    ${full && myR !== "going" ? `<p class="full-note">This event is full. RSVP to join the waitlist.</p>` : ""}
    ${questionsBlock(ev, me, myR)}` : ev.openLink ? `<p class="not-invited">You're invited! Join the guest list to RSVP.</p><div class="rsvp"><button class="rb going" data-join>Join this event</button></div>` : `<p class="not-invited">You're viewing this event but aren't on the guest list.</p>`;

  const guestList = ["going", "maybe", "waitlist", "pending", "no", "none"].map(k => {
    const ph = ["going", "maybe", "no"].includes(k) ? phonesWith(ev, k) : [];
    if (!g[k].length && !ph.length) return "";
    const label = { going: "Going", maybe: "Maybe", waitlist: "Waitlist", pending: "Awaiting approval", no: "Can't make it", none: "Invited" }[k];
    // Heads, not invites: each guest's +1s count toward their group (Going 3 = Sam, Alex, and Alex's +1).
    const heads = g[k].length + ph.length + g[k].reduce((t, u) => t + (((ev.plusOnes || {})[u]) || 0), 0) + ph.reduce((t, p) => t + phonePlus(ev, p), 0);
    return `<div class="guest-group"><div class="guest-label">${label} · ${heads}</div><div class="guest-chips">${ph.map(p => phoneChip(ev, p, manage)).join("")}${g[k].map(u => `
      <span class="guest-chip"><span data-viewprofile="${u}" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px">${avatar(u)}${esc(first(nameOf(u)))}</span>${(ev.plusOnes || {})[u] ? (() => {
        const n = ev.plusOnes[u]; const raw = (ev.plusNames || {})[u]; const names = (Array.isArray(raw) ? raw : (raw ? [raw] : [])).filter(Boolean);
        return `<i class="plusone">+${n}${names.length ? ` (${names.map(esc).join(", ")})` : ""}</i>`;
      })() : ""}
      ${manage && (k === "pending") ? `<button class="approve" data-approve="${u}" title="Approve">✓</button>` : ""}
      ${manage && (k === "waitlist") ? `<button class="approve" data-promote="${u}" title="Move in">↑</button>` : ""}
      ${manage && u !== me && u !== ev.hostId ? `<button class="approve setrsvp" data-setrsvp="${u}" title="Mark their RSVP" aria-label="Mark ${esc(first(nameOf(u)))}'s RSVP">✎</button><button class="approve remove" data-removeguest="${u}" title="Remove from guest list">✕</button>` : ""}</span>`).join("")}</div></div>`;
  }).join("");


  return `
  <button class="ev-back" data-go="#/">‹</button>
  ${ev.cover ? `<div class="event-cover"><img src="${fullCovers.get(ev.id) || ev.cover}" alt="${esc(ev.title)}"></div>` : ""}
  <div class="event-hero">
    ${ev.cover ? "" : `<div class="ev-emoji">${esc(ev.emoji || "🎉")}</div>`}
    <h1 class="ev-title">${esc(ev.title)}</h1>
    <div class="ev-when">${esc(fmtWhen(ev))}</div>
    <div class="ev-count">${countdown(ev)}</div>
    ${evStops(ev).length ? `<div class="ev-where"><button type="button" class="ev-where-btn" data-jump="planCard">🗺️ ${evStops(ev).length} stops, starting with ${esc(evStops(ev)[0].name || evStops(ev)[0].place)}${evStops(ev)[0].time ? " at " + esc(fmtTime(evStops(ev)[0].time)) : ""}</button></div>` : ev.location ? `<div class="ev-where"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener" title="Open in Google Maps">📍 ${esc(ev.location)}</a></div>${/zoom|meet\.google|teams|http|online|call/i.test(ev.location) ? "" : `<details class="map-wrap"><summary>Show map</summary><iframe class="map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://maps.google.com/maps?q=${encodeURIComponent(ev.location)}&output=embed" title="Map"></iframe></details>`}` : ""}
    ${ev.food && !evStops(ev).length ? `<div class="ev-food">🍽️ ${esc(ev.food)}</div>` : ""}
    <div class="ev-hosts">Hosted by ${hosts.map(u => esc(first(nameOf(u)))).join(" & ")}${grp ? ` · <span class="grp-tag">${groupMini(grp)} ${esc(grp.name)}</span>` : ""}</div>
    ${ev.capacity > 0 ? `<div class="ev-cap ${full ? "full" : ""}">${going} / ${ev.capacity} spots${full ? " · full" : ""}</div>` : ""}
    ${hypeBar}
  </div>

  <div class="ev-jumpnav">
    ${evStops(ev).length ? `<button type="button" class="jump-chip" data-jump="planCard">The plan</button>` : ""}
    <button type="button" class="jump-chip" data-jump="rsvpCard">RSVP</button>
    <button type="button" class="jump-chip" data-jump="guestCard">Guests</button>
    <button type="button" class="jump-chip" data-jump="dayCard">Day of</button>
    <button type="button" class="jump-chip" data-jump="pollsCard">Polls</button>
    <button type="button" class="jump-chip" data-jump="playlistCard">Playlist</button>
    <button type="button" class="jump-chip" data-jump="photosCard">Photos</button>
    <button type="button" class="jump-chip" data-jump="moneyCard">Expenses</button>
    <button type="button" class="jump-chip" data-jump="wall">Wall</button>
  </div>

  ${planCardHtml(ev)}
  ${ev.notes ? `<div class="ev-card-glass ev-notes">${esc(ev.notes).replace(/\n/g, "<br>")}</div>` : ""}

  <div class="ev-card-glass" id="rsvpCard">${rsvpBtns}</div>
  ${ev.timePoll ? `<div class="ev-card-glass" id="whenCard">${whenInner(ev)}</div>` : ""}
  ${ev.kind === "trip" ? `<div class="ev-card-glass" id="tripCard">${tripInner(ev)}</div>` : ""}

  ${!canSeeGuests(ev) ? `<div class="ev-card-glass" id="guestCard"><div class="glass-head">Guest list <span>${going} going</span></div><p class="muted-th sm" style="margin:0">🔒 RSVP above to see who's coming.</p></div>` : (() => { const gOpen = collapsedOpen("friendlyGuestOpen:" + ev.id, true); return `<div class="ev-card-glass inv-card ${gOpen ? "open" : ""}" id="guestCard">
    <button type="button" class="glass-head inv-toggle" id="guestToggle" aria-expanded="${gOpen}"><span>Guest list <span class="muted-th sm">· ${(ev.invitedUids || []).length + (ev.invitedPhones || []).length} invited</span></span><span class="inv-chev">›</span></button>
    <div class="inv-body">
    ${guestList || `<p class="muted-th">No guests yet.</p>`}
    ${manage ? `<button class="btn-th ghost small" id="addPeopleBtn">＋ Add people</button>` : ""}
    ${manage && (ev.questions || []).length ? `<button class="btn-th ghost small" id="viewAnswers">View RSVP answers</button>` : ""}
    ${manage && (ev.invitedUids || []).length > 1 && !(ev.invitedUids || []).filter(u => u !== me && !(ev.rsvps || {})[u]).length ? `<div class="dot-note">${dot("party", 44)}<span>Everyone has answered.</span></div>` : ""}
    ${manage && (ev.invitedUids || []).filter(u => u !== me && !(ev.rsvps || {})[u]).length ? `<button class="btn-th accent small nudge-btn" id="nudgeBtn">🔔 Nudge ${(ev.invitedUids || []).filter(u => u !== me && !(ev.rsvps || {})[u]).length} who haven't answered</button>` : ""}
    </div>
  </div>`; })()}

  ${unansweredPhones(ev).length && canSeeGuests(ev) ? (() => { const open = collapsedOpen("friendlyInvOpen:" + ev.id, false); return `<div class="ev-card-glass inv-card ${open ? "open" : ""}" id="invCard">
    <button type="button" class="glass-head inv-toggle" id="invToggle" aria-expanded="${open}"><span>Not on Friendly yet <span class="muted-th sm">· ${unansweredPhones(ev).length} invited by text</span></span><span class="inv-chev">›</span></button>
    <div class="inv-body">
      <p class="muted-th sm" style="margin:0 0 8px">They got a text with the link. Once they sign up, or you mark their answer with ✎, they move into the guest list above.</p>
      ${unansweredPhones(ev).map(p => { const nm = (ev.invitedPhoneNames || {})[p]; return `<div class="member-row"><span class="avatar lg" style="background:#CBB;opacity:.6">💬</span><div style="flex:1;min-width:0"><b>${esc(nm || p)}</b><div class="muted sm">${nm ? esc(p) + " · " : ""}${phoneStatus(ev, p) ? `<b class="phone-rsvp ${phoneStatus(ev, p)}">${{ going: ev.kind === "meeting" ? "Accepted" : "Going", maybe: "Maybe", no: ev.kind === "meeting" ? "Declined" : "Can't go" }[phoneStatus(ev, p)]}</b> · ` : ""}Hasn't joined yet</div></div>${manage ? `<span class="btnrow" style="gap:6px"><button class="btn ghost small" data-setphone="${esc(p)}" title="Mark their RSVP">✎</button><button class="btn ghost small" data-textinvite="${esc(p)}">Text again</button><button class="btn ghost small" data-uninvitephone="${esc(p)}" title="Remove">✕</button></span>` : ""}</div>`; }).join("")}
    </div>
  </div>`; })() : ""}

  <div class="ev-card-glass" id="dayCard">${dayInner(ev)}</div>
  <div class="ev-card-glass" id="pollsCard">${pollsInner(ev)}</div>
  <div class="ev-card-glass" id="playlistCard">${playlistInner(ev)}</div>
  <div class="ev-card-glass" id="photosCard">${photosInner(ev)}</div>
  <div class="ev-card-glass" id="moneyCard">${evMoneyInner(ev)}</div>
  <div class="ev-card-glass" id="wall">${wallInner(ev)}</div>

  <div class="ev-actions">
    <button class="btn-th" data-share>Share invite</button>
    <button class="btn-th" data-cal>Add to calendar</button>
    ${manage ? `<button class="btn-th" data-edit>Edit</button><button class="btn-th" data-dup>Duplicate</button><button class="btn-th danger" data-del>Delete</button>` : ""}
  </div>
  <div class="ev-foot">Friendly</div>`;
}
// Shown to any invited guest once there are questions, whether or not they've
// RSVP'd yet -- Going/Maybe now save these answers and require them all filled
// in before the RSVP itself goes through (see attemptRsvp). Already-RSVP'd
// guests can still come back and edit their answers with "Save answers".
function questionsBlock(ev, me, myR) {
  if (!(ev.questions || []).length) return "";
  const answered = myR === "going" || myR === "maybe" || myR === "waitlist" || myR === "pending";
  const mine = (ev.answers || {})[me] || {};
  return `<div class="q-answers" id="qAnswers"><div class="glass-head sm">${answered ? "A few questions from the host" : "Answer before you RSVP"}</div>
    ${ev.questions.map(q => `<label class="qa"><span>${esc(q.q)}</span><input data-answer="${q.id}" value="${esc(mine[q.id] || "")}" placeholder="Your answer"></label>`).join("")}
    ${answered ? `<button class="btn-th ghost small" id="saveAnswers">Save answers</button>` : ""}</div>`;
}
// Reactions: the five original short names plus any emoji from the keyboard,
// stored as "e<hex>_<hex>" so the key is a plain field name (Firestore field
// paths can't hold emoji).
const REACTS = { heart: "❤️", laugh: "😂", fire: "🔥", up: "👍", wow: "😮" };
const QUICK_REACTS = ["❤️", "😂", "🔥", "👍", "😮", "🎉", "😍", "🙏"];
const rkey = e => Object.keys(REACTS).find(k => REACTS[k] === e) || "e" + [...e].map(ch => ch.codePointAt(0).toString(16)).join("_");
const rshow = k => REACTS[k] || (/^e[0-9a-f_]+$/.test(k) ? k.slice(1).split("_").map(h => String.fromCodePoint(parseInt(h, 16))).join("") : "");
// Who reacted: a one-line summary under a reaction row ("Angel, Bea, and 2 others reacted"); tapping it opens a
// sheet listing everyone under each emoji. groups = [[emoji, [uids]], ...].
const reactGroups = new Map();
const andList = xs => xs.length <= 1 ? (xs[0] || "") : xs.length === 2 ? xs.join(" and ") : xs.slice(0, -1).join(", ") + ", and " + xs[xs.length - 1];
// Who reacted: press and hold any reaction to see who's behind it. Rows register each item's reactions as they render (reactWhoLine draws nothing);
// the hold opens a sheet with everyone, the pressed emoji first.
function reactWhoLine(key, groups) {
  groups = groups.filter(([, us]) => us && us.length);
  if (groups.length) reactGroups.set(key, groups); else reactGroups.delete(key);
  return "";
}
function openReactSheet(key, firstEmoji) {
  let groups = reactGroups.get(key) || []; const me = myUid(); if (!groups.length) return;
  if (firstEmoji) groups = [...groups.filter(([e]) => e === firstEmoji), ...groups.filter(([e]) => e !== firstEmoji)];
  dialog(`<h3>Reactions</h3>${groups.map(([e, us]) => `<div class="rs-row"><span class="rs-e">${esc(e)}</span><div class="rs-people">${us.map(u => `<span class="rs-p">${avatar(u, "sm")}<span>${esc(u === me ? "You" : nameOf(u) || "Someone")}</span></span>`).join("")}</div></div>`).join("")}`, null, null);
}
const RX_SEL = "[data-react],[data-hype],[data-pr],[data-payrx]";
const rxKeyOf = b => {
  if (b.dataset.react) { const [cid, k] = b.dataset.react.split("|"); return ["c:" + cid, rshow(k)]; }
  if (b.dataset.hype) return ["hype:" + ((S.route && S.route.id) || ""), b.dataset.hype];
  if (b.dataset.pr) { const v = el("photoViewer"); return ["photo:" + ((v && v.dataset.pid) || ""), rshow(b.dataset.pr)]; }
  if (b.dataset.payrx) { const [sid, k] = b.dataset.payrx.split("|"); return ["pay:" + sid, rshow(k)]; }
  return null;
};
let rxHold = 0, rxFired = 0;
document.addEventListener("pointerdown", e => {
  const b = e.target.closest && e.target.closest(RX_SEL); if (!b) return;
  const k = rxKeyOf(b); if (!k || !reactGroups.has(k[0])) return;
  const x0 = e.clientX, y0 = e.clientY;
  const off = () => ["pointerup", "pointercancel", "pointermove"].forEach(t => document.removeEventListener(t, cancel, true));
  const cancel = ev => { if (ev.type === "pointermove" && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 10) return; clearTimeout(rxHold); off(); };
  ["pointerup", "pointercancel", "pointermove"].forEach(t => document.addEventListener(t, cancel, true));
  clearTimeout(rxHold);
  rxHold = setTimeout(() => { off(); rxFired = Date.now(); openReactSheet(k[0], k[1]); }, 450);
}, true);
// The press that opened the sheet doesn't also toggle the reaction, and iOS doesn't pop its copy/lookup menu.
document.addEventListener("click", e => { if (Date.now() - rxFired < 800 && e.target.closest && e.target.closest(RX_SEL)) { e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener("contextmenu", e => { if (e.target.closest && e.target.closest(RX_SEL)) e.preventDefault(); }, true);
// Payments get reactions, a quick thank-you for the money. Either side of a payment can react, and the other side
// hears about it (onSettlementWritten). Shown on the Money tab's Activity list and on the payment's Activity alert.
const PAY_REACTS = ["❤️", "🙏", "🎉", "😂", "🔥", "👍"];
function payReacts(s, open) {
  const me = myUid(); if (!s || (s.from !== me && s.to !== me)) return "";
  const r = s.reactions || {};
  const groups = Object.entries(r).filter(([k, us]) => rshow(k) && Array.isArray(us) && us.length).map(([k, us]) => [rshow(k), us]);
  reactWhoLine("pay:" + s.id, groups);
  const shown = open ? PAY_REACTS.concat(groups.map(g => g[0]).filter(e => !PAY_REACTS.includes(e))) : groups.map(g => g[0]);
  return `<div class="pay-rx">${shown.map(e => { const k = rkey(e), who = r[k] || [];
    return `<button type="button" class="pay-rx-b ${who.includes(me) ? "on" : ""}" data-payrx="${esc(s.id)}|${k}" aria-label="React ${e}">${e}${who.length ? `<span>${who.length}</span>` : ""}</button>`; }).join("")}${open ? "" : `<button type="button" class="pay-rx-b add" data-payrxopen="${esc(s.id)}">${groups.length ? "＋" : "React"}</button>`}</div>`;
}
document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest("[data-payrx],[data-payrxopen]"); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  if (Date.now() - rxFired < 800) return;   // that press opened Who reacted
  if (b.dataset.payrxopen) { const box = b.closest(".pay-rx"), s = S.settlements.get(b.dataset.payrxopen); if (box && s) box.outerHTML = payReacts(s, true); return; }
  const [sid, k] = b.dataset.payrx.split("|"), s = S.settlements.get(sid); if (!s) return;
  const me = myUid(), on = ((s.reactions || {})[k] || []).includes(me);
  updateDoc(doc(db, "settlements", sid), { [`reactions.${k}`]: on ? arrayRemove(me) : arrayUnion(me) }).catch(err => toast(err.message));
}, true);
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
// ----- One photo, full screen: the full-size image, reactions, and its own comments -----
const photoFullCache = new Map();
// The original file goes to storage after the preview is on the wall, so the wall never waits on a big upload.
// Save and the viewer prefer it once it's there (fullUrl on the photo doc). Skipped when the file is tiny.
const FULL_MIN_BYTES = 900000;
const showable = t => /^image\/(jpeg|png|webp|gif)$/.test(t || "");
async function uploadOriginal(eid, pid, file) {
  if (!file || isDemo() || !(file.size > FULL_MIN_BYTES) || file.size > 30 * 1024 * 1024) return;
  try {
    const r = storageRef(getStorage(), `events/${eid}/photos/${pid}/full`);
    await uploadBytes(r, file, { contentType: file.type || "image/jpeg", cacheControl: "public, max-age=31536000, immutable" });
    const fullUrl = await getDownloadURL(r);
    await updateDoc(doc(db, "events", eid, "photos", pid), { fullUrl, fullBytes: file.size, fullType: file.type || "image/jpeg" });
  } catch (e) { fz.add("original upload failed: " + e.message); fz.save(); }
}
// The best copy of a photo we have: the original from storage when it's there, else the full-size copy, else the preview.
async function bestPhoto(ev, p) {
  if (p.fullUrl) return p.fullUrl;
  if (p.full && !photoFullCache.has(p.id)) { try { const d = await getDoc(doc(db, "events", ev.id, "photoFull", p.id)); if (d.exists()) photoFullCache.set(p.id, d.data().img); } catch {} }
  return photoFullCache.get(p.id) || p.img;
}
// Save to the camera roll: on a phone the share sheet (its Save Image), elsewhere a download.
async function savePhoto(ev, p, btn) {
  if (btn) btn.disabled = true;
  try {
    const src = await bestPhoto(ev, p);
    // Android's web view has no share sheet and ignores download links, so the original opens in Chrome (press and
    // hold there to download). Photos without an original wait for the next Android app update, which saves natively.
    const blob = await (await fetch(src)).blob();
    const ext = /png/.test(blob.type) ? "png" : /heic|heif/.test(blob.type) ? "heic" : "jpg";
    const name = `${String(ev.title || "friendly").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "friendly"}-${p.id.slice(0, 6)}.${ext}`;
    // Android app 1.0.5+: the native share sheet (Save to Photos lives there) via the Filesystem + Share plugins.
    const FS = NATIVE && plugin("Filesystem"), SH = NATIVE && plugin("Share");
    if (NATIVE && IS_ANDROID) {
      if (FS && SH) {
        try {
          const b64 = (await blobToURL(blob)).split(",")[1];
          const w = await FS.writeFile({ path: name, data: b64, directory: "CACHE" });
          await SH.share({ title: ev.title || "Photo", files: [w.uri] }); return;
        } catch (e) { if (/cancel/i.test(e.message || "")) return; }
      }
      // Older Android app: no share sheet in its web view and download links are ignored, so the original opens
      // in Chrome (press and hold there to download).
      if (/^https?:/.test(src)) { window.open(src, "_blank"); toast("Opened in your browser. Press and hold the photo to download it."); return; }
      toast("Update Friendly from the Play Store to save photos."); return;
    }
    const file = new File([blob], name, { type: blob.type || "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: ev.title || "Photo" }); return; } catch (e) { if (e.name === "AbortError") return; } }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000); toast("Saved");
  } catch (e) { toast("Couldn't save that photo: " + e.message); }
  finally { if (btn) btn.disabled = false; }
}
const photoBadges = p => { const r = Object.values(p.reactions || {}).reduce((t, v) => t + (Array.isArray(v) ? v.length : 0), 0), c = p.commentCount || 0;
  return r || c ? `<span class="ph-badges">${r ? `<span>❤️ ${r}</span>` : ""}${c ? `<span>💬 ${c}</span>` : ""}</span>` : ""; };
function closePhoto() { const v = el("photoViewer"); if (!v) return; (v._unsubs || []).forEach(fn => fn()); v.remove(); if (!el("appDialog")) unlockScroll(); }
function openPhoto(ev, p) {
  closePhoto();
  const me = myUid(), host = ev.hostId === me || (ev.cohostUids || []).includes(me) || isAdmin();
  const box = document.createElement("div"); box.className = "photo-viewer"; box.id = "photoViewer"; box._unsubs = []; box.dataset.pid = p.id;
  box.innerHTML = `<div class="pv-top"><div class="pv-who">${avatar(p.addedBy)}<div><b>${esc(first(nameOf(p.addedBy)))}</b><div class="pv-sub">${esc(ev.title || "")}${p.createdAt ? " · " + esc(ago(p.createdAt)) : ""}</div></div></div><span class="pv-btns"><button type="button" class="pv-save" id="pvSave" aria-label="Save photo"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/></svg><span>Save</span></button><button type="button" class="pv-x" id="pvClose" aria-label="Close">✕</button></span></div>
    <div class="pv-img"><img id="pvImg" src="${esc(photoFullCache.get(p.id) || p.img)}" alt=""></div>
    <div class="pv-panel"><div class="pv-reacts" id="pvReacts"></div><div class="pv-who-line" id="pvWho"></div>
      <div class="pv-comments" id="pvComments"><p class="pv-empty">Loading comments…</p></div>
      <form class="pv-form" id="pvForm"><input id="pvText" placeholder="Add a comment…" maxlength="500" autocomplete="off" enterkeyhint="send"><button class="btn primary small" type="submit">Post</button></form></div>`;
  document.body.appendChild(box); lockScroll();
  el("pvClose").onclick = closePhoto;
  el("pvSave").onclick = () => savePhoto(ev, cur, el("pvSave"));
  const pref = doc(db, "events", ev.id, "photos", p.id);
  let cur = p;
  const paintReacts = () => {
    const r = cur.reactions || {}, box2 = el("pvReacts"); if (!box2) return;
    box2.innerHTML = QUICK_REACTS.slice(0, 6).map(e => { const k = rkey(e), who = r[k] || [], on = who.includes(me);
      return `<button type="button" class="pv-react ${on ? "on" : ""}" data-pr="${k}" title="${esc(who.map(u => first(nameOf(u))).join(", "))}">${e}${who.length ? `<span>${who.length}</span>` : ""}</button>`; }).join("");
    const who = el("pvWho"); if (who) who.innerHTML = reactWhoLine("photo:" + cur.id, Object.entries(r).filter(([k, us]) => rshow(k) && Array.isArray(us)).map(([k, us]) => [rshow(k), us]));
    box2.querySelectorAll("[data-pr]").forEach(b => b.onclick = () => { const k = b.dataset.pr, on = ((cur.reactions || {})[k] || []).includes(me);
      updateDoc(pref, { [`reactions.${k}`]: on ? arrayRemove(me) : arrayUnion(me) }).catch(e => toast(e.message)); });
  };
  paintReacts();
  box._unsubs.push(onSnapshot(pref, d => { if (!d.exists()) { closePhoto(); toast("That photo was removed."); return; } cur = { id: d.id, ...d.data() }; paintReacts(); }, () => {}));
  box._unsubs.push(onSnapshot(query(collection(db, "events", ev.id, "photos", p.id, "comments"), orderBy("createdAt")), snap => {
    const list = el("pvComments"); if (!list) return;
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(visibleContent);
    list.innerHTML = rows.length ? rows.map(c => `<div class="pv-c" data-cmsg="${esc(c.id)}">${avatar(c.authorId, "sm")}<div class="pv-c-body"><b>${esc(first(c.authorName || nameOf(c.authorId)))}</b> ${renderText(c.text || "", c.mentions)}<div class="pv-sub">${esc(ago(c.createdAt))}${c.authorId === me || host ? ` · <button type="button" class="pv-del" data-pcdel="${c.id}">Delete</button>` : ""}</div></div></div>`).join("")
      : `<p class="pv-empty">No comments yet. Say something nice.</p>`;
    list.querySelectorAll("[data-pcdel]").forEach(b => b.onclick = () => deleteDoc(doc(db, "events", ev.id, "photos", p.id, "comments", b.dataset.pcdel)).catch(e => toast(e.message)));
    list.scrollTop = list.scrollHeight;
  }, () => { const list = el("pvComments"); if (list) list.innerHTML = `<p class="pv-empty">Comments aren't available right now.</p>`; }));
  if (p.full && !photoFullCache.has(p.id)) getDoc(doc(db, "events", ev.id, "photoFull", p.id)).then(d => { if (!d.exists()) return; photoFullCache.set(p.id, d.data().img); const im = el("pvImg"); if (im && !im.dataset.orig) im.src = d.data().img; }).catch(() => {});
  if (p.fullUrl && showable(p.fullType)) { const big = new Image(); big.onload = () => { const im = el("pvImg"); if (im && im.closest("#photoViewer") && (el("photoViewer") || {}).dataset.pid === p.id) { im.dataset.orig = "1"; im.src = p.fullUrl; } }; big.src = p.fullUrl; }
  el("pvForm").onsubmit = async e => {
    e.preventDefault(); const t = el("pvText"), text = t.value.trim(); if (!text) return;
    t.value = "";
    try { await addDoc(collection(db, "events", ev.id, "photos", p.id, "comments"), { text, authorId: me, authorName: (S.profile && S.profile.name) || "", createdAt: Date.now() }); }
    catch (err) { t.value = text; toast(err.message); }
  };
}
document.addEventListener("keydown", e => { if (e.key === "Escape" && el("photoViewer")) closePhoto(); });
window.addEventListener("hashchange", closePhoto);
function lightbox(src) { const box = document.createElement("div"); box.className = "lightbox"; box.innerHTML = `<img src="${esc(src)}" alt="">`; box.onclick = () => box.remove(); document.body.appendChild(box); }
function wallInner(ev, title = "Party wall") {
  const all = S.comments.filter(c => !c.kind && visibleContent(c)); const me = myUid();
  if (replyTo && replyTo.ctx !== ev.id) replyTo = null;
  const ids = new Set(all.map(c => c.id));
  const kids = {}; all.forEach(c => { if (c.parentId && ids.has(c.parentId)) (kids[c.parentId] = kids[c.parentId] || []).push(c); });
  const tops = all.filter(c => !(c.parentId && ids.has(c.parentId)));
  const msg = (c, topId) => {
    const rx = Object.entries(c.reactions || {}).filter(([k, us]) => rshow(k) && us && us.length);
    const who = first(c.authorName || nameOf(c.authorId));
    return `<div class="wall-msg${topId ? " reply" : ""}" data-cmsg="${esc(c.id)}">${avatar(c.authorId, "sm")}<div style="flex:1;min-width:0"><div class="wall-who">${esc(who)} <i>${ago(c.createdAt)}</i></div>
      ${c.gif ? `<img class="wall-img wall-gif" src="${esc(c.gif)}" alt="GIF">` : ""}${c.img ? `<img class="wall-img" src="${esc(c.img)}" alt="">` : ""}${c.text ? `<div class="wall-text">${renderText(c.text, c.mentions)}</div>` : ""}
      <div class="react-row">${rx.map(([k, us]) => `<button type="button" class="react ${us.includes(me) ? "on" : ""}" data-react="${c.id}|${k}">${rshow(k)} ${us.length}</button>`).join("")}<button type="button" class="react add" data-reactpick="${c.id}" title="React">＋</button><button type="button" class="react add" data-reply="${topId || c.id}|${esc(who)}">↩ Reply</button></div>
      ${reactWhoLine("c:" + c.id, rx.map(([k, us]) => [rshow(k), us]))}
      ${(kids[c.id] || []).map(r => msg(r, c.id)).join("")}</div>
      ${c.authorId === me || isAdmin() ? `<button class="wall-del" data-delc="${c.id}" title="Delete">✕</button>` : `<button class="wall-del" data-more="comment|${c.id}" title="Report or block">⋯</button>`}</div>`;
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
  document.querySelectorAll("[data-more]").forEach(b => b.onclick = () => { const [kind, id] = b.dataset.more.split("|"); moderationMenu(ev, kind, id); });
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
    const file = await pickFile("image/*", "wall photo"); if (!file) return; toast("Adding photo…");
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
function openGifPicker(ev, onPick) {
  dialog(`<h3>Add a GIF</h3><input id="gifQ" class="search-box" placeholder="Search GIPHY…" autocomplete="off"><div class="gif-grid" id="gifGrid"><p class="muted sm">Loading…</p></div><p class="muted sm" style="margin:6px 0 0">Powered by GIPHY</p>`, null, null);
  const grid = el("gifGrid"), q = el("gifQ"); let timer;
  const load = async term => {
    const url = term ? `https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(term)}&limit=24&rating=pg-13` : `https://api.giphy.com/v1/gifs/trending?api_key=${giphyKey}&limit=24&rating=pg-13`;
    try {
      const j = await (await fetch(url)).json();
      grid.innerHTML = (j.data || []).map(g => `<img src="${esc(g.images.fixed_height_small.url)}" data-gif="${esc(g.images.fixed_height.url)}" alt="${esc(g.title || "GIF")}" loading="lazy">`).join("") || `<p class="muted sm">No GIFs found.</p>`;
      grid.querySelectorAll("[data-gif]").forEach(im => im.onclick = async () => {
        const gif = im.dataset.gif; closeDialog();
        if (onPick) return onPick(gif);
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
// A bring-list item with a count ("PROSECCO × 6") stays open until the claims add up to it; one without a count
// ("Pumpkin Pie") means one of it, so the first person to claim it covers it and the button goes away for everyone else.
function bringState(c) {
  const who = (c.reactions || {}).claim || [], claimQty = (c.reactions || {}).claimQty || {};
  const target = parseInt(c.qty, 10), hasTarget = Number.isFinite(target) && target > 0;
  const qtyOf = u => (hasTarget && claimQty[u]) || 1;
  const total = who.reduce((t, u) => t + qtyOf(u), 0);
  const remaining = hasTarget ? Math.max(0, target - total) : (who.length ? 0 : 1);
  return { who, hasTarget, qtyOf, remaining, covered: remaining <= 0 };
}
// Claimers who share no group with you (joined by link) aren't in your contacts: use the name saved with the claim,
// then anything they've posted on this event, before giving up.
function claimerName(c, u) {
  const n = nameOf(u); if (n !== "Someone") return n;
  const saved = ((c.reactions || {}).claimNames || {})[u]; if (saved) return saved;
  const posted = S.comments.find(x => x.authorId === u && x.authorName); return posted ? posted.authorName : "";
}
function dayInner(ev) {
  const me = myUid(); const du = daysUntil(ev); const soon = du >= 0 && du <= 1;
  const latest = {}; typed("status").forEach(c => { if (!latest[c.authorId] || latest[c.authorId].createdAt < c.createdAt) latest[c.authorId] = c; });
  const statuses = Object.values(latest).filter(c => c.status !== "clear" && Date.now() - c.createdAt < 36e5 * 18).sort((a, b) => b.createdAt - a.createdAt);
  const mine = latest[me] && latest[me].status !== "clear" ? latest[me].status : "";
  const items = typed("bring"); const rides = typed("ride");
  // Three clear parts: weather and who's on the way, the bring list, and carpool. The host can turn the
  // bring list or carpool off (ev.dayBring / ev.dayCarpool === false) when making or editing the event.
  return `<div class="glass-head">Day of <span>${esc(fmtDay(ev))}</span></div>
    <div class="day-sec"><div class="glass-sub">☀️ Weather &amp; arrivals</div>
    <div id="wx" class="muted-th sm" style="margin:0 0 8px">${esc(ev._wx || "")}</div>
    ${statuses.length ? `<div class="chipwrap">${statuses.map(c => `<span class="day-chip">${LIVE_ICON[c.status] || "🚗"} ${esc(first(c.authorName || nameOf(c.authorId)))} is ${lateWord(c)} <i>${ago(c.createdAt)}</i></span>`).join("")}</div>` : ""}
    <div class="btnrow" style="margin:4px 0 10px">
      ${soon || mine ? `<button type="button" class="btn-th small ${mine === "omw" ? "accent" : ""}" data-status="omw">🚗 On my way</button><button type="button" class="btn-th small ${mine === "late" ? "accent" : ""}" data-status="late">⏰ Running late</button><button type="button" class="btn-th small ${mine === "here" ? "accent" : ""}" data-status="here">📍 I'm here</button>` : ""}
      ${S.profile && S.profile.calToken ? "" : `<button type="button" class="btn-th small" id="addCal">📆 Add to calendar</button>`}
    </div>
    </div>
    ${ev.dayBring === false ? "" : `<div class="day-sec"><div class="glass-sub">🧺 Bring list <button type="button" class="btn-th ghost small" id="addBring">＋ Add</button></div>
    ${items.length ? items.map(c => {
      const st = bringState(c), iAmIn = st.who.includes(me), myQty = st.qtyOf(me);
      const names = st.who.map(u => { const n = claimerName(c, u); return esc(n ? first(n) : "A guest"); });
      const whoLine = !st.who.length ? "" : st.hasTarget ? st.who.map((u, i) => names[i] + " is bringing " + st.qtyOf(u)).join(", ")
        : (names.length === 1 ? names[0] + " is bringing it" : names.slice(0, -1).join(", ") + " and " + names[names.length - 1] + " are bringing it");
      return `<div class="day-row"><span style="flex:1;min-width:0"><b>${esc(c.item)}</b>${c.qty ? ` <span class="muted-th sm">× ${esc(c.qty)}</span>` : ""}
        ${whoLine ? `<div class="muted-th sm" ${st.covered && !st.hasTarget ? `style="color:var(--good)"` : ""}>${st.covered && !st.hasTarget ? "✓ " : ""}${whoLine}</div>` : ""}
        ${st.hasTarget ? `<div class="muted-th sm" ${st.covered ? `style="color:var(--good)"` : ""}>${st.covered ? "✓ Covered" : st.remaining + " more needed"}</div>` : ""}</span>
        <span class="btnrow" style="gap:6px;align-items:center">
        ${iAmIn && st.hasTarget ? `<span class="qty-stepper"><button type="button" class="btn-th small" data-claimqty="${c.id}|-1" ${myQty <= 1 ? "disabled" : ""}>−</button><b class="qty-num">${myQty}</b><button type="button" class="btn-th small" data-claimqty="${c.id}|1">+</button></span>` : ""}
        ${iAmIn ? `<button type="button" class="btn-th small accent" data-claim="${c.id}" title="Tap to undo">✓ Bringing it</button>` : st.covered ? "" : `<button type="button" class="btn-th small" data-claim="${c.id}">I'll bring it</button>`}
        </span>${c.authorId === me || canManage(ev) ? `<button type="button" class="wall-del" data-delc="${c.id}" title="Remove">✕</button>` : ""}</div>`;
    }).join("") : `<p class="muted-th sm" style="margin:2px 0 8px">Nothing on the list yet. Add what's needed and people claim it.</p>`}
    ${items.length && items.every(c => bringState(c).covered) ? `<div class="dot-note">${dot("happy", 44)}<span>Everything's covered. Thanks, everyone.</span></div>` : ""}
    </div>`}
    ${ev.dayCarpool === false ? "" : `<div class="day-sec"><div class="glass-sub">🚗 Carpool <button type="button" class="btn-th ghost small" id="addRide">Offer a ride</button></div>
    ${rides.length ? rides.map(c => { const riders = ((c.reactions || {}).ride || []); const left = Math.max(0, (c.seats || 0) - riders.length); const inCar = riders.includes(me); const driver = c.authorId === me; return `<div class="day-row"><span style="flex:1;min-width:0"><b>${esc(first(c.authorName || nameOf(c.authorId)))} is driving</b>${c.from ? ` <span class="muted-th sm">from ${esc(c.from)}</span>` : ""}<div class="muted-th sm">${left} seat${left === 1 ? "" : "s"} left${riders.length ? " · " + riders.map(u => esc(first(nameOf(u)))).join(", ") : ""}${c.note ? " · " + esc(c.note) : ""}</div></span>
        ${driver ? `<button type="button" class="wall-del" data-delc="${c.id}" title="Remove">✕</button>` : `<button type="button" class="btn-th small ${inCar ? "accent" : ""}" data-ride="${c.id}" ${!inCar && !left ? "disabled" : ""}>${inCar ? "✓ Riding" : left ? "Need a seat" : "Full"}</button>`}</div>`; }).join("") : `<p class="muted-th sm" style="margin:2px 0 4px">No rides offered yet.</p>`}</div>`}`;
}
function wireDay(ev) {
  const me = myUid();
  document.querySelectorAll("[data-status]").forEach(b => b.onclick = async () => {
    const latest = typed("status").filter(c => c.authorId === me).sort((a, b) => b.createdAt - a.createdAt)[0];
    try { await postStatus(ev, b.dataset.status, latest && latest.status !== "clear" ? latest.status : ""); } catch (e) { toast(e.message); }
  });
  if (el("addCal")) el("addCal").onclick = () => openCalendarDialog(ev);
  if (el("addBring")) el("addBring").onclick = () => dialog(`<h3>Add to the bring list</h3><label class="field"><span>What</span><input id="bItem" placeholder="Ice, cups, a dessert…" maxlength="60"></label><label class="field"><span>How many <span class="muted">(optional)</span></span><input id="bQty" placeholder="2 bags" maxlength="20"></label>`, "Add", async () => {
    const item = el("bItem").value.trim(); if (!item) return toast("Say what's needed.");
    try { await addDoc(subCol(ev, "comments"), { kind: "bring", item, qty: el("bQty").value.trim(), authorId: me, authorName: S.profile.name, text: "", createdAt: Date.now() }); closeDialog(); } catch (e) { toast(e.message); }
  });
  document.querySelectorAll("[data-claim]").forEach(b => b.onclick = async () => {
    const c = S.comments.find(x => x.id === b.dataset.claim); const has = c && ((c.reactions || {}).claim || []).includes(me);
    if (!has && c && bringState(c).covered) return toast(`${first(claimerName(c, bringState(c).who[0]) || "Someone else")} already has that one.`);
    const patch = { "reactions.claim": has ? arrayRemove(me) : arrayUnion(me), [`reactions.claimNames.${me}`]: has ? deleteField() : (S.profile.name || "Friend") };
    if (has) patch[`reactions.claimQty.${me}`] = deleteField();
    try { await updateDoc(doc(subCol(ev, "comments"), b.dataset.claim), patch); } catch (e) { toast(e.message); }
  });
  // How many of a bring-list item someone's personally covering, once they've claimed it.
  document.querySelectorAll("[data-claimqty]").forEach(b => b.onclick = async () => {
    const [id, delta] = b.dataset.claimqty.split("|");
    const c = S.comments.find(x => x.id === id); if (!c) return;
    const cur = ((c.reactions || {}).claimQty || {})[me] || 1;
    const next = Math.max(1, cur + Number(delta));
    try { await updateDoc(doc(subCol(ev, "comments"), id), { [`reactions.claimQty.${me}`]: next }); } catch (e) { toast(e.message); }
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
// Find a place on the map from an address or venue string, for the forecast. Reads "..., City, ST 12345, USA":
// drops the country and zip, takes the state, and only accepts a match in that state (a bare "USA" used to
// resolve to Uşak, Turkey). With no state or country to go on, only a big, well-known city is accepted.
const STATE_NAME_BY_ABBR = Object.fromEntries(Object.entries(US_STATES).map(([name, ab]) => [ab, name]));
async function geocodePlace(str) {
  const parts = String(str || "").split(",").map(p => p.trim()).filter(Boolean);
  let country = "";
  if (parts.length && /^(usa|u\.s\.a\.?|us|u\.s\.|united states( of america)?)$/i.test(parts[parts.length - 1])) { country = "US"; parts.pop(); }
  let state = "";
  if (parts.length) {
    const last = parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, "").trim();
    if (/^[A-Za-z]{2}$/.test(last) && STATE_NAME_BY_ABBR[last.toUpperCase()]) { state = last.toUpperCase(); parts.pop(); }
    else if (US_STATES[last.toLowerCase()]) { state = US_STATES[last.toLowerCase()]; parts.pop(); }
    else if (!last) parts.pop();   // the part was only a zip code
  }
  if (state) country = "US";
  const street = /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|way|ct|court|pkwy|parkway|hwy|highway|suite|ste|apt|unit)\b\.?$/i;
  const cands = parts.slice(-2).reverse().map(c => c.replace(/\b\d{5}(-\d{4})?\b/g, "").trim()).filter(c => c && !/\d/.test(c) && !street.test(c));
  for (const c of cands) {
    const g = await (await fetch("https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(c) + "&count=10&language=en" + (country ? "&countryCode=" + country : ""))).json();
    const rs = g.results || [];
    const hit = state ? rs.find(r => String(r.admin1 || "").toLowerCase() === STATE_NAME_BY_ABBR[state]) : rs.find(r => (r.population || 0) >= 100000);
    if (hit) return hit;
  }
  return null;
}
async function loadWeather(ev) {
  const box = el("wx"); if (!box || !ev.location || /zoom|meet\.google|teams|http|online|call/i.test(ev.location)) return;
  const du = daysUntil(ev); if (du < 0 || du > 15) return;
  const key = "wx2:" + ev.date + ":" + ev.location; let cached = null; try { cached = JSON.parse(LS.get(key) || "null"); } catch {}
  const show = txt => { ev._wx = txt; const b = el("wx"); if (b) b.textContent = txt; };
  if (cached && Date.now() - cached.at < 36e5) return show(cached.txt);
  try {
    // The event's address first; with several stops, any stop that names a city will do.
    let hit = null; for (const place of [ev.location, ...evStops(ev).map(x => x.place)].filter(Boolean)) { hit = await geocodePlace(place); if (hit) break; }
    if (!hit) return;
    const f = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&timezone=auto&start_date=${ev.date}&end_date=${ev.date}`)).json();
    const d = f.daily; if (!d || !d.weather_code) return;
    const txt = `${WX[d.weather_code[0]] || "🌡"} · ${Math.round(d.temperature_2m_max[0])}° / ${Math.round(d.temperature_2m_min[0])}°${d.precipitation_probability_max && d.precipitation_probability_max[0] != null ? " · " + d.precipitation_probability_max[0] + "% rain" : ""} · ${hit.name}`;
    try { LS.set(key, JSON.stringify({ at: Date.now(), txt })); } catch {}
    show(txt);
  } catch {}
}
// Add one event to a calendar: an .ics file (Apple, Outlook) or a Google Calendar link.
function eventIcs(ev) {
  const dt = (d, t) => d.replace(/-/g, "") + "T" + (t || "09:00").replace(":", "") + "00";
  const end = () => { if (ev.endTime) return dt(ev.date, ev.endTime); const [h, m] = (ev.time || "09:00").split(":").map(Number); const e = new Date(2000, 0, 1, h + 2, m); return dt(ev.date, String(e.getHours()).padStart(2, "0") + ":" + String(e.getMinutes()).padStart(2, "0")); };
  const escI = v => String(v || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Friendly//officialfriendly.com//EN", "BEGIN:VEVENT", "UID:" + ev.id + "@officialfriendly.com", "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z", "DTSTART:" + dt(ev.date, ev.time), "DTEND:" + end(), "SUMMARY:" + escI((ev.emoji ? ev.emoji + " " : "") + ev.title), ev.location ? "LOCATION:" + escI(ev.location) : "", "DESCRIPTION:" + escI((stopsText(ev) ? "The plan:\n" + stopsText(ev) + "\n\n" : "") + (ev.notes ? ev.notes + "\n\n" : "") + "https://officialfriendly.com/#/e/" + ev.id), "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
}
function openCalendarDialog(ev) {
  const dt = (d, t) => d.replace(/-/g, "") + "T" + (t || "09:00").replace(":", "") + "00";
  const [h, m] = (ev.time || "09:00").split(":").map(Number); const e = new Date(2000, 0, 1, h + 2, m);
  const g = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent((ev.emoji ? ev.emoji + " " : "") + ev.title)}&dates=${dt(ev.date, ev.time)}/${ev.endTime ? dt(ev.date, ev.endTime) : dt(ev.date, String(e.getHours()).padStart(2, "0") + ":" + String(e.getMinutes()).padStart(2, "0"))}&location=${encodeURIComponent(ev.location || "")}&details=${encodeURIComponent("https://officialfriendly.com/#/e/" + ev.id)}`;
  dialog(`<h3>Add to calendar</h3><p class="muted" style="margin-top:-6px">Just this event. To keep every Friendly plan in your calendar automatically, use Calendar sync on your profile.</p>
    <div class="stack"><button type="button" class="btn primary" id="calApple">📆 Apple / iPhone Calendar</button><a class="btn" href="${g}" target="_blank" rel="noopener">Google Calendar</a><button type="button" class="btn" data-go="#/profile">Calendar sync (all events)</button></div>`, null, null);
  // The calendar file comes from the server, so iPhone (and the app on any phone) hands it to Safari or
  // the browser, which shows "Add to Calendar". A blob download did nothing inside the iPhone app.
  el("calApple").onclick = async () => {
    try {
      let t = S.profile.icsToken;
      if (!t) { t = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join(""); await updateDoc(doc(db, "users", myUid()), { icsToken: t }); }
      const url = `${FN_BASE}/cal?u=${encodeURIComponent(myUid())}&t=${t}&e=${encodeURIComponent(ev.id)}`;
      closeDialog();
      if (NATIVE || IOS) location.href = url; else window.open(url, "_blank");
    } catch (e) { toast("Couldn't open the calendar file: " + e.message); }
  };
  document.querySelectorAll("#appDialog [data-go]").forEach(b => b.onclick = () => { closeDialog(); go(b.dataset.go); });
}
function wireEventPage(ev) {
  wireWhen(ev); if (ev.kind === "trip") wireTrip(ev);
  if (ev.coverFull) fullCoverOf(ev).then(c => { const img = document.querySelector(".event-cover img"); if (img && c && img.getAttribute("src") !== c) img.src = c; });
  const id = ev.id;
  markPeeked("#/e/" + ev.id);
  wireDay(ev); loadWeather(ev);
  document.querySelectorAll("[data-jump]").forEach(b => b.onclick = () => { const t = el(b.dataset.jump); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); });
  document.querySelectorAll("[data-viewprofile]").forEach(el2 => el2.onclick = () => openProfileDialog(el2.dataset.viewprofile));
  const dup = $("[data-dup]"); if (dup) dup.onclick = () => duplicateEvent(ev);
  // Group members who joined after the event was created aren't in invitedUids
  // yet (it's snapshotted at creation); add them quietly so they can RSVP.
  S._autoJoined = S._autoJoined || new Set();
  if (!(ev.invitedUids || []).includes(myUid()) && ev.groupId && S.groups.has(ev.groupId) && !S._autoJoined.has(id)) {
    S._autoJoined.add(id);
    (async () => { const up = { invitedUids: arrayUnion(myUid()), [`names.${myUid()}`]: S.profile.name }; if (myPhoneE164()) up[`phoneKeys.${myUid()}`] = await phoneKey(myPhoneE164()); return updateDoc(doc(db, "events", id), up); })().catch(e => console.warn("auto-join failed:", e.message));
  }
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  document.querySelectorAll("[data-rsvp]").forEach(b => b.onclick = () => attemptRsvp(ev, b.dataset.rsvp));
  document.querySelectorAll("[data-plus]").forEach(b => b.onclick = () => setPlus(ev, Number(b.dataset.plus)));
  document.querySelectorAll("[data-hype]").forEach(b => b.onclick = () => setHype(ev, b.dataset.hype));
  document.querySelectorAll("[data-approve]").forEach(b => b.onclick = () => hostSetRsvp(ev, b.dataset.approve, "going"));
  document.querySelectorAll("[data-promote]").forEach(b => b.onclick = () => hostSetRsvp(ev, b.dataset.promote, "going"));
  document.querySelectorAll("[data-removeguest]").forEach(b => b.onclick = () => removeGuest(ev, b.dataset.removeguest));
  document.querySelectorAll("[data-setrsvp]").forEach(b => b.onclick = e => { e.stopPropagation(); openSetRsvpDialog(ev, b.dataset.setrsvp); });
  document.querySelectorAll("[data-setphone]").forEach(b => b.onclick = e => { e.stopPropagation(); openSetRsvpDialog(ev, null, b.dataset.setphone); });
  if (el("saveAnswers")) el("saveAnswers").onclick = () => saveAnswers(ev);
  // Saves as they type (debounced) instead of waiting for blur: a name typed
  // here otherwise had a real chance of vanishing unsaved, since ANY change to
  // the event doc (anyone else's RSVP, a hype, another guest's own plus-one)
  // re-renders this whole page from scratch via the events listener -- wiping
  // whatever hadn't been blurred yet. A blur handler flushes immediately too.
  let plusNameTimer = null;
  document.querySelectorAll("[data-plusidx]").forEach(inp => {
    const save = () => {
      clearTimeout(plusNameTimer);
      const raw = (ev.plusNames || {})[myUid()]; const names = Array.isArray(raw) ? [...raw] : (raw ? [raw] : []);
      const idx = +inp.dataset.plusidx; while (names.length <= idx) names.push("");
      names[idx] = inp.value.trim();
      updateDoc(doc(db, "events", ev.id), { [`plusNames.${myUid()}`]: names }).catch(e => toast(e.message));
    };
    inp.oninput = () => { clearTimeout(plusNameTimer); plusNameTimer = setTimeout(save, 600); };
    inp.onblur = save;
  });
  if (el("viewAnswers")) el("viewAnswers").onclick = () => showAnswers(ev);
  if (el("nudgeBtn")) el("nudgeBtn").onclick = () => nudge(ev, el("nudgeBtn"), true);
  const share = $("[data-share]"); if (share) share.onclick = () => shareEvent(ev);
  if (el("addPeopleBtn")) el("addPeopleBtn").onclick = () => openEventInviteDialog(ev);
  document.querySelectorAll("[data-textinvite]").forEach(b => b.onclick = () => { location.href = smsLink([b.dataset.textinvite], eventInviteText({ ...ev, openLink: true })); });
  if (el("invToggle")) el("invToggle").onclick = () => { const c = el("invCard"); const open = !c.classList.contains("open"); c.classList.toggle("open", open); el("invToggle").setAttribute("aria-expanded", open); try { LS.set("friendlyInvOpen:" + ev.id, open ? "1" : "0"); } catch {} };
  if (el("guestToggle")) el("guestToggle").onclick = () => { const c = el("guestCard"); const open = !c.classList.contains("open"); c.classList.toggle("open", open); el("guestToggle").setAttribute("aria-expanded", open); try { LS.set("friendlyGuestOpen:" + ev.id, open ? "1" : "0"); } catch {} };
  document.querySelectorAll("[data-uninvitephone]").forEach(b => b.onclick = () => uninviteEventPhone(ev, b.dataset.uninvitephone));
  const join = $("[data-join]"); if (join) join.onclick = () => joinViaLink(ev, join);
  const cal = $("[data-cal]"); if (cal) cal.onclick = () => openCalendarDialog(ev);
  wireEvMoney(ev);
  const edit = $("[data-edit]"); if (edit) edit.onclick = () => editEvent(ev);
  const del = $("[data-del]"); if (del) del.onclick = () => delEvent(ev);
  wireWall(ev);
}

// ----- Polls -----
// ---------- TRIPS (a plan that spans days: day-by-day stops, Staying with rooms, rides, packing, one tab) ----------
// A trip is an event with kind "trip" and endDate. Stops carry a day; rooms are bring-list entries of kind "room"
// (claims are the people in the room); rides and the shared packing list are the Day-of card's carpool and bring list.
const tripDays = ev => { const out = []; let d = ev.date; for (let i = 0; i < 14 && d <= (ev.endDate || ev.date); i++) { out.push(d); d = addDays(d, 1); } return out; };
const dayShort = d => evDate({ date: d }).toLocaleDateString("en-US", { weekday: "short" });
const dayLong = d => evDate({ date: d }).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
function tripInner(ev) {
  const me = myUid(), manage = canManage(ev), days = tripDays(ev), t = todayStr();
  if (!S._tripDay || !days.includes(S._tripDay) && S._tripDay !== "all") S._tripDay = days.find(d => d >= t) || days[0];
  const sel = S._tripDay, all = cleanStops(ev.stops), stopsOf = d => sortStops(all.filter(x => (x.day || ev.date) === d));
  const dayBlock = d => { const st = stopsOf(d); return `<div class="trip-day"><div class="trip-day-h"><b>${esc(dayLong(d))}</b>${manage ? `<button type="button" class="btn-th ghost small" data-addstop="${d}">＋ Add a stop</button>` : ""}</div>
    ${st.length ? `<div class="stops">${st.map(x => `<div class="stop"><span class="t">${x.time ? esc(fmtTime(x.time)) : ""}</span><span><b>${esc(x.emoji || "")} ${esc(x.name || x.place)}</b>${x.name && x.place ? `<small><a href="${esc(stopMapUrl(x))}" target="_blank" rel="noopener">${esc(x.place)}</a></small>` : ""}${x.note ? `<small>${esc(x.note)}</small>` : ""}</span>${manage ? `<button type="button" class="wall-del" data-delstop="${esc(x.day || ev.date)}|${esc(x.name)}|${esc(x.time)}" title="Remove">✕</button>` : ""}</div>`).join("")}</div>` : `<p class="muted-th sm" style="margin:4px 0 0">Nothing planned yet${manage ? ". Add the first stop." : "."}</p>`}</div>`; };
  const stay = ev.stay || {}, rooms = typed("room");
  const xs = [...S.expenses.values()].filter(x => x.eventId === ev.id), total = xs.reduce((n, x) => n + (x.amountCents || 0), 0);
  const share = xs.reduce((n, x) => n + (x.shares ? (x.shares[me] || 0) : ((x.split || []).includes(me) ? Math.round(x.amountCents / x.split.length) : 0)), 0);
  const bal = pairwise().filter(p => p.from === me), owe = bal.reduce((n, p) => n + p.amount, 0);
  return `<div class="glass-head">The trip <span>${days.length} day${days.length === 1 ? "" : "s"}</span></div>
    <div class="chiprow trip-days">${days.map(d => `<button type="button" class="fchip ${sel === d ? "on" : ""}" data-tripday="${d}">${esc(dayShort(d))}${d === t ? " · today" : ""}</button>`).join("")}<button type="button" class="fchip ${sel === "all" ? "on" : ""}" data-tripday="all">Everything</button></div>
    ${(sel === "all" ? days : [sel]).map(dayBlock).join("")}
    <div class="day-sec" style="margin-top:14px"><div class="glass-sub">🏡 Staying ${manage ? `<button type="button" class="btn-th ghost small" id="editStay">${stay.name ? "Edit" : "＋ Add"}</button>` : ""}</div>
    ${stay.name ? `<div class="day-row"><span style="flex:1;min-width:0"><b>${esc(stay.name)}</b><div class="muted-th sm">${[stay.address, stay.checkIn ? "check-in " + esc(stay.checkIn) : "", stay.checkOut ? "check-out " + esc(stay.checkOut) : "", stay.code ? "code " + esc(stay.code) : ""].filter(Boolean).join(" · ")}</div>${stay.note ? `<div class="muted-th sm">${esc(stay.note)}</div>` : ""}</span>${stay.address ? `<a class="btn-th small" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stay.address)}" target="_blank" rel="noopener">Map</a>` : ""}</div>` : `<p class="muted-th sm" style="margin:2px 0 6px">${manage ? "Add where everyone's staying: address, check-in, the gate code." : "The host hasn't added the place yet."}</p>`}
    <div class="trip-rooms">${rooms.map(c => { const st = bringState(c), inRoom = st.who.includes(me); return `<div class="day-row"><span style="flex:1;min-width:0"><b>${esc(c.item)}</b>${c.qty ? ` <span class="muted-th sm">· sleeps ${esc(c.qty)}</span>` : ""}<div class="muted-th sm">${st.who.length ? `<span class="hd-faces">${st.who.slice(0, 5).map(u => avatar(u, "xs")).join("")}</span> ${st.who.map(u => esc(first(claimerName(c, u) || "A guest"))).join(", ")}` : "Nobody in here yet"}${st.hasTarget && !st.covered ? ` · ${st.remaining} spot${st.remaining === 1 ? "" : "s"} left` : ""}</div></span>
      ${inRoom ? `<button type="button" class="btn-th small accent" data-claim="${c.id}" title="Tap to leave">✓ You're in</button>` : st.covered ? `<span class="muted-th sm">Full</span>` : `<button type="button" class="btn-th small" data-claim="${c.id}">Take a spot</button>`}${manage ? `<button type="button" class="wall-del" data-delc="${c.id}" title="Remove">✕</button>` : ""}</div>`; }).join("")}
    ${manage ? `<button type="button" class="btn-th ghost small" id="addRoom" style="margin-top:6px">＋ Add a room</button>` : ""}</div></div>
    <div class="day-sec"><div class="glass-sub">🎒 Packing</div><p class="muted-th sm" style="margin:2px 0 8px">Shared things (cooler, speaker, firewood) go on the bring list below so people can claim them. Your own list stays on this phone.</p>
    <div class="trip-pack">${packList(ev).map((p, i) => `<label class="trip-pack-row"><input type="checkbox" data-pack="${i}" ${p.done ? "checked" : ""}><span class="${p.done ? "done" : ""}">${esc(p.t)}</span><button type="button" class="wall-del" data-packdel="${i}" title="Remove">✕</button></label>`).join("")}</div>
    <form class="trip-pack-add" id="packAdd"><input id="packText" maxlength="40" placeholder="Swimsuit, sunscreen, charger…" aria-label="Add to your packing list"><button type="submit" class="btn-th small">Add</button></form></div>
    <div class="day-sec"><div class="glass-sub">💸 Running tab <a class="btn-th ghost small" data-go="#/money">Money ›</a></div>
    <div class="trip-tab"><div><span class="muted-th sm">Trip total</span><b>${fmt$(total)}</b><span class="muted-th sm">${xs.length ? xs.slice(0, 3).map(x => esc(x.desc || "expense")).join(", ") + (xs.length > 3 ? ", and more" : "") : "nothing on it yet"}</span></div><div><span class="muted-th sm">Your share so far</span><b>${fmt$(share)}</b><span class="muted-th sm">${owe ? "you owe " + fmt$(owe) + " overall" : "you're square"}</span></div></div>
    <div class="btnrow" style="margin-top:10px"><button type="button" class="btn-th accent small" id="tripAddX">＋ Add expense</button><button type="button" class="btn-th small" id="tripScan">📷 Scan a receipt</button></div></div>`;
}
const packKey = ev => "friendlyPack:" + ev.id;
function packList(ev) { try { return JSON.parse(LS.get(packKey(ev)) || "[]"); } catch { return []; } }
function savePack(ev, list) { try { LS.set(packKey(ev), JSON.stringify(list.slice(0, 60))); } catch {} const tc = el("tripCard"); if (tc) { tc.innerHTML = tripInner(ev); wireTrip(ev); wireDay(ev); } }
function wireTrip(ev) {
  const me = myUid();
  document.querySelectorAll("[data-tripday]").forEach(b => b.onclick = () => { S._tripDay = b.dataset.tripday; const tc = el("tripCard"); if (tc) { tc.innerHTML = tripInner(ev); wireTrip(ev); wireDay(ev); } });
  document.querySelectorAll("[data-addstop]").forEach(b => b.onclick = () => dialog(`<h3>Add a stop</h3><p class="muted" style="margin-top:-6px">${esc(dayLong(b.dataset.addstop))}</p><label class="field"><span>What</span><input id="tsName" maxlength="60" placeholder="Check in at the cabin"></label><label class="field"><span>Where <span class="muted">(optional)</span></span><input id="tsPlace" maxlength="120" placeholder="1250 Lakeshore Dr"></label><div class="two"><label class="field"><span>Time</span><input id="tsTime" type="time"></label><label class="field"><span>Emoji</span><input id="tsEmoji" maxlength="4" value="📍"></label></div><label class="field"><span>Note <span class="muted">(optional)</span></span><input id="tsNote" maxlength="160" placeholder="Gate code in the Staying card"></label>`, "Add", async () => {
    const name = el("tsName").value.trim(); if (!name) return toast("Say what the stop is.");
    const stops = [...cleanStops(ev.stops), { day: b.dataset.addstop, name, place: el("tsPlace").value.trim(), time: el("tsTime").value || "", emoji: el("tsEmoji").value.trim() || "📍", note: el("tsNote").value.trim() }];
    try { await updateDoc(doc(db, "events", ev.id), { stops }); closeDialog(); } catch (e) { toast(e.message); }
  }));
  document.querySelectorAll("[data-delstop]").forEach(b => b.onclick = async () => { const [day, name, time] = b.dataset.delstop.split("|"); if (!confirm(`Remove “${name}”?`)) return;
    const stops = cleanStops(ev.stops).filter(x => !((x.day || ev.date) === day && x.name === name && (x.time || "") === time)); try { await updateDoc(doc(db, "events", ev.id), { stops }); } catch (e) { toast(e.message); } });
  if (el("editStay")) el("editStay").onclick = () => { const st = ev.stay || {}; dialog(`<h3>Where everyone's staying</h3><label class="field"><span>Place</span><input id="stName" maxlength="80" value="${esc(st.name || "")}" placeholder="Cedar Point Cabin"></label><label class="field"><span>Address</span><input id="stAddr" maxlength="160" value="${esc(st.address || "")}" placeholder="1250 Lakeshore Dr, Pottsboro"></label><div class="two"><label class="field"><span>Check-in</span><input id="stIn" maxlength="20" value="${esc(st.checkIn || "")}" placeholder="4 PM"></label><label class="field"><span>Check-out</span><input id="stOut" maxlength="20" value="${esc(st.checkOut || "")}" placeholder="11 AM"></label></div><div class="two"><label class="field"><span>Door or gate code</span><input id="stCode" maxlength="20" value="${esc(st.code || "")}"></label><label class="field"><span>Note</span><input id="stNote" maxlength="160" value="${esc(st.note || "")}" placeholder="Wifi: lakehouse / sunset24"></label></div>`, "Save", async () => {
    const name = el("stName").value.trim(); if (!name) return toast("Give the place a name.");
    try { await updateDoc(doc(db, "events", ev.id), { stay: { name, address: el("stAddr").value.trim(), checkIn: el("stIn").value.trim(), checkOut: el("stOut").value.trim(), code: el("stCode").value.trim(), note: el("stNote").value.trim() } }); closeDialog(); } catch (e) { toast(e.message); } }); };
  if (el("addRoom")) el("addRoom").onclick = () => dialog(`<h3>Add a room</h3><div class="two"><label class="field"><span>Room</span><input id="rmName" maxlength="40" placeholder="Lake room, Loft, Pullout"></label><label class="field"><span>Sleeps</span><input id="rmBeds" inputmode="numeric" value="2"></label></div><p class="muted sm">People take their own spot. Leave Sleeps blank for no limit.</p>`, "Add", async () => {
    const item = el("rmName").value.trim(); if (!item) return toast("Name the room."); const qty = el("rmBeds").value.trim();
    try { await addDoc(subCol(ev, "comments"), { kind: "room", item, qty: /^\d+$/.test(qty) ? qty : "", authorId: me, authorName: S.profile.name, text: "", createdAt: Date.now() }); closeDialog(); } catch (e) { toast(e.message); } });
  document.querySelectorAll("[data-pack]").forEach(cb => cb.onchange = () => { const l = packList(ev); if (l[+cb.dataset.pack]) l[+cb.dataset.pack].done = cb.checked; savePack(ev, l); });
  document.querySelectorAll("[data-packdel]").forEach(b => b.onclick = () => { const l = packList(ev); l.splice(+b.dataset.packdel, 1); savePack(ev, l); });
  if (el("packAdd")) el("packAdd").onsubmit = e => { e.preventDefault(); const t = el("packText").value.trim(); if (!t) return; savePack(ev, [...packList(ev), { t, done: false }]); const inp = el("packText"); if (inp) inp.focus(); };
  if (el("tripAddX")) el("tripAddX").onclick = () => openExpense(ev.id, null);
  if (el("tripScan")) el("tripScan").onclick = () => scanReceipt(ev.id, null, { desc: "", paidBy: me, people: [] }, ev.groupId);
}
// ---------- WHEN WORKS? (the host offers a few times; everyone taps the ones that work) ----------
// events/{id}.timePoll: { options: [{id, date, time}], votes: {uid: [optionIds]}, lockedId }
const twWhen = o => `${evDate({ date: o.date }).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}${o.time ? " · " + fmtTime(o.time) : ""}`;
function whenInner(ev) {
  const tp = ev.timePoll, me = myUid(), votes = tp.votes || {}, people = (ev.invitedUids || []), manage = canManage(ev);
  const count = id => Object.values(votes).filter(v => (v || []).includes(id)).length, voted = Object.keys(votes).length;
  const best = [...tp.options].sort((a, b) => count(b.id) - count(a.id))[0];
  if (tp.lockedId) { const o = tp.options.find(x => x.id === tp.lockedId); return `<div class="glass-head">When works?</div><p class="muted-th">Locked in: <b>${o ? esc(twWhen(o)) : "set"}</b>. ${voted} of ${people.length} answered.</p>`; }
  return `<div class="glass-head">When works? <span>${voted} of ${people.length} answered</span></div>
    ${tp.options.map(o => { const n = count(o.id), mine = (votes[me] || []).includes(o.id); return `<button type="button" class="ww-opt ${o.id === best.id && n ? "best" : ""} ${mine ? "mine" : ""}" data-tw="${esc(o.id)}"><span class="ww-tick">${mine ? "✓" : ""}</span><span class="ww-mid"><b>${esc(twWhen(o))}</b><span class="ww-bar"><i style="width:${people.length ? n / people.length * 100 : 0}%"></i></span><small>${n} of ${people.length} can make it${o.id === best.id && n ? " · best so far" : ""}</small></span></button>`; }).join("")}
    <div class="ww-foot"><span class="muted-th">Tap the times that work for you.</span>${manage && best && count(best.id) ? `<button type="button" class="btn-th accent small" id="lockWhen" data-lock="${esc(best.id)}">Lock in ${esc(twWhen(best).split(" · ")[0])}</button>` : ""}</div>`;
}
function openWhenDialog(ev) {
  const row = i => `<div class="two"><label class="field"><span>Option ${i + 1}</span><input type="date" class="tw-d" min="${todayStr()}"></label><label class="field"><span>Time</span><input type="time" class="tw-t"></label></div>`;
  dialog(`<h3>When works?</h3><p class="muted" style="margin-top:-6px">Offer a few times. Everyone taps the ones they can make, and you lock in the winner.</p>${[0, 1, 2, 3].map(row).join("")}`, "Ask everyone", async () => {
    const ds = [...document.querySelectorAll(".tw-d")], ts = [...document.querySelectorAll(".tw-t")];
    const options = ds.map((d, i) => d.value ? { id: "o" + i + Math.random().toString(36).slice(2, 6), date: d.value, time: ts[i].value || "" } : null).filter(Boolean);
    if (options.length < 2) return toast("Give people at least two options.");
    try { await updateDoc(doc(db, "events", ev.id), { timePoll: { options, votes: {}, lockedId: "" } }); closeDialog(); toast("Asked. You'll see the answers come in.", null, null, "happy"); } catch (e) { toast(e.message); }
  });
}
function wireWhen(ev) {
  if (el("addWhen")) el("addWhen").onclick = () => openWhenDialog(ev);
  document.querySelectorAll("[data-tw]").forEach(b => b.onclick = async () => { const me = myUid(), cur = ((ev.timePoll || {}).votes || {})[me] || [], id = b.dataset.tw, next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    try { await updateDoc(doc(db, "events", ev.id), { [`timePoll.votes.${me}`]: next }); } catch (e) { toast(e.message); } });
  if (el("lockWhen")) el("lockWhen").onclick = async () => { const o = (ev.timePoll.options || []).find(x => x.id === el("lockWhen").dataset.lock); if (!o) return; if (!confirm(`Lock in ${twWhen(o)}? Everyone invited hears the new time.`)) return;
    try { await updateDoc(doc(db, "events", ev.id), { date: o.date, time: o.time || ev.time || "", updatedBy: myUid(), "timePoll.lockedId": o.id }); toast("Locked in. Everyone's been told.", null, null, "coral:party"); } catch (e) { toast(e.message); } };
}
function pollsInner(ev, hint = "Add a poll to help decide: food, time, theme.") {
  const me = myUid(); const manage = canManage(ev);
  const list = S.polls.map(p => {
    const total = Object.keys(p.votes || {}).length || 0;
    const mine = (p.votes || {})[me];
    return `<div class="poll"><div class="poll-q">${esc(p.q)}</div>${(p.options || []).map((o, i) => {
      const n = Object.values(p.votes || {}).filter(v => v === i).length;
      const pct = total ? Math.round(n / total * 100) : 0;
      return `<div class="poll-opt ${mine === i ? "mine" : ""}" data-vote="${p.id}|${i}"><div class="poll-bar" style="transform:scaleX(${total ? n / total : 0})"></div><div class="poll-opt-in"><span>${esc(o)}</span><span>${pct}%</span></div></div>`;
    }).join("")}<div class="muted-th sm" style="margin-top:4px">${total} vote${total === 1 ? "" : "s"}${manage || p.authorId === me ? ` · <a data-delpoll="${p.id}">remove</a>` : ""}${planBtn(ev, p)}</div></div>`;
  }).join("");
  // Group polls: any member can add one (the rules allow it); removing someone else's is host-only.
  const canAdd = manage || (ev._col && ev._col[0] === "groups");
  return `<div class="glass-head">Polls${canAdd ? ` <a class="btn-th ghost small" id="addPoll">＋ Add</a>${manage && !ev.timePoll ? ` <a class="btn-th ghost small" id="addWhen">🗓 When works?</a>` : ""}` : `<span>${S.polls.length}</span>`}</div><div class="scroll-cap">${list || `<p class="muted-th">${manage ? esc(hint) : "No polls yet."}</p>`}</div>`;
}
// Group date polls: the leading dated option can become an event in one tap.
function planBtn(ev, p) {
  if (!(ev._col && ev._col[0] === "groups") || !p.dates) return "";
  const counts = {}; Object.values(p.votes || {}).forEach(i => counts[i] = (counts[i] || 0) + 1);
  const lead = Object.keys(p.dates).sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0]; if (lead == null) return "";
  return ` · <a data-plan="${esc(p.dates[lead])}|${esc(p.q)}">📅 Plan it for ${esc(p.options[lead])}</a>`;
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
    </div><button type="button" class="btn ghost small" id="pAddDate" style="margin:-4px 0 8px;padding-left:0">＋ Add a date as an option</button>`,
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
  const tiles = ps.map(p => `<div class="photo-tile"><img src="${esc(p.img)}" data-photo="${p.id}" alt="" loading="lazy">${photoBadges(p)}${p.addedBy === myUid() || isAdmin() ? `<button class="photo-act" data-delphoto="${p.id}" title="Remove">✕</button>` : `<button class="photo-act" data-more="photo|${p.id}" title="Report">⚑</button>`}</div>`).join("");
  return `<div class="glass-head">Photos <span>${ps.length}</span></div><div class="photo-grid"><button class="photo-add" id="addPhoto">＋</button>${tiles || ""}</div>${ps.length ? "" : `<p class="muted-th" style="margin-top:8px">Share pics from the night.</p>`}`;
}
function wirePhotos(ev) {
  if (el("addPhoto")) el("addPhoto").onclick = async () => {
    const f = await pickFile("image/*", "event photo"); if (!f) return; toast("Uploading photo…");
    let ref;
    try { const img = await compressImage(f, 1400, 0.8); ref = await addDoc(collection(db, "events", ev.id, "photos"), { img, addedBy: myUid(), createdAt: Date.now() }); }
    catch (e) { return toast("Couldn't add photo: " + e.message); }
    uploadOriginal(ev.id, ref.id, f);
  };
  document.querySelectorAll("[data-photo]").forEach(im => im.onclick = () => { const p = S.photos.find(x => x.id === im.dataset.photo); if (p) openPhoto(ev, p); });
  document.querySelectorAll("[data-delphoto]").forEach(b => b.onclick = () => { if (confirm("Remove this photo?")) deleteDoc(doc(subCol(ev, "photos"), b.dataset.delphoto)).catch(e => toast(e.message)); });
  document.querySelectorAll("#photosCard [data-more]").forEach(b => b.onclick = () => { const [kind, id] = b.dataset.more.split("|"); moderationMenu(ev, kind, id); });
}
async function setRsvp(ev, status) {
  const me = myUid();
  if (status === "going" && ev.approval && ev.hostId !== me && !(ev.cohostUids || []).includes(me)) status = "pending";
  else if (status === "going" && isFull(ev) && (ev.rsvps || {})[me] !== "going") status = "waitlist";
  try {
    await updateDoc(doc(db, "events", ev.id), { [`rsvps.${me}`]: status });
    if (status === "going") toast("You're going to " + ev.title + "!", null, null, "party");
    else if (status === "waitlist") toast("You're on the waitlist. We'll tell you if a spot opens.", null, null, "idle");
    else if (status === "pending") toast("Sent to the host to approve.", null, null, "idle");
  }
  catch (e) { toast("Couldn't RSVP: " + e.message); }
}
// Going/Maybe with unanswered host questions saves the answers first (as their
// own write -- the security rules don't allow rsvps and answers to change in the
// same update) and only then sets the RSVP; declining skips the questions.
async function attemptRsvp(ev, status) {
  if (status !== "no" && (ev.questions || []).length) {
    const inputs = [...document.querySelectorAll("[data-answer]")];
    const empty = inputs.filter(i => !i.value.trim());
    if (empty.length) {
      toast("Answer the host's questions first.");
      empty[0].focus(); const box = el("qAnswers"); if (box) box.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const a = {}; inputs.forEach(i => a[i.dataset.answer] = i.value.trim());
    try { await updateDoc(doc(db, "events", ev.id), { [`answers.${myUid()}`]: a }); }
    catch (e) { return toast(e.message); }
  }
  setRsvp(ev, status);
}
async function setPlus(ev, delta) {
  const me = myUid(); const cur = ((ev.plusOnes || {})[me]) || 0; let n = Math.max(0, cur + delta);
  if (delta > 0 && !plusAllowed(ev)) return;
  if (ev.plusMax && n > ev.plusMax) { n = ev.plusMax; toast(`The host allows up to ${ev.plusMax} guest${ev.plusMax === 1 ? "" : "s"} each.`); if (n === cur) return; }
  // Two separate writes: firestore.rules' onlyOwn() only allows a non-host guest
  // to touch ONE top-level field per update, so plusOnes and plusNames can't be
  // combined into a single updateDoc call without getting rejected for guests.
  try {
    await updateDoc(doc(db, "events", ev.id), { [`plusOnes.${me}`]: n });
    if (delta < 0) {
      const raw = (ev.plusNames || {})[me]; const names = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      if (names.length > n) await updateDoc(doc(db, "events", ev.id), { [`plusNames.${me}`]: names.slice(0, n) });
    }
  } catch (e) { toast(e.message); }
}
async function setHype(ev, emoji) {
  const me = myUid(); const cur = (ev.hypes || {})[me]; const next = cur === emoji ? null : emoji;
  try { await updateDoc(doc(db, "events", ev.id), { [`hypes.${me}`]: next }); } catch (e) { toast(e.message); }
}
// Host/co-host takes someone off the guest list: drops their invite and
// everything keyed to them (RSVP, plus-ones, answers, hype, name).
// Hosts and co-hosts can answer for a guest (they said yes by text, at work, in person). rsvpSetBy records who
// and when, so the guest is told "Wes marked you as going" and the host isn't notified about their own change.
function openSetRsvpDialog(ev, uid, phone) {
  const meeting = ev.kind === "meeting";
  const cur = phone ? phoneStatus(ev, phone) : ((ev.rsvps || {})[uid] || ""), nm = phone ? (first((ev.invitedPhoneNames || {})[phone] || "") || phone) : first(nameOf(uid));
  const opts = meeting ? [["going", "✓ Accepted"], ["maybe", "Maybe"], ["no", "Declined"], ["", "No answer"]] : [["going", "✓ Going"], ["maybe", "Maybe"], ["no", "Can't go"], ["", "No answer"]];
  dialog(`<h3>Mark ${esc(nm)}'s RSVP</h3><p class="muted" style="margin-top:-6px">${phone ? `Use this when ${esc(nm)} told you in person or by text. When they join Friendly, their answer comes with them and they can change it.` : `Use this when ${esc(nm)} told you in person or by text. They'll get a note that you marked it, and they can change it anytime.`}</p>
    <div class="stack set-rsvp">${opts.map(([v, l]) => `<button type="button" class="btn ${cur === v ? "primary" : ""}" data-pick="${v}">${l}${cur === v ? " · current" : ""}</button>`).join("")}</div>
    ${plusAllowed(ev) || (phone ? phonePlus(ev, phone) : ((ev.plusOnes || {})[uid] || 0)) ? `<div class="plus host-plus"><span>${esc(nm)} is bringing</span><button type="button" data-hplus="-1">−</button><b id="hPlusN">+${phone ? phonePlus(ev, phone) : ((ev.plusOnes || {})[uid] || 0)}</b><button type="button" data-hplus="1">＋</button></div>
    <p class="muted sm" style="margin:4px 0 0">You can add +1s for them${ev.plusMax ? `, past the ${ev.plusMax}-guest limit if you need to` : ""}. Saves right away.</p>` : ""}`, null, null);
  // Hosts set a guest's +1s directly (texted guests keep theirs with their answer and bring them along when they join).
  let plusN = phone ? phonePlus(ev, phone) : ((ev.plusOnes || {})[uid] || 0);
  document.querySelectorAll("[data-hplus]").forEach(b => b.onclick = async () => {
    const n = Math.max(0, plusN + Number(b.dataset.hplus)); if (n === plusN) return;
    const prev = plusN; plusN = n; el("hPlusN").textContent = "+" + n;
    const entry = (ev.phoneRsvps || {})[phone];
    const up = phone ? (entry ? { [`phoneRsvps.${phone}.plus`]: n } : { [`phoneRsvps.${phone}`]: { status: "going", by: myUid(), at: Date.now(), plus: n } })
      : { [`plusOnes.${uid}`]: n };
    try { await updateDoc(doc(db, "events", ev.id), up); if (phone && !entry) toast(`${nm} is marked going with +${n}.`, null, null, "happy"); }
    catch (e) { plusN = prev; if (el("hPlusN")) el("hPlusN").textContent = "+" + prev; toast(e.message); }
  });
  document.querySelectorAll(".set-rsvp [data-pick]").forEach(b => b.onclick = async () => {
    const v = b.dataset.pick; closeDialog();
    if (v === (cur || "")) return;
    const up = phone ? { [`phoneRsvps.${phone}`]: v ? { status: v, by: myUid(), at: Date.now() } : deleteField() }
      : v ? { [`rsvps.${uid}`]: v, [`rsvpSetBy.${uid}`]: { by: myUid(), at: Date.now() } } : { [`rsvps.${uid}`]: deleteField(), [`rsvpSetBy.${uid}`]: deleteField() };
    try { await updateDoc(doc(db, "events", ev.id), up); toast(v ? `${nm} is marked ${{ going: meeting ? "accepted" : "going", maybe: "maybe", no: meeting ? "declined" : "can't go" }[v]}.` : `${nm}'s answer is cleared.`, null, null, "happy"); }
    catch (e) { toast(e.message); }
  });
}
async function removeGuest(ev, uid) {
  if (!confirm(`Remove ${first(nameOf(uid))} from the guest list?`)) return;
  const up = { invitedUids: arrayRemove(uid), cohostUids: arrayRemove(uid) };
  for (const k of ["rsvps", "plusOnes", "plusNames", "hypes", "answers", "names"]) up[`${k}.${uid}`] = deleteField();
  try { await updateDoc(doc(db, "events", ev.id), up); toast(first(nameOf(uid)) + " removed"); } catch (e) { toast(e.message); }
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
const REPORT_REASONS = ["Spam", "Harassment or bullying", "Hate or violence", "Nudity or sexual content", "Child safety concern", "Something else"];
// Hide anything I reported and everything from people I blocked.
const visibleContent = item => !(S.profile.blockedUids || []).includes(item.authorId || item.addedBy) && !(S.profile.hiddenIds || []).includes(item.id);
// "⋯" on someone else's message or photo: report it, or block the person outright.
function moderationMenu(ev, kind, id) {
  const item = (kind === "photo" ? S.photos : S.comments).find(x => x.id === id); if (!item) return;
  const who = item.authorId || item.addedBy; const name = first(nameOf(who));
  dialog(`<h3>${kind === "photo" ? "This photo" : "This message"}</h3>
    <div class="stack"><button type="button" class="btn" id="modReport">⚑ Report ${kind === "photo" ? "this photo" : "this message"}</button>
    <button type="button" class="btn danger-ghost" id="modBlock">🚫 Block ${esc(name)}</button></div>
    <p class="muted sm" style="margin:10px 0 0">Reports go to the Friendly team within 24 hours. Blocking hides everything ${esc(name)} posts from you, instantly, and tells us.</p>`, null, null);
  el("modReport").onclick = () => { closeDialog(); reportContent(ev, kind, id); };
  el("modBlock").onclick = () => blockUser(who, ev, kind, id);
}
async function blockUser(who, ev, kind, id) {
  const name = first(nameOf(who));
  if (!confirm(`Block ${name}? You won't see anything they post, and we'll be notified.`)) return;
  try {
    const path = ev ? doc(subCol(ev, kind === "photo" ? "photos" : "comments"), id).path : "";
    await addDoc(collection(db, "reports"), { reporterId: myUid(), reporterName: S.profile.name, targetUid: who, kind: kind || "user", path, snippet: "(user blocked)", reason: "Blocked user", status: "open", createdAt: Date.now() });
    await updateDoc(doc(db, "users", myUid()), { blockedUids: arrayUnion(who) });
    closeDialog(); toast(name + " is blocked");
  } catch (e) { toast(e.message); }
}
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
// The text a texted invitee gets. It comes from the host's own number via Messages;
// the link lets anyone -- Friendly member or not -- open the event and join.
const eventInviteText = ev => { const when = fmtWhen(ev) + (ev.location ? " at " + ev.location : ""); return `You're invited! ${ev.emoji || "🎉"} ${ev.title}, ${when}. RSVP here: ${eventUrl(ev)}`; };
// Add people to an existing event or meeting the same way people are added to
// groups: known Friendly contacts go straight onto the guest list; everyone
// else gets tracked in invitedPhones/invitedPhoneNames (for the "Invited" list
// and a resend button) and texted the join link. The event's own unguessable
// id is what actually lets them in (openLink+selfJoin), so this list is for
// the host's tracking, not a security check.
function openEventInviteDialog(ev) {
  pickPeopleDialog({
    title: "Add people",
    blurb: "Pick them from your contacts. Friends already on Friendly are added on the spot; everyone else gets a text from you with a join link.",
    exclude: new Set(ev.invitedUids || []),
    excludeKeys: new Map(Object.entries(ev.phoneKeys || {}).filter(([u]) => (ev.invitedUids || []).includes(u)).map(([u, k]) => [k, (ev.names || {})[u] || nameOf(u)])),
    pendingPhones: new Map((ev.invitedPhones || []).map(p => [p, (ev.invitedPhoneNames || {})[p] || ""])),
    onSubmit: async (direct, texted) => {
      const updates = {};
      if (direct.length) {
        updates.invitedUids = [...new Set([...(ev.invitedUids || []), ...direct.map(p => p.uid)])];
        updates.names = { ...(ev.names || {}) };
        for (const p of direct) updates.names[p.uid] = nameOf(p.uid) !== "Someone" ? nameOf(p.uid) : (p.name || "Friend");
      }
      const addP = texted.map(p => p.e164).filter(n => !(ev.invitedPhones || []).includes(n)); if (addP.length) updates.invitedPhones = [...(ev.invitedPhones || []), ...addP];
      for (const p of texted) if (p.e164) updates[`invitedPhoneNames.${p.e164}`] = p.name || "";
      if (texted.length && !ev.openLink) updates.openLink = true;
      try {
        if (Object.keys(updates).length) await updateDoc(doc(db, "events", ev.id), updates);
        closeDialog(); toast(direct.length ? direct.length + " added" + (texted.length ? ", texting the rest" : "") : texted.length ? "Opening Messages…" : "Invites sent", null, null, "happy");
        const text = eventInviteText({ ...ev, openLink: true });
        if (texted.length === 1) setTimeout(() => { location.href = smsLink([texted[0].e164], text); }, 400);
        else if (texted.length > 1) setTimeout(() => openTextInviteDialog(texted, text), 400);
      } catch (e) { toast(e.message); }
    }
  });
}
async function uninviteEventPhone(ev, e164) { try { await updateDoc(doc(db, "events", ev.id), { invitedPhones: (ev.invitedPhones || []).filter(p => p !== e164), [`invitedPhoneNames.${e164}`]: deleteField() }); } catch (e) { toast(e.message); } }
async function joinViaLink(ev, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Joining…"; }
  // joinedVia marks a link join so the host gets a "joined via your link" heads-up
  // (group members added automatically don't set it).
  const patch = { invitedUids: arrayUnion(myUid()), [`names.${myUid()}`]: S.profile.name, [`joinedVia.${myUid()}`]: "link" };
  if (myPhoneE164()) patch[`phoneKeys.${myUid()}`] = await phoneKey(myPhoneE164());
  // selfJoin() in firestore.rules lets a joiner also clear their own entry from
  // the host's invitedPhones tracking list, but only their own -- never anyone else's.
  const myPhone = myPhoneE164();
  if (myPhone && (ev.invitedPhones || []).includes(myPhone)) { patch.invitedPhones = arrayRemove(myPhone); patch[`invitedPhoneNames.${myPhone}`] = deleteField(); }
  try {
    await updateDoc(doc(db, "events", ev.id), patch);
    // A host already marked this number (they told the host by text or in person): bring that answer along.
    const pre = myPhone && (ev.phoneRsvps || {})[myPhone];
    if (pre && pre.status) { await updateDoc(doc(db, "events", ev.id), { [`rsvps.${myUid()}`]: pre.status }).catch(() => {}); if (Number(pre.plus) > 0) await updateDoc(doc(db, "events", ev.id), { [`plusOnes.${myUid()}`]: Number(pre.plus) }).catch(() => {}); toast(`You're in, marked ${{ going: "going", maybe: "maybe", no: "can't go" }[pre.status] || pre.status}. Change it below anytime.`); }
    else toast("You're on the list! RSVP below.");
  }
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
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Friendly//EN", "BEGIN:VEVENT", "UID:" + ev.id + "@officialfriendly.com", "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z", dts, dte, "SUMMARY:" + esc2(ev.emoji + " " + ev.title), ev.location ? "LOCATION:" + esc2(ev.location) : "", "DESCRIPTION:" + esc2((stopsText(ev) ? "The plan:\n" + stopsText(ev) + "\n\n" : "") + (ev.notes || "") + "\nRSVP: " + location.origin + location.pathname + "#/e/" + ev.id), "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
  const a = document.createElement("a"); a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics); a.download = ev.title.replace(/[^a-z0-9]+/gi, "-") + ".ics"; a.click();
}
async function delEvent(ev) { if (isDemo() && DEMO_EVENTS.includes(ev.id)) return toast("Deleting this demo event is off -- it resets nightly instead."); if (!confirm(`Delete “${ev.title}”?`)) return; try { await deleteDoc(doc(db, "events", ev.id)); go("#/"); toast("Event deleted"); } catch (e) { toast(e.message); } }
function editEvent(ev) {
  const E = { stops: evStops(ev).map(x => ({ ...x })), time: ev.time || "", where: ev.location || "", emoji: ev.emoji || "📍", kind: ev.kind || "event" };
  const ectx = { h: E, card: "eStopsCard", head: "eStopsHead", time: "eTime", where: "eWhere", hide: "estops-hide", save: () => {}, before: null };
  const many = E.stops.length >= 2;
  dialog(`<h3>Edit event</h3>
    <label class="field"><span>Title</span><input id="eTitle" value="${esc(ev.title)}"></label>
    <div class="two"><label class="field"><span>Date</span><input id="eDate" type="date" value="${ev.date}"></label>
    <label class="field estops-hide ${many ? "hidden" : ""}"><span>Start</span><input id="eTime" type="time" value="${ev.time || ""}"></label></div>
    <label class="field estops-hide ${many ? "hidden" : ""}"><span>Where</span><input id="eWhere" value="${esc(ev.location || "")}"></label>
    <span class="field-label" style="display:flex;justify-content:space-between;margin-top:6px">${ev.kind === "meeting" ? "Agenda" : "The plan"} <small class="muted" id="eStopsHead">${stopsHead(ectx)}</small></span><div class="stops-card in-dialog" id="eStopsCard">${stopsEditor(ectx)}</div>
    ${ev.kind === "meeting" ? "" : `<label class="field estops-hide ${many ? "hidden" : ""}"><span>Food &amp; drinks</span><input id="eFood" maxlength="120" value="${esc(ev.food || "")}" placeholder="Tacos and margs · BYOB"></label>`}
    ${repeatFields("e", ev)}
    <label class="field"><span>Details</span><textarea id="eNotes">${esc(ev.notes || "")}</textarea></label>
    ${plusFields("e", plusAllowed(ev), ev.plusMax)}
    ${ev.kind === "meeting" ? "" : `<label class="switch" style="margin-top:8px"><input type="checkbox" id="eBringOn" ${ev.dayBring === false ? "" : "checked"}><span>🧺 Bring list on Day of</span></label><label class="switch"><input type="checkbox" id="eCarOn" ${ev.dayCarpool === false ? "" : "checked"}><span>🚗 Carpool on Day of</span></label>`}
    <span class="field-label" style="margin-top:10px">Co-hosts (can edit &amp; manage)</span><div class="check-grid">${contactChecks("ecoh", new Set(ev.cohostUids || []))}</div>`,
    "Save", async () => {
      const cohostUids = [...document.querySelectorAll("input[name=ecoh]:checked")].map(i => i.value).filter(u => u !== ev.hostId);
      try { await updateDoc(doc(db, "events", ev.id), { cohostUids, ...(cohostUids.length ? { invitedUids: arrayUnion(...cohostUids) } : {}), updatedBy: myUid(), title: el("eTitle").value.trim(), date: el("eDate").value, ...(() => { const st = sortStops(cleanStops(E.stops)); return st.length >= 2 ? { stops: st, time: (st.find(x => x.time) || {}).time || el("eTime").value, location: st[0].place || el("eWhere").value.trim(), food: "" } : { stops: [], time: el("eTime").value, location: el("eWhere").value.trim() }; })(), ...(el("eFood") && cleanStops(E.stops).length < 2 ? { food: el("eFood").value.trim() } : {}), notes: el("eNotes").value.trim(), allowPlus: el("ePlusOn").checked, plusMax: plusMaxVal("e"), ...(el("eBringOn") ? { dayBring: el("eBringOn").checked, dayCarpool: el("eCarOn").checked } : {}), ...readRepeat("e") }); closeDialog(); toast("Saved"); } catch (e) { toast(e.message); }
    });
  attachPlaces(el("eWhere"));
  stopCtx = ectx; wireStops(); wireRepeat("e"); wirePlusFields("e");
}

// ---------- MONEY ----------
// Everyone who owes on an expense has paid (the payer doesn't owe themselves).
const allPaidBack = x => { const owe = (x.split || []).filter(u => u !== x.paidBy && (!x.shares || x.shares[u] > 0)); return owe.length > 0 && owe.every(u => (x.paid || {})[u]); };
// Everyone on a shared receipt has tapped I'm done (the creator finishes it, so they don't count).
const allPicked = t => { const others = (t.uids || []).filter(u => u !== t.createdBy); return others.length > 0 && others.every(u => (t.done || {})[u]); };
function pairwise() {
  // owes[d][c]: what d owes c; why[d][c]: the expenses (and paybacks) behind it, for the settle-up rows.
  const owes = {}, why = {};
  const add = (d, c, cents, label, paid) => { if (d === c || !cents) return; (owes[d] = owes[d] || {})[c] = (owes[d][c] || 0) + cents; ((why[d] = why[d] || {})[c] = why[d][c] || []).push({ label, cents, paid: !!paid }); };
  for (const x of S.expenses.values()) {
    // Itemized expenses carry exact per-person amounts; otherwise split evenly.
    if (x.shares) { for (const [u, c] of Object.entries(x.shares)) if (knownPerson(u)) add(u, x.paidBy, c, x.desc || "Expense", (x.paid || {})[u]); continue; }
    const split = (x.split || []).filter(knownPerson); if (!split.length) continue;
    const base = Math.floor(x.amountCents / split.length); let rem = x.amountCents - base * split.length;
    for (const u of split) add(u, x.paidBy, base + (rem-- > 0 ? 1 : 0), x.desc || "Expense", (x.paid || {})[u]);
  }
  for (const s of S.settlements.values()) add(s.to, s.from, s.amountCents, "Paid back");
  const pairs = []; const seen = new Set();
  for (const a in owes) for (const b in owes[a]) { const k = a < b ? a + b : b + a; if (seen.has(k)) continue; seen.add(k); const net = (owes[a]?.[b] || 0) - (owes[b]?.[a] || 0);
    const parts = (f, t) => [...((why[f] || {})[t] || []).map(x => ({ ...x, sign: 1 })), ...((why[t] || {})[f] || []).map(x => ({ ...x, sign: -1 }))];
    if (net > 0) pairs.push({ from: a, to: b, amount: net, parts: parts(a, b) }); else if (net < 0) pairs.push({ from: b, to: a, amount: -net, parts: parts(b, a) }); }
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
  <div class="section-head"><h2>Money</h2><span class="btnrow" style="gap:6px"><button class="btn small" id="addPitch">🎁 Pitch in</button><button class="btn primary small" id="addExpense">＋ Expense</button></span></div>
  <div class="tiles"><div class="card tile owe"><span class="muted sm">You owe</span><div class="amt">${fmt$(iOwe)}</div></div>
    <div class="card tile owed"><span class="muted sm">Owed to you</span><div class="amt">${fmt$(owed)}</div></div></div>
  ${pickCards()}${pitchCards()}
  ${!mine.length && rows.length ? `<div class="card empty compact">${dot("party", 72)}<b>All squared up</b><p class="muted">Nobody owes anybody. Nice.</p></div>` : ""}
  ${mine.length ? `<div class="section-head"><h2>Settle up</h2>${pairs.length > 1 ? `<button class="btn small ${S.simplePay ? "primary" : ""}" id="simplePay" title="Combine debts into the fewest payments">${S.simplePay ? "✓ Fewest payments" : "Fewest payments"}</button>` : ""}</div><div class="stack" id="settleCard">${mine.map(p => {
    const other = payInfoOf(p.from === me ? p.to : p.from);
    let pay = "";
    if (p.from === me) pay = payBtns(p.to, p.amount);
    else if (other.venmo) pay = `<button class="btn small venmo" data-request="${p.from}" data-amt="${p.amount}">Request</button>`;
    else if (isGuest(p.from)) pay = `<button class="btn small" data-text="${p.from}|${p.amount}|owed">💬 Text a reminder</button>`;
    return `<div class="card settle-row" data-pair="${esc(p.from + "|" + p.to)}"><div class="settle-top">${avatar(p.from)}<div style="flex:1"><b>${p.from === me ? "You owe " + esc(nameOf(p.to)) : esc(nameOf(p.from)) + " owes you"}</b>${settleWhy(p, me)}</div><span class="amt sm">${fmt$(p.amount)}</span></div><div class="settle-actions">${pay}<button class="btn small" data-record="${p.from}|${p.to}|${p.amount}">${p.from === me ? "Mark as paid" : "Mark as received"}</button></div></div>`;
  }).join("")}</div>` : ""}
  <div class="section-head"><h2>Activity</h2></div>
  <div class="card">${rows.length ? rows.map(r => {
    if (r.kind === "s") return `<div class="ledger" data-srow="${esc(r.id)}"><div class="li pay">⤴</div><div style="flex:1;min-width:0"><b>${esc(nameOf(r.from))} paid ${esc(nameOf(r.to))}</b><div class="muted sm">${r.note ? esc(r.note) + " · " : ""}${new Date(r.createdAt).toLocaleDateString()}</div>${payReacts(r, false)}</div><span class="amt sm">${fmt$(r.amountCents)}</span>${r.addedBy === me ? `<button class="btn ghost small" data-dels="${r.id}">✕</button>` : ""}</div>`;
    const n = (r.split || []).length || 1;
    if (r.kind === "e" && r.pitch) return `<div class="ledger" data-xrow="${r.id}"><div class="li">🎁</div><div style="flex:1"><b>${esc(r.desc)}</b><div class="muted sm">${esc(first(nameOf(r.paidBy)))} is collecting · ${fmt$(r.pitch.each)} each · ${pitchPaid(r).length} of ${(r.split || []).filter(u => u !== r.paidBy).length} in · ${new Date(r.createdAt).toLocaleDateString()}</div></div><span class="amt sm">${fmt$(pitchTotal(r))}</span><button class="btn ghost small" data-xopen="${r.id}">Open</button></div>`;
    return `<div class="ledger" data-xrow="${r.id}"><div class="li">🧾</div><div style="flex:1"><b>${esc(r.desc)}</b><div class="muted sm">${esc(nameOf(r.paidBy))} paid · ${r.shares ? "itemized, " + n + " people" : `split ${n} way${n > 1 ? "s" : ""}`} · ${new Date(r.createdAt).toLocaleDateString()}</div></div><span class="amt sm">${fmt$(r.amountCents)}</span><button class="btn ghost small" data-xopen="${r.id}" title="Details & discussion">💬</button>${r.addedBy === me ? `<button class="btn ghost small" data-dele="${r.id}" title="Delete" style="margin-left:6px">✕</button>` : ""}</div>`;
  }).join("") : emptyState("💸", "No shared costs yet", "Add an expense after your next hangout.", "happy")}</div>`;
}
function wireMoney() {
  el("addExpense").onclick = () => openExpense(null, null);
  if (el("addPitch")) el("addPitch").onclick = () => openPitchIn();
  wirePitch();
  if (el("simplePay")) el("simplePay").onclick = () => { S.simplePay = !S.simplePay; render(); };
  document.querySelectorAll("[data-xopen]").forEach(b => b.onclick = () => go("#/x/" + b.dataset.xopen));
  document.querySelectorAll("[data-xrow]").forEach(d => d.onclick = e => { if (e.target.closest("button,a")) return; go("#/x/" + d.dataset.xrow); });
  document.querySelectorAll("[data-venmo]").forEach(b => b.onclick = () => payVenmo(b.dataset.venmo, +b.dataset.amt, "pay"));
  document.querySelectorAll("[data-request]").forEach(b => b.onclick = () => payVenmo(b.dataset.request, +b.dataset.amt, "charge"));
  document.querySelectorAll("[data-apple]").forEach(b => b.onclick = () => payApple(b.dataset.apple, +b.dataset.amt));
  document.querySelectorAll("[data-cashapp]").forEach(b => b.onclick = () => payCashApp(b.dataset.cashapp, +b.dataset.amt));
  document.querySelectorAll("[data-zelle]").forEach(b => b.onclick = () => payZelle(b.dataset.zelle, +b.dataset.amt));
  document.querySelectorAll("[data-record]").forEach(b => b.onclick = () => { const [f, t, a] = b.dataset.record.split("|"); openSettle(f, t, +a); });
  document.querySelectorAll("[data-text]").forEach(b => b.onclick = () => { const [id, a, dir] = b.dataset.text.split("|"); textGuest(id, +a, dir); });
  document.querySelectorAll("[data-dele]").forEach(b => b.onclick = () => deleteWithUndo("expenses", b.dataset.dele, S.expenses.get(b.dataset.dele), "expense"));
  document.querySelectorAll("[data-dels]").forEach(b => b.onclick = () => deleteWithUndo("settlements", b.dataset.dels, (S.settlements || new Map()).get(b.dataset.dels), "payment"));
}
// Deleting from the ledger asks first and can be undone for a few seconds: the ✕ sits right beside the details
// button, and one tap there used to erase an expense for everyone with no way back.
async function deleteWithUndo(col, id, data, what) {
  const label = data && (data.desc || data.note) ? ` "${String(data.desc || data.note).slice(0, 40)}"` : "";
  const ok = confirm(`Delete this ${what}${label}? It disappears for everyone on it.`); fz.tick = Date.now();   // the system dialog pauses the page; not a stall
  if (!ok) return;
  const copy = data ? { ...data } : null; if (copy) delete copy.id;
  fz.add(`${what} deleted by tap ${String(id).slice(0, 6)}`); fz.save();
  try { await deleteDoc(doc(db, col, id)); } catch (e) { return toast("Couldn't delete: " + e.message); }
  toast(`${what[0].toUpperCase() + what.slice(1)} deleted`, copy ? "Undo" : null, copy ? () => setDoc(doc(db, col, id), copy).then(() => toast("Restored")).catch(e => toast("Couldn't restore: " + e.message)) : null);
}
// ---------- EXPENSE PAGE (details + discussion) ----------
function expenseBody(id) {
  const x = S.expenses.get(id);
  if (!x) return `<div class="card empty">${dot("oops", 72)}<b>Expense not found</b><p class="muted">It may have been deleted.</p><button class="btn" data-go="#/money">Back to Money</button></div>`;
  const n = (x.split || []).length || 1, share = Math.round(x.amountCents / n);
  const ev = x.eventId ? S.events.get(x.eventId) : null;
  return `
  <button class="link-back" data-go="#/money">‹ Money</button>
  <div class="group-hero"><span class="li" style="width:52px;height:52px;font-size:24px">${x.pitch ? "🎁" : "🧾"}</span>
    <div><h1>${esc(x.desc || "Expense")}</h1><div class="muted">${x.pitch ? `${esc(first(nameOf(x.paidBy)))} is collecting · ${fmt$(x.pitch.each)} each${x.pitch.closes ? " · " + (x.pitch.closes < todayStr() ? "closed " : "closes ") + esc(fmtDay({ date: x.pitch.closes })) : ""}` : `${fmt$(x.amountCents)} · ${esc(nameOf(x.paidBy))} paid`}${ev ? " · " + esc(ev.title) : ""} · ${new Date(x.createdAt).toLocaleDateString()}</div></div></div>
  ${x.pitch ? pitchProgress(x) : ""}
  ${x.receipt ? `<div class="btnrow" style="margin-top:12px"><button class="btn small" id="viewReceipt">🧾 View receipt</button></div>` : ""}
  ${x.addedBy !== myUid() ? "" : x.pitch ? (Object.keys(x.paid || {}).length ? "" : `<div class="btnrow" style="margin-top:12px"><button class="btn small danger-ghost" id="xDelete">Delete</button></div>`) : Object.keys(x.paid || {}).some(u => u !== x.paidBy) ? `<p class="muted sm" style="margin-top:10px">Someone has already paid, so this can't be changed. Mark their payment unpaid first if it needs fixing.</p>`
    : `<div class="btnrow" style="margin-top:12px"><button class="btn small" id="xReopen">${(x.items || []).length ? "✏️ Reopen to make changes" : "✏️ Change who's splitting"}</button>${Object.keys(x.paid || {}).length ? "" : `<button class="btn small danger-ghost" id="xDelete">Delete</button>`}</div>`}
  <div class="section-head"><h2>${x.pitch ? "Who's in" : x.shares ? "Who owes what" : `Split ${n} way${n > 1 ? "s" : ""}`}</h2>${x.pitch && x.addedBy === myUid() && pitchLeft(x).length ? `<button class="btn small" id="pitchNudge">🔔 Nudge the ${pitchLeft(x).length} left</button>` : ""}</div>
  <div class="card">${(x.split || []).map(u => {
    const me = myUid(), cents = x.shares ? (x.shares[u] || 0) : share, paid = (x.paid || {})[u], payer = u === x.paidBy, canManage = me === x.paidBy || me === x.addedBy;
    const status = payer ? `<span class="pill ok">${x.pitch ? "Collecting" : "Paid the bill"}</span>` : paid ? `<span class="pill ok">Paid${paid.at ? " · " + new Date(paid.at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}</span>` : `<span class="pill due">Unpaid</span>`;
    const acts = payer || !cents ? "" : paid ? (canManage || paid.by === me ? `<button class="btn ghost small" data-munpaid="${esc(u)}">Mark unpaid</button>` : "")
      : `${canManage && u !== me ? `<button class="btn small" data-remind="${esc(u)}">${isGuest(u) ? "💬 Text" : "🔔 Remind"}</button>` : ""}${canManage && u !== me ? `<button class="btn small" data-mpaid="${esc(u)}">Mark paid</button>` : ""}`;
    return `<div class="member-row x-person" data-xperson="${esc(u)}">${avatar(u, "lg")}<div style="flex:1;min-width:0"><b>${esc(nameOf(u))}${u === me ? " (you)" : ""}</b><div class="x-status">${status}</div></div><div class="x-acts"><span class="amt sm">${fmt$(cents)}</span>${acts ? `<div class="btnrow" style="gap:6px;justify-content:flex-end">${acts}</div>` : ""}</div></div>${u === me && !payer && !paid && cents ? payBar(x.paidBy, cents) : ""}`; }).join("")}</div>
  ${(x.items || []).length ? `<div class="section-head" style="margin-top:22px"><h2>Receipt${x.merchant ? " · " + esc(x.merchant) : ""}</h2></div>
  <div class="card">${x.items.map(it => `<div class="member-row"><div style="flex:1;min-width:0"><b>${esc(it.name)}</b><div class="muted sm">${(it.uids || []).map(u => esc(first(nameOf(u))) + (it.w && it.w[u] > 1 ? " ×" + it.w[u] : "")).join(", ") || "unassigned"}</div></div><span class="amt sm">${fmt$(it.cents)}</span></div>`).join("")}
    ${x.tax ? `<div class="member-row"><div style="flex:1"><b>Tax</b><div class="muted sm">split in proportion</div></div><span class="amt sm">${fmt$(x.tax)}</span></div>` : ""}
    ${x.fees ? `<div class="member-row"><div style="flex:1"><b>${esc((x.feeNames || []).join(", ") || "Fees")}</b><div class="muted sm">split in proportion</div></div><span class="amt sm">${fmt$(x.fees)}</span></div>` : ""}
    ${x.tip ? `<div class="member-row"><div style="flex:1"><b>Tip</b><div class="muted sm">split in proportion</div></div><span class="amt sm">${fmt$(x.tip)}</span></div>` : ""}</div>` : ""}
  <div class="card th-plain" id="wall" style="margin-top:22px"><p class="muted">Loading…</p></div>`;
}
// The ways to pay someone, their preferred one first and ringed: the same buttons on the Money tab and inside an
// expense. `pre` names the click attributes ("" on the Money tab, "x" on an expense page).
// Apple Cash needs an iPhone at both ends: never offered on Android, and never for someone whose app reported Android.
// People whose phone type isn't known yet (they haven't opened the app since this shipped) still get it.
const appleCashFor = uid => { const o = payInfoOf(uid); return !!o.phone && !IS_ANDROID && o.os !== "android"; };
const appleCashLabel = () => /iPhone|iPad|Mac/.test(navigator.userAgent) ? `<span class="apple-glyph" aria-hidden="true">\uF8FF</span>Cash` : "Apple Cash";
function payBtns(to, cents, pre = "") {
  const o = payInfoOf(to), amt = `data-amt="${cents}"`;
  const btns = {
    venmo: o.venmo ? `<button class="btn small venmo" data-${pre}venmo="${esc(to)}" ${amt}>Venmo</button>` : "",
    cashapp: o.cashapp ? `<button class="btn small cashapp" data-${pre}cashapp="${esc(to)}" ${amt}>Cash App</button>` : "",
    zelle: o.zelle ? `<button class="btn small zelle" data-${pre}zelle="${esc(to)}" ${amt} title="Zelle has no payment links: this copies their Zelle handle for your bank app">Zelle</button>` : "",
    apple: appleCashFor(to) ? `<button class="btn small apple" data-${pre}apple="${esc(to)}" ${amt} aria-label="Apple Cash">${appleCashLabel()}</button>` : ""
  };
  if (isGuest(to)) btns.text = `<button class="btn small" data-${pre}text="${esc(to)}|${cents}|owe">💬 Text</button>`;
  const order = [o.payPref, "venmo", "cashapp", "zelle", "apple", "text"].filter((k, i, arr) => k && btns[k] && arr.indexOf(k) === i);
  let html = order.map((k, i) => i === 0 && o.payPref === k ? btns[k].replace('class="btn small', 'class="btn small pref') : btns[k]).join("");
  if (o.payPref && btns[o.payPref]) html = `<span class="pref-note">Prefers ${PAY_METHODS[o.payPref]}</span>` + html;
  return html;
}
// What you owe on this expense, with the same pay buttons as the Money tab, and Mark as paid.
function payBar(to, cents) {
  const who = esc(first(nameOf(to))), btns = payBtns(to, cents, "x");
  return `<div class="x-pay"><div class="x-pay-head">Pay ${who} <b>${fmt$(cents)}</b></div>${btns ? "" : `<p class="muted sm" style="margin:0">${who} hasn't added Venmo, Zelle, or Cash App yet. Pay them however you like, then mark it paid.</p>`}<div class="settle-actions">${btns}<button class="btn small" data-mpaid="${esc(myUid())}">Mark as paid</button></div></div>`;
}
function wireExpensePage() {
  const x = S.expenses.get(S.route.id); if (!x) return;
  const pseudo = { id: x.id, _col: ["expenses", x.id], _manage: false, title: x.desc };
  if (el("viewReceipt")) el("viewReceipt").onclick = () => lightbox(x.receipt);
  if (el("xReopen")) el("xReopen").onclick = () => (x.items || []).length ? reopenAsPick(x) : changeSplitPeople(x);
  if (el("xDelete")) el("xDelete").onclick = () => { if (!confirm(`Delete “${x.desc || "this expense"}”? Nobody has paid on it yet.`)) return; deleteWithUndo("expenses", x.id, x, "expense"); go("#/money"); };
  if (el("pitchNudge")) el("pitchNudge").onclick = async () => { const b = el("pitchNudge"), left = pitchLeft(x).filter(u => !isGuest(u)); b.disabled = true;
    try { await Promise.all(left.map(u => addDoc(collection(db, "nudges"), { expenseId: x.id, to: u, by: myUid(), createdAt: Date.now() }))); b.textContent = "Reminded ✓"; toast(`${left.length} ${left.length === 1 ? "person gets" : "people get"} a reminder.`, null, null, "coral:happy"); } catch (e) { toast(e.message); b.disabled = false; } };
  const share = u => x.shares ? (x.shares[u] || 0) : Math.round(x.amountCents / ((x.split || []).length || 1));
  const mine = share(myUid());
  document.querySelectorAll("[data-xvenmo]").forEach(b => b.onclick = () => payVenmo(x.paidBy, mine, "pay", x.id));
  document.querySelectorAll("[data-xcashapp]").forEach(b => b.onclick = () => payCashApp(x.paidBy, mine, x.id));
  document.querySelectorAll("[data-xzelle]").forEach(b => b.onclick = () => payZelle(x.paidBy, mine, x.id));
  document.querySelectorAll("[data-xapple]").forEach(b => b.onclick = () => payApple(x.paidBy, mine, x.id));
  document.querySelectorAll("[data-xtext]").forEach(b => b.onclick = () => textGuest(x.paidBy, mine, "owe"));
  // Paid: a payback for this expense (so balances move) plus a mark on the expense itself (so everyone on it sees the status).
  document.querySelectorAll("[data-mpaid]").forEach(b => b.onclick = async () => {
    const u = b.dataset.mpaid; b.disabled = true;
    const sid = await markPaid(u, x.paidBy, share(u), x.desc || "", x.id); if (!sid) { b.disabled = false; return; }
    updateDoc(doc(db, "expenses", x.id), { [`paid.${u}`]: { at: Date.now(), by: myUid(), sid } }).catch(e => toast(e.message));
  });
  // Unpaid: the payback behind the mark goes too (else Money still counts it). One that covered more than this
  // expense is removed only after asking, since their other expenses go back to unpaid with it.
  document.querySelectorAll("[data-munpaid]").forEach(b => b.onclick = async () => {
    const u = b.dataset.munpaid, p = (x.paid || {})[u] || {};
    const ids = [...new Set([...(p.sids || []), ...String(p.sid || "").split("+")])].filter(id => id && S.settlements.has(id));
    const total = ids.reduce((n, id) => n + (S.settlements.get(id).amountCents || 0), 0);
    if (ids.length && total > share(u) + 1) { const ok = confirm(`${first(nameOf(u))}'s payment of ${fmt$(total)} covered more than this expense. Remove the whole payment? Anything else it paid for goes back to unpaid.`); fz.tick = Date.now(); if (!ok) return; }
    b.disabled = true;
    for (const id of ids) { try { await deleteDoc(doc(db, "settlements", id)); } catch (e) { b.disabled = false; return toast("Couldn't remove the payment: " + e.message); } }
    updateDoc(doc(db, "expenses", x.id), { [`paid.${u}`]: deleteField() }).then(() => toast(ids.length ? `Marked unpaid. ${first(nameOf(u))}'s payment is off the Money tab too.` : "Marked unpaid")).catch(e => toast(e.message));
  });
  document.querySelectorAll("[data-remind]").forEach(b => b.onclick = async () => {
    const u = b.dataset.remind;
    if (isGuest(u)) return textGuest(u, share(u), "owed");
    if (!confirm(`Remind ${first(nameOf(u))} about their ${fmt$(share(u))} for ${x.desc || "this"}?`)) return; fz.tick = Date.now();
    b.disabled = true; b.textContent = "Reminding…";
    try { await addDoc(collection(db, "nudges"), { expenseId: x.id, to: u, by: myUid(), createdAt: Date.now() }); b.textContent = "Reminded ✓"; toast(`${first(nameOf(u))} will get a reminder.`); }
    catch (e) { b.disabled = false; b.textContent = "🔔 Remind"; toast(e.message); }
  });
  S.comments = [];
  S.evSubs.push(onSnapshot(subCol(pseudo, "comments"), snap => {
    S.comments = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.createdAt - b.createdAt);
    const b = el("wall"); if (b) withInputKept(() => { b.innerHTML = wallInner(pseudo, "Discussion"); wireWall(pseudo); });
  }, e => toast(e.message)));
}
function payVenmo(uid, cents, txn, expenseId) { const v = payInfoOf(uid).venmo; if (!v) return; const x = expenseId && S.expenses.get(expenseId); window.open(`https://venmo.com/${encodeURIComponent(v.replace(/^@/, ""))}?txn=${txn}&amount=${(cents / 100).toFixed(2)}&note=${encodeURIComponent((x && x.desc ? x.desc + " · " : "") + "Friendly 🤝")}`, "_blank"); if (txn === "pay") askIfSent(uid, cents, "Venmo", expenseId); else toast("Request sent in Venmo."); }
// Marks a payment as made. Undo is offered right away, and every settlement can
// be removed later from the Activity list too.
async function markPaid(from, to, cents, note, expenseId) {
  const ref = doc(db, "settlements", newId());
  try { await setDoc(ref, { from, to, amountCents: cents, involved: [...new Set([from, to, myUid()])], note: note || "", expenseId: expenseId || null, addedBy: myUid(), createdAt: Date.now() }); }
  catch (e) { toast(e.message); return null; }
  const undo = () => deleteDoc(ref).then(() => { if (expenseId) updateDoc(doc(db, "expenses", expenseId), { [`paid.${from}`]: deleteField() }).catch(() => {}); toast("Undone"); }).catch(e => toast(e.message));
  toast(expenseId ? `${first(nameOf(from))} marked as paid` : note ? `Opened ${note} · marked as paid` : "Marked as paid", "Undo", undo);
  return ref.id;
}
// After a payment app opens, nothing is marked until the person says the money went: when they come back to
// Friendly (or after a few seconds if the app opened beside it) they're asked once.
function askIfSent(to, cents, method, expenseId, onNo) {
  let asked = false; const t0 = Date.now();
  // Kept on the phone too: iOS may reload Friendly while Apple Pay or Venmo is open, and the question must still come.
  LS.set("friendlyPayPending", JSON.stringify({ to, cents, method, expenseId: expenseId || null, at: t0 }));
  const ask = () => { if (asked) return; asked = true; LS.remove("friendlyPayPending"); document.removeEventListener("visibilitychange", onVis); clearTimeout(timer);
    dialog(`<h3>Did it go through?</h3><p>Did you send <b>${fmt$(cents)}</b> to <b>${esc(first(nameOf(to)))}</b> with ${esc(method)}?</p><p class="muted sm">It's marked paid only once you say so, for both of you.</p>`, "Yes, mark it paid", () => { closeDialog(); markPaid(myUid(), to, cents, method, expenseId); });
    const c = el("dlgCancel"); if (c) { c.textContent = "Not yet"; if (onNo) c.addEventListener("click", onNo); } };
  const onVis = () => { if (document.visibilityState === "visible" && Date.now() - t0 > 600) setTimeout(ask, 350); };
  document.addEventListener("visibilitychange", onVis);
  const timer = setTimeout(() => { if (document.visibilityState === "visible") ask(); }, 6000);
}
// What makes up a settle-up amount: each expense between the two of you, with the ones running the other way (and
// paybacks) taken off, so a $1 you owe Sarah tucked inside "Sarah owes you $22.01" is still visible.
function settleWhy(p, me) {
  let parts = (p.parts || []).filter(x => x.cents); if (!parts.length) return "";
  // Expenses already marked paid cancel against their paybacks; when the rest adds up to the amount, show only the rest.
  const open = parts.filter(x => !x.paid && x.label !== "Paid back");
  if (open.length && open.reduce((n, x) => n + x.sign * x.cents, 0) === p.amount) parts = open;
  const yours = x => (x.sign > 0) === (p.from === me);   // you owe on this line
  const shown = parts.sort((x, y) => (y.sign - x.sign) || (y.cents - x.cents)).slice(0, 4);
  const line = shown.map(x => x.sign > 0 ? `${esc(x.label)} ${fmt$(x.cents)}` : `${x.label === "Paid back" ? (p.from === me ? "you paid back" : "they paid back") : `minus ${esc(x.label)}${yours(x) ? " (you owe)" : ""}`} ${fmt$(x.cents)}`).join(" · ");
  return `<div class="settle-why">${line}${parts.length > shown.length ? ` · +${parts.length - shown.length} more` : ""}</div>`;
}
// After a reload, a payment that was in progress (under 20 minutes ago) asks its question once.
async function resumePayAsk() {
  await bootDiag; let p = null; try { p = JSON.parse(LS.get("friendlyPayPending") || "null"); } catch {}
  if (!p || !p.to || !p.cents || Date.now() - (p.at || 0) > 20 * 60000 || !myUid()) { if (p) LS.remove("friendlyPayPending"); return; }
  LS.remove("friendlyPayPending");
  if (el("appDialog")) return;
  dialog(`<h3>Did it go through?</h3><p>Did you send <b>${fmt$(p.cents)}</b> to <b>${esc(first(nameOf(p.to)))}</b> with ${esc(p.method)}?</p><p class="muted sm">It's marked paid only once you say so, for both of you.</p>`, "Yes, mark it paid", () => { closeDialog(); markPaid(myUid(), p.to, p.cents, p.method, p.expenseId || undefined); });
  const c = el("dlgCancel"); if (c) c.textContent = "Not yet";
}
// A text to someone who isn't on Friendly: what they owe you and how to pay you, or what you owe them.
function textGuest(id, cents, dir) {
  const me = S.profile || {}, ways = [["venmo", "Venmo " + (me.venmo || "").replace(/^@?/, "@")], ["zelle", "Zelle " + me.zelle], ["cashapp", "Cash App " + (me.cashapp || "").replace(/^\$?/, "$")]].filter(([k]) => me[k]);
  const pref = ways.find(([k]) => k === me.payPref) || ways[0];
  const body = dir === "owed"
    ? `Hey ${first(nameOf(id))}, you owe me ${fmt$(cents)} from Friendly.${pref ? " Easiest is " + pref[1] + "." : ""} Thanks!`
    : `Hey ${first(nameOf(id))}, I owe you ${fmt$(cents)}. What's easiest for you, Venmo, Zelle, or Cash App?`;
  const sep = /iPhone|iPad|Mac/.test(navigator.userAgent) ? "&" : "?";
  location.href = "sms:" + id.slice(3) + sep + "body=" + encodeURIComponent(body);
}
// One-tap Apple Cash (live for every iPhone user since v246): the "Friendly Pay" Shortcut runs iPhone's Send
// Payment action with Apple Pay, the person and amount filled in, then reopens Friendly (Apple still asks for Face ID).
// iCloud link (opens straight in Shortcuts with Add Shortcut); shared from Wes's iPhone Oct 18. The signed file in
// shortcuts/ (built by shortcuts/build-pay.py) is the same shortcut.
const PAY_SHORTCUT_URL = "https://www.icloud.com/shortcuts/b46dc76288a14df78c1c08dccb5ac36a";   // Friendly Pay v5 (verified via the iCloud records API Oct 18 2026). amt is sent as text: a JSON number crashes Send Payment (see shortcuts/build-pay.py)
const payShortcutOn = () => NATIVE && IOS;   // live for everyone since v246 (Oct 18 2026)
function payViaShortcut(uid, cents, expenseId) {
  const to = toE164(payInfoOf(uid).phone || ""), x = expenseId && S.expenses.get(expenseId);
  // Apple's sheet shows the person as their number no matter what is sent (it rebuilds the payee from Siri matches
  // only); the amount must be text, a JSON number crashes the Send Payment step. See shortcuts/build-pay.py.
  const run = () => { location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent("Friendly Pay") + "&input=text&text=" + encodeURIComponent(JSON.stringify({ to, amt: (Math.round(cents) / 100).toFixed(2), note: ((x && x.desc) || "Friendly") + " · Friendly" })); askIfSent(uid, cents, "Apple Cash", expenseId, () => LS.remove("friendlyPayShortcut")); };   // "Not yet" brings the setup back next time
  if (LS.get("friendlyPayShortcut") === "1") return run();
  dialog(`<h3>Apple Cash in one tap</h3>
    <p>Add the free <b>Friendly Pay</b> shortcut once. After that, Cash opens Apple Pay with <b>${fmt$(cents)}</b> to ${esc(first(nameOf(uid)))} already filled in. You confirm with Face ID.</p>
    <div class="stack"><button type="button" class="btn" id="fpAdd">1. Add the shortcut</button><button type="button" class="btn primary" id="fpRun">2. Pay ${fmt$(cents)} now</button><button type="button" class="btn ghost" id="fpSms">Use Messages instead</button></div>`, null, null);
  // Apple's Add Shortcut screen can't send anyone back, so when they return (the "◀ Friendly" corner link, or
  // switching apps) this box is already on the next step: one button to pay.
  const ready = () => { const d = el("appDialog"); if (!d || !el("fpAdd")) return;
    d.querySelector(".dlg-inner").innerHTML = `<h3>You're set up</h3><p>Friendly Pay is added. Next time, Cash goes straight to Apple Pay.</p>
      <div class="stack"><button type="button" class="btn primary" id="fpGo">Pay ${esc(first(nameOf(uid)))} ${fmt$(cents)} now</button><button type="button" class="btn ghost" id="fpLater">Not now</button></div>`;
    el("fpGo").onclick = () => { LS.set("friendlyPayShortcut", "1"); closeDialog(); run(); };
    el("fpLater").onclick = () => { LS.set("friendlyPayShortcut", "1"); closeDialog(); }; };
  const onBack = () => { if (document.visibilityState === "visible") { document.removeEventListener("visibilitychange", onBack); setTimeout(ready, 300); } };
  el("fpAdd").onclick = () => { document.addEventListener("visibilitychange", onBack); window.open(PAY_SHORTCUT_URL, "_blank"); };
  el("fpRun").onclick = () => { LS.set("friendlyPayShortcut", "1"); closeDialog(); run(); };
  el("fpSms").onclick = () => { closeDialog(); payApple(uid, cents, expenseId, true); };
}
function payApple(uid, cents, expenseId, plain) {
  if (payShortcutOn() && !plain && toE164(payInfoOf(uid).phone || "")) return payViaShortcut(uid, cents, expenseId); const p = payInfoOf(uid).phone; if (!p) return; const sep = /iPhone|iPad|Mac/.test(navigator.userAgent) ? "&" : "?"; location.href = "sms:" + p.replace(/[^+\d]/g, "") + sep + "body=" + encodeURIComponent(`Sending $${(cents / 100).toFixed(2)} Apple Cash for our Friendly tab 🤝`); askIfSent(uid, cents, "Apple Cash", expenseId); }
function payCashApp(uid, cents, expenseId) { const t = (payInfoOf(uid).cashapp || "").replace(/^\$/, ""); if (!t) return; window.open(`https://cash.app/$${encodeURIComponent(t)}/${(cents / 100).toFixed(2)}`, "_blank"); askIfSent(uid, cents, "Cash App", expenseId); }
// Zelle lives inside each bank's app and has no payment links, so the best we can do is hand over the handle.
function payZelle(uid, cents, expenseId) {
  const z = payInfoOf(uid).zelle; if (!z) return;
  const done = () => dialog(`<h3>Pay with Zelle</h3><p>Send <b>${fmt$(cents)}</b> to <b>${esc(first(nameOf(uid)))}</b> in your bank app. Their Zelle is <b class="mono">${esc(z)}</b>${navigator.clipboard ? " (copied)" : ""}.</p><p class="muted sm">When it's sent, mark it paid so the balance clears for both of you.</p>`, "I sent it", () => { closeDialog(); markPaid(myUid(), uid, cents, "Zelle", expenseId); });
  if (navigator.clipboard) navigator.clipboard.writeText(z).then(done, done); else done();
}
const PAY_METHODS = { venmo: "Venmo", apple: "Apple Cash", zelle: "Zelle", cashapp: "Cash App" };
const payPrefOptions = sel => `<option value="" ${!sel ? "selected" : ""}>No preference</option>` + Object.entries(PAY_METHODS).filter(([k]) => !(IS_ANDROID && k === "apple")).map(([k, v]) => `<option value="${k}" ${sel === k ? "selected" : ""}>${v}</option>`).join("");
const payerOptions = (people, sel) => { const opt = ([u, i]) => `<option value="${u}" ${u === (sel || myUid()) ? "selected" : ""}>${esc(first(i.name))}</option>`; const main = Array.isArray(people) ? people : people.main, others = Array.isArray(people) ? [] : people.others; return main.map(opt).join("") + (others.length ? `<optgroup label="More people">${others.map(opt).join("")}</optgroup>` : ""); };
// Who an expense can be between. From an event: that event's guests, whether or not you share a group with them
// (their names travel with the event), Going first and pre-checked; from a group: its members; from Money:
// everyone you know. Anyone else you know is offered under "More people", collapsed.
// People not on Friendly yet who belong on an expense: the event's and group's phone invites and friends you
// texted. They're "ph:+1…" ids; when they sign up with that number the server swaps in their account (onUserPhone).
function phonePeople(eventId, groupId) {
  const out = new Map(), add = (e164, name) => { if (e164 && !out.has("ph:" + e164)) out.set("ph:" + e164, { name: name || fmtPhone(e164) }); };
  const ev = eventId ? S.events.get(eventId) : null, g = groupId ? S.groups.get(groupId) : ev && ev.groupId ? S.groups.get(ev.groupId) : null;
  if (ev) (ev.invitedPhones || []).forEach(p => add(p, (ev.invitedPhoneNames || {})[p]));
  if (g) (g.invitedPhones || []).forEach(p => add(p, (g.invitedPhoneNames || {})[p]));
  invitedByText().forEach(r => add(r.phone, r.name));
  return out;
}
function expensePeople(eventId, restrict, groupId) {
  const me = myUid(), info = u => S.contacts.get(u) || { name: nameOf(u) };
  const ev = eventId ? S.events.get(eventId) : null;
  let main = [], checked = new Set(), tags = new Map();
  if (ev) {
    const r = ev.rsvps || {}, rank = u => u === me ? 0 : r[u] === "going" ? 1 : r[u] === "maybe" ? 2 : !r[u] ? 3 : 4;
    main = [...new Set([me, ...(ev.invitedUids || [])])].sort((x, y) => rank(x) - rank(y)).map(u => [u, info(u)]);
    main.forEach(([u]) => { if (u === me || r[u] === "going") checked.add(u); else tags.set(u, r[u] === "no" ? "can't go" : r[u] === "maybe" ? "maybe" : r[u] ? r[u] : "no answer"); });
    // guests invited by text who said they're going are part of the crew too
    for (const p of ev.invitedPhones || []) { const id = "ph:" + p; main.push([id, { name: (ev.invitedPhoneNames || {})[p] || fmtPhone(p) }]); if (phoneStatus(ev, p) === "going") checked.add(id); }
  } else if (restrict) {
    main = [...new Set([me, ...restrict])].map(u => [u, info(u)]); main.forEach(([u]) => checked.add(u));
  } else {
    main = [...S.contacts.entries()];   // from the Money tab: nobody is picked for you
  }
  const inMain = new Set(main.map(([u]) => u));
  const others = [...S.contacts.entries(), ...phonePeople(eventId, groupId).entries()].filter(([u]) => !inMain.has(u));
  return { main, others, checked, tags };
}
// "Split between": who's in (faces, names, and each person's share), quick picks for the usual crowds, and a
// searchable list behind Edit. The old wall of first-name checkboxes stopped working past about 8 people. The
// hidden checkboxes in #xSplit stay the source of truth: saving, Dot's fill-in and added guests all use them.
const splitPicked = () => [...document.querySelectorAll('#xSplit input[name=spl]:checked')].map(i => i.value);
function splitField(pp) {
  const all = [...pp.main, ...pp.others], on = pp.checked.size ? pp.checked : new Set([myUid()]);
  return `<div class="split" id="spBox"><div class="split-head"><span class="field-label">Split between</span><span class="muted sm" id="spEach"></span></div>
    <button type="button" class="split-who" id="spOpen" aria-label="Choose who splits it"></button>
    <div class="chiprow split-quick" id="spQuick"></div></div>
    <div id="xSplit" hidden>${all.map(([u]) => `<input type="checkbox" name="spl" value="${esc(u)}" ${on.has(u) ? "checked" : ""}>`).join("")}</div>`;
}
function wireSplit(pp, eventId, restrict) {
  const me = myUid(), ev = eventId ? S.events.get(eventId) : null, r = (ev && ev.rsvps) || {}, inv = new Set((ev && ev.invitedUids) || []);
  const names = new Map([...pp.main, ...pp.others].map(([u, i]) => [u, i.name || nameOf(u)]));
  const nm = u => u === me ? "You" : names.get(u) || nameOf(u);
  const inputs = () => [...document.querySelectorAll('#xSplit input[name=spl]')];
  const ensure = u => { if (!inputs().some(i => i.value === u)) el("xSplit").insertAdjacentHTML("beforeend", `<input type="checkbox" name="spl" value="${esc(u)}">`); };
  const sel = () => new Set(splitPicked());
  const face = (u, cls = "xs") => isGuest(u) ? `<span class="avatar ${cls} texted-av">${esc(initials(nm(u)).slice(0, 1))}</span>` : avatar(u, cls);
  const tag = u => isGuest(u) ? fmtPhone(u.slice(3)) + " · gets a text" : "";   // RSVPs show as the list's sections
  const quick = [];
  if (ev) {
    const going = [me, ...[...inv].filter(u => r[u] === "going"), ...(ev.invitedPhones || []).filter(p => phoneStatus(ev, p) === "going").map(p => "ph:" + p)], maybe = [...inv].filter(u => r[u] === "maybe");
    quick.push(["Everyone going", going]); if (maybe.length) quick.push(["Going + maybe", [...going, ...maybe]]);
  } else if (restrict) quick.push(["Everyone here", [me, ...restrict]]);
  else for (const g of S.groups.values()) quick.push([`${groupMini(g)} ${esc(g.name)}`, [me, ...(g.memberUids || [])]]);
  const same = (a, b) => a.size === b.size && [...a].every(u => b.has(u));
  const quickHtml = () => { const s = sel(); return quick.map(([label, us], k) => `<button type="button" class="fchip ${same(new Set(us), s) ? "on" : ""}" data-spq="${k}">${label} <span class="sp-n">${new Set(us).size}</span></button>`).join(""); };
  const paint = () => {
    const s = [...sel()].sort((a, b) => (a === me ? -1 : b === me ? 1 : 0)), n = s.length, amt = parseAmount((el("xAmt") || {}).value || "");
    const firsts = s.map(u => u === me ? "You" : first(nm(u)));
    const text = !n ? "Nobody yet. Tap to choose." : n <= 3 ? firsts.join(n === 2 ? " and " : ", ").replace(/, ([^,]+)$/, ", and $1") : `${firsts.slice(0, 3).join(", ")}, and ${n - 3} more`;
    el("spOpen").innerHTML = `<span class="mini-guests">${s.slice(0, 4).map(u => face(u)).join("")}</span><span class="split-names">${esc(text)}</span><span class="split-edit">Edit</span>`;
    el("spEach").textContent = !n ? "" : n === 1 ? "1 person" : `${n} people${amt ? " · " + fmt$(Math.round(amt / n)) + " each" : ""}`;
    el("spQuick").innerHTML = quickHtml();
    el("spQuick").querySelectorAll("[data-spq]").forEach(b => b.onclick = () => { const us = new Set(quick[+b.dataset.spq][1]); us.forEach(ensure); inputs().forEach(i => { i.checked = us.has(i.value); }); paint(); });
  };
  const open = () => {
    const inner = document.querySelector("#appDialog .dlg-inner"); if (!inner || el("spPanel")) return;
    const s = sel(), all = inputs().map(i => i.value).filter(u => u !== me), others = all.filter(u => !isGuest(u)), guests = all.filter(isGuest), az = us => us.sort((a, b) => nm(a).localeCompare(nm(b)));
    const secs = ev ? [["Going", others.filter(u => inv.has(u) && r[u] === "going")], ["Maybe", others.filter(u => inv.has(u) && r[u] === "maybe")], ["No answer yet", others.filter(u => inv.has(u) && !r[u])], ["Can't go", others.filter(u => inv.has(u) && r[u] && !["going", "maybe"].includes(r[u]))], ["Others you know", others.filter(u => !inv.has(u))]]
      : restrict ? [["In this group", others.filter(u => restrict.includes(u))], ["Others you know", others.filter(u => !restrict.includes(u))]]
      : others.some(u => s.has(u)) ? [["Splitting", others.filter(u => s.has(u))], ["Everyone else", others.filter(u => !s.has(u))]] : [["People you know", others]];
    secs.push(["Not on Friendly yet", guests]);   // they get a text to join and settle up
    const row = u => `<button type="button" class="sp-row ${s.has(u) ? "on" : ""}" data-spu="${esc(u)}" data-find="${esc((nm(u) + " " + (isGuest(u) ? u.slice(3) : "")).toLowerCase())}">${face(u, "")}<span class="sp-nm"><b>${esc(nm(u))}</b>${tag(u) ? `<span class="muted sm">${esc(tag(u))}</span>` : ""}</span><span class="sp-check" aria-hidden="true"></span></button>`;
    inner.classList.add("sp-open");
    inner.insertAdjacentHTML("beforeend", `<div class="split-panel" id="spPanel">
      <div class="sp-top"><h3 style="margin:0">Who's splitting?</h3><span class="muted sm" id="spCount"></span></div>
      <input type="search" class="inv-search" id="spSearch" placeholder="Search ${others.length + 1} people" autocomplete="off" enterkeyhint="search">
      ${quick.length ? `<div class="chiprow split-quick" id="spQuick2"></div>` : ""}
      <div id="spList">${row(me)}${secs.filter(([, us]) => us.length).map(([t, us]) => `<div class="sp-sec">${esc(t)} <span>${us.length}</span></div>${az(us).map(row).join("")}`).join("")}</div>
      <p class="muted sm hidden" id="spNone" style="margin:10px 4px">Nobody by that name.</p>
      ${isDemo() ? "" : `<button type="button" class="btn ghost small" id="spGuest" style="margin-top:8px">＋ Someone not on Friendly</button>`}
      <div class="sp-bar"><button type="button" class="btn ghost small" id="spClear">Clear</button><button type="button" class="btn primary" id="spDone">Done</button></div></div>`);
    const dlg = el("appDialog"); if (dlg) dlg.scrollTop = 0;
    const count = () => { const n = sel().size; el("spCount").textContent = n + " selected"; el("spDone").textContent = n ? `Split ${n} ${n === 1 ? "way" : "ways"}` : "Done";
      if (el("spQuick2")) { el("spQuick2").innerHTML = quickHtml(); el("spQuick2").querySelectorAll("[data-spq]").forEach(b => b.onclick = () => { const us = new Set(quick[+b.dataset.spq][1]); us.forEach(ensure); inputs().forEach(i => { i.checked = us.has(i.value); }); document.querySelectorAll("#spList [data-spu]").forEach(x => x.classList.toggle("on", us.has(x.dataset.spu))); count(); }); } };
    document.querySelectorAll("#spList [data-spu]").forEach(b => b.onclick = () => { const i = inputs().find(x => x.value === b.dataset.spu); if (!i) return; i.checked = !i.checked; b.classList.toggle("on", i.checked); count(); });
    el("spSearch").oninput = () => { const q = el("spSearch").value.trim().toLowerCase(); let hits = 0;
      document.querySelectorAll("#spList [data-spu]").forEach(b => { const show = !q || b.dataset.find.includes(q); b.classList.toggle("hidden", !show); if (show) hits++; });
      document.querySelectorAll("#spList .sp-sec").forEach(h => { let n = h.nextElementSibling, any = false; while (n && !n.classList.contains("sp-sec")) { if (!n.classList.contains("hidden")) any = true; n = n.nextElementSibling; } h.classList.toggle("hidden", !any); });
      el("spNone").classList.toggle("hidden", hits > 0); };
    el("spClear").onclick = () => { inputs().forEach(i => { i.checked = false; }); document.querySelectorAll("#spList [data-spu]").forEach(x => x.classList.remove("on")); count(); };
    el("spDone").onclick = close;
    if (el("spGuest")) el("spGuest").onclick = () => { close(); if (el("xAddGuest")) el("xAddGuest").click(); };
    count();
  };
  const close = () => { const p = el("spPanel"); if (p) p.remove(); const inner = document.querySelector("#appDialog .dlg-inner"); if (inner) inner.classList.remove("sp-open"); paint(); const b = el("spBox"); if (b) b.scrollIntoView({ block: "center" }); };
  el("spOpen").onclick = open;
  if (el("xAmt")) el("xAmt").addEventListener("input", paint);
  S._splitPaint = paint; paint();
  return { add: (id, name) => { names.set(id, name); ensure(id); inputs().find(i => i.value === id).checked = true; paint(); } };
}
// After an expense with people not on Friendly: text them to join and settle up (their share waits for them).
function textSettleUp(rec) {
  const guests = [...new Set([...(rec.split || []), ...(rec.involved || [])])].filter(u => isGuest(u) && u !== rec.paidBy); if (!guests.length) return;
  const ev = rec.eventId ? S.events.get(rec.eventId) : null, what = ev ? ev.title : rec.merchant || rec.desc || "our tab";
  const name = u => (rec.guestNames || {})[u] || nameHint(u) || fmtPhone(u.slice(3)), payer = rec.paidBy === myUid() ? first(S.profile.name || "me") : first(nameOf(rec.paidBy));
  const hi = guests.length === 1 && !/^\(?\d/.test(name(guests[0])) ? `Hey ${first(name(guests[0]))}!` : "Hey!";
  const text = `${hi} Join Friendly to settle up with ${payer} for ${what}: https://officialfriendly.com (free). Sign up with this number and your share will be waiting.`;
  setTimeout(() => openTextInviteDialog(guests.map(u => ({ name: name(u), e164: u.slice(3) })), text, "expense", "Text them to settle up"), 400);
}
// Everyone who can appear in a payback: people you know plus anyone on one of your expenses (a guest who joined
// an event by link, say).
function moneyPeople(...must) {
  const m = new Map(S.contacts);
  for (const x of S.expenses.values()) for (const u of x.involved || []) if (u && !m.has(u)) m.set(u, { name: nameOf(u) });
  for (const u of must) if (u && !m.has(u)) m.set(u, { name: nameOf(u) });
  return [...m.entries()];
}
// An expense between exactly the members of one group belongs to that group,
// even when it was added from the Money tab instead of the group page.
function matchGroupId(involved) {
  const key = [...new Set(involved)].sort().join("|"); if (involved.length < 2) return null;
  for (const g of S.groups.values()) if ([...new Set(g.memberUids || [])].sort().join("|") === key) return g.id;
  return null;
}
const inGroup = (x, g) => x.groupId === g.id || (!x.groupId && (x.involved || []).length >= 2 && [...new Set(x.involved)].sort().join("|") === [...new Set(g.memberUids || [])].sort().join("|"));
function openExpense(eventId, restrict, groupId) {
  const people = expensePeople(eventId, restrict, groupId);
  dialog(`<h3>Add expense</h3>
    ${window.Blip && !isDemo() ? `<button type="button" class="btn small tell-dot" id="xTell">${dot("happy", 24)} Or just tell me: “Dinner was 120, I paid, split with Sam and Alex.”</button>` : ""}
    <label class="field"><span>What was it?</span><input id="xDesc" maxlength="80" placeholder="Pizza & drinks"></label>
    <div class="two"><label class="field"><span>Amount ($)</span><input id="xAmt" inputmode="decimal" placeholder="42.50"></label>
    <label class="field"><span>Paid by</span><select id="xPayer">${payerOptions(people)}</select></label></div>
    ${splitField(people)}
    ${isDemo() ? "" : `<div id="xGuests"></div><button type="button" class="btn ghost small" id="xAddGuest" style="margin-top:8px">＋ Someone not on Friendly</button>`}
    <div id="xScanBox"><button type="button" class="btn scan" id="xScan">📷 Scan or upload a receipt to itemize</button>
    <p class="muted sm" style="margin-top:6px">Snap it or pick a photo, then assign each line to whoever had it. Tax and tip split in proportion.</p></div>`,
    "Add expense", async () => {
      const amount = parseAmount(el("xAmt").value); if (!amount) return toast("Enter a valid amount.");
      const split = [...document.querySelectorAll('input[name=spl]:checked')].map(i => i.value); if (!split.length) return toast("Pick who splits it.");
      const paidBy = el("xPayer").value; const involved = [...new Set([...split, paidBy])];
      const rec = { desc: el("xDesc").value.trim(), amountCents: amount, paidBy, split, involved, eventId: eventId || null, groupId: groupId || (eventId && (S.events.get(eventId) || {}).groupId) || matchGroupId(involved), addedBy: myUid(), createdAt: Date.now(), guestNames: guestNamesFor(involved) };
      try { await saveExpense(rec); closeDialog(); toast("Expense added"); textSettleUp(rec); } catch (e) { toast("Couldn't save that expense: " + e.message); }
    });
  S._dlgGuests = Object.fromEntries([...people.main, ...people.others].filter(([u]) => isGuest(u)).map(([u, i]) => [u, i.name]));
  const split = wireSplit(people, eventId, restrict);
  if (el("xAddGuest")) el("xAddGuest").onclick = () => guestAdder(el("xGuests"), (id, name) => {
    if (splitPicked().includes(id)) { toast(`${first(name)} is already splitting it.`); return; }
    split.add(id, name);
    if (!el("xPayer").querySelector(`option[value="${CSS.escape(id)}"]`)) el("xPayer").insertAdjacentHTML("beforeend", `<option value="${esc(id)}">${esc(first(name))}</option>`);
  });
  el("xScan").onclick = () => scanReceipt(eventId, restrict, { desc: el("xDesc").value.trim(), paidBy: el("xPayer").value, people: splitPicked() }, groupId);
  if (el("xTell")) el("xTell").onclick = () => openPlanDialog("expense", { eventId, groupId });
}

// One door for expense writes: the save is capped in time (a write to a dead connection otherwise waits forever,
// showing an expense that was never saved), kept under Firestore's document size, and a failure is reported with
// the sizes that matter.
async function saveExpense(rec) {
  const id = newId(), t0 = Date.now();
  if (rec.receipt && rec.receipt.length > 600000) { try { rec.receipt = await compressImage(rec.receipt, 800, 0.7, 420000); } catch { rec.receipt = ""; } }
  const size = Math.round(JSON.stringify(rec).length / 1024);
  fz.add(`expense save ${size}KB`); fz.save();
  try { await Promise.race([setDoc(doc(db, "expenses", id), rec), new Promise((_, no) => setTimeout(() => no(new Error("the save is taking too long; check your connection and try again")), 40000))]); fz.add("expense saved in " + Math.round((Date.now() - t0) / 1000) + "s"); fz.save(); return id; }
  catch (e) {
    fz.add("expense save FAILED " + String(e.message).slice(0, 80)); fz.save();
    try { addDoc(collection(db, "bugs"), { uid: myUid(), name: "diag", text: `expense write failed after ${Math.round((Date.now() - t0) / 1000)}s: ${e.code || ""} ${e.message}. Doc ${size}KB, receipt ${Math.round((rec.receipt || "").length / 1024)}KB, ${(rec.items || []).length} items, ${(rec.involved || []).length} people, event ${rec.eventId || "-"}, cache note: ${window.__cacheNote || "none"}`, route: location.hash, version: APP_V + " / " + (nativeVersion || ""), platform: NATIVE ? (IS_ANDROID ? "android" : "ios") : "web", status: "open", diag: true, createdAt: Date.now() }).catch(() => {}); } catch {}
    throw e;
  }
}
// "Someone not on Friendly" inside an expense dialog: name and phone (typed, or from the phone's contacts),
// added as a checked person. A number that belongs to someone you already know adds that person instead.
// onAdd(id, name) gets "ph:+1…" for a guest or a real uid. Names of the guests added here are kept for the save.
function guestAdder(host, onAdd) {
  if (!host || host.firstChild) { const n = el("gName"); if (n) n.focus(); return; }
  const native = plugin("Contacts");
  host.innerHTML = `<div class="guest-add"><div class="two"><input id="gName" placeholder="Name" maxlength="40" autocomplete="off"><input id="gPhone" inputmode="tel" placeholder="Phone number" autocomplete="off"></div>
    <div class="btnrow">${native ? `<button type="button" class="btn small" id="gPick">📇 From contacts</button>` : ""}<button type="button" class="btn small primary" id="gAdd">Add</button><button type="button" class="btn ghost small" id="gDone">Done</button></div></div>`;
  const add = (name, phone) => {
    const e164 = toE164(phone); if (!e164) return toast("Enter a phone number for " + (name || "them") + ".");
    const known = [...S.contacts.entries()].find(([, i]) => toE164(i.phone) === e164);
    if (known) { onAdd(known[0], known[1].name); toast(`${first(known[1].name)} is on Friendly, so they're added as themselves.`); }
    else if (e164 === myPhoneE164()) toast("That's your own number.");
    else { const id = "ph:" + e164; S._dlgGuests = S._dlgGuests || {}; S._dlgGuests[id] = (name || "").trim() || e164; (S.nameHints = S.nameHints || new Map()).set(id, S._dlgGuests[id]); onAdd(id, S._dlgGuests[id]); }
    el("gName").value = ""; el("gPhone").value = ""; el("gName").focus();
  };
  el("gAdd").onclick = () => add(el("gName").value, el("gPhone").value);
  el("gPhone").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); add(el("gName").value, el("gPhone").value); } };
  el("gDone").onclick = () => { host.innerHTML = ""; };
  if (native) el("gPick").onclick = async () => {
    try { const r = await native.pickContact({ projection: { name: true, phones: true } }); const c = (r && (r.contact || (r.contacts && r.contacts[0]))) || (r && r.name ? r : null); if (!c) return;
      add(nameOfContact(c), phoneOfContact(c)); } catch (e) { const m = String((e && e.message) || ""); if (!/cancel/i.test(m)) toast("Couldn't read that contact: " + m); }
  };
  el("gName").focus();
}
const guestNamesFor = ids => { const o = {}; for (const u of ids || []) if (isGuest(u)) o[u] = (S._dlgGuests || {})[u] || nameHint(u) || u.slice(3); return o; };
// ----- Receipt scan → itemize → assign -----
// Generic request/response doc: write {uid, ...payload, status:"pending"},
// resolve with the doc once a Cloud Function marks it done.
function requestViaFirestore(col, payload, timeoutMs = 90000, onUpdate, onSent) {
  return new Promise(async (resolve, reject) => {
    const uid = S.user && S.user.uid; if (!uid) return reject(new Error("signed out"));
    const ref = doc(db, col, newId());
    let unsub = null, timer = null;
    const done = (fn, arg) => { clearTimeout(timer); if (unsub) unsub(); deleteDoc(ref).catch(() => {}); fn(arg); };
    // A write never gives up on its own: with no connection it waits in a queue indefinitely, so cap it here.
    try { await Promise.race([setDoc(ref, { uid, ...payload, status: "pending", createdAt: Date.now() }), new Promise((_, no) => setTimeout(() => no(new Error("couldn't reach Friendly's servers (check your connection)")), 45000))]); }
    catch (e) { deleteDoc(ref).catch(() => {}); return reject(e); }
    if (onSent) try { onSent(); } catch {}
    timer = setTimeout(() => done(reject, new Error("timed out")), timeoutMs);
    unsub = onSnapshot(ref, s => { const d = s.data(); if (!d) return; if (onUpdate) try { onUpdate(d); } catch {} if (d.status === "done") done(resolve, d); else if (d.status === "error") done(reject, new Error(d.error || "failed")); }, err => done(reject, err));
  });
}
async function scanReceipt(eventId, restrict, seed, groupId, file) {
  if (isDemo()) return toast("Receipt scanning is off in the demo -- try Add expense instead.");
  const f = file || await pickFile("image/*", "receipt"); if (!f) return;
  // Progress shows in the dialog, where the button was: each step named and timed, with a way out. Every step
  // has a time limit, so a stuck photo or a dead connection ends in a message rather than a spinner.
  const box = el("xScanBox"), was = box ? box.innerHTML : "", t0 = Date.now(); let cancelled = false, timer = 0, stage = "";
  const setStage = (s, note) => { stage = s; fz.add("receipt: " + s); fz.save(); const b = el("xScanStage"), n = el("xScanNote"); if (b) b.textContent = s; if (n) n.textContent = note || ""; };
  const restore = () => { clearInterval(timer); const bx = el("xScanBox"); if (!bx) return; bx.innerHTML = was; const sb = el("xScan"); if (sb) sb.onclick = () => scanReceipt(eventId, restrict, { desc: el("xDesc").value.trim(), paidBy: el("xPayer").value, people: splitPicked() }, groupId); };
  if (box) {
    box.innerHTML = `<div class="scan-prog"><img id="xScanThumb" alt="" hidden><div style="flex:1;min-width:0"><b id="xScanStage">Preparing the photo…</b><span class="muted sm" id="xScanNote">About 10 seconds in all.</span></div><button type="button" class="btn small" id="xScanCancel">Cancel</button></div>`;
    el("xScanCancel").onclick = () => { cancelled = true; fz.add("receipt: cancelled during " + stage); fz.save(); restore(); };
    timer = setInterval(() => { const n = el("xScanNote"), s = Math.round((Date.now() - t0) / 1000); if (n && s >= 3) n.textContent = `${s}s` + (s > 30 ? " · slower than usual, still trying" : ""); }, 1000);
  } else toast("Reading the receipt…", null, null, "thinking");
  const limit = (pr, ms, what) => Promise.race([pr, new Promise((_, no) => setTimeout(() => no(new Error(what)), ms))]);
  try {
    setStage("Preparing the photo…", "About 10 seconds in all.");
    const image = await limit(compressImage(f, 2000, 0.85), 25000, "the photo took too long to prepare");
    const thumb = await limit(compressImage(image, 1000, 0.72), 15000, "the photo took too long to prepare");   // kept on the expense; made from the prepared copy, not a second full-size decode
    if (cancelled) return;
    const im = el("xScanThumb"); if (im) { im.src = thumb; im.hidden = false; }
    pickerMark(null); setStage("Sending it to Dot…");
    const res = await requestViaFirestore("receiptRequests", { image }, 90000, null, () => { if (!cancelled) setStage("Dot is reading the receipt…"); });
    if (cancelled) return;
    fz.add("receipt: read " + ((res.data && res.data.items) || []).length + " lines in " + Math.round((Date.now() - t0) / 1000) + "s"); fz.save(); clearInterval(timer);
    itemizeDialog(eventId, restrict, seed, res.data || {}, thumb, groupId);
  } catch (e) {
    fz.add("receipt: failed during " + stage + ": " + e.message); fz.save(); if (cancelled) return;
    restore();
    const bx = el("xScanBox"); if (bx) { const n = document.createElement("p"); n.className = "muted sm oops"; n.style.marginTop = "6px"; n.textContent = "Couldn't read that receipt: " + String(e.message || "").replace(/\.+$/, "") + ". Try again, or type the amount above."; bx.appendChild(n); }
    else toast("Couldn't read that receipt: " + e.message);
  }
}
const toCents = v => Math.max(0, Math.round((Number(v) || 0) * 100));
// Each item's cost splits evenly among the people on it; tax and tip follow
// each person's share of the subtotal. Rounding drift lands on the biggest share.
function computeShares(items, tax, tip) {
  const sub = {}; let subtotal = 0;
  for (const it of items) {
    if (it.w) {   // portions (Pick your items): split by weight, the last person gets the leftover cent
      const who = Object.keys(it.w).filter(u => it.w[u] > 0); if (!who.length || !it.cents) continue;
      subtotal += it.cents; const tw = who.reduce((n, u) => n + it.w[u], 0); let given = 0;
      who.forEach((u, k) => { const c = k === who.length - 1 ? it.cents - given : Math.floor(it.cents * it.w[u] / tw); given += c; sub[u] = (sub[u] || 0) + c; });
      continue;
    }
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
  const pp = expensePeople(eventId, restrict, groupId);
  const keep = seed.people && seed.people.length > 1 ? new Set([...seed.people, seed.paidBy]) : null;   // the people already picked to split it
  const people = keep ? [...pp.main, ...pp.others].filter(([u]) => keep.has(u)) : [...pp.main, ...pp.others.filter(([u]) => u === seed.paidBy)];
  S._dlgGuests = Object.fromEntries([...pp.main, ...pp.others].filter(([u]) => isGuest(u)).map(([u, i]) => [u, i.name]));
  const items = (data.items || []).map(it => ({ name: String(it.name || "Item").slice(0, 60), cents: toCents(it.price), uids: new Set() }));
  const fees = Array.isArray(data.fees) ? data.fees.filter(f => f && toCents(f.amount)) : [];
  const st = { tax: toCents(data.tax), tip: toCents(data.tip), fees: fees.reduce((n, f) => n + toCents(f.amount), 0) }, printed = toCents(data.total);
  const chips = it => people.map(([u, i]) => `<button type="button" class="${it.uids.has(u) ? "on" : ""}" data-who="${u}">${esc(first(i.name))}</button>`).join("");
  const rowHtml = (it, k) => `<div class="itz-item" data-k="${k}">
      <input class="nm" value="${esc(it.name)}" maxlength="60" aria-label="Item">
      <input class="pr" inputmode="decimal" value="${(it.cents / 100).toFixed(2)}" aria-label="Price">
      <div class="who">${chips(it)}<button type="button" class="all" data-all="1">everyone</button></div></div>`;
  dialog(`<h3>Itemize${data.merchant ? " · " + esc(data.merchant) : ""}</h3>
    <div class="two"><label class="field"><span>What was it?</span><input id="xDesc" maxlength="80" value="${esc(seed.desc || data.merchant || "")}" placeholder="Dinner"></label>
    <label class="field"><span>Paid by</span><select id="xPayer">${payerOptions(pp, seed.paidBy)}</select></label></div>
    ${isDemo() ? "" : `<button type="button" class="btn pick-send" id="itzSend">👥 Send it to everyone to pick their own<span>They tap what they had, live. You pick for anyone not on Friendly.</span></button>`}
    <p class="muted sm" style="margin:-2px 0 6px">${isDemo() ? "" : "Or assign it yourself: "}Tap who had each line. Tax and tip are split in proportion to what each person ordered.</p>
    <div id="itz">${items.map(rowHtml).join("")}</div>
    <div class="btnrow" style="margin-top:8px"><button type="button" class="btn small" id="itzAdd">＋ Add a line</button>${isDemo() ? "" : `<button type="button" class="btn ghost small" id="xAddGuest">＋ Someone not on Friendly</button>`}</div><div id="xGuests"></div>
    <div class="three" style="margin-top:12px"><label class="field"><span>Tax ($)</span><input id="xTax" inputmode="decimal" value="${(st.tax / 100).toFixed(2)}"></label>
    <label class="field"><span>Fees ($)</span><input id="xFees" inputmode="decimal" value="${(st.fees / 100).toFixed(2)}"></label>
    <label class="field"><span>Tip ($)</span><input id="xTip" inputmode="decimal" value="${(st.tip / 100).toFixed(2)}"></label></div>
    ${fees.length ? `<p class="muted sm" style="margin:-4px 0 6px">Fees on the receipt: ${fees.map(f => esc(f.name) + " " + fmt$(toCents(f.amount))).join(", ")}. They split in proportion, like the tax.</p>` : ""}
    <div class="btnrow" style="margin-top:-4px;align-items:center;gap:6px"><span class="muted sm">${st.tip ? "Tip read from the receipt. Change it:" : "Tip not printed yet? Add it:"}</span>${[15, 18, 20].map(p => `<button type="button" class="btn ghost small" data-tip="${p}">${p}%</button>`).join("")}</div>
    <p class="muted sm" style="margin:4px 0 0">Receipts usually print before the tip is written in. Whatever you enter splits in proportion to each person's lines, same as the tax.</p>
    <div class="itz-sum card" id="itzSum"></div>`,
    "Add expense", async () => {
      const unassigned = items.filter(it => it.cents && !it.uids.size).length;
      if (unassigned) return toast(unassigned + " line" + (unassigned > 1 ? "s" : "") + " still need" + (unassigned > 1 ? "" : "s") + " a person.");
      const { shares, total } = computeShares(items, st.tax + st.fees, st.tip); const split = Object.keys(shares); if (!split.length) return toast("Assign at least one line.");
      const paidBy = el("xPayer").value; const involved = [...new Set([...split, paidBy])];
      const rec = { desc: el("xDesc").value.trim() || data.merchant || "Receipt", amountCents: total, paidBy, split, shares, involved, eventId: eventId || null, groupId: groupId || (eventId && (S.events.get(eventId) || {}).groupId) || matchGroupId(involved), addedBy: myUid(), createdAt: Date.now(),
        items: items.filter(it => it.cents).map(it => ({ name: it.name, cents: it.cents, uids: [...it.uids] })), tax: st.tax, tip: st.tip, fees: st.fees, feeNames: fees.map(f => String(f.name || "Fee").slice(0, 40)), merchant: data.merchant || "", receipt: receipt || "", guestNames: guestNamesFor(involved) };
      rec.groupId = groupId || (eventId && (S.events.get(eventId) || {}).groupId) || null;
      try { await saveExpense(rec); closeDialog(); toast("Itemized expense added"); textSettleUp(rec); } catch (e) { toast("Couldn't save that expense: " + e.message); }
    });
  const renderSum = () => {
    const { shares, subtotal, total } = computeShares(items, st.tax + st.fees, st.tip);
    // Check the lines against the printed total: every line counts here, assigned or not, and a tip that wasn't on
    // the receipt (added here) is left out, since the printed total can't include it.
    const lines = items.reduce((n, it) => n + (it.cents || 0), 0), printedTip = toCents(data.tip);
    const off = printed && Math.abs(printed - (lines + st.tax + st.fees + (printedTip ? st.tip : 0))) > 1 ? printed - (lines + st.tax + st.fees + (printedTip ? st.tip : 0)) : 0;
    el("itzSum").innerHTML = `<div><span>Subtotal</span><b>${fmt$(subtotal)}</b></div><div><span>Tax${st.fees ? ", fees," : ""} + tip</span><b>${fmt$(st.tax + st.fees + st.tip)}</b></div><div class="tot"><span>Total</span><b>${fmt$(total)}</b></div>
      ${off ? `<div class="itz-warn">The receipt's total is ${fmt$(printed)}, ${fmt$(Math.abs(off))} ${off > 0 ? "more" : "less"} than this. Check for a line or fee that's missing${off < 0 ? " or counted twice" : ""}.</div>` : ""}
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
  const crewExtra = [];   // people not on Friendly added here go out with the receipt too
  if (el("itzSend")) el("itzSend").onclick = async () => {
    const b = el("itzSend"); b.disabled = true; b.firstChild.textContent = "Sending…";
    const crew = [...new Set([...(seed.people && seed.people.length ? seed.people : people.map(([u]) => u)), ...crewExtra])];
    const names = Object.fromEntries([[myUid(), S.profile.name || "You"], ...people.map(([u, i]) => [u, i.name || nameOf(u)])]);
    try {
      const id = await sendPickToCrew({ items, tax: st.tax, fees: st.fees, tip: st.tip, feeNames: fees.map(f => String(f.name || "Fee").slice(0, 40)), desc: el("xDesc").value.trim(), merchant: data.merchant || "", paidBy: el("xPayer").value, people: crew, names, eventId, groupId: groupId || (eventId && (S.events.get(eventId) || {}).groupId) || null, receipt });
      closeDialog(); go("#/pick/" + id);
      if (crew.filter(u => u !== myUid()).length) toast("Sent! Everyone on it gets a notification.", null, null, "happy"); else setTimeout(() => openPickPeople(id), 700);
    } catch (e) { b.disabled = false; b.firstChild.textContent = "👥 Send it to everyone to pick their own"; toast("Couldn't send it: " + e.message); }
  };
  if (el("xAddGuest")) el("xAddGuest").onclick = () => guestAdder(el("xGuests"), (id, name) => {
    if (people.some(([u]) => u === id)) { toast(`${first(name)} is already on the list.`); return; }
    people.push([id, { name }]); crewExtra.push(id);
    document.querySelectorAll("#itz .itz-item .who").forEach(w => w.querySelector(".all").insertAdjacentHTML("beforebegin", `<button type="button" data-who="${esc(id)}">${esc(first(name))}</button>`));
    if (!el("xPayer").querySelector(`option[value="${CSS.escape(id)}"]`)) el("xPayer").insertAdjacentHTML("beforeend", `<option value="${esc(id)}">${esc(first(name))}</option>`);
    wireRows();
  });
  el("xTax").oninput = e => { st.tax = toCents(e.target.value); renderSum(); };
  el("xTip").oninput = e => { st.tip = toCents(e.target.value); renderSum(); };
  el("xFees").oninput = e => { st.fees = toCents(e.target.value); renderSum(); };
  document.querySelectorAll("[data-tip]").forEach(b => b.onclick = () => { const { subtotal } = computeShares(items, 0, 0); st.tip = Math.round(subtotal * +b.dataset.tip / 100); el("xTip").value = (st.tip / 100).toFixed(2); renderSum(); });
  wireRows(); renderSum();
}
// ---------- PICK YOUR ITEMS: a receipt the crew splits together, live ----------
// receiptSplits/{id} holds the creator's receipt (items, tax, fees, tip) and who's on it. Everyone taps what they
// had: picks.{person}.{itemId} = portions (1 by default; a shared line splits by portions, so "2 of the 3 tacos"
// works) and done.{person} once they're finished. Each person writes only their own picks, so taps that land at
// the same moment never clash. Only the creator edits the receipt, picks for people not on Friendly, and hands out
// what's left; Finish turns it into a normal itemized expense. The photo sits in files/receipt so the live doc
// stays small (every tap re-sends the doc to everyone watching).
let pickFor = null, pickId = "";
const splitTotal = t => (t.items || []).reduce((n, it) => n + (it.cents || 0), 0) + (t.tax || 0) + (t.fees || 0) + (t.tip || 0);
const pickName = (t, u) => u === myUid() ? "You" : (t.names || {})[u] || nameOf(u);
function pickClaims(t, it) { const out = {}; for (const u of t.people || []) { const w = ((t.picks || {})[u] || {})[it.id]; if (w > 0) out[u] = w; } return out; }
const pickShares = t => computeShares((t.items || []).map(it => ({ cents: it.cents, w: pickClaims(t, it) })), (t.tax || 0) + (t.fees || 0), t.tip || 0);
const pickLeft = t => (t.items || []).filter(it => it.cents && !Object.keys(pickClaims(t, it)).length);
const pickFace = (t, u, cls = "xs") => isGuest(u) ? `<span class="avatar ${cls} texted-av">${esc(initials(pickName(t, u)).slice(0, 1))}</span>` : avatar(u, cls);
function setPick(id, who, itemId, w) {
  updateDoc(doc(db, "receiptSplits", id), new FieldPath("picks", who, itemId), w > 0 ? w : deleteField()).catch(e => toast("Couldn't save that tap: " + e.message));
}
// Called from the itemize screen: the receipt as read so far (and any lines already assigned) goes out to the crew.
async function sendPickToCrew(r) {
  const me = myUid(), id = newId(), people = [...new Set([me, ...r.people])], picks = {};
  const items = r.items.filter(it => it.cents || it.name).map((it, k) => { const iid = "i" + k; for (const u of it.uids || []) if (people.includes(u)) (picks[u] = picks[u] || {})[iid] = 1; return { id: iid, name: (it.name || "Item").slice(0, 60), cents: it.cents || 0 }; });
  await setDoc(doc(db, "receiptSplits", id), { createdBy: me, paidBy: r.paidBy || me, desc: (r.desc || r.merchant || "Receipt").slice(0, 80), merchant: r.merchant || "", eventId: r.eventId || null, groupId: r.groupId || null,
    people, uids: people.filter(u => !isGuest(u)), names: r.names, items, tax: r.tax || 0, fees: r.fees || 0, feeNames: r.feeNames || [], tip: r.tip || 0, picks, done: {}, status: "open", hasReceipt: !!r.receipt, createdAt: Date.now() });
  if (r.receipt) setDoc(doc(db, "receiptSplits", id, "files", "receipt"), { image: r.receipt }).catch(() => {});
  return id;
}
function pickBody(id) {
  const t = (S.splits || new Map()).get(id);
  if (!t) return `<button class="link-back" data-go="#/money">‹ Money</button><div class="card empty" style="margin-top:14px">${dot("thinking", 64)}<b>${S.splitsReady ? "This receipt isn't shared with you" : "Opening the receipt…"}</b>${S.splitsReady ? `<p class="muted">Ask whoever paid to add you to it.</p>` : ""}</div>`;
  return `<div id="pickRoot" data-pid="${esc(id)}">${pickInner(t)}</div>`;
}
function pickInner(t) {
  const me = myUid(), boss = t.createdBy === me, open = t.status === "open";
  if (pickId !== t.id) { pickId = t.id; pickFor = me; }
  if (!(t.people || []).includes(pickFor) || !boss) pickFor = me;
  const { shares, subtotal, total } = pickShares(t), left = pickLeft(t), payer = pickName(t, t.paidBy);
  const head = `<button class="link-back" data-go="#/money">‹ Money</button>
    <div class="pk-head"><div style="flex:1;min-width:0"><h1>${esc(t.desc || "Receipt")}</h1><div class="muted sm">${payer === "You" ? "You paid" : esc(first(payer)) + " paid"} ${fmt$(splitTotal(t))}${t.merchant && t.merchant !== t.desc ? " · " + esc(t.merchant) : ""}</div></div>
    ${t.hasReceipt ? `<button type="button" class="btn small" id="pkPhoto">🧾 Receipt</button>` : ""}</div>`;
  if (!open) return head + `<div class="card empty" style="margin-top:14px">${dot("happy", 64)}<b>All split up</b><p class="muted">This receipt is now an expense${shares[me] ? `. Your share is <b>${fmt$(shares[me])}</b>` : ""}.</p>${t.expenseId ? `<button class="btn primary" data-go="#/x/${esc(t.expenseId)}">Open the expense</button>` : ""}</div>`;
  const state = u => (t.done || {})[u] ? "done" : Object.keys((t.picks || {})[u] || {}).length ? "picking" : "";
  const people = [...(t.people || [])].sort((a, b) => (a === me ? -1 : b === me ? 1 : 0));
  const strip = `<div class="pk-people">${people.map(u => `<button type="button" class="pk-person ${state(u)} ${boss && pickFor === u ? "for" : ""}" data-pkfor="${esc(u)}" ${boss ? "" : "tabindex=\"-1\""}>${pickFace(t, u, "lg")}<span class="pk-pn">${esc(u === me ? "You" : first(pickName(t, u)))}</span><span class="pk-ps">${state(u) === "done" ? "✓ Done" : state(u) === "picking" ? "Picking…" : isGuest(u) ? "You pick" : "Not yet"}</span></button>`).join("")}${boss ? `<button type="button" class="pk-person pk-add" id="pkAdd"><span class="avatar lg">＋</span><span class="pk-pn">Add</span><span class="pk-ps">people</span></button>` : ""}</div>`;
  const tools = boss ? `<div class="btnrow pk-tools"><button type="button" class="btn small" id="pkEdit">✏️ Edit receipt</button></div>` : "";
  const hint = boss && pickFor !== me ? `Picking for <b>${esc(first(pickName(t, pickFor)))}</b>. Tap what they had. <button type="button" class="linkish" data-pkfor="${esc(me)}">Back to you</button>`
    : `Tap what you had. Shared something? Tap it too and it splits.${boss ? " Tap a person to pick for them." : ""}`;
  const row = it => {
    const c = pickClaims(t, it), who = Object.keys(c), n = who.length, on = !!c[pickFor], tw = who.reduce((s, u) => s + c[u], 0), even = who.every(u => c[u] === c[who[0]]);
    const label = !n ? "Nobody yet" : n === 1 ? esc(who[0] === me ? "You" : first(pickName(t, who[0]))) + (c[who[0]] > 1 ? " ×" + c[who[0]] : "") : even ? `Split ${n} ways · ${fmt$(Math.round(it.cents / n))} each` : who.map(u => esc(first(pickName(t, u))) + (c[u] > 1 ? " ×" + c[u] : "")).join(", ");
    const mineCents = on && n > 1 ? Math.round(it.cents * c[pickFor] / tw) : 0;
    return `<div class="pk-item ${on ? "on" : ""} ${n ? "" : "open"}" data-pk="${esc(it.id)}" data-sig="${esc(JSON.stringify(c))}" role="button" tabindex="0">
      <div class="pk-main"><b>${esc(it.name)}</b><span class="pk-who">${who.slice(0, 5).map(u => pickFace(t, u)).join("")}<span>${label}</span></span></div>
      <div class="pk-right"><span class="pk-price">${fmt$(it.cents)}</span>${mineCents ? `<span class="pk-yours">${pickFor === me ? "you" : esc(first(pickName(t, pickFor)))} ${fmt$(mineCents)}</span>` : ""}${boss ? `<button type="button" class="pk-por" data-pkp="${esc(it.id)}">Who had it?</button>` : n > 1 ? `<button type="button" class="pk-por" data-pkp="${esc(it.id)}">Portions</button>` : ""}</div>
      <span class="pk-check" aria-hidden="true"></span></div>`;
  };
  const items = (t.items || []).filter(it => it.cents > 0);   // $0 lines (modifiers, comps) stay in Edit receipt
  const mineCount = items.filter(it => pickClaims(t, it)[pickFor]).length, done = !!(t.done || {})[me];
  const sum = `<div class="itz-sum card pk-sum"><div><span>Items</span><b>${fmt$(subtotal)}</b></div>${t.tax || t.fees ? `<div><span>Tax${t.fees ? " & fees" : ""}</span><b>${fmt$((t.tax || 0) + (t.fees || 0))}</b></div>` : ""}${t.tip ? `<div><span>Tip</span><b>${fmt$(t.tip)}</b></div>` : ""}<div class="tot"><span>Total</span><b>${fmt$(splitTotal(t))}</b></div>
    <div class="pk-shares">${people.map(u => `<div><span>${esc(pickName(t, u))}</span><b>${fmt$(shares[u] || 0)}</b></div>`).join("")}${left.length ? `<div class="muted"><span>Nobody yet</span><b>${fmt$(left.reduce((n, it) => n + it.cents, 0))} + tax & tip</b></div>` : ""}</div></div>`;
  const bar = `<div class="pk-bar"><div class="pk-me"><span class="muted sm">${pickFor === me ? "Your share" : esc(first(pickName(t, pickFor))) + "'s share"}</span><b>${fmt$(shares[pickFor] || 0)}</b><span class="muted sm">${mineCount} item${mineCount === 1 ? "" : "s"}${mineCount ? " · with tax & tip" : ""}</span></div>
    ${boss ? (left.length ? `<button type="button" class="btn primary" id="pkLeft">Assign ${left.length} left</button>` : `<button type="button" class="btn primary" id="pkFinish">Finish</button>`) : `<button type="button" class="btn ${done ? "" : "primary"}" id="pkDone">${done ? "✓ Done" : "I'm done"}</button>`}</div>`;
  return head + strip + tools + `<p class="pk-hint">${hint}</p><div class="pk-list">${items.map(row).join("")}</div>` + sum + bar;
}
function wirePick(id) {
  const root = el("pickRoot"); if (!root) return;
  const me = myUid(), cur = () => (S.splits || new Map()).get(id); const t = cur(); if (!t || t.status !== "open") { wirePickPhoto(id); return; }
  const boss = t.createdBy === me;
  root.querySelectorAll("[data-pk]").forEach(r => r.onclick = e => {
    const por = e.target.closest("[data-pkp]"); if (por) return openPortions(id, por.dataset.pkp);
    const x = cur(); if (!x || (pickFor !== me && x.createdBy !== me)) return;
    const had = ((x.picks || {})[pickFor] || {})[r.dataset.pk];
    r.classList.toggle("on", !had);   // instant feedback; the snapshot (local first) redraws it a moment later
    setPick(id, pickFor, r.dataset.pk, had ? 0 : 1);
    if (!had && navigator.vibrate) try { navigator.vibrate(8); } catch {}
  });
  root.querySelectorAll("[data-pkfor]").forEach(b => b.onclick = () => { if (!boss) return; pickFor = b.dataset.pkfor; patchPick(); });
  // I'm done: thank them and take them back where they came from (the event's Expenses, or Money); they can reopen it there.
  if (el("pkDone")) el("pkDone").onclick = () => { const x = cur(); const d = !!((x.done || {})[me]); updateDoc(doc(db, "receiptSplits", id), new FieldPath("done", me), d ? deleteField() : Date.now()).catch(e => toast(e.message));
    if (d) return; const back = x.eventId && S.events.has(x.eventId) ? "#/e/" + x.eventId + "?to=moneyCard" : "#/money";
    toast(`Thanks! Your picks are saved. Change them anytime from ${back === "#/money" ? "Money" : "the event's Expenses"}.`, null, null, "happy"); go(back); };
  if (el("pkLeft")) el("pkLeft").onclick = () => { const r = root.querySelector(".pk-item.open"); if (!r) return; r.scrollIntoView({ block: "center", behavior: "smooth" }); r.classList.remove("flash"); void r.offsetWidth; r.classList.add("flash"); toast("Tap a person above, then the lines that are theirs."); };
  if (el("pkFinish")) el("pkFinish").onclick = () => finishPick(id);
  if (el("pkAdd")) el("pkAdd").onclick = () => openPickPeople(id);
  if (el("pkEdit")) el("pkEdit").onclick = () => openPickEdit(id);
  wirePickPhoto(id);
}
function wirePickPhoto(id) {
  if (el("pkPhoto")) el("pkPhoto").onclick = async () => {
    try { const f = await getDoc(doc(db, "receiptSplits", id, "files", "receipt")); const img = (f.data() || {}).image; if (!img) return toast("The photo isn't available."); dialog(`<img src="${esc(img)}" alt="Receipt" style="width:100%;border-radius:12px;display:block">`, null); }
    catch (e) { toast("Couldn't load the photo: " + e.message); }
  };
}
// Live updates redraw only this page (the rest of the app stays put), keep the scroll, and flash lines that changed.
function patchPick() {
  const root = el("pickRoot"); if (!root) return; const t = (S.splits || new Map()).get(root.dataset.pid); if (!t) return renderSoon();
  const before = {}; root.querySelectorAll("[data-pk]").forEach(r => { before[r.dataset.pk] = r.dataset.sig; });
  root.innerHTML = pickInner(t); wirePick(t.id); wireShellLinks(root);
  root.querySelectorAll("[data-pk]").forEach(r => { if (before[r.dataset.pk] != null && before[r.dataset.pk] !== r.dataset.sig) r.classList.add("flash"); });
  if (S._porRedraw) S._porRedraw();
}
const wireShellLinks = box => box.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
// One line of the receipt. The creator ticks everyone who had it (portions when it wasn't even), fixes its name or
// price, or removes it; everyone else can add or adjust only themselves.
function openPortions(id, itemId) {
  const me = myUid(); let editing = false, armed = false;
  const draw = () => {
    const t = (S.splits || new Map()).get(id), it = t && (t.items || []).find(x => x.id === itemId); if (!it) return "";
    const c = pickClaims(t, it), who = Object.keys(c), tw = who.reduce((s, u) => s + c[u], 0), boss = t.createdBy === me;
    const list = boss ? [...(t.people || [])].sort((a, b) => (a === me ? -1 : b === me ? 1 : 0)) : who;
    const row = u => { const on = c[u] > 0, can = u === me || boss;
      return `<div class="por-row ${on ? "on" : ""}">${pickFace(t, u, "")}<div style="flex:1;min-width:0"><b>${esc(pickName(t, u))}</b><div class="muted sm">${on ? fmt$(Math.round(it.cents * c[u] / tw)) + (who.length > 1 && !who.every(x => c[x] === c[who[0]]) ? ` · ${c[u]} of ${tw} portions` : "") : "Didn't have it"}</div></div>
        ${on && can ? `<div class="stepper"><button type="button" data-porw="${esc(u)}|${c[u] - 1}" aria-label="Less">−</button><span>${c[u]}</span><button type="button" data-porw="${esc(u)}|${c[u] + 1}" aria-label="More">＋</button></div>` : on ? `<span class="por-n">${c[u]}</span>` : can ? `<button type="button" class="btn small" data-porw="${esc(u)}|1">Had it</button>` : ""}</div>`; };
    const head = editing ? `<div class="por-edit"><input id="porName" value="${esc(it.name)}" maxlength="60" aria-label="Item"><input id="porPrice" inputmode="decimal" value="${(it.cents / 100).toFixed(2)}" aria-label="Price"><button type="button" class="btn primary small" id="porSave">Save</button></div>`
      : `<h3>${esc(it.name)} · ${fmt$(it.cents)}</h3>`;
    return `${head}<p class="muted sm" style="margin-top:-8px">${boss ? "Tap Had it for everyone who shared it. It splits evenly; had 2 of the 3? Make theirs 2." : "It splits by portions. Had 2 of the 3? Make yours 2."}</p>
      <div class="por-list">${list.map(row).join("")}</div>
      ${!boss && !c[me] ? `<button type="button" class="btn small" data-porw="${esc(me)}|1">＋ I had some too</button>` : ""}
      ${boss ? `<div class="por-tools">${editing ? "" : `<button type="button" class="btn ghost small" id="porEditBtn">✏️ Name or price</button>`}<button type="button" class="btn ghost small por-del" id="porDel">${armed ? "Tap again to remove" : "Remove this line"}</button></div>` : ""}`;
  };
  dialog(`<div id="porBox">${draw()}</div>`, null);
  const ref = doc(db, "receiptSplits", id), items = () => (((S.splits || new Map()).get(id) || {}).items || []);
  const wire = () => {
    document.querySelectorAll("#porBox [data-porw]").forEach(b => b.onclick = () => { const [u, w] = b.dataset.porw.split("|"); setPick(id, u, itemId, Math.max(0, Math.min(20, +w))); });
    if (el("porEditBtn")) el("porEditBtn").onclick = () => { editing = true; S._porRedraw(); const n = el("porName"); if (n) n.focus(); };
    if (el("porSave")) el("porSave").onclick = () => { const name = el("porName").value.trim().slice(0, 60) || "Item", cents = toCents(el("porPrice").value);
      updateDoc(ref, { items: items().map(x => x.id === itemId ? { ...x, name, cents } : x) }).then(() => { editing = false; S._porRedraw(); }).catch(e => toast(e.message)); };
    if (el("porDel")) el("porDel").onclick = () => { if (!armed) { armed = true; S._porRedraw(); return; }
      updateDoc(ref, { items: items().filter(x => x.id !== itemId) }).then(() => { closeDialog(); toast("Line removed. Everyone sees the new totals."); }).catch(e => toast(e.message)); };
  };
  S._porRedraw = () => { const b = el("porBox"); if (!b) { S._porRedraw = null; return; } if (editing && el("porName")) return; b.innerHTML = draw() || `<p class="muted">That line was removed.</p>`; wire(); };
  wire();
}
function openPickEdit(id) {
  const t = (S.splits || new Map()).get(id); if (!t) return;
  const items = (t.items || []).map(it => ({ ...it }));
  const line = it => `<div class="pe-line" data-id="${esc(it.id)}"><input class="nm" value="${esc(it.name)}" maxlength="60" placeholder="Item" aria-label="Item"><input class="pr" inputmode="decimal" value="${it.cents ? (it.cents / 100).toFixed(2) : ""}" placeholder="0.00" aria-label="Price"><button type="button" class="pe-del" aria-label="Remove line">✕</button></div>`;
  const money = c => c ? (c / 100).toFixed(2) : "";
  dialog(`<h3>Edit the receipt</h3><p class="muted sm" style="margin-top:-8px">Everyone sees changes right away. Picks on a removed line are dropped.</p>
    <div id="peLines">${items.map(line).join("")}</div><button type="button" class="btn small" id="peAdd" style="margin-top:6px">＋ Add a line</button>
    <div class="three" style="margin-top:12px"><label class="field"><span>Tax ($)</span><input id="peTax" inputmode="decimal" value="${money(t.tax)}"></label><label class="field"><span>Fees ($)</span><input id="peFees" inputmode="decimal" value="${money(t.fees)}"></label><label class="field"><span>Tip ($)</span><input id="peTip" inputmode="decimal" value="${money(t.tip)}"></label></div>
    <div class="btnrow" style="gap:6px;align-items:center"><span class="muted sm">Tip:</span>${[15, 18, 20].map(p => `<button type="button" class="btn ghost small" data-petip="${p}">${p}%</button>`).join("")}</div>`,
    "Save", async () => {
      const next = [...document.querySelectorAll("#peLines .pe-line")].map((r, k) => ({ id: r.dataset.id || ("n" + Date.now().toString(36) + k), name: r.querySelector(".nm").value.trim().slice(0, 60) || "Item", cents: toCents(r.querySelector(".pr").value) })).filter(it => it.cents || it.name !== "Item");
      try { await updateDoc(doc(db, "receiptSplits", id), { items: next, tax: toCents(el("peTax").value), fees: toCents(el("peFees").value), tip: toCents(el("peTip").value) }); closeDialog(); toast("Receipt updated for everyone"); }
      catch (e) { toast("Couldn't save: " + e.message); }
    });
  const wireDel = () => document.querySelectorAll("#peLines .pe-del").forEach(b => b.onclick = () => b.closest(".pe-line").remove());
  el("peAdd").onclick = () => { el("peLines").insertAdjacentHTML("beforeend", line({ id: "", name: "", cents: 0 })); wireDel(); el("peLines").lastElementChild.querySelector(".nm").focus(); };
  document.querySelectorAll("[data-petip]").forEach(b => b.onclick = () => { const sub = [...document.querySelectorAll("#peLines .pr")].reduce((n, i) => n + toCents(i.value), 0); el("peTip").value = (Math.round(sub * +b.dataset.petip / 100) / 100).toFixed(2); });
  wireDel();
}
function openPickPeople(id) {
  const t = (S.splits || new Map()).get(id); if (!t) return;
  const me = myUid(), inT = new Set(t.people || []), added = {};
  const pp = { main: (t.people || []).map(u => [u, { name: (t.names || {})[u] || nameOf(u) }]), others: [...S.contacts.entries(), ...phonePeople(t.eventId, t.groupId).entries()].filter(([u]) => !inT.has(u)), checked: new Set(t.people || []), tags: new Map() };
  const known = Object.fromEntries([...pp.main, ...pp.others].map(([u, i]) => [u, i.name]));
  dialog(`<h3>Who's on this receipt?</h3><p class="muted sm" style="margin-top:-8px">Everyone you add gets a notification to pick their items. For people not on Friendly, you pick.</p>
    ${splitField(pp)}<div id="xGuests"></div><button type="button" class="btn ghost small" id="xAddGuest" style="margin-top:8px">＋ Someone not on Friendly</button>`, "Save", async () => {
    const next = [...new Set([me, ...splitPicked()])], gone = (t.people || []).filter(u => !next.includes(u)), names = { ...(t.names || {}) };
    next.forEach(u => { if (!names[u]) names[u] = added[u] || known[u] || (S.contacts.get(u) || {}).name || nameOf(u); });
    const args = ["people", next, "uids", next.filter(u => !isGuest(u)), "names", names];
    gone.forEach(u => { if ((t.picks || {})[u]) args.push(new FieldPath("picks", u), deleteField()); if ((t.done || {})[u]) args.push(new FieldPath("done", u), deleteField()); });
    try { await updateDoc(doc(db, "receiptSplits", id), ...args); closeDialog(); toast(next.length > inT.size ? "Added. They'll get a notification." : "Saved"); }
    catch (e) { toast("Couldn't save: " + e.message); }
  });
  const split = wireSplit(pp, t.eventId, null);
  el("xAddGuest").onclick = () => guestAdder(el("xGuests"), (gid, name) => { if (splitPicked().includes(gid)) return toast(`${first(name)} is already on it.`); added[gid] = name; split.add(gid, name); });
}
function finishPick(id) {
  const t = (S.splits || new Map()).get(id); if (!t) return;
  const { shares, total } = pickShares(t);
  dialog(`<h3>Finish and add the expense?</h3><p class="muted" style="margin-top:-6px">${esc(t.desc)} · ${fmt$(total)}. Everyone sees their share in Money.</p>
    <div class="itz-sum card">${Object.entries(shares).sort((a, b) => b[1] - a[1]).map(([u, c]) => `<div><span>${esc(pickName(t, u))}</span><b>${fmt$(c)}</b></div>`).join("")}</div>`, "Add the expense", async () => {
    const ok = el("dlgOk"); ok.disabled = true; ok.textContent = "Adding…";
    try {
      let receipt = ""; if (t.hasReceipt) { try { receipt = ((await getDoc(doc(db, "receiptSplits", id, "files", "receipt"))).data() || {}).image || ""; } catch {} }
      const split = Object.keys(shares), involved = [...new Set([...split, t.paidBy])];
      const rec = { desc: t.desc, amountCents: total, paidBy: t.paidBy, split, shares, involved, eventId: t.eventId || null, groupId: t.groupId || matchGroupId(involved), addedBy: myUid(), createdAt: Date.now(),
        items: (t.items || []).filter(it => it.cents).map(it => { const c = pickClaims(t, it); return { name: it.name, cents: it.cents, uids: Object.keys(c), ...(Object.values(c).some(v => v !== 1) ? { w: c } : {}) }; }),
        tax: t.tax || 0, tip: t.tip || 0, fees: t.fees || 0, feeNames: t.feeNames || [], merchant: t.merchant || "", receipt, guestNames: Object.fromEntries(involved.filter(isGuest).map(u => [u, (t.names || {})[u] || ""])), fromSplit: id };
      const xid = await saveExpense(rec);
      await updateDoc(doc(db, "receiptSplits", id), { status: "done", expenseId: xid });
      deleteDoc(doc(db, "receiptSplits", id, "files", "receipt")).catch(() => {});
      closeDialog(); toast("Expense added. Everyone sees their share.", null, null, "happy"); go("#/x/" + xid); textSettleUp(rec);
    } catch (e) { ok.disabled = false; ok.textContent = "Add the expense"; toast("Couldn't add it: " + e.message); }
  });
}
// Until anyone has paid, the person who added an itemized expense can reopen it as a live receipt: lines, people
// and picks stay as they were, the expense comes off everyone's balances, and Finish makes it again.
function reopenAsPick(x) {
  dialog(`<h3>Reopen this receipt?</h3><p>You can add or remove people, fix or remove lines, and change who had what. It comes off everyone's balances until you tap Finish again.</p>`, "Reopen", async () => {
    const ok = el("dlgOk"); ok.disabled = true; ok.textContent = "Reopening…";
    try {
      const me = myUid(); let id = x.fromSplit && S.splits && S.splits.has(x.fromSplit) && S.splits.get(x.fromSplit).createdBy === me ? x.fromSplit : "";
      if (id) { await updateDoc(doc(db, "receiptSplits", id), { status: "open", expenseId: deleteField() }); if (x.receipt) setDoc(doc(db, "receiptSplits", id, "files", "receipt"), { image: x.receipt }).catch(() => {}); }
      else {
        const people = [...new Set([me, ...(x.involved || [])])], names = {};
        people.forEach(u => { names[u] = (x.guestNames || {})[u] || (S.contacts.get(u) || {}).name || nameOf(u); });
        id = await sendPickToCrew({ items: (x.items || []).map(it => ({ name: it.name, cents: it.cents, uids: [] })), tax: x.tax, fees: x.fees, tip: x.tip, feeNames: x.feeNames, desc: x.desc, merchant: x.merchant, paidBy: x.paidBy, people, names, eventId: x.eventId, groupId: x.groupId, receipt: x.receipt });
        const args = []; (x.items || []).forEach((it, k) => (it.uids || []).forEach(u => { if (people.includes(u)) args.push(new FieldPath("picks", u, "i" + k), (it.w && it.w[u]) || 1); }));
        if (args.length) await updateDoc(doc(db, "receiptSplits", id), ...args);
      }
      await deleteDoc(doc(db, "expenses", x.id));
      closeDialog(); go("#/pick/" + id); toast("Reopened. Make your changes, then tap Finish.", null, null, "happy");
    } catch (e) { ok.disabled = false; ok.textContent = "Reopen"; toast("Couldn't reopen it: " + e.message); }
  });
}
// An evenly split expense: change who's in it (until anyone has paid).
function changeSplitPeople(x) {
  const base = expensePeople(x.eventId || null, null), pp = { ...base, checked: new Set(x.split || []) };
  const known = new Set([...pp.main, ...pp.others].map(([u]) => u)); (x.split || []).filter(u => !known.has(u)).forEach(u => pp.main.push([u, { name: (x.guestNames || {})[u] || nameOf(u) }]));
  const added = {};
  dialog(`<h3>Who's splitting ${esc(x.desc || "this")}?</h3>${splitField(pp)}<div id="xGuests"></div><button type="button" class="btn ghost small" id="xAddGuest" style="margin-top:8px">＋ Someone not on Friendly</button>`, "Save", async () => {
    const split = splitPicked(); if (!split.length) return toast("Pick who splits it.");
    const guestNames = { ...(x.guestNames || {}), ...added };
    try { await updateDoc(doc(db, "expenses", x.id), { split, involved: [...new Set([...split, x.paidBy])], guestNames }); closeDialog(); toast("Updated. Everyone's share changed with it."); }
    catch (e) { toast("Couldn't save: " + e.message); }
  });
  const sp = wireSplit(pp, x.eventId || null, null);
  el("xAddGuest").onclick = () => guestAdder(el("xGuests"), (gid, name) => { if (splitPicked().includes(gid)) return toast(`${first(name)} is already splitting it.`); added[gid] = name; sp.add(gid, name); });
}
// Open shared receipts on the Money tab.
// ---------- PITCH IN (collect money up front: a gift, a deposit, tickets) ----------
// A pitch-in is an expense with `pitch: { each, closes, goal }`: the collector is paidBy, everyone in is split with
// shares of `each`, so paying, Mark paid, reminders, and Settle up all work exactly as they do for any expense.
const pitchPaid = x => (x.split || []).filter(u => u !== x.paidBy && (x.paid || {})[u]);
const pitchLeft = x => (x.split || []).filter(u => u !== x.paidBy && !(x.paid || {})[u]);
const pitchTotal = x => (x.split || []).filter(u => u !== x.paidBy).length * x.pitch.each;
const pitchOpen = x => x.pitch && (pitchLeft(x).length > 0) && (!x.pitch.closes || x.pitch.closes >= addDays(todayStr(), -14));
function pitchProgress(x) {
  const got = pitchPaid(x).length * x.pitch.each, goal = x.pitch.goal || pitchTotal(x), pct = goal ? Math.min(100, Math.round(got / goal * 100)) : 0, people = (x.split || []).filter(u => u !== x.paidBy);
  return `<div class="card pi-card"><div class="pi-bar"><i style="width:${pct}%"></i></div><div class="pi-stats"><b>${fmt$(got)} of ${fmt$(goal)}</b><span class="muted sm">${pitchPaid(x).length} of ${people.length} have pitched in</span></div>
    <div class="pi-people">${people.map(u => `<span class="pi-p ${(x.paid || {})[u] ? "paid" : ""}" title="${esc(nameOf(u))}">${avatar(u, "sm")}<i>${(x.paid || {})[u] ? "✓" : ""}</i></span>`).join("")}</div></div>`;
}
function pitchCards() {
  const me = myUid(), list = [...S.expenses.values()].filter(x => x.pitch && pitchOpen(x) && (x.involved || []).includes(me)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  if (!list.length) return "";
  return `<div class="section-head"><h2>Pitch in</h2></div><div class="stack" id="pitchCard">${list.map(x => {
    const mine = x.paidBy === me, got = pitchPaid(x).length * x.pitch.each, goal = x.pitch.goal || pitchTotal(x), pct = goal ? Math.min(100, Math.round(got / goal * 100)) : 0, people = (x.split || []).filter(u => u !== x.paidBy), iPaid = !!(x.paid || {})[me], left = pitchLeft(x);
    const when = x.pitch.closes ? (x.pitch.closes < todayStr() ? " · closed " : " · closes ") + esc(fmtDay({ date: x.pitch.closes })) : "";
    return `<div class="card pi-card" data-pitch="${esc(x.id)}"><div class="pi-h">${avatar(x.paidBy, "lg")}<div style="flex:1;min-width:0"><b>${esc(x.desc)}</b><div class="muted sm">${mine ? "You're" : esc(first(nameOf(x.paidBy))) + " is"} collecting · ${fmt$(x.pitch.each)} each${when}</div></div></div>
      <div class="pi-bar"><i style="width:${pct}%"></i></div><div class="pi-stats"><b>${fmt$(got)} of ${fmt$(goal)}</b><span class="muted sm">${pitchPaid(x).length} of ${people.length} have pitched in</span></div>
      <div class="pi-people">${people.slice(0, 10).map(u => `<span class="pi-p ${(x.paid || {})[u] ? "paid" : ""}" title="${esc(nameOf(u))}">${avatar(u, "sm")}<i>${(x.paid || {})[u] ? "✓" : ""}</i></span>`).join("")}${people.length > 10 ? `<span class="muted sm">+${people.length - 10}</span>` : ""}</div>
      <div class="settle-actions pi-acts">${mine ? `${left.length ? `<button class="btn small" data-pinudge="${esc(x.id)}">🔔 Nudge the ${left.length} left</button>` : `<span class="pill ok">Everyone's in 🎉</span>`}<button class="btn small" data-xopen="${esc(x.id)}">Open</button>`
        : iPaid ? `<span class="pill ok">You pitched in ✓</span><button class="btn small" data-xopen="${esc(x.id)}">Open</button>` : `${payBtns(x.paidBy, x.pitch.each).replace(/>(Venmo|Cash App|Zelle)</g, (m, k) => `>${k} ${fmt$(x.pitch.each)}<`)}<button class="btn small" data-pipaid="${esc(x.id)}">Paid in cash</button>`}</div></div>`; }).join("")}</div>`;
}
function wirePitch() {
  document.querySelectorAll("[data-pinudge]").forEach(b => b.onclick = async () => { const x = S.expenses.get(b.dataset.pinudge); if (!x) return; const left = pitchLeft(x).filter(u => !isGuest(u)); b.disabled = true;
    try { await Promise.all(left.map(u => addDoc(collection(db, "nudges"), { expenseId: x.id, to: u, by: myUid(), createdAt: Date.now() }))); b.textContent = "Reminded ✓"; toast(`${left.length} ${left.length === 1 ? "person gets" : "people get"} a reminder.`, null, null, "coral:happy"); } catch (e) { toast(e.message); b.disabled = false; } });
  document.querySelectorAll("[data-pipaid]").forEach(b => b.onclick = async () => { const x = S.expenses.get(b.dataset.pipaid); if (!x) return; if (!confirm(`Mark your ${fmt$(x.pitch.each)} as paid? ${first(nameOf(x.paidBy))} will see it.`)) return;
    try { await updateDoc(doc(db, "expenses", x.id), { [`paid.${myUid()}`]: { at: Date.now(), by: myUid() } }); toast("You're in 🎉", null, null, "coral:party"); } catch (e) { toast(e.message); } });
}
function openPitchIn(groupId) {
  const me = myUid(), groups = [...S.groups.values()], friends = myFriendUids();
  let who = groupId && S.groups.get(groupId) ? groupId : groups[0] ? groups[0].id : "friends";
  const picked = new Set();
  const people = () => who === "pick" ? [...picked] : who === "friends" ? friends : ((S.groups.get(who) || {}).memberUids || []).filter(u => u !== me);
  const everyone = [...new Set([...friends, ...groups.flatMap(g => g.memberUids || []), ...S.contacts.keys()])].filter(u => u && u !== me && !isGuest(u)).map(u => [u, nameOf(u)]).sort((a, b) => a[1].localeCompare(b[1]));
  const sum = () => { const n = people().length, each = parseAmount(el("piEach").value) || 0; el("piSum").textContent = n && each ? `${n} ${n === 1 ? "person" : "people"} · ${fmt$(each * n)} total` : n ? `${n} ${n === 1 ? "person" : "people"}` : ""; };
  dialog(`<h3>Start a pitch-in</h3>
    <label class="field"><span>What for</span><input id="piDesc" maxlength="80" placeholder="Gigi's birthday gift 🎁"></label>
    <div class="two"><label class="field"><span>Each person pays ($)</span><input id="piEach" inputmode="decimal" placeholder="25"></label><label class="field"><span>Closes <span class="muted">(optional)</span></span><input type="date" id="piCloses" min="${todayStr()}"></label></div>
    <div class="muted sm" style="margin:4px 0 6px">Who's in</div><div class="chiprow" id="piWho" style="flex-wrap:wrap;overflow:visible;padding-bottom:0">${groups.map(g => `<button type="button" class="fchip ${who === g.id ? "on" : ""}" data-piw="${esc(g.id)}">${groupMini(g)} ${esc(g.name)} (${((g.memberUids || []).filter(u => u !== me)).length})</button>`).join("")}<button type="button" class="fchip ${who === "friends" ? "on" : ""}" data-piw="friends">All friends (${friends.length})</button><button type="button" class="fchip" data-piw="pick">Pick people</button></div>
    <div id="piPick" class="pi-pick" hidden><input type="search" id="piSearch" placeholder="Search people" autocomplete="off" aria-label="Search people">
      <div class="pi-pick-list">${everyone.map(([u, n]) => `<label class="pi-pick-row" data-pname="${esc(n.toLowerCase())}"><input type="checkbox" data-pip="${esc(u)}">${avatar(u, "sm")}<span>${esc(n)}</span></label>`).join("") || `<p class="muted sm">Nobody to pick yet. Add friends or a group first.</p>`}</div></div>
    <div class="muted sm" id="piSum" style="margin-top:6px"></div>
    <p class="muted sm" style="margin:10px 0 0">Everyone gets a nudge with your pay buttons. Money lands with you directly; you tick people off as it does, or they mark it themselves.</p>`,
    "Send it", async () => {
      const desc = el("piDesc").value.trim(), each = parseAmount(el("piEach").value), split = people();
      if (!desc) return toast("Say what it's for."); if (!each) return toast("Enter what each person pays."); if (!split.length) return toast("Pick who's in.");
      const rec = { desc, amountCents: each * split.length, paidBy: me, split: [...split], shares: Object.fromEntries(split.map(u => [u, each])), involved: [...new Set([me, ...split])], eventId: null, groupId: who === "friends" ? matchGroupId([me, ...split]) : who, addedBy: me, createdAt: Date.now(), guestNames: {}, pitch: { each, closes: el("piCloses").value || "", goal: each * split.length } };
      try { const id = await saveExpense(rec); closeDialog(); toast("Sent. You'll see each one land.", null, null, "coral:happy"); go("#/x/" + id); } catch (e) { toast("Couldn't start that: " + e.message); }
    });
  document.querySelectorAll("[data-piw]").forEach(b => b.onclick = () => { document.querySelectorAll("[data-piw]").forEach(x => x.classList.remove("on")); b.classList.add("on"); who = b.dataset.piw; el("piPick").hidden = who !== "pick"; if (who === "pick") el("piSearch").focus(); sum(); });
  document.querySelectorAll("[data-pip]").forEach(cb => cb.onchange = () => { cb.checked ? picked.add(cb.dataset.pip) : picked.delete(cb.dataset.pip); sum(); });
  el("piSearch").oninput = () => { const q = el("piSearch").value.trim().toLowerCase(); document.querySelectorAll(".pi-pick-row").forEach(r => { r.hidden = !!q && !r.dataset.pname.includes(q); }); };
  el("piEach").oninput = sum; sum();
}
function pickCards() {
  const me = myUid(), list = [...(S.splits || new Map()).values()].filter(t => t.status === "open").sort((a, b) => b.createdAt - a.createdAt);
  if (!list.length) return "";
  return `<div class="section-head" style="margin-top:6px"><h2>Pick your items</h2></div><div class="card">${list.map(t => { const left = pickLeft(t).length, boss = t.createdBy === me, done = (t.done || {})[me];
    const waiting = (t.uids || []).filter(u => u !== me && !(t.done || {})[u]).length;
    const sub = boss ? (left ? `${left} line${left === 1 ? "" : "s"} nobody has picked` : waiting ? `Waiting on ${waiting} ${waiting === 1 ? "person" : "people"}` : "Everyone's done · tap Finish") : done ? "You're done" : "Tap what you had";
    return `<div class="member-row dm-row" role="button" data-go="#/pick/${esc(t.id)}"><span class="li">🧾</span><div style="flex:1;min-width:0"><b>${esc(t.desc)}</b><div class="muted sm">${sub} · ${fmt$(splitTotal(t))}</div></div><span class="chev">›</span></div>`; }).join("")}</div>`;
}

// Mark as paid / received from a settle-up row: the pair is already known, so only the amount can change
// (for a partial payment). Undo is offered right after.
function openSettle(from, to, amount) {
  const me = myUid(), received = to === me, nm = u => u === me ? "You" : first(nameOf(u));
  dialog(`<h3>${received ? "Mark as received" : "Mark as paid"}</h3><p class="muted" style="margin-top:-6px">${received ? `${esc(nm(from))} paid you back outside Friendly?` : `You paid ${esc(nm(to))} outside Friendly?`} Log it here and the balances update. You can undo it right after.</p>
    <div class="settle-who">${avatar(from, "sm")}<b>${esc(nm(from))}</b><span class="muted">→</span>${avatar(to, "sm")}<b>${esc(nm(to))}</b></div>
    <label class="field"><span>Amount ($)</span><input id="sAmt" inputmode="decimal" value="${amount ? (amount / 100).toFixed(2) : ""}"></label><p class="muted sm" style="margin-top:-4px">Only part of it? Change the amount.</p>`,
    received ? "Mark received" : "Mark paid", async () => {
      const amt = parseAmount(el("sAmt").value); if (!amt) return toast("Enter a valid amount.");
      closeDialog(); markPaid(from, to, amt, "");
    });
}

// ---------- PROFILE ----------
// Push categories a person can turn on/off individually. Keys match what the
// notify() Cloud Function checks (functions/index.js NOTIF_CATEGORY); missing
// or true = on, so existing accounts keep getting everything until they opt out.
const NOTIF_CATS = [
  { key: "invites", label: "Invites & RSVPs" },
  { key: "chat", label: "Group chat & comments" },
  { key: "reminders", label: "Day-of reminders & nudges" },
  { key: "money", label: "Expenses & paybacks" },
  { key: "photos", label: "New photos" },
  { key: "birthdays", label: "Birthdays" },
];
function profileBody() {
  const p = S.profile;
  return `
  <button class="link-back" data-go="#/">‹ Back</button>
  <div class="profile-hero"><button type="button" class="avatar-edit" id="photoBtn" title="Change photo">${avatar(myUid(), "xxl")}<span class="cam">📷</span></button><div><h1>${esc(p.name)}</h1><div class="muted mono">${esc(p.email || "")}</div></div></div>
  <div class="form-card card" data-keep>
    <label class="field"><span>Name</span><input id="pName" value="${esc(p.name)}" maxlength="40"></label>
    <label class="field"><span>Email <span class="muted">(calendar invites, password reset)</span></span><input id="pEmail" type="email" value="${esc(p.email || "")}" placeholder="you@example.com" autocomplete="email"></label>
    ${IS_ANDROID ? `<label class="field"><span>Venmo</span><input id="pVenmo" value="${esc(p.venmo || "")}" placeholder="@sam-rivera"></label>` : `<div class="two"><label class="field"><span>Venmo</span><input id="pVenmo" value="${esc(p.venmo || "")}" placeholder="@sam-rivera"></label>
    <label class="field"><span>Phone (Apple Cash)</span><input id="pPhone" value="${esc(p.phone || "")}" placeholder="+1 555 123 4567"></label></div>`}
    <div class="two"><label class="field"><span>Zelle <span class="muted">(phone or email)</span></span><input id="pZelle" value="${esc(p.zelle || "")}" placeholder="+1 555 123 4567"></label>
    <label class="field"><span>Cash App</span><input id="pCashapp" value="${esc(p.cashapp || "")}" placeholder="$samrivera"></label></div>
    <label class="field"><span>Preferred way to get paid back</span><select id="pPayPref">${payPrefOptions(p.payPref || "")}</select></label>
    <label class="field"><span>Birthday <span class="muted">(so your groups can plan something)</span></span><input id="pBday" type="date" value="${esc(p.birthday || "")}"></label>
    <label class="field"><span>Home city <span class="muted">(for nights out nearby)</span></span><input id="pCity" value="${esc(p.city || "")}" placeholder="Start typing a city" maxlength="60" autocomplete="off"></label>
    <p class="muted sm">Your payment handles are shared only with people in your groups, so they can pay you back.</p>
    <button class="btn primary" id="saveProfile">Save profile</button>
  </div>
  <div class="section-head" style="margin-top:22px"><h2>Notifications</h2></div>
  <div class="card member-row"${NATIVE ? ' id="notifRow" style="cursor:pointer"' : ""}><span class="li">🔔</span><div style="flex:1;min-width:0"><b>${({ on: "On for this device", off: "Off", denied: "Blocked in your browser settings", unsupported: "Not available in this browser", native: "Managed in iPhone Settings" })[pushState()]}</b><div class="muted sm">${IOS && !STANDALONE && pushState() === "off" ? "Add Friendly to your Home Screen first (Share → Add to Home Screen)." : NATIVE ? "Tap to open Notification settings." : "Invites, comments, RSVPs, and day-of reminders."}</div></div>${NATIVE ? `<span class="chev">›</span>` : pushState() === "off" ? `<button class="btn small primary" id="pushToggle">Turn on</button>` : pushState() === "on" ? `<button class="btn small" id="pushToggle">Turn off</button>` : ""}</div>
  ${pushState() !== "unsupported" ? `<div class="card" id="notifPrefs" style="padding:12px 16px;margin-top:8px">
    <p class="muted sm" style="margin:0 0 4px">What you get notified about${["native", "on"].includes(pushState()) ? "" : " (once notifications are on)"}:</p>
    ${NOTIF_CATS.map(c => `<label class="switch" style="margin:8px 0"><input type="checkbox" data-notifpref="${c.key}" ${(p.notifPrefs || {})[c.key] !== false ? "checked" : ""}><span>${esc(c.label)}</span></label>`).join("")}
  </div>` : ""}
  <div class="section-head" style="margin-top:22px"><h2>Calendar sync</h2></div>
  <div class="card" style="padding:14px 16px"><p class="muted sm" style="margin:0 0 10px">Subscribe once and every event you're invited to appears in your calendar and stays up to date when plans change.</p>
    <div class="btnrow"><button class="btn primary small" id="calSubscribe">Add to iPhone / Apple Calendar</button><button class="btn small" id="calCopy">Copy link for Google Calendar</button></div>
    <p class="muted sm" style="margin:8px 0 0">Google Calendar: Other calendars → ＋ → From URL → paste the link. Calendars refresh on their own schedule (usually within a few hours).</p></div>
  <div class="section-head" style="margin-top:22px"><h2>Account</h2></div>
  <button class="btn tour-btn" id="takeTour">${dot("happy", 26)}<span>Take the tour with Dot</span></button>
  <div class="btnrow" style="gap:8px;margin:0 0 12px"><button class="btn" id="bugBtn" style="flex:1">🐞 Report a bug</button>${shakeNeedsPermission() && !shakeOn() ? `<button class="btn" id="shakeOn" style="flex:1">📳 Turn on shake to report</button>` : ""}</div>
  <button class="btn danger-ghost" id="signOut" style="width:100%;justify-content:center;font-weight:700;border:1.5px solid var(--bad)">Sign out</button>
  <div class="section-head" style="margin-top:22px"><h2>Blocked people</h2></div>
  <div class="card">${(p.blockedUids || []).length ? p.blockedUids.map(u => `<div class="member-row">${avatar(u, "lg")}<div style="flex:1;min-width:0"><b>${esc(nameOf(u))}</b><div class="muted sm">You don't see anything they post.</div></div><button class="btn small" data-unblock="${u}">Unblock</button></div>`).join("") : `<p class="muted sm" style="padding:14px 16px;margin:0">Nobody blocked. Use ⋯ on a message or photo to report it or block the person.</p>`}</div>
  <div class="section-head" style="margin-top:22px"><h2>Delete account</h2></div>
  <div class="card" style="padding:14px 16px"><p class="muted sm" style="margin:0 0 10px">Deleting removes your profile and sign-in permanently. Groups you own pass to another member.</p><button class="btn danger-ghost" id="deleteAccount">Delete my account</button></div>
  ${isAdmin() ? `<div class="section-head" style="margin-top:28px"><h2>Reports <span class="muted sm">moderation</span></h2></div>
  <div class="card" id="reportsCard"><p class="muted" style="padding:14px 16px;margin:0">Loading…</p></div>
  <div class="section-head" style="margin-top:22px"><h2>Bug reports</h2></div>
  <div class="card" id="bugsCard"><p class="muted" style="padding:14px 16px;margin:0">Loading…</p></div>` : ""}`;
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
    const urgent = r => /child safety/i.test(r.reason || "") ? 1 : 0;   // child safety reports first, always
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => urgent(b) - urgent(a) || b.createdAt - a.createdAt);
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
  attachPlaces(el("pCity"), { cities: true });
  if (el("saveProfile")) el("saveProfile").onclick = async () => {
    const name = el("pName").value.trim(); if (!name) return toast("Name can't be empty.");
    const venmo = el("pVenmo").value.trim(), phone = el("pPhone") ? el("pPhone").value.trim() : (S.profile.phone || ""), zelle = ((el("pZelle") || {}).value || "").trim(), cashapp = ((el("pCashapp") || {}).value || "").trim(), payPref = (el("pPayPref") || {}).value || "";
    const handleFor = { venmo, apple: phone, zelle, cashapp };
    if (payPref && !handleFor[payPref]) return toast("Add your " + PAY_METHODS[payPref] + " above, or pick another preferred method.");
    try {
      const birthday = (el("pBday") || {}).value || "";
      const email = (el("pEmail") || {}).value || ""; if (email && !email.includes("@")) return toast("That email doesn't look right.");
      const city = el("pCity") ? await pickedCity(el("pCity"), true) : (S.profile.city || ""); if (city === null) return;
      await updateDoc(doc(db, "users", myUid()), { name, venmo, phone, zelle, cashapp, payPref, city, cityGuess: deleteField(), phoneE164: toE164(phone) || myPhoneE164(), birthday, email: email.trim().toLowerCase() });
      if (city) registerCity(city);
      // propagate name/contact into each group's denormalized members map
      for (const g of S.groups.values()) if ((g.memberUids || []).includes(myUid())) await updateDoc(doc(db, "groups", g.id), { [`members.${myUid()}`]: { name, venmo, phone, os: myOs(), zelle, cashapp, payPref, photo: myPhotoSm(), birthday } }).catch(() => {});
      for (const f of S.friends.values()) await updateDoc(doc(db, "friendships", f.id), { [`people.${myUid()}.name`]: name }).catch(() => {});
      toast("Profile saved");
    } catch (e) { toast(e.message); }
  };
  if (el("takeTour")) el("takeTour").onclick = () => { go("#/"); setTimeout(() => { tourStep = 0; showTourStep(); }, 500); };
  el("signOut").onclick = async () => {
    const b = el("signOut"); if (b.disabled) return; b.disabled = true; b.textContent = "Signing out…";
    try { clearBadge(); } catch {} try { stopListening(); } catch {}
    await within(signOut(auth), 3000);
    wipeLocalData();
  };
  const pt = el("pushToggle"); if (pt) pt.onclick = () => pushState() === "on" ? disableWebPush() : enableWebPush();
  const nr = el("notifRow"); if (nr) nr.onclick = () => { location.href = "app-settings:"; };
  document.querySelectorAll("[data-notifpref]").forEach(cb => cb.onchange = () => updateDoc(doc(db, "users", myUid()), { [`notifPrefs.${cb.dataset.notifpref}`]: cb.checked }).catch(e => toast(e.message)));
  el("photoBtn").onclick = async () => {
    const f = await pickFile("image/*", "profile photo"); if (!f) return;
    const cropped = await openCropDialog(f); if (!cropped) return;
    toast("Updating photo…");
    try {
      const photo = await compressImage(cropped, 320, 0.82), photoSm = await compressImage(cropped, 160, 0.8);
      await updateDoc(doc(db, "users", myUid()), { photo, photoSm });
      for (const g of S.groups.values()) if ((g.memberUids || []).includes(myUid())) await updateDoc(doc(db, "groups", g.id), { [`members.${myUid()}.photo`]: photoSm }).catch(() => {});
      for (const f of S.friends.values()) await updateDoc(doc(db, "friendships", f.id), { [`people.${myUid()}.photo`]: photoSm }).catch(() => {});
      toast("Photo updated");
    } catch (e) { toast(e.message); }
  };
  // Calendar feed: a private token on the profile, made on first use.
  const calUrl = async () => {
    let t = S.profile.calToken;
    if (!t) { t = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join(""); await updateDoc(doc(db, "users", myUid()), { calToken: t }); }
    return FN_BASE + "/cal?u=" + myUid() + "&t=" + t;
  };
  if (el("calSubscribe")) el("calSubscribe").onclick = async () => { try { const u = await calUrl(); location.href = u.replace(/^https:/, "webcal:"); } catch (e) { toast(e.message); } };
  if (el("calCopy")) el("calCopy").onclick = async () => { try { const u = await calUrl(); await navigator.clipboard.writeText(u); toast("Link copied. Google Calendar: Other calendars → From URL"); } catch (e) { toast(e.message); } };
  wireReports(); wireBugs();
  if (el("bugBtn")) el("bugBtn").onclick = () => openBugDialog();
  if (el("shakeOn")) el("shakeOn").onclick = async () => { if (await enableShake()) { toast("Shake your phone anytime to report a bug", null, null, "happy"); render(); } else toast("Motion access wasn't allowed. You can still use Report a bug."); };
  // App Store requires in-app account deletion (guideline 5.1.1). Re-auth first:
  // Firebase refuses to delete a user without a recent sign-in.
  document.querySelectorAll("[data-unblock]").forEach(b => b.onclick = async () => { try { await updateDoc(doc(db, "users", myUid()), { blockedUids: arrayRemove(b.dataset.unblock) }); toast("Unblocked"); } catch (e) { toast(e.message); } });
  if (el("deleteAccount")) el("deleteAccount").onclick = () => dialog(`
    <h2>Delete your account?</h2>
    <p class="muted">This removes your profile, sign-in, and notifications, and takes you out of your groups. Events and expenses you were part of stay visible to the other people involved.</p>
    <label class="field"><span>Confirm your password</span><input type="password" id="delPw" autocomplete="current-password"></label>`,
    "Delete account", deleteAccount);
}
async function deleteAccount() {
  if (isDemo()) { closeDialog(); return toast("Account deletion is off in the demo."); }
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
    closeDialog(); toast("Your account has been deleted."); setTimeout(wipeLocalData, 1500);
  } catch (e) { toast(e.code === "auth/invalid-credential" || e.code === "auth/wrong-password" ? "That password didn't match." : e.message); }
}

// ---------- FRIENDS & PRIVATE MESSAGES ----------
// Friends connect one-on-one (no shared group needed): friendships/{a_b} is "pending" until the
// other person accepts. Accepted friends can message in dms/{a_b}/messages; the server keeps the
// conversation's last message and read marks (onDmMessage) and pushes the other person.
const pairOf = u => [myUid(), u].sort().join("_");
const otherIn = f => ((f && f.uids) || String((f && f.id) || "").split("_")).find(x => x !== myUid());
const friendshipWith = u => S.friends.get(pairOf(u));
const isFriend = u => (friendshipWith(u) || {}).status === "accepted";
const incomingRequests = () => [...S.friends.values()].filter(f => f.status === "pending" && f.requestedBy !== myUid());
const outgoingRequests = () => [...S.friends.values()].filter(f => f.status === "pending" && f.requestedBy === myUid());
const acceptedFriends = () => [...S.friends.values()].filter(f => f.status === "accepted");
const dmIsUnread = t => !!(t && t.lastBy && t.lastBy !== myUid() && (t.lastAt || 0) > ((t.readAt || {})[myUid()] || 0));
const dmUnread = () => [...S.dms.values()].filter(t => dmIsUnread(t) && !(S.profile.blockedUids || []).includes(otherIn(t)) && (t.lastAt || 0) > ((S.profile.hiddenDms || {})[t.id] || 0)).length;
const msgBadge = () => { try { return dmUnread() + incomingRequests().length; } catch { return 0; } };
const personName = u => nameOf(u) !== "Someone" ? nameOf(u) : "Friend";

async function sendFriendRequest(u) {
  const f = friendshipWith(u);
  if (f && f.status === "pending" && f.requestedBy === u) return acceptFriend(f);
  if (f) return;
  const me = myUid(), info = S.contacts.get(u) || { name: nameHint(u) };
  try {
    await setDoc(doc(db, "friendships", pairOf(u)), { uids: [me, u].sort(), requestedBy: me, status: "pending", createdAt: Date.now(),
      people: { [me]: { name: S.profile.name || "Friend", photo: myPhotoSm() }, [u]: { name: info.name || "Friend", photo: info.photo || "" } } });
    toast(`Friend request sent to ${first(personName(u))}`, null, null, "happy");
  } catch (e) { toast(/permission/i.test(e.message) ? "Couldn't send that request." : e.message); }
}
async function acceptFriend(f) {
  try { await updateDoc(doc(db, "friendships", f.id), { status: "accepted", acceptedAt: Date.now() }); toast(`You and ${first(personName(otherIn(f)))} are friends now`, null, null, "party"); }
  catch (e) { toast(e.message); }
}
async function dropFriendship(f, msg) { try { await deleteDoc(doc(db, "friendships", f.id)); if (msg) toast(msg); } catch (e) { toast(e.message); } }

// Add friends: anyone you know from groups and events, contacts, or a phone number.
function openAddFriendsDialog() {
  const exclude = new Set([myUid(), ...[...S.friends.values()].map(otherIn)]);
  pickPeopleDialog({
    title: "Add friends",
    blurb: "Friends can message each other one-on-one, even if you're not in a group together. They'll get a request to accept.",
    exclude, submitLabel: "Send requests", knownLabel: "On Friendly · gets a friend request", phoneLabel: "We'll find them, or you can text an invite",
    onSubmit: async (direct, texted) => {
      for (const p of direct) await sendFriendRequest(p.uid);
      closeDialog();
      if (!texted.length) return;
      // Numbers we don't recognize: the server looks them up. Anyone not on Friendly yet gets a text from you,
      // and the request waits for them (it becomes real the moment they sign up with that number).
      toast("Looking them up…", null, null, "thinking");
      const results = await Promise.all(texted.map(async p => {
        try {
          const waiting = (S.textInvites || []).find(r => r.phone === p.e164 && r.status === "notOnFriendly");
          if (waiting) return { ...p, status: "notOnFriendly" };
          const ref = await addDoc(collection(db, "friendRequests"), { from: myUid(), fromName: S.profile.name || "", name: p.name || "", phone: p.e164, createdAt: Date.now() });
          const status = await new Promise(res => { const t = setTimeout(() => { un(); res("sent"); }, 9000); const un = onSnapshot(ref, d => { const st = d.exists() && d.data().status; if (st) { clearTimeout(t); un(); res(st); } }, () => { clearTimeout(t); res("sent"); }); });
          return { ...p, status };
        } catch { return { ...p, status: "error" }; }
      }));
      const notOn = results.filter(r => r.status === "notOnFriendly");
      const sent = results.filter(r => ["sent", "accepted", "pending", "already"].includes(r.status)).length;
      if (sent) toast(`${sent} friend request${sent === 1 ? "" : "s"} sent`, null, null, "happy");
      if (notOn.length) {
        const text = FRIEND_TEXT;
        setTimeout(() => { if (notOn.length === 1) location.href = smsLink([notOn[0].e164], text); else openTextInviteDialog(notOn, text, "friends"); }, 500);
      }
    }
  });
}

function friendActions(u) {
  if (!S.msgsReady || u === myUid() || isDemo() && !String(u).startsWith("demo-")) return "";
  const f = friendshipWith(u);
  if (f && f.status === "accepted") return `<button type="button" class="btn primary" data-go="#/m/${pairOf(u)}">💬 Message</button>`;
  if (f && f.requestedBy === u) return `<button type="button" class="btn primary" data-friendaccept="${f.id}">✓ Accept friend request</button>`;
  if (f) return `<button type="button" class="btn" disabled>Friend request sent</button>`;
  return `<button type="button" class="btn" data-friendadd="${u}">＋ Add friend</button>`;
}
function wireFriendButtons(root = document) {
  root.querySelectorAll("[data-friendadd]").forEach(b => b.onclick = async () => { b.disabled = true; await sendFriendRequest(b.dataset.friendadd); closeDialog(); });
  root.querySelectorAll("[data-friendaccept]").forEach(b => b.onclick = async () => { const f = S.friends.get(b.dataset.friendaccept); if (f) { b.disabled = true; await acceptFriend(f); } closeDialog(); });
}

// The Friends page (the 👥 circle), three tabs: Friends (requests to answer, then everyone you're friends with),
// Messages (the inbox), and Invited (everyone you've invited anywhere who hasn't joined or answered yet).
function messagesBody(tab = "messages") {
  const me = myUid(), blocked = new Set(S.profile.blockedUids || []);
  const inc = incomingRequests().filter(f => !blocked.has(otherIn(f)));
  const friends = acceptedFriends().filter(f => !blocked.has(otherIn(f)));
  // A deleted conversation stays hidden until something new arrives; pinned ones sit on top as big circles.
  const cleared = S.profile.hiddenDms || {}, pins = S.profile.pinnedDms || [], muted = new Set(S.profile.mutedDms || []);
  const live = t => t && t.lastAt && t.lastAt > (cleared[t.id] || 0);
  const threads = friends.map(f => ({ f, t: S.dms.get(f.id) })).filter(x => live(x.t) && !pins.includes(x.f.id)).sort((a, b) => b.t.lastAt - a.t.lastAt);
  const pinned = pins.map(id => friends.find(f => f.id === id)).filter(Boolean);
  const row = (u, mid, right, go, extra = "") => `<div class="member-row ${go ? "dm-row" : ""}" data-find="${esc((personName(u) + " " + extra).toLowerCase())}" ${go ? `data-go="${go}" role="button"` : ""}>${avatar(u, "lg")}<div style="flex:1;min-width:0">${mid}</div>${right}</div>`;
  const inv = invitedRows();
  const T = (k, label, n, hot) => `<button type="button" class="tab ${tab === k ? "on" : ""}" data-go="#/${k}">${label}${n ? `<span class="fr-n${hot ? " hot" : ""}">${n}</span>` : ""}</button>`;
  const head = `<div class="section-head msg-head"><h1 style="margin:0">Friends</h1><span class="btnrow" style="gap:8px;margin:0"><button class="btn small" id="addFriendsBtn">＋ Add friends</button>${tab === "messages" ? `<button class="btn primary small" id="newMsgBtn">✏️ New</button>` : ""}</span></div>
  <div class="tabs fr-tabs">${T("friends", "Friends", inc.length || friends.length, !!inc.length)}${T("messages", "Messages", dmUnread(), true)}${T("invited", "Invited", inv.length)}</div>`;
  const reqs = inc.length ? `<div class="section-head" style="margin-top:18px"><h2>Friend requests</h2></div>
<div class="card" id="reqCard">${inc.map(f => { const u = otherIn(f); return row(u, `<b>${esc(personName(u))}</b><div class="muted sm">Wants to be friends</div>`, `<span class="btnrow" style="gap:6px"><button class="btn small primary" data-friendaccept="${f.id}">Accept</button><button class="btn ghost small" data-frienddecline="${f.id}">Decline</button></span>`); }).join("")}</div>` : `<div id="reqCard"></div>`;
  const search = ph => `<input type="search" class="inv-search msg-search" id="msgSearch" placeholder="${ph}" autocomplete="off" enterkeyhint="search">
  <p class="muted sm hidden" id="msgNoHits" style="margin:6px 2px">Nothing matches that.</p>`;
  if (tab === "invited") return head + invitedBody(inv);
  if (tab === "friends") {
    const all = friends.map(otherIn).sort((a, b) => personName(a).localeCompare(personName(b)));
    return head + reqs + (all.length ? `${search("Search your friends…")}
  <div class="section-head" style="margin-top:18px"><h2>All friends</h2><span class="muted sm">${all.length}</span></div>
  <div class="card">${all.map(u => { const shared = [...S.groups.values()].filter(g => (g.memberUids || []).includes(u)).map(g => g.name);   // group members become friends automatically; say which group
    return row(u, `<b>${esc(personName(u))}</b><div class="muted sm">${shared.length ? `${esc(shared[0])}${shared.length > 1 ? ` +${shared.length - 1}` : ""} · ` : ""}Our Friendlyship ›</div>`, `<button class="btn small" data-go="#/m/${pairOf(u)}" data-stop="1">Message</button>`, "#/fs/" + u); }).join("")}</div>`
      : inc.length ? "" : emptyState("👥", "No friends yet", "Add friends to message them one-on-one, even if you're not in a group together.", "coral:happy"));
  }
  const reqLink = inc.length ? `<button type="button" class="req-link" data-go="#/friends">👋 ${inc.length === 1 ? "1 friend request" : inc.length + " friend requests"} waiting <span>›</span></button>` : "";
  return head + reqLink + (threads.length || pinned.length ? `${search("Search messages…")}
  ${pinned.length ? `<div class="dm-pins">${pinned.map(f => { const u = otherIn(f), t = S.dms.get(f.id); return `<button type="button" class="dm-pin" data-go="#/m/${f.id}" data-find="${esc(personName(u).toLowerCase())}">${avatar(u, "xl")}${dmIsUnread(t) ? `<span class="dm-dot"></span>` : ""}<span>${esc(first(personName(u)))}</span></button>`; }).join("")}</div>` : ""}
  ${threads.length ? `<div class="card" style="margin-top:18px">${threads.map(({ f, t }) => { const u = otherIn(f); const unread = dmIsUnread(t);
      return row(u, `<b>${esc(personName(u))}</b>${muted.has(f.id) ? ` <span title="Alerts hidden">🔕</span>` : ""}<div class="muted sm dm-last ${unread ? "unread" : ""}">${t.lastBy === me ? "You: " : ""}${esc(t.lastText || "")}</div>`, `<span class="muted sm">${ago(t.lastAt)}</span>${unread ? `<span class="dm-dot" aria-label="Unread"></span>` : ""}`, "#/m/" + f.id, t.lastText || ""); }).join("")}</div>` : ""}` : emptyState("💬", "No conversations yet", friends.length ? "Tap ✏️ New to message a friend." : "Add friends to message them one-on-one, even if you're not in a group together.", "happy"));
}
// Everyone you've invited anywhere and are still waiting on: friend requests you sent, friends you texted to join,
// people invited to groups you host who haven't joined, and people who haven't answered your upcoming events.
// ---------- OUR FRIENDLYSHIP: your history with one person ----------
// Opened from a friend's row in Friends and from anyone's profile card. Everything comes from what the app already
// holds (plans you both went to, their photos, expenses and paybacks between you, groups you share, reactions on
// each other's photos); comments between you load once the page is open, from the plans you shared.
function fsData(u) {
  const me = myUid(), t = todayStr(), f = friendshipWith(u);
  const both = ev => { const r = ev.rsvps || {}, inv = new Set(ev.invitedUids || []); if (!inv.has(me) || !inv.has(u) || ev.kind === "meeting") return false; return ev.date < t ? r[me] === "going" && r[u] === "going" : r[me] !== "no" && r[u] !== "no"; };
  const evs = [...S.events.values()].filter(both);
  const past = evs.filter(ev => ev.date < t).sort((a, b) => b.date.localeCompare(a.date)), next = evs.filter(ev => ev.date >= t).sort((a, b) => a.date.localeCompare(b.date));
  const photos = past.flatMap(ev => (S.memories.get(ev.id) || []).map(p => ({ p, ev })));
  const xs = [...S.expenses.values()].filter(x => (x.involved || []).includes(u) && (x.involved || []).includes(me)).sort((a, b) => b.createdAt - a.createdAt);
  const ss = [...S.settlements.values()].filter(s => (s.from === u && s.to === me) || (s.from === me && s.to === u)).sort((a, b) => b.createdAt - a.createdAt);
  const bal = pairwise().find(p => (p.from === u && p.to === me) || (p.from === me && p.to === u));
  const all = [...S.memories.values()].flat(), rx = (list, who) => list.reduce((n, p) => n + Object.values(p.reactions || {}).filter(us => Array.isArray(us) && us.includes(who)).length, 0);
  const spots = {}; past.forEach(ev => { const g = ev.groupId && S.groups.get(ev.groupId), k = g ? `${groupMini(g)} ${esc(g.name)}` : ev.location ? esc(placeName(ev.location)) : ""; if (k) spots[k] = (spots[k] || 0) + 1; });
  const top = Object.entries(spots).sort((a, b) => b[1] - a[1])[0];
  const since = Math.min((f && f.createdAt) || Infinity, ...past.map(ev => evDate(ev).getTime()), ...xs.map(x => x.createdAt || Infinity));
  return { evs, past, next, photos, xs, ss, bal, top, since, split: xs.reduce((n, x) => n + (x.amountCents || 0), 0),
    theyOnMine: rx(all.filter(p => p.addedBy === me), u), meOnTheirs: rx(all.filter(p => p.addedBy === u), me),
    groups: [...S.groups.values()].filter(g => (g.memberUids || []).includes(u) && (g.memberUids || []).includes(me)) };
}
// The Friendlyship mark (Dot and a coral friend) and wordmark; the big one animates the first time a page opens.
const fsPair = (size, still) => window.Blip && window.Blip.pair ? window.Blip.pair({ size, still }) : "";
// "ship" fades coral to yellow letter by letter and does a little shimmy now and then.
const fsWord = () => `<span class="fs-word">Friend<span class="tilt">l</span>y<span class="ship" aria-label="ship">${[..."ship"].map((c, i) => `<span style="--i:${i}" aria-hidden="true">${c}</span>`).join("")}</span></span>`;
// How much of each section shows; See more adds a page at a time.
const FS_STEP = { mem: 9, next: 3, past: 5, money: 5, cm: 4, groups: 6 };
const fsShown = (u, k) => ((S._fsMore && S._fsMore.u === u && S._fsMore[k]) || FS_STEP[k]);
const fsMoreBtn = (k, left) => left > 0 ? `<button type="button" class="fs-more" data-fsmore="${k}">See more <span>${left} more</span></button>` : "";
function friendshipBody(u) {
  const me = myUid(), fn = first(personName(u)), d = fsData(u), play = S._fsPlayed !== u ? "play" : ""; S._fsPlayed = u;
  const hi = coralPop();   // Coral's hello (first Friendlyship page on this phone): she waves and bounces while it shows
  const stat = (n, l) => `<div class="fs-stat"><b>${n}</b><span>${l}</span></div>`;
  const hero = `<button class="link-back" data-go="#/friends">‹ Friends</button>
    <div class="fs-hero"><div class="fs-faces">${avatar(me, "xl")}<span class="fs-pair ${play} ${hi ? "intro" : ""}">${fsPair(104)}${hi}</span>${avatar(u, "xl")}</div>
      <div class="fs-kicker">Our ${fsWord()}</div><h1>You & ${esc(fn)}</h1>
      ${isFinite(d.since) ? `<div class="muted sm">Making plans together since ${new Date(d.since).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</div>` : ""}
      <div class="fs-stats">${stat(d.evs.length, d.evs.length === 1 ? "plan together" : "plans together")}${stat(d.photos.length, d.photos.length === 1 ? "photo" : "photos")}${stat(fmt$(d.split).replace(/\.00$/, ""), "split together")}</div>
      <div class="btnrow fs-acts">${isFriend(u) ? `<button class="btn primary" data-go="#/m/${pairOf(u)}">💬 Message</button>` : ""}<button class="btn" id="fsPlan">＋ Plan something together</button></div></div>`;
  return `<div class="fs-page">${hero}<div id="fsRest">${fsRest(u, d)}</div></div>`;
}
// Tap Dot or Coral on a Friendlyship page: a profile for each. Dot is the planner; Coral, her best friend, is the
// fun one (more energy, more chaos, more photos). PG-13 on purpose.
const MASCOTS = {
  dot: { name: "Dot", tag: "Friendly's planner-in-chief", coral: false, other: "coral",
    vibes: ["🔋 Steady energy", "📋 Certified Type A", "☕ Iced coffee, always"],
    bio: ["Hi, I'm Dot. I started out as the dot over the y in Friendly and grew into a pebble with opinions. I'm the one who actually makes the plan: I pick the place, chase the maybes, paint the cover, and read the receipt so nobody has to do math three drinks in.",
      "People call me the mom friend. I prefer \"head of logistics.\" I care a lot, I overthink a little, and yes, I remember exactly who said they were coming and then didn't."],
    night: "Dinner at 7, a second spot within walking distance, home by midnight. Coral has other ideas. Coral always has other ideas.",
    takes: ["\"Maybe\" isn't an RSVP. It's a cry for help.", "Splitting the bill evenly when you had a side salad and water? Absolutely not.", "Every group chat gets 48 hours: make the plan or let it die."],
    facts: [["🎂", "Born", "The day Friendly was, already holding a clipboard"], ["🦸", "Superpower", "Turning \"we should hang out\" into a date, a time, and a place"], ["🙈", "Guilty pleasure", "Color-coding a calendar nobody else looks at"],
      ["😤", "Pet peeve", "\"I'm 5 minutes away\" (they are in the shower)"], ["🎨", "Side hustle", "Painting covers. Beret on, judgment off."], ["🏆", "Most likely to", "Send the reminder text, then the reminder about the reminder"],
      ["👯", "Best friend", "Coral. She's pure chaos and I'd take a bullet for her."]] },
  coral: { name: "Coral", tag: "Dot's best friend · the fun one", coral: true, other: "dot",
    vibes: ["⚡ 1,000% energy", "🎉 Chaos, but make it cute", "🍹 \"One more round\""],
    bio: ["Hiii, I'm Coral! Dot's best friend and the reason your group chat has 47 unread messages. I came from the coral l in Friendly, which is why I'm a little tilted. That's my story and I'm sticking to it.",
      "Dot makes the plan; I make it a night. I start the photo dump, remember every inside joke, and keep track of who owes who, because somebody has to, and let's be honest, it's not going to be you."],
    night: "Starts on a rooftop, ends at a diner at 2 AM, with one detour nobody can fully explain the next morning.",
    takes: ["Every great night needs one bad decision. A small one. Like karaoke.", "No photos? Then it didn't happen.", "\"I'll Venmo you later\" is the biggest lie in friendship."],
    facts: [["🎂", "Born", "Right next to Dot in the Friendly logo, already waving"], ["🦸", "Superpower", "Never forgetting a birthday, an inside joke, or a tab"], ["🐿️", "Attention span", "Golden retriever at a squirrel convention"],
      ["🙈", "Guilty pleasure", "Saying \"one more drink\" and meaning four"], ["🎤", "Banned from", "Two karaoke bars and one group chat. Worth it."], ["🏆", "Most likely to", "Start the dance floor, then make sure everyone gets home safe"],
      ["👯", "Best friend", "Dot. She's the brains, I'm the hype. It works."]] }
};
// The first Friendlyship page on a phone: Coral says hi in a small bubble over her head that fades on its own.
function coralPop() {
  let seen = false; try { seen = LS.get("friendlyCoralHi") === "1"; LS.set("friendlyCoralHi", "1"); } catch {}
  return seen ? "" : `<button type="button" class="coral-pop" id="coralPop">Hi, I'm Coral! Dot's best friend 👋</button>`;
}
function openMascot(k) {
  const m = MASCOTS[k]; if (!m || !window.Blip) return;
  dialog(`<div class="mascot-card m-${k}">${window.Blip.svg({ mood: "happy", size: 112, wave: true, coral: m.coral })}<h2>${m.name}</h2><span class="mascot-tag">${m.tag}</span>
    <div class="mascot-vibes">${m.vibes.map(v => `<span>${esc(v)}</span>`).join("")}</div>
    ${m.bio.map(p => `<p class="mascot-bio">${esc(p)}</p>`).join("")}
    <div class="mascot-sec">Ideal night out</div><div class="card mascot-night">🌙 ${esc(m.night)}</div>
    <div class="mascot-sec">Hot takes</div><div class="card mascot-takes">${m.takes.map(t => `<div>🔥 ${esc(t)}</div>`).join("")}</div>
    <div class="mascot-sec">Fun facts</div><div class="card mascot-facts">${m.facts.map(([i, l, v]) => `<div class="member-row"><span class="li">${i}</span><div style="flex:1;min-width:0"><div class="muted sm">${l}</div><b>${esc(v)}</b></div></div>`).join("")}</div>
    <button type="button" class="linkish mascot-other" id="mascotOther">Meet ${MASCOTS[m.other].name} ›</button></div>`, null);
  el("mascotOther").onclick = () => openMascot(m.other);
  // open at the top (the dialog otherwise scrolls down to its only button)
  const top = () => { const d = el("appDialog"); if (d) d.scrollTop = 0; if (document.activeElement && document.activeElement.id === "mascotOther") document.activeElement.blur(); };
  top(); requestAnimationFrame(top); setTimeout(top, 60);
}
// What counts as a milestone between two people: plans, photos, money split, and years of plans together.
function fsMilestones(d) {
  const plans = d.evs.length, photos = d.photos.length, dollars = Math.round((d.split || 0) / 100), years = isFinite(d.since) ? Math.floor((Date.now() - d.since) / (365.25 * 864e5)) : 0;
  const out = [];
  [1, 5, 10, 25, 50, 100].forEach(n => out.push({ id: "p" + n, done: plans >= n, title: n === 1 ? "First plan together" : `${n} plans together`, sub: n === 1 ? "It all started somewhere." : "That's a lot of good nights.", left: `${n - plans} more plan${n - plans === 1 ? "" : "s"} to go` }));
  [1, 10, 50].forEach(n => out.push({ id: "f" + n, done: photos >= n, title: n === 1 ? "First photo together" : `${n} photos together`, sub: "Memories, made.", left: `${n - photos} more photo${n - photos === 1 ? "" : "s"} to go` }));
  [100, 500, 1000, 5000].forEach(n => out.push({ id: "d" + n, done: dollars >= n, title: `$${n.toLocaleString()} split together`, sub: "And nobody argued about the bill.", left: `$${(n - dollars).toLocaleString()} more to go` }));
  [1, 2, 3, 5, 10].forEach(n => out.push({ id: "y" + n, done: years >= n, title: `${n} year${n === 1 ? "" : "s"} of plans`, sub: "Still making plans. That's the good stuff.", left: "" }));
  const order = x => ({ p: 0, f: 1, d: 2, y: 3 })[x.id[0]] * 1000 + parseInt(x.id.slice(1), 10);
  return out.sort((a, b) => order(a) - order(b)).filter(x => x.done || x.left);
}
function fsRest(u, d) {
  const me = myUid(), fn = first(personName(u)), n = k => fsShown(u, k);
  const when = ev => { const x = evDate(ev); return `${MONTHS[x.getMonth()]} ${x.getDate()}${x.getFullYear() !== new Date().getFullYear() ? ", " + x.getFullYear() : ""}`; };
  const first1 = d.past[d.past.length - 1];
  const hl = [first1 && ["🥇", "First plan together", `${esc(first1.title)} · ${when(first1)}`, first1.id], d.top && d.top[1] > 1 && ["📍", "Your spot", `${d.top[0]} · ${d.top[1]} times`], d.next[0] && ["🔜", "Next up", `${esc(d.next[0].title)} · ${when(d.next[0])}`, d.next[0].id]].filter(Boolean);
  const ms = fsMilestones(d), reached = ms.filter(x => x.done), nextUp = ms.find(x => !x.done);
  const milestones = reached.length || nextUp ? `<div class="section-head"><h2>Milestones</h2><span class="muted sm">Coral keeps count</span></div><div class="card">${reached.slice(-3).reverse().map(x => `<div class="member-row"><span class="li ms-li">${coral("party", 28)}</span><div style="flex:1;min-width:0"><b>${esc(x.title)}</b><div class="muted sm">${esc(x.sub)}</div></div></div>`).join("")}${nextUp ? `<div class="member-row ms-next"><span class="li ms-li">${coral("idle", 28)}</span><div style="flex:1;min-width:0"><div class="muted sm">Next up</div><b>${esc(nextUp.title)}</b><div class="muted sm">${esc(nextUp.left)}</div></div></div>` : ""}</div>` : "";
  { const key = "friendlyFsMs:" + u, had = (LS.get(key) || "").split(",").filter(Boolean), now = reached.map(x => x.id); const fresh = had.length ? now.filter(id => !had.includes(id)) : [];
    if (now.join(",") !== had.join(",")) LS.set(key, now.join(","));
    if (fresh.length) { const x = reached.find(y => y.id === fresh[fresh.length - 1]); setTimeout(() => coralCheer(x.title + " with " + fn + "!", x.sub), 900); } }
  const highlights = hl.length ? `<div class="section-head"><h2>Highlights</h2></div><div class="card">${hl.map(([i, k, v, id]) => `<div class="member-row ${id ? "dm-row" : ""}" ${id ? `data-go="#/e/${id}" role="button"` : ""}><span class="li">${i}</span><div style="flex:1;min-width:0"><div class="muted sm">${k}</div><b>${v}</b></div>${id ? `<span class="chev">›</span>` : ""}</div>`).join("")}</div>` : "";
  const mem = d.photos.length ? `<div class="section-head"><h2>Memories</h2><span class="muted sm">${d.photos.length} from your plans</span></div><div class="photo-grid mem-grid fs-mem">${d.photos.slice(0, n("mem")).map(({ p, ev }) => `<div class="photo-tile"><img src="${esc(p.img)}" data-fsp="${esc(ev.id)}|${esc(p.id)}" alt="" loading="lazy">${photoBadges(p)}</div>`).join("")}</div>${fsMoreBtn("mem", d.photos.length - n("mem"))}` : "";
  const evRow = ev => { const k = (S.memories.get(ev.id) || []).length, host = ev.hostId === u ? `${esc(fn)} hosted` : ev.hostId === me ? "You hosted" : "";
    return `<div class="member-row dm-row" data-go="#/e/${ev.id}" role="button">${ev.cover ? `<img class="fs-thumb" src="${esc(ev.cover)}" alt="">` : `<span class="fs-thumb fs-emo">${esc(ev.emoji || "🎉")}</span>`}<div style="flex:1;min-width:0"><b>${esc(ev.title)}</b><div class="muted sm">${when(ev)}${host ? " · " + host : ""}${k ? ` · ${k} photo${k === 1 ? "" : "s"}` : ""}</div></div><span class="chev">›</span></div>`; };
  const plans = d.evs.length ? `<div class="section-head"><h2>Plans together</h2></div><div class="card">${d.next.length ? `<div class="fs-sub">Coming up</div>${d.next.slice(0, n("next")).map(evRow).join("")}${fsMoreBtn("next", d.next.length - n("next"))}` : ""}${d.past.length ? `<div class="fs-sub">Been there</div>${d.past.slice(0, n("past")).map(evRow).join("")}${fsMoreBtn("past", d.past.length - n("past"))}` : ""}</div>` : "";
  const share = x => x.shares ? (x.shares[u] || 0) : ((x.split || []).includes(u) ? Math.round(x.amountCents / x.split.length) : 0);
  const balLine = !d.bal ? `<div class="member-row"><span class="li">✅</span><div style="flex:1"><b>You're all square</b></div></div>` : d.bal.to === me ? `<div class="member-row"><span class="li">💸</span><div style="flex:1"><b>${esc(fn)} owes you ${fmt$(d.bal.amount)}</b></div><button class="btn small" data-go="#/money">Settle up</button></div>` : `<div class="member-row"><span class="li">💸</span><div style="flex:1"><b>You owe ${esc(fn)} ${fmt$(d.bal.amount)}</b></div><button class="btn small primary" data-go="#/money">Pay</button></div>`;
  const rows = [...d.xs.map(x => ({ at: x.createdAt, html: `<div class="ledger dm-row" data-go="#/x/${x.id}" role="button"><div class="li">🧾</div><div style="flex:1;min-width:0"><b>${esc(x.desc || "Expense")}</b><div class="muted sm">${x.paidBy === me ? "You paid" : x.paidBy === u ? esc(fn) + " paid" : esc(first(nameOf(x.paidBy))) + " paid"}${share(x) && x.paidBy !== u ? ` · ${esc(fn)}'s share ${fmt$(share(x))}` : ""}</div></div><span class="amt sm">${fmt$(x.amountCents)}</span></div>` })),
    ...d.ss.map(s => ({ at: s.createdAt, html: `<div class="ledger"><div class="li">✅</div><div style="flex:1;min-width:0"><b>${s.from === me ? "You paid " + esc(fn) : esc(fn) + " paid you"}</b><div class="muted sm">${esc(s.method || "Payback")} · ${new Date(s.createdAt).toLocaleDateString()}</div></div><span class="amt sm">${fmt$(s.amountCents)}</span></div>` }))].sort((a, b) => b.at - a.at);
  const money = rows.length ? `<div class="section-head"><h2>Money between you</h2><span class="muted sm">${fmt$(d.split)} split in ${d.xs.length} expense${d.xs.length === 1 ? "" : "s"}</span></div><div class="card">${balLine}${rows.slice(0, n("money")).map(r => r.html).join("")}${fsMoreBtn("money", rows.length - n("money"))}</div>` : "";
  const back = `<div class="section-head"><h2>Back and forth</h2></div><div class="card" id="fsBack">${fsBackInner(u, d)}</div>`;
  const gs = d.groups, groups = gs.length ? `<div class="section-head"><h2>Groups you share</h2></div><div class="fs-groups">${gs.slice(0, n("groups")).map(g => `<button class="fchip" data-go="#/g/${g.id}">${groupMini(g)} ${esc(g.name)}</button>`).join("")}${gs.length > n("groups") ? `<button class="fchip" data-fsmore="groups">+${gs.length - n("groups")} more</button>` : ""}</div>` : "";
  const empty = !d.evs.length && !d.xs.length ? `<div class="card empty" style="margin-top:14px">${dot("happy", 64)}<b>Your story starts here</b><p class="muted">Plans you go to together, photos, and money between you will show up here.</p></div>` : "";
  return empty + highlights + milestones + mem + plans + money + back + groups;
}
function fsBackInner(u, d) {
  const fn = first(personName(u)), c = S._fsComments && S._fsComments.u === u ? S._fsComments.list : null;
  const times = n => n + (n === 1 ? " time" : " times"), them = d.theyOnMine ? `${esc(fn)} reacted to your photos ${times(d.theyOnMine)}` : "", you = d.meOnTheirs ? `You reacted to ${esc(fn)}'s ${times(d.meOnTheirs)}` : "";
  const rx = them || you ? `<div class="member-row"><span class="li">❤️</span><div style="flex:1;min-width:0"><b>${them || you}</b>${them && you ? `<div class="muted sm">You reacted to theirs ${times(d.meOnTheirs)}</div>` : ""}</div></div>` : "";
  const list = c == null ? `<p class="muted sm" style="padding:10px 14px;margin:0">Gathering comments…</p>` : c.length ? c.slice(0, fsShown(u, "cm")).map(x => `<div class="fs-cm dm-row" data-go="#/e/${x.evId}" role="button">${avatar(x.authorId, "sm")}<div style="flex:1;min-width:0"><div class="muted sm"><b>${esc(x.authorId === myUid() ? "You" : fn)}</b> on ${esc(x.evTitle)} · ${ago(x.createdAt)}</div><div class="fs-cm-t">${renderText(x.text || "", x.mentions)}</div></div></div>`).join("") + fsMoreBtn("cm", c.length - fsShown(u, "cm")) : `<p class="muted sm" style="padding:10px 14px;margin:0">No comments between you yet.</p>`;
  return rx + list;
}
// Comments you two left on the plans you shared (latest 30, shown a few at a time), loaded when the page opens.
async function fsLoadComments(u) {
  const me = myUid(), d = fsData(u), evs = [...d.next, ...d.past].slice(0, 12), out = [];
  await Promise.all(evs.map(async ev => { try { const snap = await getDocs(query(collection(db, "events", ev.id, "comments"), where("authorId", "in", [me, u]), limit(30)));
    snap.docs.forEach(x => { const c = x.data(); if (!c.kind && c.text) out.push({ ...c, evId: ev.id, evTitle: ev.title }); }); } catch {} }));
  S._fsComments = { u, list: out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 30) };
  fsPatch(u);
}
function fsPatch(u) {
  const rest = el("fsRest"); if (!rest || S.route.name !== "friendship" || S.route.id !== u) return;
  rest.innerHTML = fsRest(u, fsData(u)); wireFsRest(u);
}
function wireFsRest(u) {
  const rest = el("fsRest"); if (!rest) return;
  rest.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  rest.querySelectorAll("[data-fsmore]").forEach(b => b.onclick = () => { const k = b.dataset.fsmore; if (!S._fsMore || S._fsMore.u !== u) S._fsMore = { u }; S._fsMore[k] = fsShown(u, k) + (k === "money" || k === "groups" ? 10 : FS_STEP[k] * (k === "cm" ? 1.5 : 1)); fsPatch(u); });
  rest.querySelectorAll("[data-fsp]").forEach(im => im.onclick = () => { const [eid, pid] = im.dataset.fsp.split("|"), ev = S.events.get(eid), p = (S.memories.get(eid) || []).find(x => x.id === pid); if (ev && p) openPhoto(ev, p); });
}
function wireFriendship(u) {
  document.querySelectorAll(".fs-hero .fsp-l, .fs-hero .fsp-r").forEach(g => g.onclick = e => { e.stopPropagation(); openMascot(g.classList.contains("fsp-l") ? "dot" : "coral"); });
  if (el("coralPop")) { el("coralPop").onclick = () => openMascot("coral"); setTimeout(() => { const c = el("coralPop"); if (c) c.remove(); }, 6500); }
  if (el("fsPlan")) el("fsPlan").onclick = () => { resetCompose(); compose.invitees.add(u); go("#/new"); toast(`Planning with ${first(personName(u))}. Pick a theme and a time.`, null, null, "happy"); };
  if (!S._fsMore || S._fsMore.u !== u) S._fsMore = { u };
  wireFsRest(u);
  if (!S._fsComments || S._fsComments.u !== u) fsLoadComments(u);
  if (fsData(u).past.some(ev => !S.memories.has(ev.id)) && !S._memLoading) { S._memLoading = true; loadMemories(false).then(() => { S._memLoading = false; S._memFreshAt = Date.now(); fsPatch(u); }); }
}

function invitedRows() {
  const me = myUid(), t = todayStr(), out = [];
  for (const f of outgoingRequests()) out.push({ kind: "request", uid: otherIn(f), id: f.id });
  for (const r of invitedByText()) out.push({ kind: "text", phone: r.phone, name: r.name || "", id: r.id, at: r.createdAt });
  for (const g of S.groups.values()) {
    if (g.ownerId !== me && !(g.hostUids || []).includes(me)) continue;
    for (const p of g.invitedPhones || []) out.push({ kind: "group", phone: p, name: (g.invitedPhoneNames || {})[p] || "", g });
    for (const e of g.invitedEmails || []) out.push({ kind: "group", email: e, g });
  }
  for (const ev of myEvents()) {
    if (!canManage(ev) || (ev.date || "") < t) continue;
    for (const p of unansweredPhones(ev)) out.push({ kind: "event", phone: p, name: (ev.invitedPhoneNames || {})[p] || "", ev });
    for (const u of ev.invitedUids || []) if (u !== me && !(ev.rsvps || {})[u]) out.push({ kind: "event", uid: u, ev });
  }
  return out;
}
function invitedBody(inv) {
  if (!inv.length) return emptyState("✉️", "No open invites", "When you invite people to Friendly, a group, or an event, anyone who hasn't joined or answered yet shows up here.", "happy");
  const ghost = ico => `<span class="avatar lg" style="background:#CBB;opacity:.6">${ico}</span>`;
  const r = (lead, title, sub, right, find) => `<div class="member-row" data-find="${esc(String(find || title).toLowerCase())}">${lead}<div style="flex:1;min-width:0"><b>${title}</b><div class="muted sm">${sub}</div></div>${right}</div>`;
  const who = x => esc(x.name || (x.phone ? fmtPhone(x.phone) : x.email || ""));
  const textBtn = (attr, val) => `<button class="btn small" ${attr}="${esc(val)}">Text again</button>`;
  const reqs = inv.filter(x => x.kind === "request"), texts = inv.filter(x => x.kind === "text");
  const groups = [...new Set(inv.filter(x => x.kind === "group").map(x => x.g))], events = [...new Set(inv.filter(x => x.kind === "event").map(x => x.ev))].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const sec = (title, sub, rows, go) => `<div class="section-head inv-sec" style="margin-top:18px"><div style="min-width:0"><h2>${title}</h2>${sub ? `<div class="muted sm">${sub}</div>` : ""}</div>${go ? `<a class="btn small ghost" data-go="${go}">Open ›</a>` : ""}</div><div class="card">${rows}</div>`;
  return `<input type="search" class="inv-search msg-search" id="msgSearch" placeholder="Search everyone you've invited…" autocomplete="off" enterkeyhint="search">
  <p class="muted sm hidden" id="msgNoHits" style="margin:6px 2px">Nothing matches that.</p>
  ${reqs.length ? sec("Friend requests", "waiting on them", reqs.map(x => r(avatar(x.uid, "lg"), esc(personName(x.uid)), "Friend request sent", `<button class="btn ghost small" data-friendcancel="${x.id}">Cancel</button>`, personName(x.uid))).join("")) : ""}
  ${texts.length ? sec("Texted to join Friendly", "not on Friendly yet", texts.map(x => r(ghost("💬"), who(x), `${x.name ? esc(fmtPhone(x.phone)) + " · " : ""}texted ${ago(x.at)}. Your friend request is waiting for them.`, `<span class="btnrow" style="gap:6px">${textBtn("data-textagain", x.id)}<button class="btn ghost small" data-untext="${x.id}" aria-label="Remove">✕</button></span>`, (x.name || "") + " " + x.phone)).join("")) : ""}
  ${groups.map(g => sec(`${groupMini(g)} ${esc(g.name)}`, "Group invites", inv.filter(x => x.kind === "group" && x.g === g).map(x => r(ghost(x.email ? "✉︎" : "💬"), who(x), `${x.name && x.phone ? esc(fmtPhone(x.phone)) + " · " : ""}Invited to the group · hasn't joined yet`, x.phone ? textBtn("data-gtext", g.id + "|" + x.phone) : "", (x.name || "") + " " + (x.phone || x.email || "") + " " + g.name)).join(""), "#/g/" + g.id)).join("")}
  ${events.map(ev => sec(`${esc(ev.emoji || "🎉")} ${esc(ev.title)}`, esc(fmtWhen(ev)), inv.filter(x => x.kind === "event" && x.ev === ev).map(x => x.uid
      ? r(avatar(x.uid, "lg"), esc(personName(x.uid)), "Hasn't answered yet", "", personName(x.uid) + " " + ev.title)
      : r(ghost("💬"), who(x), `${x.name ? esc(fmtPhone(x.phone)) + " · " : ""}Not on Friendly yet · hasn't answered`, textBtn("data-etext", ev.id + "|" + x.phone), (x.name || "") + " " + x.phone + " " + ev.title)).join(""), "#/e/" + ev.id)).join("")}`;
}
// Filter the inbox in place (no re-render), so typing never loses focus; re-applied after live refreshes.
function filterMessages() {
  const box = el("msgSearch"); if (!box) return;
  const q = box.value.trim().toLowerCase(); let hits = 0;
  document.querySelectorAll("#app [data-find]").forEach(r => { const on = !q || r.dataset.find.includes(q); r.classList.toggle("hidden", !on); if (on) hits++; });
  // Hide a section's heading and card when nothing in it matches.
  document.querySelectorAll("#app .card").forEach(c => { if (!c.querySelector("[data-find]")) return; const any = [...c.querySelectorAll("[data-find]")].some(r => !r.classList.contains("hidden")); c.classList.toggle("hidden", !any); const h = c.previousElementSibling; if (h && h.classList.contains("section-head")) h.classList.toggle("hidden", !any); });
  el("msgNoHits").classList.toggle("hidden", !q || hits > 0);
}
// New message: search your friends and jump into the chat, or add someone new (contacts, phone, or people you know).
function openNewMessageDialog() {
  const friends = acceptedFriends().map(otherIn).filter(u => !(S.profile.blockedUids || []).includes(u));
  const known = [...S.contacts.keys()].filter(u => u !== myUid() && !friendshipWith(u));
  dialog(`<h3>New message</h3>
    <input type="search" class="inv-search" id="nmSearch" placeholder="Search your friends…" autocomplete="off">
    <div class="inv-results nm-results" id="nmResults"></div>
    <button type="button" class="btn" id="nmAdd" style="width:100%">＋ Add a new friend from contacts</button>`, null, null);
  const paint = () => {
    const q = el("nmSearch").value.trim().toLowerCase(), m = u => !q || personName(u).toLowerCase().includes(q);
    const fr = friends.filter(m).sort((a, b) => personName(a).localeCompare(personName(b)));
    const kn = q ? known.filter(m).slice(0, 8) : [];
    el("nmResults").innerHTML = (fr.map(u => `<div class="inv-hit" data-nmgo="${u}">${avatar(u)}<div style="flex:1;min-width:0"><b>${esc(personName(u))}</b></div><span class="add">Message</span></div>`).join("")
      + (kn.length ? `<div class="muted sm" style="margin:8px 4px 2px">People you know</div>` + kn.map(u => `<div class="inv-hit" data-nmadd="${u}">${avatar(u)}<div style="flex:1;min-width:0"><b>${esc(personName(u))}</b><div class="muted sm">Not friends yet</div></div><span class="add">Add friend</span></div>`).join("") : ""))
      || `<p class="muted sm" style="padding:8px 4px;margin:0">${friends.length ? "No friends match that. Add them below." : "No friends yet. Add one below to start messaging."}</p>`;
  };
  paint(); el("nmSearch").oninput = paint; setTimeout(() => el("nmSearch") && el("nmSearch").focus(), 50);
  el("nmResults").onclick = async e => {
    const go1 = e.target.closest("[data-nmgo]"), add = e.target.closest("[data-nmadd]");
    if (go1) { closeDialog(); go("#/m/" + pairOf(go1.dataset.nmgo)); }
    else if (add) { const u = add.dataset.nmadd; closeDialog(); await sendFriendRequest(u); }
  };
  el("nmAdd").onclick = () => { closeDialog(); openAddFriendsDialog(); };
}
function wireMessages() {
  // a button inside a tappable row does its own thing (Message), not the row's (Our Friendlyship)
  document.querySelectorAll("[data-stop][data-go]").forEach(b => b.onclick = e => { e.stopPropagation(); go(b.dataset.go); });
  document.querySelectorAll("#addFriendsBtn").forEach(b => b.onclick = openAddFriendsDialog);
  if (el("newMsgBtn")) el("newMsgBtn").onclick = openNewMessageDialog;
  if (el("msgSearch")) { el("msgSearch").oninput = filterMessages; filterMessages(); }
  wireFriendButtons();
  document.querySelectorAll("[data-frienddecline]").forEach(b => b.onclick = () => { const f = S.friends.get(b.dataset.frienddecline); if (f) dropFriendship(f, "Request declined"); });
  document.querySelectorAll("[data-friendcancel]").forEach(b => b.onclick = () => { const f = S.friends.get(b.dataset.friendcancel); if (f) dropFriendship(f, "Request canceled"); });
  document.querySelectorAll("[data-textagain]").forEach(b => b.onclick = () => { const r = (S.textInvites || []).find(x => x.id === b.dataset.textagain); if (r) location.href = smsLink([r.phone], FRIEND_TEXT); });
  document.querySelectorAll("[data-gtext]").forEach(b => b.onclick = () => { const [gid, ph] = b.dataset.gtext.split("|"), g = S.groups.get(gid); if (g) location.href = smsLink([ph], groupInviteText(g)); });
  document.querySelectorAll("[data-etext]").forEach(b => b.onclick = () => { const [eid, ph] = b.dataset.etext.split("|"), ev = S.events.get(eid); if (ev) location.href = smsLink([ph], eventInviteText(ev)); });
  // Removing drops every waiting invite to that number, so nothing turns into a request later.
  document.querySelectorAll("[data-untext]").forEach(b => b.onclick = async () => { const r = (S.textInvites || []).find(x => x.id === b.dataset.untext); if (!r) return;
    b.disabled = true; await Promise.all((S.textInvites || []).filter(x => x.phone === r.phone && x.status === "notOnFriendly").map(x => deleteDoc(doc(db, "friendRequests", x.id)).catch(() => {}))); toast("Invite removed"); });
}

// ---- One conversation, iMessage-style ----
// Messages: { authorId, authorName, text?, photo?, gif?, audio?, audioDur?, replyTo?{id,text,authorId},
// effect?, reactions{uid: emoji}, editedAt?, createdAt }. They stream in through their own listener
// (kept across re-renders, stopped when you leave) so typing and scroll survive every refresh.
let dmSub = null;   // { fid, unsub, msgs, first }
let dmReply = null; // message being replied to { id, text, authorId }
let dmSearchQ = null; // null = search closed; "" or text = filtering
const DM_TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"];
const DM_EFFECTS = { confetti: { label: "Confetti", em: ["🎉", "🎊", "✨", "🥳"] }, balloons: { label: "Balloons", em: ["🎈", "🎈", "🎈", "🎀"] }, love: { label: "Love", em: ["❤️", "💖", "💕", "😍"] }, fireworks: { label: "Fireworks", em: ["🎆", "🎇", "✨", "💥"] } };
const EDIT_WINDOW = 15 * 60 * 1000, UNSEND_WINDOW = 2 * 60 * 1000;
function stopDmSub() { if (dmSub) { dmSub.unsub(); dmSub = null; } dmReply = null; dmSearchQ = null; stopDmRec(); }
// Coming back to an open conversation (app reopened, tab refocused) counts as reading it.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.user && S.route.name === "dm" && S.msgsReady) markDmRead(S.route.id); });
function ensureDmSub(fid) {
  if (dmSub && dmSub.fid === fid) return;
  stopDmSub();
  const sub = { fid, msgs: null, first: true, unsub: () => {} }; dmSub = sub;
  sub.unsub = onSnapshot(query(collection(db, "dms", fid, "messages"), orderBy("createdAt", "desc"), limit(200)), { includeMetadataChanges: true }, snap => {
    sub.msgs = snap.docs.map(d => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites })).reverse();
    paintDm(); markDmRead(fid); playDmEffects(fid);
  }, err => { sub.msgs = []; paintDm(); console.warn("dm listener:", err.message); });
}
function markDmRead(fid) {
  const t = S.dms.get(fid);
  if (t && dmIsUnread(t) && document.visibilityState === "visible" && S.route.name === "dm") updateDoc(doc(db, "dms", fid), { [`readAt.${myUid()}`]: Math.max(Date.now(), t.lastAt || 0) }).catch(() => {});
}
// Links become tappable; 1-3 emoji with no other text show big, like iMessage.
const linkifyHtml = h => h.replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const bigEmoji = t => { const s = String(t || "").trim(); if (!s || s.length > 24 || /[\p{L}\p{N}]/u.test(s)) return false; try { const n = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].filter(x => x.segment.trim()).length; return n > 0 && n <= 3 && /\p{Extended_Pictographic}/u.test(s); } catch { return false; } };
const fmtClock = ms => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function dmVisibleMsgs() {
  const msgs = (dmSub && dmSub.msgs) || [];
  const blocked = new Set(S.profile.blockedUids || []), hidden = new Set(S.profile.hiddenIds || []);
  const clearedAt = ((S.profile.hiddenDms || {})[dmSub && dmSub.fid]) || 0;   // "Delete conversation" hides everything before then
  return msgs.filter(m => !blocked.has(m.authorId) && !hidden.has(m.id) && m.createdAt > clearedAt);
}
function dmListInner() {
  if (!dmSub || !dmSub.msgs) return `<p class="muted sm" style="text-align:center">Loading…</p>`;
  let vis = dmVisibleMsgs();
  if (dmSearchQ) { const q = dmSearchQ.toLowerCase(); vis = vis.filter(m => String(m.text || "").toLowerCase().includes(q)); if (!vis.length) return `<p class="muted sm" style="text-align:center">No messages match “${esc(dmSearchQ)}”.</p>`; }
  if (!vis.length) return `<div class="dm-empty">${window.Blip ? window.Blip.svg({ mood: "happy", size: 64 }) : "👋"}<p class="muted">Say hi! Only the two of you can see this conversation.</p></div>`;
  const me = myUid(), t = S.dms.get(dmSub.fid) || {}, otherRead = Object.entries(t.readAt || {}).find(([u]) => u !== me);
  const theirReadAt = otherRead ? otherRead[1] : 0;
  const lastMine = [...vis].reverse().find(m => m.authorId === me);
  let prev = null;
  return vis.map(m => {
    const mine = m.authorId === me;
    const gap = !prev || m.createdAt - prev.createdAt > 15 * 60 * 1000;
    const stamp = gap ? `<div class="dm-stamp">${esc(new Date(m.createdAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</div>` : "";
    prev = m;
    const big = !m.photo && !m.gif && !m.audio && bigEmoji(m.text);
    const quote = m.replyTo ? `<button type="button" class="dm-quote" data-jumpmsg="${esc(m.replyTo.id)}">${esc(first(personName(m.replyTo.authorId)))}: ${esc(String(m.replyTo.text || "📷 Photo").slice(0, 80))}</button>` : "";
    const media = m.photo ? `<img class="dm-photo" src="${esc(m.photo)}" alt="Photo" data-dmimg>` : m.gif ? `<img class="dm-photo" src="${esc(m.gif)}" alt="GIF" data-dmimg>` : m.audio ? `<audio class="dm-audio" controls preload="none" src="${esc(m.audio)}"></audio>` : "";
    const rx = Object.entries(m.reactions || {}).filter(([, e]) => e);
    const tap = rx.length ? `<span class="dm-tapbacks">${[...new Set(rx.map(([, e]) => e))].slice(0, 4).map(e => esc(e)).join("")}${rx.length > 1 ? `<i>${rx.length}</i>` : ""}</span>` : "";
    const receipt = mine && lastMine && m.id === lastMine.id && !dmSearchQ ? `<div class="dm-receipt">${m._pending ? "Sending…" : theirReadAt >= m.createdAt ? "Read " + fmtClock(theirReadAt) : "Delivered"}</div>` : "";
    return `${stamp}<div class="dm-wrap ${mine ? "mine" : "theirs"}">${quote}<div class="dm-msg ${mine ? "mine" : "theirs"} ${big ? "big" : ""} ${media && !m.text ? "media" : ""}" data-cmsg="${esc(m.id)}" data-dmmsg="${esc(m.id)}">${tap}${media}${m.text ? `<span>${big ? esc(m.text) : linkifyHtml(renderText(m.text, []))}</span>` : ""}</div>${m.editedAt ? `<div class="dm-edited">Edited</div>` : ""}${receipt}</div>`;
  }).join("") + dmTypingHtml();
}
function dmTypingHtml() {
  const t = S.dms.get(dmSub && dmSub.fid) || {}; const other = Object.entries(t.typing || {}).find(([u]) => u !== myUid());
  return other && Date.now() - other[1] < 7000 ? `<div class="dm-wrap theirs"><div class="dm-msg theirs dm-typing" aria-label="Typing"><i></i><i></i><i></i></div></div>` : "";
}
function paintDm() {
  const box = el("dmList"); if (!box) return;
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  box.innerHTML = dmListInner();
  if (dmSub && (dmSub.first || nearBottom) && dmSub.msgs && !dmSearchQ) {
    if (!(S.route.q || {}).c) window.scrollTo(0, document.documentElement.scrollHeight);
    dmSub.first = false;
  }
}
// The typing bubble fades on its own, so repaint while a chat is open.
setInterval(() => { if (S.route && S.route.name === "dm" && dmSub && el("dmList")) { const had = !!el("dmList").querySelector(".dm-typing"); if (had !== !!dmTypingHtml()) paintDm(); } }, 2000);
// Effects (confetti, balloons…) play once for the recipient when a fresh message arrives.
function playDmEffects(fid) {
  if (!dmSub || document.visibilityState !== "visible") return;
  let seen = {}; try { seen = JSON.parse(LS.get("friendlyFx") || "{}"); } catch {}
  for (const m of dmSub.msgs || []) {
    if (!m.effect || !DM_EFFECTS[m.effect] || seen[m.id] || Date.now() - m.createdAt > 10 * 60 * 1000) continue;
    seen[m.id] = 1; burstEffect(m.effect);
  }
  try { LS.set("friendlyFx", JSON.stringify(Object.fromEntries(Object.entries(seen).slice(-200)))); } catch {}
}
function burstEffect(kind) {
  const fx = DM_EFFECTS[kind]; if (!fx) return;
  const layer = document.createElement("div"); layer.className = "fx-layer fx-" + kind;
  for (let i = 0; i < 34; i++) { const s = document.createElement("span"); s.textContent = fx.em[i % fx.em.length]; s.style.left = Math.random() * 100 + "vw"; s.style.animationDelay = Math.random() * 0.9 + "s"; s.style.fontSize = 18 + Math.random() * 22 + "px"; layer.appendChild(s); }
  document.body.appendChild(layer); setTimeout(() => layer.remove(), 3600);
}
function dmBody(fid) {
  const parts = String(fid || "").split("_");
  if (parts.length !== 2 || !parts.includes(myUid())) return `<div class="card empty">${dot("oops", 72)}<b>Conversation not found</b><button class="btn" data-go="#/messages">Back to Messages</button></div>`;
  const u = parts.find(x => x !== myUid());
  const f = S.friends.get(fid); const friends = f && f.status === "accepted";
  const blocked = (S.profile.blockedUids || []).includes(u);
  const muted = (S.profile.mutedDms || []).includes(fid);
  ensureDmSub(fid);
  return `
  <button class="link-back" data-go="#/messages">‹ Messages</button>
  <div class="dm-head"><span class="member-click" data-viewprofile="${u}" style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;cursor:pointer">${avatar(u, "lg")}<b>${esc(personName(u))}</b>${muted ? `<span title="Alerts hidden">🔕</span>` : ""}</span>
    <button type="button" class="btn ghost small" id="dmSearchBtn" title="Search this conversation">🔍</button><button type="button" class="btn ghost small" id="dmMore" title="More">⋯</button></div>
  ${dmSearchQ !== null ? `<div class="dm-searchbar"><input type="search" class="inv-search" id="dmSearch" placeholder="Search this conversation…" value="${esc(dmSearchQ)}" autocomplete="off"><button type="button" class="btn ghost small" id="dmSearchClose">Done</button></div>` : ""}
  <div class="dm-list" id="dmList">${dmListInner()}</div>
  ${blocked ? `<p class="muted sm dm-note">You blocked ${esc(first(personName(u)))}. Unblock them from your profile to message again.</p>`
    : friends ? `<div class="dm-dock">
      <div class="dm-replychip ${dmReply ? "" : "hidden"}" id="dmReplyChip"><span>↩︎ Replying to <b id="dmReplyWho">${dmReply ? esc(first(personName(dmReply.authorId))) : ""}</b>: <i id="dmReplyText">${dmReply ? esc(String(dmReply.text || "Photo").slice(0, 60)) : ""}</i></span><button type="button" class="btn ghost small" id="dmReplyX" aria-label="Cancel reply">✕</button></div>
      <div class="dm-rec hidden" id="dmRec"><span class="rec-dot"></span><b id="dmRecTime">0:00</b><span class="muted sm">Recording…</span><button type="button" class="btn ghost small" id="dmRecCancel">Cancel</button><button type="button" class="btn primary small" id="dmRecSend">Send</button></div>
      <form class="dm-compose" id="dmForm">
        <button type="button" class="dm-tool" id="dmPhoto" title="Photo" aria-label="Send a photo">📷</button>${giphyKey ? `<button type="button" class="dm-tool" id="dmGif" title="GIF" aria-label="Send a GIF">GIF</button>` : ""}
        <textarea id="dmInput" rows="1" maxlength="4000" placeholder="Message ${esc(first(personName(u)))}…" enterkeyhint="send"></textarea>
        ${canRecordVoice() ? `<button type="button" class="dm-tool" id="dmMic" title="Voice message" aria-label="Record a voice message">🎤</button>` : ""}
        <button type="button" class="dm-tool" id="dmFx" title="Send with an effect" aria-label="Send with an effect">✨</button>
        <button class="btn primary dm-send" id="dmSend" type="submit" aria-label="Send">➤</button>
      </form></div>`
    : `<div class="card dm-note"><p class="muted sm" style="margin:0 0 8px">You're not friends with ${esc(first(personName(u)))} right now, so you can't send messages.</p>${friendActions(u)}</div>`}`;
}
async function sendDm(fid, patch) {
  const msg = { authorId: myUid(), authorName: S.profile.name || "", createdAt: Date.now(), ...patch };
  if (dmReply) msg.replyTo = { id: dmReply.id, text: String(dmReply.text || "").slice(0, 200), authorId: dmReply.authorId };
  dmReply = null; const chip = el("dmReplyChip"); if (chip) chip.classList.add("hidden");
  try { await addDoc(collection(db, "dms", fid, "messages"), msg); window.scrollTo(0, document.documentElement.scrollHeight); return true; }
  catch (err) { toast(/permission/i.test(err.message) ? "Couldn't send. You may no longer be friends." : /exceeds|too large|size/i.test(err.message) ? "That's too big to send." : err.message); return false; }
}
let lastTypingPing = 0;
function wireDm(fid) {
  const u = String(fid).split("_").find(x => x !== myUid());
  document.querySelectorAll("[data-viewprofile]").forEach(x => x.onclick = () => openProfileDialog(x.dataset.viewprofile));
  wireFriendButtons();
  paintDm(); markDmRead(fid);
  const form = el("dmForm"), input = el("dmInput");
  if (form) {
    const grow = () => { input.style.height = "auto"; input.style.height = Math.min(140, input.scrollHeight) + "px"; };
    input.oninput = () => {
      grow();
      // "typing…" for the other person: at most one write every 4 seconds, only once the conversation exists.
      if (input.value.trim() && Date.now() - lastTypingPing > 4000 && S.dms.has(fid)) { lastTypingPing = Date.now(); updateDoc(doc(db, "dms", fid), { [`typing.${myUid()}`]: Date.now() }).catch(() => {}); }
    };
    grow();
    input.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !IOS && !IS_ANDROID) { e.preventDefault(); form.requestSubmit(); } };
    const submitText = async effect => {
      const text = input.value.trim(); if (!text) return toast("Type a message first.");
      input.value = ""; grow();
      if (S.dms.has(fid)) updateDoc(doc(db, "dms", fid), { [`typing.${myUid()}`]: 0 }).catch(() => {});
      const ok = await sendDm(fid, effect ? { text, effect } : { text });
      if (!ok) { input.value = text; grow(); } else if (effect) burstEffect(effect);
    };
    form.onsubmit = e => { e.preventDefault(); submitText(null); };
    el("dmFx").onclick = () => {
      dialog(`<h3>Send with an effect</h3><div class="stack">${Object.entries(DM_EFFECTS).map(([k, v]) => `<button type="button" class="btn" data-fx="${k}">${v.em[0]} ${v.label}</button>`).join("")}</div>`, null, null);
      document.querySelectorAll("[data-fx]").forEach(b => b.onclick = () => { closeDialog(); submitText(b.dataset.fx); });
    };
    el("dmPhoto").onclick = async () => {
      const file = await pickFile("image/*", "message photo"); if (!file) return; toast("Sending photo…");
      try { await sendDm(fid, { text: "", photo: await compressImage(file, 1400, 0.8) }); } catch (e) { toast("Couldn't send that photo: " + e.message); }
    };
    if (el("dmGif")) el("dmGif").onclick = () => openGifPicker(null, gif => sendDm(fid, { text: "", gif }));
    if (el("dmMic")) el("dmMic").onclick = () => startDmRec(fid);
    el("dmReplyX").onclick = () => { dmReply = null; el("dmReplyChip").classList.add("hidden"); };
  }
  const list = el("dmList");
  if (list) list.onclick = e => {
    const q = e.target.closest("[data-jumpmsg]"); if (q) { const t = list.querySelector(`[data-cmsg="${CSS.escape(q.dataset.jumpmsg)}"]`); if (t) { t.scrollIntoView({ block: "center" }); t.classList.add("focus-flash"); setTimeout(() => t.classList.remove("focus-flash"), 2400); } return; }
    if (e.target.closest("a, audio")) return;
    const img = e.target.closest("[data-dmimg]"); if (img) return lightbox(img.src);
    const m = e.target.closest("[data-dmmsg]"); if (!m || !dmSub || !dmSub.msgs) return;
    const msg = dmSub.msgs.find(x => x.id === m.dataset.dmmsg); if (msg) dmMessageSheet(fid, msg);
  };
  el("dmSearchBtn").onclick = () => { dmSearchQ = dmSearchQ === null ? "" : null; render(); setTimeout(() => el("dmSearch") && el("dmSearch").focus(), 30); };
  if (el("dmSearch")) { el("dmSearch").oninput = e => { dmSearchQ = e.target.value; paintDm(); }; el("dmSearchClose").onclick = () => { dmSearchQ = null; render(); }; }
  el("dmMore").onclick = () => dmConversationSheet(fid, u);
}
// Tap a message: tapbacks, reply, copy, edit or unsend (yours), report (theirs).
function dmMessageSheet(fid, msg) {
  const me = myUid(), mine = msg.authorId === me, mineRx = (msg.reactions || {})[me] || "";
  const canEdit = mine && msg.text && Date.now() - msg.createdAt < EDIT_WINDOW, canUnsend = mine && Date.now() - msg.createdAt < UNSEND_WINDOW;
  const who = Object.entries(msg.reactions || {}).filter(([, e]) => e).map(([uid, e]) => `${esc(e)} ${esc(uid === me ? "You" : first(personName(uid)))}`).join(" · ");
  dialog(`<div class="tapback-row">${DM_TAPBACKS.map(e => `<button type="button" class="tapback ${mineRx === e ? "on" : ""}" data-tb="${e}">${e}</button>`).join("")}<input class="react-any" id="tbAny" maxlength="8" placeholder="＋" aria-label="Any emoji"></div>
    ${who ? `<p class="muted sm" style="margin:6px 0 0">${who}</p>` : ""}
    <p class="muted sm" style="margin:8px 0 10px">${mine ? "You" : esc(first(personName(msg.authorId)))} · ${esc(new Date(msg.createdAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}${msg.editedAt ? " · Edited" : ""}</p>
    <div class="stack">
      <button type="button" class="btn" id="msReply">↩︎ Reply</button>
      ${msg.text ? `<button type="button" class="btn" id="msCopy">Copy</button>` : ""}
      ${canEdit ? `<button type="button" class="btn" id="msEdit">✏️ Edit</button>` : ""}
      ${mine ? `<button type="button" class="btn danger-ghost" id="msUnsend">${canUnsend ? "Unsend" : "Delete for both of us"}</button>` : `<button type="button" class="btn danger-ghost" id="msReport">⚑ Report</button>`}
      <button type="button" class="btn ghost" id="msHide">Delete for me</button>
    </div>`, null, null);
  const react = async e => {
    closeDialog();
    try { await updateDoc(doc(db, "dms", fid, "messages", msg.id), { [`reactions.${me}`]: mineRx === e ? deleteField() : e }); } catch (err) { toast(err.message); }
  };
  document.querySelectorAll("[data-tb]").forEach(b => b.onclick = () => react(b.dataset.tb));
  el("tbAny").oninput = e => { const v = e.target.value.trim(); if (v && /\p{Extended_Pictographic}/u.test(v)) react(v); };
  el("msReply").onclick = () => {
    closeDialog(); dmReply = { id: msg.id, text: msg.text || (msg.photo ? "📷 Photo" : msg.gif ? "GIF" : msg.audio ? "🎤 Voice message" : ""), authorId: msg.authorId };
    const chip = el("dmReplyChip"); if (chip) { el("dmReplyWho").textContent = first(personName(msg.authorId)); el("dmReplyText").textContent = String(dmReply.text).slice(0, 60); chip.classList.remove("hidden"); el("dmInput").focus(); }
  };
  if (el("msCopy")) el("msCopy").onclick = () => { closeDialog(); navigator.clipboard.writeText(msg.text).then(() => toast("Copied")).catch(() => toast("Couldn't copy")); };
  if (el("msEdit")) el("msEdit").onclick = () => {
    dialog(`<h3>Edit message</h3><label class="field"><textarea id="msEditText" rows="3" maxlength="4000">${esc(msg.text)}</textarea></label><p class="muted sm">Shows “Edited” to both of you. You can edit for 15 minutes after sending.</p>`, "Save", async () => {
      const t = el("msEditText").value.trim(); if (!t) return toast("A message can't be empty.");
      try { await updateDoc(doc(db, "dms", fid, "messages", msg.id), { text: t, editedAt: Date.now() }); closeDialog(); } catch (err) { toast(/permission/i.test(err.message) ? "It's been more than 15 minutes, so it can't be edited." : err.message); }
    });
  };
  if (el("msUnsend")) el("msUnsend").onclick = async () => { closeDialog(); try { await deleteDoc(doc(db, "dms", fid, "messages", msg.id)); } catch (err) { toast(err.message); } };
  if (el("msReport")) el("msReport").onclick = () => { closeDialog(); dmReportDialog(fid, msg); };
  el("msHide").onclick = async () => { closeDialog(); try { await updateDoc(doc(db, "users", myUid()), { hiddenIds: arrayUnion(msg.id) }); } catch (err) { toast(err.message); } };
}
// The ⋯ menu: pin, hide alerts, mark unread, photos, delete conversation, remove friend, block.
function dmConversationSheet(fid, u) {
  const f = S.friends.get(fid), p = S.profile;
  const pinned = (p.pinnedDms || []).includes(fid), muted = (p.mutedDms || []).includes(fid);
  const media = dmVisibleMsgs().filter(m => m.photo || m.gif);
  dialog(`<h3>${esc(personName(u))}</h3><div class="stack">
    <button type="button" class="btn" id="cvPin">${pinned ? "📌 Unpin" : "📌 Pin to top"}</button>
    <button type="button" class="btn" id="cvMute">${muted ? "🔔 Show alerts" : "🔕 Hide alerts"}</button>
    <button type="button" class="btn" id="cvUnread">Mark as unread</button>
    ${media.length ? `<button type="button" class="btn" id="cvPhotos">🖼️ Photos (${media.length})</button>` : ""}
    <button type="button" class="btn" id="cvDelete">Delete conversation</button>
    ${f && f.status === "accepted" ? `<button type="button" class="btn" id="dmUnfriend">Remove friend</button>` : ""}
    <button type="button" class="btn danger-ghost" id="dmBlock">🚫 Block ${esc(first(personName(u)))}</button></div>
    <p class="muted sm" style="margin:10px 0 0">Tap any message to react, reply, or report it.</p>`, null, null);
  const save = async (patch, msg) => { closeDialog(); try { await updateDoc(doc(db, "users", myUid()), patch); if (msg) toast(msg); } catch (err) { toast(err.message); } };
  el("cvPin").onclick = () => save({ pinnedDms: pinned ? arrayRemove(fid) : arrayUnion(fid) }, pinned ? "Unpinned" : "Pinned to the top of Messages");
  el("cvMute").onclick = () => save({ mutedDms: muted ? arrayRemove(fid) : arrayUnion(fid) }, muted ? "Alerts are back on" : "Alerts hidden for this conversation");
  el("cvUnread").onclick = async () => { closeDialog(); const t = S.dms.get(fid); if (!t || !t.lastAt || t.lastBy === myUid()) return toast("Nothing from them to mark unread yet."); try { await updateDoc(doc(db, "dms", fid), { [`readAt.${myUid()}`]: t.lastAt - 1 }); go("#/messages"); } catch (err) { toast(err.message); } };
  if (el("cvPhotos")) el("cvPhotos").onclick = () => { dialog(`<h3>Photos</h3><div class="dm-gallery">${media.map(m => `<img src="${esc(m.photo || m.gif)}" alt="" loading="lazy" data-gal>`).join("")}</div>`, null, null); document.querySelectorAll("[data-gal]").forEach(i => i.onclick = () => lightbox(i.src)); };
  el("cvDelete").onclick = () => { if (!confirm(`Delete this conversation? It disappears for you only; ${first(personName(u))} keeps their copy.`)) return; save({ [`hiddenDms.${fid}`]: Date.now() }, "Conversation deleted").then(() => go("#/messages")); };
  if (el("dmUnfriend")) el("dmUnfriend").onclick = () => { if (confirm(`Remove ${first(personName(u))} as a friend? You won't be able to message each other.`)) { closeDialog(); dropFriendship(f, "Removed"); } };
  el("dmBlock").onclick = () => { closeDialog(); blockUser(u, null, "user", null); };
}
// Voice messages: tap 🎤 to record (up to a minute), then Send or Cancel. Stored with the message.
let dmRec = null;
function stopDmRec() { if (dmRec) { clearInterval(dmRec.timer); try { dmRec.rec.state !== "inactive" && dmRec.rec.stop(); } catch {} dmRec.stream.getTracks().forEach(t => t.stop()); dmRec = null; } }
async function startDmRec(fid) {
  if (dmRec || !canRecordVoice()) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast("Voice messages need a newer app or browser.");
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast("Friendly needs microphone access for voice messages. You can allow it in Settings."); }
  const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(t => MediaRecorder.isTypeSupported(t)) || "";
  const rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
  const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const started = Date.now(); let send = false;
  dmRec = { rec, stream, timer: setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); if (el("dmRecTime")) el("dmRecTime").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); if (s >= 60) { send = true; stopDmRec(); } }, 250) };
  rec.onstop = async () => {
    el("dmRec") && el("dmRec").classList.add("hidden"); el("dmForm") && el("dmForm").classList.remove("hidden");
    if (!send || !chunks.length) return;
    const blob = new Blob(chunks, { type: rec.mimeType || type || "audio/webm" });
    if (blob.size > 700000) return toast("That voice message is too long to send.");
    const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    sendDm(fid, { text: "", audio: url, audioDur: Math.round((Date.now() - started) / 1000) });
  };
  rec.start(500);
  el("dmRec").classList.remove("hidden"); el("dmForm").classList.add("hidden");
  el("dmRecCancel").onclick = () => { send = false; stopDmRec(); };
  el("dmRecSend").onclick = () => { send = true; stopDmRec(); };
}
function dmReportDialog(fid, msg) {
  dialog(`<h3>Report this message</h3>
    <p class="muted" style="margin-top:-6px">We review every report within 24 hours. Reported messages are hidden from you right away.</p>
    <label class="field"><span>Reason</span><select id="rpReason">${REPORT_REASONS.map(r => `<option>${r}</option>`).join("")}</select></label>
    <label class="cbox"><input type="checkbox" id="rpBlock"> Also block ${esc(first(personName(msg.authorId)))}</label>`,
    "Report", async () => {
      try {
        await addDoc(collection(db, "reports"), { reporterId: myUid(), reporterName: S.profile.name, targetUid: msg.authorId, kind: "dm", path: `dms/${fid}/messages/${msg.id}`, snippet: String(msg.text || "(photo)").slice(0, 200), reason: el("rpReason").value, status: "open", createdAt: Date.now() });
        const up = { hiddenIds: arrayUnion(msg.id) }; if (el("rpBlock").checked) up.blockedUids = arrayUnion(msg.authorId);
        await updateDoc(doc(db, "users", myUid()), up);
        closeDialog(); toast("Thanks. We'll review it within 24 hours.");
      } catch (e) { toast(e.message); }
    });
}

// ---------- BUG REPORTS: shake the phone (or Profile › Report a bug) ----------
// Reports go to bugs/{id} with where you were and what app version; admins get a push and a queue on Profile.
const shakeNeedsPermission = () => typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function";
const shakeOn = () => { try { return LS.get("friendlyShake") === "1"; } catch { return false; } };
let shakeHits = [], shakeQuiet = 0, shakeWired = false;
function wireShake() {
  if (shakeWired || typeof window.DeviceMotionEvent === "undefined") return; shakeWired = true;
  window.addEventListener("devicemotion", e => {
    const a = e.accelerationIncludingGravity || e.acceleration; if (!a) return;
    const g = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2), now = Date.now();
    if (g < 24) return;                                   // a firm shake, not a bump or a walk
    shakeHits = shakeHits.filter(t => now - t < 1200); shakeHits.push(now);
    if (shakeHits.length >= 3 && now > shakeQuiet && S.user && !document.querySelector("#appDialog[open]")) { shakeQuiet = now + 8000; shakeHits = []; openBugDialog(true); }
  });
}
async function enableShake() {
  try { if (shakeNeedsPermission() && (await DeviceMotionEvent.requestPermission()) !== "granted") return false; } catch { return false; }
  try { LS.set("friendlyShake", "1"); } catch {} wireShake(); return true;
}
// Phones that don't ask for motion permission (Android, most browsers) get shake-to-report right away.
if (!shakeNeedsPermission() || shakeOn()) wireShake();
function openBugDialog(fromShake) {
  if (!S.user) return;
  let shot = null;
  dialog(`<div class="dot-say">${dot("oops", 52)}<div class="say-bubble">${fromShake ? "Whoa, a shake! " : ""}Something not working? Tell me what happened and I'll pass it straight to the Friendly team.</div></div>
    <label class="field"><span>What happened?</span><textarea id="bugText" rows="4" maxlength="2000" placeholder="I tapped Add to calendar and nothing happened…"></textarea></label>
    <button type="button" class="btn small" id="bugShot">📷 Add a screenshot</button><span class="muted sm" id="bugShotNote" style="margin-left:8px"></span>
    <p class="muted sm" style="margin:10px 0 0">We'll include the screen you were on and your app version.</p>`, "Send", async () => {
      const text = el("bugText").value.trim(); if (text.length < 4) return toast("Tell us a little about what happened.");
      try {
        await addDoc(collection(db, "bugs"), { uid: myUid(), name: S.profile.name || "", text, ...(shot ? { photo: shot } : {}), route: location.hash || "#/", version: nativeVersion || "", platform: NATIVE ? (IS_ANDROID ? "android" : "ios") : "web", ua: navigator.userAgent.slice(0, 200), status: "open", createdAt: Date.now() });
        closeDialog(); toast("Thanks! The team has it.", null, null, "happy");
      } catch (e) { toast(e.message); }
    });
  el("bugShot").onclick = async () => { const f = await pickFile("image/*", "screenshot"); if (!f) return; try { shot = await compressImage(f, 1400, 0.75); el("bugShotNote").textContent = "✓ Screenshot attached"; } catch (e) { toast(e.message); } };
  setTimeout(() => el("bugText") && el("bugText").focus(), 50);
}
function wireBugs() {
  if (!el("bugsCard")) return;
  S.evSubs.push(onSnapshot(query(collection(db, "bugs"), where("status", "==", "open")), snap => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => !r.diag).sort((a, b) => b.createdAt - a.createdAt);
    const c = el("bugsCard"); if (!c) return;
    c.innerHTML = rows.length ? rows.map(r => `<div class="member-row" style="align-items:flex-start;flex-wrap:wrap"><div style="flex:1;min-width:0"><b>${esc(r.name || "Someone")}</b> <span class="muted sm">· ${esc(r.platform || "")} ${esc(r.version || "")} · ${ago(r.createdAt)}</span><div class="sm" style="margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere">${esc(r.text)}</div><div class="muted sm mono">${esc(r.route || "")}</div>${r.photo ? `<img src="${esc(r.photo)}" alt="" style="max-width:160px;border-radius:8px;margin-top:6px;cursor:pointer" data-bugimg>` : ""}</div><div class="btnrow" style="width:100%;margin-top:6px"><button class="btn small" data-bugdone="${r.id}">Mark fixed</button></div></div>`).join("") : `<p class="muted" style="padding:14px 16px;margin:0">No open bug reports. 🎉</p>`;
    c.querySelectorAll("[data-bugimg]").forEach(i => i.onclick = () => lightbox(i.src));
    c.querySelectorAll("[data-bugdone]").forEach(b => b.onclick = () => updateDoc(doc(db, "bugs", b.dataset.bugdone), { status: "fixed", handledAt: Date.now() }).catch(e => toast(e.message)));
  }, err => console.warn("bugs:", err.message)));
}

// ---------- APP ICON BADGE ----------
// The red number on the app icon = the bell's unread count. Pushes set it from the server;
// whenever the app is open it re-syncs, so reading something clears it. Only app builds
// with the Badge plugin (iOS 1.0.3+, Android 1.0.4+) set users.badgeOk, and the server
// sends a badge only to those, so older builds never get a number they can't clear.
let lastBadge = -1;
function syncBadge() {
  if (!S.user || !S.profile || !S.activity) return;
  const n = Math.min(99, unreadCount() + dmUnread()); if (n === lastBadge) return; lastBadge = n;
  const B = NATIVE ? plugin("Badge") : null;
  if (B && B.set) {
    (n ? B.set({ count: n }) : B.clear()).catch(() => {});
    if (!S.profile.badgeOk) updateDoc(doc(db, "users", S.user.uid), { badgeOk: true }).catch(() => {});
  } else if (!NATIVE && navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
function clearBadge() { lastBadge = -1; const B = NATIVE ? plugin("Badge") : null; if (B && B.clear) B.clear().catch(() => {}); else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {}); }

// ---------- ACTIVITY ----------
const seenAt = () => (S.profile && S.profile.activitySeenAt) || 0;
// A "New" pill clears the moment you actually open that event or group, not only
// when you visit the Activity page -- opening the thing IS seeing the alert.
// Tracked per-device in localStorage, keyed by the same url tail activity items carry.
const peekedMap = () => { try { return JSON.parse(LS.get("friendlyPeeked") || "{}"); } catch { return {}; } };
// Also saved on the account (users.peeked.<e_id>) so the app icon badge the server sends matches the bell.
const peekKey = tail => tail.replace(/^#\//, "").replace(/[^A-Za-z0-9_-]/g, "_");
const markPeeked = urlTail => {
  const hadNew = newCountFor(urlTail) > 0;
  try { const m = peekedMap(); m[urlTail] = Date.now(); LS.set("friendlyPeeked", JSON.stringify(m)); } catch {}
  if (hadNew && S.user) updateDoc(doc(db, "users", S.user.uid), { ["peeked." + peekKey(urlTail)]: Date.now() }).catch(() => {});
};
const isPeeked = a => { const tail = tailOf(a.url); if (tail === "#/" || tail === "#") return false; return Math.max(peekedMap()[tail] || 0, ((S.profile && S.profile.peeked) || {})[peekKey(tail)] || 0) >= a.createdAt; };
const unreadCount = () => (S.activity || []).filter(a => a.createdAt > seenAt() && !isPeeked(a)).length;
const newCountFor = urlTail => (S.activity || []).filter(a => a.createdAt > seenAt() && !isPeeked(a) && tailOf(a.url) === urlTail).length;
const isNewEvent = ev => (S.activity || []).some(a => a.createdAt > seenAt() && !isPeeked(a) && tailOf(a.url) === "#/e/" + ev.id);
const actIcon = a => a.type === "digest" ? dot("happy", 30) : /wants to be friends|wanted to be friends|friends now|accepted your friend/.test(a.title) ? "👋" : a.sid || /paid you|as paid/.test(a.title) || a.type === "photo" ? coral(a.type === "photo" ? "happy" : "party", 30) : /pick your items|picked their items/.test(a.title) ? "🧾" : /joined via your link/.test(a.title) ? "🔗" : /waiting on your RSVP/.test(a.title) ? "📣" : /mentioned you/.test(a.title) ? "＠" : /to a meeting/.test(a.title) ? "📅" : /You're in!/.test(a.title) ? "🎟️" : /still owe/.test(a.title) ? "💸" : /invited you/.test(a.title) ? "🎟️" : /^Today:/.test(a.title) ? "⏰" : /reported/i.test(a.title) ? "⚑" : /is going|might come|can't make|joined the waitlist|requested/.test(a.title) ? "✅" : "💬";
function notifCard() {
  let pushDismissed = false; try { pushDismissed = !!LS.get("friendlyPushDismissed"); } catch {}
  if (NATIVE || pushDismissed) return "";
  const st = pushState(); if (st !== "off") return "";
  const needsInstall = IOS && !STANDALONE;
  return `<div class="card notif-card"><span class="li">🔔</span><div style="flex:1;min-width:0"><b>${needsInstall ? "Get a buzz when plans change" : "Turn on notifications"}</b><div class="muted sm">${needsInstall ? "Add Friendly to your Home Screen (Share → Add to Home Screen), then turn them on from your profile." : "New invites, comments, RSVPs, and day-of reminders, right on this device."}</div></div><div class="btnrow">${needsInstall ? "" : `<button class="btn primary small" id="pushOn">Turn on</button>`}<button class="btn ghost small" id="pushLater">Later</button></div></div>`;
}
function activityBody() {
  if (S._actOpenSeen == null) S._actOpenSeen = seenAt();   // keep "new" highlights until you leave the page
  const rows = S.activity || [];
  return `<div class="section-head"><h2>Activity</h2></div>
  <div class="card">${rows.length ? rows.map(a => { a = friendAlertNow(a); return `<a class="act-row ${a.createdAt > S._actOpenSeen ? "new" : ""}" data-act="${esc(a.url || "#/")}"><span class="li">${actIcon(a)}</span><div style="flex:1;min-width:0"><b>${esc(a.title)}</b><div class="muted sm" style="overflow-wrap:anywhere">${esc(a.body || "")}</div>${a.sid && S.settlements.get(a.sid) ? payReacts(S.settlements.get(a.sid), true) : ""}${a._req ? `<span class="btnrow act-acts" style="gap:6px;margin-top:8px"><button type="button" class="btn small primary" data-friendaccept="${esc(a._req)}">Accept</button><button type="button" class="btn ghost small" data-frienddecline="${esc(a._req)}">Decline</button></span>` : ""}</div><span class="muted sm">${ago(a.createdAt)}</span></a>`; }).join("") : emptyState("🔔", "Nothing yet", "Invites, comments, RSVPs, and reminders will show up here.", "sleepy")}</div>
  ${rows.length ? `<div class="empty caughtup">${dot("sleepy", 64)}<b>You're all caught up</b><p class="muted">Nothing new since you last looked.</p></div>` : ""}`;
}
// "Wes wants to be friends" is only true while the request is open. Once it's accepted the row says so (and opens
// the chat); once it's gone the row says the request closed. While it's open, Accept and Decline sit right on the row.
function friendAlertNow(a) {
  if (a.type !== "friend" || !a.actorId || !/wants to be friends/.test(a.title || "")) return a;
  const f = friendshipWith(a.actorId), name = first(nameOf(a.actorId));
  if (f && f.status === "accepted") return { ...a, title: `You and ${name} are friends now`, body: "Say hi 👋", url: "#/m/" + f.id };
  if (f && f.status === "pending" && f.requestedBy === a.actorId) return { ...a, _req: f.id, body: "Accept to message each other." };
  return { ...a, title: `${name} wanted to be friends`, body: "That request isn't open anymore.", url: "#/friends" };
}
function wireActivity() {
  document.querySelectorAll("[data-act]").forEach(a => a.onclick = e => { if (e.target.closest("button")) return; e.preventDefault(); location.hash = routeTail(a.dataset.act); });
  document.querySelectorAll(".act-acts [data-friendaccept]").forEach(b => b.onclick = async e => { e.preventDefault(); e.stopPropagation(); const f = S.friends.get(b.dataset.friendaccept); if (!f) return; b.disabled = true; await acceptFriend(f); });
  document.querySelectorAll(".act-acts [data-frienddecline]").forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); const f = S.friends.get(b.dataset.frienddecline); if (f) dropFriendship(f, "Request declined"); });
  // Seen up to the newest item's own time (server clock), not this phone's: a phone clock running behind left the
  // newest item "unread" forever, so every redraw wrote again and the screen kept redrawing.
  if (unreadCount()) { const newest = Math.max(Date.now(), ...(S.activity || []).map(x => x.createdAt || 0)); if (Date.now() - (S._actSeenTry || 0) > 5000) { S._actSeenTry = Date.now(); S._actSeenWrote = newest; updateDoc(doc(db, "users", myUid()), { activitySeenAt: newest }).catch(() => {}); } }
}

// ---------- MEETINGS (plain calendar entries, rendered in the normal shell) ----------
function meetingBody(ev) {
  const me = myUid(); const myR = (ev.rsvps || {})[me]; const invited = (ev.invitedUids || []).includes(me); const manage = canManage(ev);
  const g = statusGroups(ev);
  const row = (label, uids, phones = []) => uids.length || phones.length ? `<div class="muted sm" style="margin:8px 0 4px;font-weight:600">${label} · ${uids.length + phones.length + uids.reduce((t, u) => t + (((ev.plusOnes || {})[u]) || 0), 0) + phones.reduce((t, p) => t + phonePlus(ev, p), 0)}</div>${phones.map(p => `<div class="member-row" style="padding:6px 0"><span style="display:flex;align-items:center;gap:8px;flex:1;min-width:0"><span class="avatar sm texted-av">💬</span><span>${esc(phoneName(ev, p))}${phonePlus(ev, p) ? ` <i class="plusone">+${phonePlus(ev, p)}</i>` : ""} <span class="muted sm">· by text, not on Friendly yet</span></span></span>${manage ? `<button class="btn ghost small" data-setphone="${esc(p)}" title="Mark their answer">✎ Set</button><button class="btn ghost small" data-uninvitephone="${esc(p)}" title="Remove">✕</button>` : ""}</div>`).join("")}${uids.map(u => `<div class="member-row" style="padding:6px 0"><span data-viewprofile="${u}" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer">${avatar(u, "sm")}<span>${esc(nameOf(u))}${u === ev.hostId ? " · organizer" : ""}${(ev.plusOnes || {})[u] ? ` <i class="plusone">+${ev.plusOnes[u]}</i>` : ""}</span></span>${manage && u !== me && u !== ev.hostId ? `<button class="btn ghost small" data-setrsvp="${u}" title="Mark their answer">✎ Set</button><button class="btn ghost small" data-removeguest="${u}" title="Remove from invite list">✕</button>` : ""}</div>`).join("")}` : "";
  return `
  <button class="link-back" data-go="#/">‹ Back</button>
  <div class="group-hero"><span class="li" style="width:52px;height:52px;font-size:24px">📅</span>
    <div><h1>${esc(ev.title)}</h1><div class="muted">${esc(fmtWhen(ev))} · ${countdown(ev)}${repeatLabel(ev) ? " · repeats " + esc(repeatLabel(ev)) : ""}</div></div></div>
  <div class="card" style="padding:14px 16px">
    ${ev.location && !evStops(ev).length ? `<p style="margin:0 0 8px">📍 <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">${esc(ev.location)}</a></p>` : ""}
    <p class="muted" style="margin:0 0 8px">Organized by ${esc(nameOf(ev.hostId) === "Someone" ? (ev.hostName || "the organizer") : nameOf(ev.hostId))}</p>
    ${ev.notes ? `<p style="margin:0;white-space:pre-wrap">${esc(ev.notes)}</p>` : ""}
  </div>
  ${planCardHtml(ev, true)}
  ${invited ? `<div class="btnrow" style="margin-top:14px">
    <button class="btn ${myR === "going" ? "primary" : ""}" data-rsvp="going">${myR === "going" ? "✓ Accepted" : "Accept"}</button>
    <button class="btn ${myR === "maybe" ? "primary" : ""}" data-rsvp="maybe">${myR === "maybe" ? "✓ Maybe" : "Maybe"}</button>
    <button class="btn ${myR === "no" ? "primary" : ""}" data-rsvp="no">${myR === "no" ? "✓ Declined" : "Decline"}</button>
  </div>${myR === "going" && plusAllowed(ev) ? (() => { const mp = ((ev.plusOnes || {})[myUid()]) || 0; return `<div class="plus" style="margin-top:10px"><span>Bringing</span><button data-plus="-1" ${mp <= 0 ? "disabled" : ""}>−</button><b>+${mp}</b><button data-plus="1" ${ev.plusMax && mp >= ev.plusMax ? "disabled" : ""}>＋</button></div>`; })() : ""}` : ev.groupId && S.groups.has(ev.groupId) ? `<p class="muted" style="margin-top:12px">Adding you to this meeting…</p>` : ev.openLink ? `<div class="btnrow" style="margin-top:14px"><button class="btn primary" data-join>I'll be there</button></div>` : `<p class="muted" style="margin-top:12px">You're viewing this meeting but aren't on the invite list.</p>`}
  <div class="btnrow" style="margin-top:10px">
    <button class="btn small" data-cal>Add to calendar</button>
    ${manage ? `<button class="btn small" id="addPeopleBtn">＋ Add people</button><button class="btn small" data-nudge>Nudge non-responders</button><button class="btn small" data-edit>Edit</button><button class="btn small" data-dup>Duplicate</button><button class="btn small danger-ghost" data-del>Delete</button>` : ""}
  </div>
  ${!canSeeGuests(ev) ? `<div class="card" style="padding:14px 16px;margin-top:22px"><b>Who's coming</b><p class="muted sm" style="margin:4px 0 0">🔒 Accept, maybe, or decline to see who's coming. ${g.going.length} accepted so far.</p></div>` : `<div class="card inv-card ${collapsedOpen("friendlyGuestOpen:" + ev.id, true) ? "open" : ""}" id="guestCard" style="padding:12px 16px;margin-top:22px">
    <button type="button" class="inv-toggle" id="guestToggle"><b>Who's coming <span class="muted sm">· ${(ev.invitedUids || []).length + (ev.invitedPhones || []).length} invited</span></b><span class="inv-chev">›</span></button>
    <div class="inv-body">${row("Accepted", g.going, phonesWith(ev, "going")) + row("Maybe", g.maybe, phonesWith(ev, "maybe")) + row("Declined", g.no, phonesWith(ev, "no")) + row("No answer yet", g.none) || `<p class="muted">Nobody invited yet.</p>`}</div></div>`}
  ${unansweredPhones(ev).length && canSeeGuests(ev) ? `<div class="card inv-card ${collapsedOpen("friendlyInvOpen:" + ev.id, false) ? "open" : ""}" id="invCard" style="padding:12px 16px">
    <button type="button" class="inv-toggle" id="invToggle"><b>Not on Friendly yet <span class="muted sm">· ${unansweredPhones(ev).length} invited by text</span></b><span class="inv-chev">›</span></button>
  <div class="inv-body">${unansweredPhones(ev).map(p => { const nm = (ev.invitedPhoneNames || {})[p]; return `<div class="member-row"><span class="avatar lg" style="background:#CBB;opacity:.6">💬</span><div style="flex:1;min-width:0"><b>${esc(nm || p)}</b><div class="muted sm">${nm ? esc(p) + " · " : ""}${phoneStatus(ev, p) ? `<b class="phone-rsvp ${phoneStatus(ev, p)}">${{ going: ev.kind === "meeting" ? "Accepted" : "Going", maybe: "Maybe", no: ev.kind === "meeting" ? "Declined" : "Can't go" }[phoneStatus(ev, p)]}</b> · ` : ""}Hasn't joined yet</div></div>${manage ? `<span class="btnrow" style="gap:6px"><button class="btn ghost small" data-setphone="${esc(p)}" title="Mark their RSVP">✎</button><button class="btn ghost small" data-textinvite="${esc(p)}">Text</button><button class="btn ghost small" data-uninvitephone="${esc(p)}">✕</button></span>` : ""}</div>`; }).join("")}</div></div>` : ""}
  <div class="card th-plain" id="wall" style="margin-top:22px"><p class="muted">Loading…</p></div>`;
}
function wireMeeting(ev) {
  // Group members who joined after the meeting was made aren't on it yet; add them quietly.
  S._autoJoined = S._autoJoined || new Set();
  if (!(ev.invitedUids || []).includes(myUid()) && ev.groupId && S.groups.has(ev.groupId) && !S._autoJoined.has(ev.id)) {
    S._autoJoined.add(ev.id);
    (async () => { const up = { invitedUids: arrayUnion(myUid()), [`names.${myUid()}`]: S.profile.name }; if (myPhoneE164()) up[`phoneKeys.${myUid()}`] = await phoneKey(myPhoneE164()); return updateDoc(doc(db, "events", ev.id), up); })().catch(e => console.warn("auto-join failed:", e.message));
  }
  document.querySelectorAll("[data-rsvp]").forEach(b => b.onclick = () => setRsvp(ev, b.dataset.rsvp));
  document.querySelectorAll("[data-plus]").forEach(b => b.onclick = () => setPlus(ev, Number(b.dataset.plus)));
  document.querySelectorAll("[data-viewprofile]").forEach(el2 => el2.onclick = () => openProfileDialog(el2.dataset.viewprofile));
  document.querySelectorAll("[data-removeguest]").forEach(b => b.onclick = () => removeGuest(ev, b.dataset.removeguest));
  document.querySelectorAll("[data-setrsvp]").forEach(b => b.onclick = e => { e.stopPropagation(); openSetRsvpDialog(ev, b.dataset.setrsvp); });
  document.querySelectorAll("[data-setphone]").forEach(b => b.onclick = e => { e.stopPropagation(); openSetRsvpDialog(ev, null, b.dataset.setphone); });
  const j = $("[data-join]"); if (j) j.onclick = () => joinViaLink(ev, j);
  const cal = $("[data-cal]"); if (cal) cal.onclick = () => openCalendarDialog(ev);
  if (el("addPeopleBtn")) el("addPeopleBtn").onclick = () => openEventInviteDialog(ev);
  document.querySelectorAll("[data-textinvite]").forEach(b => b.onclick = () => { location.href = smsLink([b.dataset.textinvite], eventInviteText({ ...ev, openLink: true })); });
  if (el("invToggle")) el("invToggle").onclick = () => { const c = el("invCard"); const open = !c.classList.contains("open"); c.classList.toggle("open", open); el("invToggle").setAttribute("aria-expanded", open); try { LS.set("friendlyInvOpen:" + ev.id, open ? "1" : "0"); } catch {} };
  if (el("guestToggle")) el("guestToggle").onclick = () => { const c = el("guestCard"); const open = !c.classList.contains("open"); c.classList.toggle("open", open); el("guestToggle").setAttribute("aria-expanded", open); try { LS.set("friendlyGuestOpen:" + ev.id, open ? "1" : "0"); } catch {} };
  document.querySelectorAll("[data-uninvitephone]").forEach(b => b.onclick = () => uninviteEventPhone(ev, b.dataset.uninvitephone));
  const nd = $("[data-nudge]"); if (nd) nd.onclick = () => nudge(ev, nd, true);
  const ed = $("[data-edit]"); if (ed) ed.onclick = () => editEvent(ev);
  const dp = $("[data-dup]"); if (dp) dp.onclick = () => duplicateEvent(ev);
  const dl = $("[data-del]"); if (dl) dl.onclick = () => delEvent(ev);
  const pseudo = { id: ev.id, _col: ["events", ev.id], _manage: false, title: ev.title };
  S.comments = [];
  S.evSubs.push(onSnapshot(subCol(pseudo, "comments"), snap => { S.comments = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.createdAt - b.createdAt); const w = el("wall"); if (w) withInputKept(() => { w.innerHTML = wallInner(pseudo, "Notes & questions"); wireWall(pseudo); }); }, err => toast(err.message)));
}
// Host asks the guests who haven't answered to RSVP (Cloud Function delivers).
async function nudge(ev, btn, ask) {
  const pending = (ev.invitedUids || []).filter(u => u !== myUid() && !(ev.rsvps || {})[u]);
  if (!pending.length) return toast("Everyone has answered already.");
  if (ask) {
    const names = pending.map(u => esc(first(nameOf(u)) || "a guest"));
    const list = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
    const who = list.length === 1 ? list[0] : list.length === 2 ? list.join(" and ") : list.slice(0, -1).join(", ") + ", and " + list[list.length - 1];
    return dialog(`<h3>Nudge ${pending.length} ${pending.length === 1 ? "person" : "people"}?</h3><p>${who} will get a reminder to RSVP to “${esc(ev.title)}”.</p>`, "Send nudge", () => { closeDialog(); nudge(ev, btn, false); });
  }
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Nudging…"; }
  try { await addDoc(collection(db, "nudges"), { eventId: ev.id, by: myUid(), createdAt: Date.now() }); toast("Nudged " + pending.length + " " + (pending.length === 1 ? "person" : "people")); }
  catch (e) { toast(e.message); }
  if (btn) { btn.disabled = false; btn.textContent = label; }
}
function meetingCard(ev) {
  // Same size as an event tile so the grid stays even; a plain surface, a coral edge and a
  // "Meeting" tag are what set it apart.
  const d = evDate(ev); const myR = (ev.rsvps || {})[myUid()];
  const tf = tileFaces(ev, "accepted");
  const pills = `${isNewEvent(ev) ? `<span class="new-pill">New</span>` : ""}${myR ? `<span class="you-pill ${myR}">${{ going: "Accepted", maybe: "Maybe", no: "Declined" }[myR] || ""}</span>` : ""}`;
  return `<a class="ev-card meet-tile ${ev._unjoined ? "unjoined" : ""}" data-ev="${ev.id}">
    <div class="ev-card-body">
      ${pills ? `<div class="ev-pills">${pills}</div>` : ""}
      <span class="meet-tag">📅 Meeting${ev.repeat ? " · ↻" : ""}</span>
      <div class="ev-card-text">
        <div class="ev-card-title">${esc(ev.title)}</div>
        <div class="ev-card-date">${MONTHS[d.getMonth()]} ${d.getDate()}${ev.time ? " · " + fmtTime(ev.time) : ""}${evStops(ev).length ? ` · <span class="ev-route">${evStops(ev).slice(0, 4).map(x => esc(x.emoji || "📍")).join("<i>›</i>")}</span>` : ""}</div>
        ${evStops(ev).length ? `<div class="ev-card-loc">📋 ${evStops(ev).length} items</div>` : ev.location ? `<div class="ev-card-loc">📍 ${esc(placeName(ev.location))}</div>` : ""}
        <div class="ev-card-foot">
          <span class="mini-guests">${tf.faces}</span>
          <span class="count">${tf.label}</span>
        </div>
      </div>
    </div>
    ${ev._unjoined ? `<div class="unjoined-veil"><span class="uj-tag">✉️ You're invited</span><span class="uj-cta">Tap to join</span></div>` : ""}
  </a>`;
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
    card.innerHTML = `${p.cover ? `<img class="pv-cover" src="${esc(p.cover)}" alt="">` : ""}<div class="pv-body">
      <p class="muted sm" style="margin:0 0 4px">${esc(p.hostName || "A friend")} invited you${p.kind === "meeting" ? " to a meeting" : ""}</p>
      <h2 style="margin:0 0 6px">${p.kind === "meeting" ? "📅" : esc(p.emoji || "🎉")} ${esc(p.title)}</h2>
      <p style="margin:0 0 4px">${esc(when)}</p>${p.location ? `<p class="muted" style="margin:0 0 4px">📍 ${esc(p.location)}</p>` : ""}
      <p class="muted sm" style="margin:8px 0 0">${p.going} going${p.capacity ? " / " + p.capacity : ""} · Sign in or create a free account below to RSVP.</p></div>`;
  }
  renderAuth(el("authRoot"));
}

// ---------- MEMORIES (photo archive across my events) ----------
S.memories = S.memories || new Map();   // eventId -> photos[]
async function loadMemories(all) {
  const evs = [...S.events.values()].sort((a, b) => b.date.localeCompare(a.date));
  await Promise.all(evs.filter(ev => all || !S.memories.has(ev.id)).map(async ev => {
    try { const snap = await getDocs(collection(db, "events", ev.id, "photos")); S.memories.set(ev.id, snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(visibleContent)); }
    catch { S.memories.set(ev.id, []); }
  }));
}
const yearAgoEvents = () => { const t = new Date(); t.setFullYear(t.getFullYear() - 1); const c = t.getTime(); return [...S.events.values()].filter(ev => Math.abs(evDate(ev).getTime() - c) < 8 * 86400e3); };
function photosPageBody() {
  const evs = [...S.events.values()].filter(ev => (S.memories.get(ev.id) || []).length).sort((a, b) => b.date.localeCompare(a.date));
  const ago1 = yearAgoEvents().filter(ev => (S.memories.get(ev.id) || []).length);
  const section = (ev, label) => `<div class="section-head" style="margin-top:18px"><h2>${label ? label + " · " : ""}${esc(ev.emoji || "")} ${esc(ev.title)}</h2><a class="muted sm" data-go="#/e/${ev.id}">${esc(fmtWhen(ev))} ›</a></div>
    <div class="photo-grid mem-grid">${(S.memories.get(ev.id) || []).map(p => `<div class="photo-tile"><img src="${esc(p.img)}" data-mem="${p.id}" data-mev="${ev.id}" alt="" loading="lazy">${photoBadges(p)}</div>`).join("")}</div>`;
  return `<button class="link-back" data-go="#/">‹ Back</button>
  <div class="section-head"><h2>Memories</h2><span class="muted sm">${(n => n + (n === 1 ? " photo" : " photos"))(evs.reduce((t, ev) => t + S.memories.get(ev.id).length, 0))}</span></div>
  ${yearData().plans.length >= 2 ? `<a class="card yr-link" data-go="#/year">${dot("party", 34)}${coral("party", 34)}<span style="flex:1;min-width:0"><b>A year with the crew</b><span class="muted sm">${yearData().plans.length} plans so far in ${new Date().getFullYear()}</span></span><span class="chev">›</span></a>` : ""}
  ${S._memLoading ? `<p class="muted">Gathering photos…</p>` : ""}
  ${ago1.map(ev => section(ev, "🕰️ One year ago")).join("")}
  ${evs.length ? evs.map(ev => section(ev)).join("") : (S._memLoading ? "" : emptyState("📸", "No photos yet", "Photos from your plans land here, newest first. Coral is ready for them.", "coral:idle"))}`;
}
function wirePhotosPage() {
  document.querySelectorAll("[data-mem]").forEach(im => im.onclick = () => { const ev = S.events.get(im.dataset.mev), p = (S.memories.get(im.dataset.mev) || []).find(x => x.id === im.dataset.mem); if (ev && p) openPhoto(ev, p); });
  // Each visit re-checks every event (photos added since the last look used to stay missing until a restart);
  // events that arrived since are fetched too. The 20-second window keeps render -> wire -> load from looping.
  const missing = [...S.events.values()].some(ev => !S.memories.has(ev.id));
  const stale = Date.now() - (S._memFreshAt || 0) > 20000;
  if (S._memLoading || (!missing && !stale)) return;
  S._memLoading = true;
  loadMemories(stale).then(() => { S._memLoading = false; S._memFreshAt = Date.now(); if (S.route.name === "photos") render(); });
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
  if (!evs.length && !gs.length && !xs.length) return emptyState("🔍", "Nothing matched", "Try a different word: event titles, places, notes, groups, and expenses are searchable.", "thinking");
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
// Every event in progress is kept in 📝 Drafts on the account automatically (a couple of seconds after each
// change), so it's never "hidden" behind New event. Creating the event removes the draft.
let draftTimer = null;
// Leaving New event: anything with a name is saved to Drafts right away, and the form is cleared so the next
// "+ New event" starts fresh (the half-finished one waits in 📝 Drafts).
let prevHash = location.hash;
window.addEventListener("hashchange", () => {
  const was = prevHash; prevHash = location.hash;
  if (was !== "#/new" || location.hash === "#/new") return;
  if ((compose.title || "").trim() && S.user && !compose._created) {
    clearTimeout(draftTimer);
    if (!compose._draftId) compose._draftId = newId();
    let json = composeJson(); if (json.length > 900000) json = JSON.stringify({ ...JSON.parse(json), cover: null, coverTab: "emoji" });
    setDoc(doc(db, "users", myUid(), "drafts", compose._draftId), { json, title: compose.title.trim(), emoji: compose.emoji || "🎉", date: compose.date || "", kind: compose.kind || "event", updatedAt: Date.now() }).catch(() => {});
    toast("Saved to 📝 Drafts on the Events page");
  }
  resetCompose(); compose._restored = true;
});
function saveDraft() {
  if (!(compose.title || "").trim() || !S.user) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (location.hash !== "#/new" || !(compose.title || "").trim() || (el("createEventBtn") && el("createEventBtn").disabled)) return;
    if (!compose._draftId) compose._draftId = newId();
    let json = composeJson(); if (json.length > 900000) json = JSON.stringify({ ...JSON.parse(json), cover: null, coverTab: "emoji" });   // a huge cover photo won't fit
    setDoc(doc(db, "users", myUid(), "drafts", compose._draftId), { json, title: compose.title.trim(), emoji: compose.emoji || "🎉", date: compose.date || "", kind: compose.kind || "event", updatedAt: Date.now() })
      .then(() => { const s = el("draftStatus"); if (s) s.textContent = "✓ Saved to Drafts"; }).catch(() => {});
  }, 1500);
}
// Drafts you save on purpose live on your account (users/{uid}/drafts), so they're on every device.
const composeJson = () => JSON.stringify({ ...compose, invitees: [...compose.invitees], cohosts: [...compose.cohosts], _restored: undefined, _fromDraft: undefined, _draftId: undefined, _plan: undefined });
async function saveDraftToAccount() {
  if (!(compose.title || "").trim()) return toast("Give it a name first, then save the draft.");
  const id = compose._draftId || newId();
  try {
    await setDoc(doc(db, "users", myUid(), "drafts", id), { json: composeJson(), title: compose.title.trim(), emoji: compose.emoji || "🎉", date: compose.date || "", kind: compose.kind || "event", updatedAt: Date.now() });
    composeStop(); resetCompose(); try { LS.remove("friendlyDraft"); } catch {}
    go("#/drafts"); toast("Saved to Drafts", null, null, "happy");
  } catch (e) { toast(/exceed|size|large/i.test(e.message) ? "That draft is too big to save (try a smaller cover photo)." : e.message); }
}
function openDraft(d) {
  try {
    const x = JSON.parse(d.json || "{}");
    resetCompose(); Object.assign(compose, x, { invitees: new Set(x.invitees || []), cohosts: new Set(x.cohosts || []), questions: x.questions || [], stops: x.stops || [] });
    compose._draftId = d.id; compose._restored = true; go("#/new");
  } catch { toast("Couldn't open that draft."); }
}
function draftsBody() {
  const ds = S.drafts || [];
  return `<button class="link-back" data-go="#/">‹ Events</button>
  <div class="section-head"><h1 style="margin:0">Drafts</h1><button class="btn primary small" data-go="#/new">＋ New event</button></div>
  <p class="muted sm" style="margin:-4px 0 14px">Plans you saved without sending. Nobody sees them until you create the event.</p>
  ${ds.length ? `<div class="card">${ds.map(d => `<div class="member-row"><span class="li">${esc(d.emoji || "📝")}</span><div style="flex:1;min-width:0"><b>${esc(d.title || "Untitled")}</b><div class="muted sm">${d.kind === "meeting" ? "Meeting · " : ""}${d.date ? esc(fmtDay({ date: d.date })) + " · " : ""}saved ${ago(d.updatedAt)}</div></div><span class="btnrow" style="gap:6px"><button class="btn small primary" data-opendraft="${d.id}">Continue</button><button class="btn ghost small" data-deldraft="${d.id}" title="Delete draft">✕</button></span></div>`).join("")}</div>`
    : emptyState("📝", "No drafts", "Tap “Save draft” while making an event to finish it later.", "sleepy")}`;
}
function wireDrafts() {
  document.querySelectorAll("[data-opendraft]").forEach(b => b.onclick = () => { const d = (S.drafts || []).find(x => x.id === b.dataset.opendraft); if (d) openDraft(d); });
  document.querySelectorAll("[data-deldraft]").forEach(b => b.onclick = () => {
    if (!confirm("Delete this draft?")) return;
    // The draft you had open goes too, so New event starts clean.
    if (compose._draftId === b.dataset.deldraft) { resetCompose(); try { LS.remove("friendlyDraft"); } catch {} }
    deleteDoc(doc(db, "users", myUid(), "drafts", b.dataset.deldraft)).then(() => toast("Draft deleted")).catch(e => toast(e.message));
  });
}
// Day-of setup while making the event: start the bring list, offer your own car, or turn either part off.
function composeDayInner() {
  const c = compose, bring = c.bring || [];
  return `<label class="switch"><input type="checkbox" id="cBringOn" ${c.bringOn === false ? "" : "checked"}><span>🧺 Bring list</span></label>
    <div class="${c.bringOn === false ? "hidden" : ""}" style="margin:8px 0 12px">
      ${bring.map((b, i) => `<div class="inv-hit"><div style="flex:1;min-width:0"><b>${esc(b.item)}</b>${b.qty ? ` <span class="muted sm">× ${esc(b.qty)}</span>` : ""}</div><button type="button" class="btn ghost small" data-bringx="${i}">✕</button></div>`).join("")}
      <div class="two"><label class="field"><span>Add an item</span><input id="cBringItem" maxlength="60" placeholder="Ice, chips, a dessert…"></label><label class="field"><span>How many <span class="muted">(optional)</span></span><input id="cBringQty" maxlength="12" placeholder="2 bags"></label></div>
      <button type="button" class="btn small" id="cBringAdd">＋ Add to list</button>
    </div>
    <label class="switch"><input type="checkbox" id="cCarOn" ${c.carOn === false ? "" : "checked"}><span>🚗 Carpool</span></label>
    <div class="${c.carOn === false ? "hidden" : ""}" style="margin:8px 0 0">
      <label class="switch day-sub"><input type="checkbox" id="cDrive" ${c.drive ? "checked" : ""}><span>I'm driving and have room</span></label>
      <label class="field ${c.drive ? "" : "hidden"}" style="margin-top:6px"><span>Open seats</span><select id="cSeats">${[1, 2, 3, 4, 5, 6].map(n => `<option ${Number(c.seats || 3) === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    </div>`;
}
function wireComposeDay() {
  const card = el("cDayCard"); if (!card) return;
  const redraw = () => { card.innerHTML = composeDayInner(); wireComposeDay(); saveDraft(); };
  el("cBringOn").onchange = e => { compose.bringOn = e.target.checked; redraw(); };
  el("cCarOn").onchange = e => { compose.carOn = e.target.checked; redraw(); };
  el("cDrive").onchange = e => { compose.drive = e.target.checked; redraw(); };
  el("cSeats").onchange = e => { compose.seats = Number(e.target.value) || 3; saveDraft(); };
  const add = () => { const item = el("cBringItem").value.trim(); if (!item) return toast("Type what's needed."); compose.bring = [...(compose.bring || []), { item, qty: el("cBringQty").value.trim() }]; redraw(); setTimeout(() => el("cBringItem") && el("cBringItem").focus(), 0); };
  el("cBringAdd").onclick = add;
  el("cBringItem").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); add(); } };
  card.querySelectorAll("[data-bringx]").forEach(b => b.onclick = () => { compose.bring.splice(Number(b.dataset.bringx), 1); redraw(); });
}
// The old device-only autosave moves into the account's Drafts once, instead of reappearing inside New event.
function restoreDraft() {
  if (compose._restored) return; compose._restored = true;
  try {
    const raw = LS.get("friendlyDraft"); if (!raw || !S.user) return;
    LS.remove("friendlyDraft");
    const d = JSON.parse(raw); if (!d || !(d.title || "").trim()) return;
    let json = JSON.stringify({ ...d, _restored: undefined, _fromDraft: undefined, _draftId: undefined }); if (json.length > 900000) json = JSON.stringify({ ...d, cover: null, coverTab: "emoji" });
    setDoc(doc(db, "users", myUid(), "drafts", newId()), { json, title: d.title.trim(), emoji: d.emoji || "🎉", date: d.date || "", kind: d.kind || "event", updatedAt: Date.now() }).catch(() => {});
  } catch {}
}
// Full-size cover for an event whose record only carries the small preview (see slimEventCover in functions).
const fullCovers = new Map();
async function fullCoverOf(ev) {
  if (!ev || !ev.coverFull) return ev && ev.cover || "";
  if (fullCovers.has(ev.id)) return fullCovers.get(ev.id);
  try { const s = await getDoc(doc(db, "eventCovers", ev.id)); const c = (s.exists() && s.data().cover) || ev.cover; fullCovers.set(ev.id, c); return c; } catch { return ev.cover || ""; }
}
async function duplicateEvent(ev) {
  if (ev.coverFull) { toast("Copying…"); ev = { ...ev, cover: await Promise.race([fullCoverOf(ev), new Promise(r => setTimeout(() => r(ev.cover), 5000))]) }; }
  resetCompose(); compose._restored = true;
  Object.assign(compose, { stops: evStops(ev).map(x => ({ ...x })), title: ev.title, emoji: ev.emoji || "🎉", theme: ev.theme || DEFAULT_THEME, customTheme: ev.customTheme || null, cover: ev.cover || null, coverTab: ev.cover ? "upload" : "emoji", time: ev.time || "", end: ev.endTime || "", where: ev.location || "", notes: ev.notes || "", cap: ev.capacity ? String(ev.capacity) : "", approval: !!ev.approval, questions: (ev.questions || []).map(q => ({ ...q, id: newId() })), groupId: ev.groupId || "", invitees: new Set(ev.groupId ? [] : (ev.invitedUids || []).filter(u => u !== myUid())), phoneInvitees: ev.groupId ? [] : Object.entries(ev.invitedPhoneNames || {}).map(([e164, name]) => ({ e164, name })), cohosts: new Set(ev.cohostUids || []), kind: ev.kind || "event", repeat: ev.repeat || "", date: "" });
  go("#/new"); toast("Copied. Pick a date and it's ready.");
}
// ---------- passwordless sign-in (email link) ----------
async function sendMagicLink() {
  const email = (el("aEmail").value || "").trim(); if (!email.includes("@")) return toast("Enter your email first.");
  try {
    await sendSignInLinkToEmail(auth, email, { url: location.origin + location.pathname + location.hash, handleCodeInApp: true });
    LS.set("friendlyMagicEmail", email); toast("Check your email for a sign-in link ✉️");
  } catch (e) { toast(e.code === "auth/operation-not-allowed" ? "Sign-in links aren't switched on yet. Use your password for now." : authError(e)); }
}
if (isSignInWithEmailLink(auth, location.href)) {
  const email = LS.get("friendlyMagicEmail") || prompt("Confirm your email to finish signing in");
  if (email) signInWithEmailLink(auth, email, location.href).then(() => { LS.remove("friendlyMagicEmail"); history.replaceState(null, "", location.pathname + location.hash); }).catch(e => toast(authError(e)));
}

// ---------- dialog helper ----------
function dialog(inner, okLabel, onOk) {
  closeDialog();
  const d = document.createElement("dialog");
  d.className = "app-dialog"; d.id = "appDialog";
  d.innerHTML = `<form method="dialog" class="dlg-inner">${inner}
    <div class="dlg-actions">${okLabel ? `<button type="button" class="btn" id="dlgCancel">Cancel</button><button type="button" class="btn primary" id="dlgOk">${esc(okLabel)}</button>` : `<button type="button" class="btn primary" id="dlgCancel">Close</button>`}</div></form>`;
  // Shown as an ordinary fixed overlay (show(), not showModal()): in the iPhone app, a modal <dialog> opened
  // from far down a long page (Add people on New event) silently stopped receiving taps.
  lockScroll();
  const bd = document.createElement("div"); bd.id = "dlgBackdrop"; bd.className = "dlg-backdrop";
  document.body.appendChild(bd); document.body.appendChild(d); d.show();
  el("dlgCancel").onclick = closeDialog;
  if (el("dlgOk")) el("dlgOk").onclick = onOk;
  d.addEventListener("close", () => { d.remove(); if (!el("appDialog")) { const b = el("dlgBackdrop"); if (b) b.remove(); unlockScroll(); } });
}
function closeDialog() { try { ctTrace.end(); } catch {} const d = el("appDialog"); if (d) { d.close(); d.remove(); } const b = el("dlgBackdrop"); if (b) b.remove(); unlockScroll(); }
document.addEventListener("keydown", e => { if (e.key === "Escape" && el("appDialog")) closeDialog(); });
// While a dialog is open the page underneath is pinned in place (body fixed at the scrolled offset) and put
// back on close. In the iPhone app, a modal dialog opened over a page scrolled far down stopped receiving
// taps at all (Add people on the long New event form); with the page pinned at the top it hit-tests right.
let lockedY = null;
function lockScroll() {
  if (lockedY !== null) return;
  lockedY = window.scrollY || 0;
  document.body.classList.add("dlg-open");
  const b = document.body.style;
  b.position = "fixed"; b.top = -lockedY + "px"; b.left = "0"; b.right = "0"; b.width = "100%";
}
function unlockScroll() {
  if (lockedY === null) return;
  const y = lockedY; lockedY = null;
  document.body.classList.remove("dlg-open");
  const b = document.body.style;
  b.position = ""; b.top = ""; b.left = ""; b.right = ""; b.width = "";
  window.scrollTo(0, y);
}
window.closeDialog = closeDialog;

// register service worker
// The page's load event may already have fired (index.html now loads this script after a non-blocking version check).
if ("serviceWorker" in navigator) { const reg = () => navigator.serviceWorker.register("./sw.js").catch(() => {}); if (document.readyState === "complete") reg(); else addEventListener("load", reg); }

render();
