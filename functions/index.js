// Friendly Cloud Functions: push notifications, day-of reminders, and an
// optional SMS path. Deploy with:  firebase deploy --only functions
// (Requires the Blaze plan, which is enabled.)
//
// Push works once the native app registers an FCM token (saved to
// users/{uid}.pushTokens by the client). SMS is only active if you set Twilio
// credentials:  firebase functions:config:set twilio.sid=... twilio.token=... twilio.from=+1...
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { GoogleAuth } = require("google-auth-library");
const sharp = require("sharp");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

// ---- AI cover art via Vertex (Gemini image models, in your own project) ----
// Firestore-triggered: no public HTTP endpoint needed. The app creates
// coverRequests/{id}; we generate and write the image back onto that doc; the
// app reads it and deletes the request.
// Vertex retires model IDs roughly yearly. If these start returning 404
// "not found or your project does not have access", list the current catalog:
//   GET https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models
const PROJECT = "friendly-6992a", LOCATION = "us-central1";
// Tried in order. Gemini 3.x image models are served from the global endpoint
// only (regional returns 404); 2.5 is regional. Flash tier matches the budget
// the app was built around; put { model: "gemini-3-pro-image", location: "global" }
// first for top quality at roughly 3× the cost.
const IMAGE_MODELS = [
  { model: "gemini-3.1-flash-image", location: "global" },
  { model: "gemini-2.5-flash-image", location: LOCATION }
];
const vertexHost = loc => (loc === "global" ? "" : loc + "-") + "aiplatform.googleapis.com";
const gauth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

// "Invitation art" made models paint dates/RSVP text onto covers; ask for
// pure imagery instead.
const FLAIR = ", vibrant celebratory illustration, bold colors, high quality. Pure imagery only: no text, no words, no letters, no numbers, no dates, no calendars, no signs or banners with writing";

// Firestore docs cap at 1MB and these models return multi-MB PNGs, so
// normalize to a ~1024px JPEG data URL (~100-200KB).
async function toCoverJpeg(buf) {
  const out = await sharp(buf).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return "data:image/jpeg;base64," + out.toString("base64");
}

// Preferred generator: a Gemini image model on Vertex (as our own service account).
async function geminiGenerate(prompt) {
  const token = (await (await gauth.getClient()).getAccessToken()).token;
  let lastErr;
  for (const { model, location } of IMAGE_MODELS) {
    const url = `https://${vertexHost(location)}/v1/projects/${PROJECT}/locations/${location}/publishers/google/models/${model}:generateContent`;
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt + FLAIR }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } }
    };
    try {
      const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(model + " " + r.status + ": " + (await r.text()).slice(0, 160));
      const j = await r.json();
      const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      const img = parts.find(p => p.inlineData && p.inlineData.data);
      if (!img) throw new Error(model + ": no image in response");
      return { image: await toCoverJpeg(Buffer.from(img.inlineData.data, "base64")), model };
    } catch (e) { lastErr = e; logger.warn(e.message + ", trying next model"); }
  }
  throw lastErr;
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
    } catch (e) { lastErr = e; logger.warn(e.message + ", trying next model"); }
  }
  throw lastErr;
}

exports.onCoverRequest = onDocumentCreated({ document: "coverRequests/{id}", region: "us-central1", timeoutSeconds: 120, memory: "512MiB" }, async e => {
  const d = e.data && e.data.data(); if (!d || !d.prompt) return;
  const ref = e.data.ref;
  const prompt = String(d.prompt).slice(0, 400);
  let image = null, source = null;
  try { const g = await geminiGenerate(prompt); image = g.image; source = g.model; }
  catch (err) {
    logger.warn("vertex unavailable, using fallback: " + err.message);
    try { image = await pollinationsGenerate(prompt); source = "pollinations"; }
    catch (err2) { logger.error("cover generation failed: " + err2.message); }
  }
  if (image) await ref.update({ status: "done", source, image });
  else await ref.update({ status: "error", error: "generation failed" });
});

// ---- Receipt reading (Gemini vision) ----
// Same request/response-doc pattern as covers: the app writes
// receiptRequests/{id} with a photo; we write back itemized JSON.
const RECEIPT_MODEL = "gemini-2.5-flash";
async function readReceipt(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(dataUrl); if (!m) throw new Error("not an image");
  const token = (await (await gauth.getClient()).getAccessToken()).token;
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${RECEIPT_MODEL}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: m[1], data: m[2] } },
      { text: "Read this receipt. List every purchased line item with its price after any per-line discount (merge quantity lines into one item with the extended price), plus subtotal, tax, tip (0 if none is printed), total, and the merchant name. Prices are dollars as numbers. Ignore payment, change, and loyalty lines." }
    ] }],
    generationConfig: {
      temperature: 0, responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", required: ["items"], properties: {
        merchant: { type: "STRING" },
        items: { type: "ARRAY", items: { type: "OBJECT", required: ["name", "price"], properties: { name: { type: "STRING" }, price: { type: "NUMBER" } } } },
        subtotal: { type: "NUMBER" }, tax: { type: "NUMBER" }, tip: { type: "NUMBER" }, total: { type: "NUMBER" }
      } }
    }
  };
  const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(RECEIPT_MODEL + " " + r.status + ": " + (await r.text()).slice(0, 160));
  const j = await r.json();
  const text = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || "").join("");
  const data = JSON.parse(text);
  if (!Array.isArray(data.items) || !data.items.length) throw new Error("no line items found");
  return data;
}

exports.onReceiptRequest = onDocumentCreated({ document: "receiptRequests/{id}", region: "us-central1", timeoutSeconds: 120, memory: "512MiB" }, async e => {
  const d = e.data && e.data.data(); if (!d || !d.image) return;
  const ref = e.data.ref;
  try { const data = await readReceipt(String(d.image)); await ref.update({ status: "done", data, image: FieldValue.delete() }); }
  catch (err) { logger.error("receipt read failed: " + err.message); await ref.update({ status: "error", error: "couldn't read that receipt", image: FieldValue.delete() }); }
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

// Group chat message -> tell the other members.
exports.onGroupComment = onDocumentCreated("groups/{gid}/comments/{cid}", async e => {
  const c = e.data && e.data.data(); if (!c) return;
  const g = (await db.doc("groups/" + e.params.gid).get()).data(); if (!g) return;
  await notify((g.memberUids || []).filter(u => u !== c.authorId),
    firstName(c.authorName) + " in " + g.name, String(c.text).slice(0, 120),
    "/#/g/" + e.params.gid);
});

// Expense discussion -> tell the people involved.
exports.onExpenseComment = onDocumentCreated("expenses/{xid}/comments/{cid}", async e => {
  const c = e.data && e.data.data(); if (!c) return;
  const x = (await db.doc("expenses/" + e.params.xid).get()).data(); if (!x) return;
  await notify((x.involved || []).filter(u => u !== c.authorId),
    firstName(c.authorName) + " on " + (x.desc || "an expense"), String(c.text).slice(0, 120),
    "/#/x/" + e.params.xid);
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
