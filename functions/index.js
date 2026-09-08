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
const { GoogleAuth } = require("google-auth-library");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

// ---- AI cover art via Vertex Imagen (runs in your own project) ----
// Firestore-triggered so it works on domain-restricted orgs (no public HTTP
// invocation needed). The app creates coverRequests/{id}; we generate and write
// the image back onto that doc; the app reads it and deletes the request.
const PROJECT = "friendly-6992a", LOCATION = "us-central1", IMAGEN_MODEL = "imagen-3.0-generate-002";
const gauth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

const FLAIR = ", vibrant party invitation art, bold, celebratory, high quality";

// Preferred generator: Google Vertex Imagen (runs as our own service account).
async function imagenGenerate(prompt) {
  const token = (await (await gauth.getClient()).getAccessToken()).token;
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${IMAGEN_MODEL}:predict`;
  const body = {
    instances: [{ prompt: prompt + FLAIR }],
    parameters: { sampleCount: 1, aspectRatio: "16:9", outputOptions: { mimeType: "image/jpeg", compressionQuality: 82 }, safetySetting: "block_medium_and_above" }
  };
  const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("imagen " + r.status + ": " + (await r.text()).slice(0, 160));
  const j = await r.json();
  const b64 = j.predictions && j.predictions[0] && j.predictions[0].bytesBase64Encoded;
  if (!b64) throw new Error("no image in response");
  return "data:image/jpeg;base64," + b64;
}

// Fallback generator: free, no key. Keeps covers working even where the org
// blocks Vertex publisher-model access. "flux" is their fast backend; the
// default one rate-limits under load, so try a second model before giving up.
async function pollinationsGenerate(prompt) {
  let lastErr;
  for (const model of ["flux", "turbo"]) {
    const seed = Math.floor(Math.random() * 1e6);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + FLAIR)}?width=1024&height=640&nologo=true&model=${model}&seed=${seed}`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("pollinations/" + model + " " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 5000) throw new Error("pollinations/" + model + " returned no image");
      return "data:image/jpeg;base64," + buf.toString("base64");
    } catch (e) { lastErr = e; logger.warn(e.message + " — trying next model"); }
  }
  throw lastErr;
}

exports.onCoverRequest = onDocumentCreated({ document: "coverRequests/{id}", region: "us-central1", timeoutSeconds: 120, memory: "512MiB" }, async e => {
  const d = e.data && e.data.data(); if (!d || !d.prompt) return;
  const ref = e.data.ref;
  const prompt = String(d.prompt).slice(0, 400);
  let image = null, source = null;
  try { image = await imagenGenerate(prompt); source = "imagen"; }
  catch (err) {
    logger.warn("imagen unavailable, using fallback: " + err.message);
    try { image = await pollinationsGenerate(prompt); source = "pollinations"; }
    catch (err2) { logger.error("cover generation failed: " + err2.message); }
  }
  if (image) await ref.update({ status: "done", source, image });
  else await ref.update({ status: "error", error: "generation failed" });
});

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
