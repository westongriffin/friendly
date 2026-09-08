// Friendly Cloud Functions — push notifications, day-of reminders, and an
// optional SMS path. Deploy with:  firebase deploy --only functions
// (Requires the Blaze plan, which is enabled.)
//
// Push works once the native app registers an FCM token (saved to
// users/{uid}.pushTokens by the client). SMS is only active if you set Twilio
// credentials:  firebase functions:config:set twilio.sid=... twilio.token=... twilio.from=+1...
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

const firstName = n => (n || "Someone").split(" ")[0];

// Collect FCM tokens for a set of user ids, send a notification, and prune any
// tokens the platform reports as dead.
async function notify(uids, title, body, url = "/") {
  const ids = [...new Set(uids)].filter(Boolean);
  if (!ids.length) return;
  const snaps = await db.getAll(...ids.map(id => db.doc("users/" + id)));
  const tokenOwner = {};                 // token -> uid (to prune later)
  const tokens = [];
  snaps.forEach(s => { (s.get("pushTokens") || []).forEach(t => { tokens.push(t); tokenOwner[t] = s.id; }); });
  if (!tokens.length) return;
  const res = await getMessaging().sendEachForMulticast({
    tokens, notification: { title, body },
    data: { url }, apns: { payload: { aps: { sound: "default" } } }
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    if (!r.success) { const c = r.error && r.error.code; if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-argument") dead.push(tokens[i]); }
  });
  // remove dead tokens
  const byUser = {};
  dead.forEach(t => { (byUser[tokenOwner[t]] = byUser[tokenOwner[t]] || []).push(t); });
  const { FieldValue } = require("firebase-admin/firestore");
  await Promise.all(Object.entries(byUser).map(([uid, ts]) => db.doc("users/" + uid).update({ pushTokens: FieldValue.arrayRemove(...ts) }).catch(() => {})));
}

async function names(uids) {
  const snaps = await db.getAll(...uids.map(id => db.doc("users/" + id)));
  const m = {}; snaps.forEach(s => m[s.id] = s.get("name") || "Someone"); return m;
}

// New event -> tell the guests.
exports.onEventCreated = onDocumentCreated("events/{id}", async e => {
  const ev = e.data && e.data.data(); if (!ev) return;
  const nm = await names([ev.hostId]);
  await notify((ev.invitedUids || []).filter(u => u !== ev.hostId),
    firstName(nm[ev.hostId]) + " invited you", (ev.emoji || "🎉") + " " + ev.title,
    "/#/e/" + e.params.id);
});

// New party-wall comment -> tell the other guests.
exports.onComment = onDocumentCreated("events/{id}/comments/{cid}", async e => {
  const c = e.data && e.data.data(); if (!c) return;
  const ev = (await db.doc("events/" + e.params.id).get()).data(); if (!ev) return;
  await notify((ev.invitedUids || []).filter(u => u !== c.authorId),
    firstName(c.authorName) + " on " + ev.title, String(c.text).slice(0, 120),
    "/#/e/" + e.params.id);
});

// RSVP change -> tell the host who's coming.
exports.onRsvp = onDocumentUpdated("events/{id}", async e => {
  const before = e.data.before.data(), after = e.data.after.data();
  const b = before.rsvps || {}, a = after.rsvps || {};
  const changed = Object.keys(a).find(u => a[u] !== b[u] && u !== after.hostId);
  if (!changed) return;
  const nm = await names([changed]);
  const word = { going: "is going to", maybe: "might come to", no: "can't make", waitlist: "joined the waitlist for", pending: "requested to join" }[a[changed]] || "updated";
  await notify([after.hostId], firstName(nm[changed]) + " " + word, after.title, "/#/e/" + e.params.id);
});

// Day-of reminders at 9am (project timezone).
exports.dailyReminders = onSchedule({ schedule: "0 9 * * *", timeZone: "America/Chicago" }, async () => {
  const d = new Date();
  const today = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const snap = await db.collection("events").where("date", "==", today).get();
  for (const doc of snap.docs) {
    const ev = doc.data();
    const going = (ev.invitedUids || []).filter(u => ["going", "maybe"].includes((ev.rsvps || {})[u]));
    await notify(going, "Today: " + ev.title, (ev.time ? "Starts " + ev.time + ". " : "") + (ev.location || "See you there!"), "/#/e/" + doc.id);
  }
  logger.info("Sent reminders for " + snap.size + " events");
});
