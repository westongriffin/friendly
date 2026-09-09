// Friendly Cloud Functions: push notifications, day-of reminders, and an
// optional SMS path. Deploy with:  firebase deploy --only functions
// (Requires the Blaze plan, which is enabled.)
//
// Push works once the native app registers an FCM token (saved to
// users/{uid}.pushTokens by the client). SMS is only active if you set Twilio
// credentials:  firebase functions:config:set twilio.sid=... twilio.token=... twilio.from=+1...
const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const webpush = require("web-push");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { GoogleAuth } = require("google-auth-library");
const sharp = require("sharp");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

// Web push (installed PWA / browsers). Public key also lives in firebase-config.js;
// the private key is a Functions secret (firebase functions:secrets:set VAPID_PRIVATE_KEY).
const VAPID_PUBLIC = "BAG0yqJjd5-thc9sQ3g9oG95zpXkbsUTLn2uJ0_nzx2n9IZ4cSgrQ5pLhTuVVexRrnUBNSOYLJDmyDs-paqWTN8";
const VAPID_PRIVATE = defineSecret("VAPID_PRIVATE_KEY");
const PUSH = { secrets: [VAPID_PRIVATE] };   // spread into every function that calls notify()

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

// ---- Email calendar invites (iMIP over Resend) ----
// One email per guest with an invite.ics (METHOD:REQUEST / CANCEL) so Gmail,
// Apple Mail and Outlook show Accept/Decline and file it on the calendar.
// Organizer is the host (Reply-To goes to them); the sender is Friendly.
// Requires the MAILGUN_API_KEY secret (a value of "unset" means "not configured").
// Mailgun sending domain: mail.officialfriendly.com (Wix can only host TXT/CNAME
// records for it, which is all Mailgun needs).
const MAILGUN_API_KEY = defineSecret("MAILGUN_API_KEY");
const MAILGUN_API = "https://api.mailgun.net/v3/mail.officialfriendly.com";
const MAIL = { secrets: [VAPID_PRIVATE, MAILGUN_API_KEY] };
// Shown as "<Host name> via Friendly"; replies and calendar responses go to the host.
const MAIL_FROM = name => `${String(name || "Friendly").replace(/[<>"]/g, "")} via Friendly <invites@mail.officialfriendly.com>`;
const SITE = "https://officialfriendly.com";
const icsEsc = s => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsFold = line => { const out = []; let s = line; while (s.length > 73) { out.push(s.slice(0, 73)); s = " " + s.slice(73); } out.push(s); return out.join("\r\n"); };
const minutes = t => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
const hhmm = mins => String(Math.floor(mins / 60) % 24).padStart(2, "0") + String(mins % 60).padStart(2, "0") + "00";
const nextDay = date => { const [y, m, d] = date.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1, d + 1)); return x.toISOString().slice(0, 10); };
function buildIcs(id, ev, method, attendees, host, seq) {
  const ymd = ev.date.replace(/-/g, "");
  let dt;
  if (!ev.time) dt = `DTSTART;VALUE=DATE:${ymd}\r\nDTEND;VALUE=DATE:${nextDay(ev.date).replace(/-/g, "")}`;
  else { const s = minutes(ev.time); let e = ev.endTime ? minutes(ev.endTime) : s + 120; if (e <= s) e = s + 120; dt = `DTSTART:${ymd}T${hhmm(s)}\r\nDTEND:${e >= 1440 ? nextDay(ev.date).replace(/-/g, "") : ymd}T${hhmm(e % 1440)}`; }
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Friendly//officialfriendly.com//EN", "METHOD:" + method, "BEGIN:VEVENT",
    "UID:" + id + "@officialfriendly.com", "SEQUENCE:" + seq, "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, ""), dt,
    "SUMMARY:" + icsEsc((ev.kind === "meeting" ? "" : (ev.emoji ? ev.emoji + " " : "")) + ev.title),
    ev.location ? "LOCATION:" + icsEsc(ev.location) : null,
    "DESCRIPTION:" + icsEsc((ev.notes ? ev.notes + "\n\n" : "") + "RSVP and details in Friendly: " + SITE + "/#/e/" + id),
    "URL:" + SITE + "/#/e/" + id,
    host.email ? `ORGANIZER;CN=${icsEsc(host.name)}:mailto:${host.email}` : null,
    ...attendees.map(a => `ATTENDEE;CN=${icsEsc(a.name)};ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${a.email}`),
    "STATUS:" + (method === "CANCEL" ? "CANCELLED" : "CONFIRMED"), "END:VEVENT", "END:VCALENDAR"
  ].filter(Boolean);
  return lines.map(icsFold).join("\r\n") + "\r\n";
}
const humanWhen = ev => { const [y, m, d] = ev.date.split("-").map(Number); const day = new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }); const t = x => { const [h, mi] = x.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; return ((h % 12) || 12) + (mi ? ":" + String(mi).padStart(2, "0") : "") + " " + ap; }; return day + (ev.time ? " at " + t(ev.time) + (ev.endTime ? " to " + t(ev.endTime) : "") : ""); };
// onlyUids: restrict to newly added guests (used when the guest list grows).
async function sendInviteEmails(id, ev, method, onlyUids) {
  const key = MAILGUN_API_KEY.value(); if (!key || key === "unset") { logger.info("email invites skipped: MAILGUN_API_KEY not set"); return; }
  if (!ev || !ev.date || !ev.title) return;
  const uids = [...new Set([...(ev.invitedUids || []), ev.hostId])].filter(Boolean);
  const snaps = uids.length ? await db.getAll(...uids.map(u => db.doc("users/" + u))) : [];
  const people = {}; snaps.forEach(s => { if (s.exists) people[s.id] = { name: s.get("name") || "Guest", email: String(s.get("email") || "").toLowerCase() }; });
  const host = people[ev.hostId] || { name: ev.hostName || "Your host", email: "" };
  const attendees = [], seen = new Set([host.email]);
  for (const u of (ev.invitedUids || [])) { const p = people[u]; if (u === ev.hostId || !p || !p.email || seen.has(p.email)) continue; seen.add(p.email); attendees.push({ uid: u, name: p.name, email: p.email }); }
  for (const e of (ev.guestEmails || [])) { const em = String(e).toLowerCase().trim(); if (!em.includes("@") || seen.has(em)) continue; seen.add(em); attendees.push({ uid: null, name: em.split("@")[0], email: em }); }
  const targets = onlyUids ? attendees.filter(a => a.uid && onlyUids.includes(a.uid)) : attendees;
  if (!targets.length) return;
  const seq = Number(ev.sequence || 0);
  const ics = buildIcs(id, ev, method, attendees, host, seq);
  const kind = ev.kind === "meeting" ? "meeting" : "event";
  const prefix = method === "CANCEL" ? "Cancelled: " : seq ? "Updated: " : "Invitation: ";
  const subject = prefix + (kind === "event" && ev.emoji ? ev.emoji + " " : "") + ev.title;
  const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2A2019">
    <p style="color:#8C7C70;margin:0 0 6px">${esc(host.name)} ${method === "CANCEL" ? "cancelled this " + kind : (seq ? "updated this " + kind : "invited you to a " + kind)}</p>
    <h2 style="margin:0 0 14px;font-size:24px">${kind === "event" && ev.emoji ? esc(ev.emoji) + " " : ""}${esc(ev.title)}</h2>
    <p style="margin:0 0 6px"><b>When:</b> ${esc(humanWhen(ev))}</p>
    ${ev.location ? `<p style="margin:0 0 6px"><b>Where:</b> ${esc(ev.location)}</p>` : ""}
    ${ev.notes ? `<p style="margin:12px 0;white-space:pre-wrap">${esc(ev.notes)}</p>` : ""}
    ${method === "CANCEL" ? "" : `<p style="margin:20px 0"><a href="${SITE}/#/e/${id}" style="background:#FF6B57;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600;display:inline-block">RSVP in Friendly</a></p>
    <p style="color:#8C7C70;font-size:13px">The attached invite adds this to your calendar. Accept or decline there, or RSVP in Friendly.</p>`}
  </div>`;
  let sent = 0;
  for (const a of targets) {
    const form = new FormData();
    form.append("from", MAIL_FROM(host.name)); form.append("to", a.email);
    if (host.email) form.append("h:Reply-To", host.email);
    form.append("subject", subject); form.append("html", html);
    form.append("attachment", new Blob([ics], { type: "text/calendar; method=" + method }), "invite.ics");
    const r = await fetch(MAILGUN_API + "/messages", { method: "POST", headers: { Authorization: "Basic " + Buffer.from("api:" + key).toString("base64") }, body: form });
    if (!r.ok) logger.warn("mailgun " + r.status + ": " + (await r.text()).slice(0, 200)); else sent++;
    await new Promise(res => setTimeout(res, 150));
  }
  logger.info(`invite emails (${method}) sent: ${sent}/${targets.length} for ${id}`);
}

// ---- Public preview for "anyone with the link" events (signed-out visitors) ----
async function writePreview(id, ev) {
  const ref = db.doc("previews/" + id);
  if (!ev || !ev.openLink) { await ref.delete().catch(() => {}); return; }
  const going = (ev.invitedUids || []).reduce((t, u) => (ev.rsvps || {})[u] === "going" ? t + 1 + (((ev.plusOnes || {})[u]) || 0) : t, 0);
  const data = { title: ev.title, emoji: ev.emoji || "", kind: ev.kind || "event", date: ev.date, time: ev.time || "", endTime: ev.endTime || "", location: ev.location || "", hostName: ev.hostName || "", theme: ev.theme || "", going, capacity: ev.capacity || 0, updatedAt: Date.now() };
  const cur = await ref.get();
  const coverKey = ev.cover ? ev.cover.length : 0;
  if (coverKey && (!cur.exists || cur.get("coverKey") !== coverKey)) {
    try { const m = /^data:image\/[a-z]+;base64,(.+)$/i.exec(ev.cover); if (m) { const out = await sharp(Buffer.from(m[1], "base64")).resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer(); data.cover = "data:image/jpeg;base64," + out.toString("base64"); data.coverKey = coverKey; } } catch (e) { logger.warn("preview cover: " + e.message); }
  } else if (cur.exists && cur.get("cover")) { data.cover = cur.get("cover"); data.coverKey = cur.get("coverKey"); }
  await ref.set(data);
}

// ---- Recurring events: the next occurrence is created the day after one passes ----
function addPeriod(date, repeat) {
  const [y, m, d] = date.split("-").map(Number);
  let x;
  if (repeat === "monthly") { x = new Date(Date.UTC(y, m, Math.min(d, 28))); }
  else x = new Date(Date.UTC(y, m - 1, d + (repeat === "biweekly" ? 14 : 7)));
  return x.toISOString().slice(0, 10);
}

// ---- Public HTTP endpoints (org policy now allows public invokers) ----
const FN_BASE = "https://us-central1-friendly-6992a.cloudfunctions.net";
const htmlEsc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Rich link previews for texted/shared invites: /p/{eventId} serves OpenGraph
// tags (iMessage, WhatsApp, Slack unfurl them) then sends people on to the app;
// /p/{eventId}/cover.jpg serves the preview's cover image.
exports.share = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB" }, async (req, res) => {
  const m = /^\/p\/([a-f0-9]{8,64})(\/cover\.jpg)?\/?$/i.exec(req.path || "");
  if (!m) { res.redirect(302, SITE); return; }
  const id = m[1]; const snap = await db.doc("previews/" + id).get(); const p = snap.exists ? snap.data() : null;
  if (m[2]) {
    const c = p && p.cover ? /^data:image\/jpeg;base64,(.+)$/i.exec(p.cover) : null;
    if (!c) { res.redirect(302, SITE + "/icons/icon-512.png"); return; }
    res.set("Cache-Control", "public, max-age=600"); res.type("image/jpeg").send(Buffer.from(c[1], "base64")); return;
  }
  const target = SITE + "/#/e/" + id;
  if (!p) { res.redirect(302, target); return; }
  const title = (p.kind === "meeting" ? "📅 " : (p.emoji ? p.emoji + " " : "")) + p.title;
  const when = humanWhen({ date: p.date, time: p.time, endTime: p.endTime });
  const desc = when + (p.location ? " · " + p.location : "") + (p.hostName ? " · hosted by " + p.hostName : "") + (p.going ? " · " + p.going + " going" : "");
  const img = p.cover ? FN_BASE + "/share/p/" + id + "/cover.jpg" : SITE + "/icons/icon-512.png";
  res.set("Cache-Control", "public, max-age=300");
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${htmlEsc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:type" content="website"><meta property="og:site_name" content="Friendly">
<meta property="og:title" content="${htmlEsc(title)}"><meta property="og:description" content="${htmlEsc(desc)}">
<meta property="og:image" content="${img}"><meta property="og:url" content="${FN_BASE}/share/p/${id}">
<meta name="twitter:card" content="${p.cover ? "summary_large_image" : "summary"}"><meta name="twitter:title" content="${htmlEsc(title)}"><meta name="twitter:description" content="${htmlEsc(desc)}"><meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)});</script></head>
<body style="font-family:-apple-system,system-ui,sans-serif;padding:24px;color:#2A2019"><p>Opening your invite… <a href="${target}">Tap here if it doesn't open.</a></p></body></html>`);
});

// Calendar subscription: /cal?u=<uid>&t=<token> is a live .ics feed of every
// event the user is invited to (subscribe once in iPhone/Google Calendar).
// The token lives on the user's profile; the app makes it on first use.
exports.cal = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB" }, async (req, res) => {
  const u = String(req.query.u || ""), t = String(req.query.t || "");
  if (!/^[A-Za-z0-9]{10,64}$/.test(u) || !/^[a-f0-9]{24,64}$/i.test(t)) { res.status(400).send("bad request"); return; }
  const user = await db.doc("users/" + u).get();
  if (!user.exists || user.get("calToken") !== t) { res.status(403).send("forbidden"); return; }
  const snap = await db.collection("events").where("invitedUids", "array-contains", u).get();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Friendly//officialfriendly.com//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Friendly", "X-WR-TIMEZONE:America/Chicago", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  snap.forEach(d => {
    const ev = d.data(); if (!ev.date || !ev.title) return;
    const my = (ev.rsvps || {})[u] || "no answer yet";
    const ymd = ev.date.replace(/-/g, "");
    let dt;
    if (!ev.time) dt = `DTSTART;VALUE=DATE:${ymd}\r\nDTEND;VALUE=DATE:${nextDay(ev.date).replace(/-/g, "")}`;
    else { const s = minutes(ev.time); let e = ev.endTime ? minutes(ev.endTime) : s + 120; if (e <= s) e = s + 120; dt = `DTSTART:${ymd}T${hhmm(s)}\r\nDTEND:${e >= 1440 ? nextDay(ev.date).replace(/-/g, "") : ymd}T${hhmm(e % 1440)}`; }
    lines.push("BEGIN:VEVENT", "UID:" + d.id + "@officialfriendly.com", "DTSTAMP:" + stamp, dt,
      "SUMMARY:" + icsEsc((ev.kind === "meeting" ? "" : (ev.emoji ? ev.emoji + " " : "")) + ev.title),
      ev.location ? "LOCATION:" + icsEsc(ev.location) : null,
      "DESCRIPTION:" + icsEsc("Your RSVP: " + my + (ev.hostName ? "\nHost: " + ev.hostName : "") + (ev.notes ? "\n\n" + ev.notes : "") + "\n\n" + SITE + "/#/e/" + d.id),
      "URL:" + SITE + "/#/e/" + d.id, "STATUS:" + (my === "no" ? "CANCELLED" : "CONFIRMED"), "END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  res.set("Cache-Control", "private, max-age=300"); res.set("Content-Disposition", 'inline; filename="friendly.ics"');
  res.type("text/calendar; charset=utf-8").send(lines.filter(Boolean).map(icsFold).join("\r\n") + "\r\n");
});

const firstName = n => (n || "Someone").split(" ")[0];

const commentPreview = c => c.img && !c.text ? "📷 Photo" : String(c.text || "").slice(0, 120);
// People named with @ get their own line in the feed / a push of their own.
const mentionNotify = (c, url, where) => (c.mentions && c.mentions.length) ? notify(c.mentions.filter(u => u !== c.authorId), firstName(c.authorName) + " mentioned you" + (where ? " in " + where : ""), commentPreview(c), url, { type: "mention", actorId: c.authorId }) : Promise.resolve();

// Every device for a set of users (native FCM tokens + web push subscriptions):
// send, prune anything dead, and log the item to the Activity feed so it shows
// in-app even for people who keep notifications off.
async function notify(uids, title, body, url = "/", extra = {}) {
  const ids = [...new Set(uids)].filter(Boolean);
  if (!ids.length) return;
  await db.collection("activity").add({ uids: ids, title, body, url, type: extra.type || "", actorId: extra.actorId || "", createdAt: Date.now() })
    .catch(err => logger.warn("activity: " + err.message));
  const snaps = await db.getAll(...ids.map(id => db.doc("users/" + id)));
  const tokenOwner = {}, tokens = [], subs = [];
  snaps.forEach(s => {
    (s.get("pushTokens") || []).forEach(t => { tokens.push(t); tokenOwner[t] = s.id; });
    (s.get("webPush") || []).forEach(sub => subs.push({ sub, uid: s.id }));
  });
  const jobs = [];
  if (tokens.length) jobs.push(getMessaging().sendEachForMulticast({
    tokens, notification: { title, body }, data: { url }, apns: { payload: { aps: { sound: "default" } } }
  }).then(async res => {
    const dead = [];
    res.responses.forEach((r, i) => { if (!r.success) { const c = r.error && r.error.code; if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-argument") dead.push(tokens[i]); } });
    const byUser = {}; dead.forEach(t => { (byUser[tokenOwner[t]] = byUser[tokenOwner[t]] || []).push(t); });
    await Promise.all(Object.entries(byUser).map(([uid, ts]) => db.doc("users/" + uid).update({ pushTokens: FieldValue.arrayRemove(...ts) }).catch(() => {})));
  }).catch(err => logger.warn("fcm: " + err.message)));
  if (subs.length && VAPID_PRIVATE.value()) {
    webpush.setVapidDetails("mailto:wes@wes-griffin.com", VAPID_PUBLIC, VAPID_PRIVATE.value());
    const payload = JSON.stringify({ title, body, url });
    jobs.push(...subs.map(({ sub, uid }) => webpush.sendNotification(sub, payload).catch(err => {
      // 404/410 = the browser dropped the subscription; forget it.
      if (err.statusCode === 404 || err.statusCode === 410) return db.doc("users/" + uid).update({ webPush: FieldValue.arrayRemove(sub) }).catch(() => {});
      logger.warn("webpush " + err.statusCode + ": " + String(err.message).slice(0, 120));
    })));
  }
  await Promise.all(jobs);
}

async function names(uids) {
  const snaps = await db.getAll(...uids.map(id => db.doc("users/" + id)));
  const m = {}; snaps.forEach(s => m[s.id] = s.get("name") || "Someone"); return m;
}

// New event -> tell the guests, email calendar invites, publish a preview.
exports.onEventCreated = onDocumentCreated({ document: "events/{id}", ...MAIL }, async e => {
  const ev = e.data && e.data.data(); if (!ev) return;
  const nm = await names([ev.hostId]);
  const kind = ev.kind === "meeting" ? "meeting" : "event";
  await notify((ev.invitedUids || []).filter(u => u !== ev.hostId),
    firstName(nm[ev.hostId]) + " invited you" + (kind === "meeting" ? " to a meeting" : ""), (kind === "meeting" ? "📅 " : (ev.emoji || "🎉") + " ") + ev.title,
    "/#/e/" + e.params.id, { type: kind, actorId: ev.hostId });
  await Promise.all([sendInviteEmails(e.params.id, ev, "REQUEST"), writePreview(e.params.id, ev)]);
});

// Event deleted -> cancel the calendar entries, drop the preview.
exports.onEventDeleted = onDocumentDeleted({ document: "events/{id}", ...MAIL }, async e => {
  const ev = e.data && e.data.data(); if (!ev) return;
  await Promise.all([sendInviteEmails(e.params.id, ev, "CANCEL"), db.doc("previews/" + e.params.id).delete().catch(() => {})]);
});

// Someone nudged the guests who haven't answered.
exports.onNudge = onDocumentCreated({ document: "nudges/{id}", ...PUSH }, async e => {
  const n = e.data && e.data.data(); if (!n || !n.eventId) return;
  const evSnap = await db.doc("events/" + n.eventId).get(); const ev = evSnap.data(); if (!ev) return;
  if (n.by !== ev.hostId && !(ev.cohostUids || []).includes(n.by)) return;
  const targets = (ev.invitedUids || []).filter(u => u !== ev.hostId && !(ev.rsvps || {})[u]);
  const nm = await names([n.by]);
  await notify(targets, firstName(nm[n.by]) + " is waiting on your RSVP", (ev.emoji || "📅") + " " + ev.title, "/#/e/" + n.eventId, { type: "nudge", actorId: n.by });
  await e.data.ref.update({ sent: targets.length, at: Date.now() });
});

// New party-wall comment -> tell the other guests.

exports.onComment = onDocumentCreated({ document: "events/{id}/comments/{cid}", ...PUSH }, async e => {
  const c = e.data && e.data.data(); if (!c) return;
  const ev = (await db.doc("events/" + e.params.id).get()).data(); if (!ev) return;
  await notify((ev.invitedUids || []).filter(u => u !== c.authorId),
    firstName(c.authorName) + " on " + ev.title, commentPreview(c),
    "/#/e/" + e.params.id, { type: "comment", actorId: c.authorId });
  await mentionNotify(c, "/#/e/" + e.params.id, ev.title);
});

// Group chat message -> tell the other members.
exports.onGroupComment = onDocumentCreated({ document: "groups/{gid}/comments/{cid}", ...PUSH }, async e => {
  const c = e.data && e.data.data(); if (!c) return;
  const g = (await db.doc("groups/" + e.params.gid).get()).data(); if (!g) return;
  await notify((g.memberUids || []).filter(u => u !== c.authorId),
    firstName(c.authorName) + " in " + g.name, commentPreview(c),
    "/#/g/" + e.params.gid, { type: "comment", actorId: c.authorId });
  await mentionNotify(c, "/#/g/" + e.params.gid, g.name);
});

// Expense discussion -> tell the people involved.
exports.onExpenseComment = onDocumentCreated({ document: "expenses/{xid}/comments/{cid}", ...PUSH }, async e => {
  const c = e.data && e.data.data(); if (!c) return;
  const x = (await db.doc("expenses/" + e.params.xid).get()).data(); if (!x) return;
  await notify((x.involved || []).filter(u => u !== c.authorId),
    firstName(c.authorName) + " on " + (x.desc || "an expense"), commentPreview(c),
    "/#/x/" + e.params.xid, { type: "comment", actorId: c.authorId });
  await mentionNotify(c, "/#/x/" + e.params.xid, x.desc || "an expense");
});

// Content reported -> tell the moderators (we promise a 24-hour review).
// Keep in sync with adminUids in firebase-config.js and isAdmin() in the rules.
const ADMIN_UIDS = ["zzJY7MHFnyN2kAqq13hv79rZTVF2", "TUngQGsAKTRtHBpVEpZwFFHE0sP2"];
exports.onReport = onDocumentCreated({ document: "reports/{id}", ...PUSH }, async e => {
  const r = e.data && e.data.data(); if (!r) return;
  await notify(ADMIN_UIDS, "Content reported: " + (r.reason || "review needed"), String(r.snippet || r.kind || "").slice(0, 120), "/#/profile");
});

// Event updated: RSVP changes tell the host (and promote waitlisters), edits
// re-send calendar invites, new guests get theirs, and the preview refreshes.
exports.onRsvp = onDocumentUpdated({ document: "events/{id}", ...MAIL }, async e => {
  const before = e.data.before.data(), after = e.data.after.data();
  const id = e.params.id;
  const b = before.rsvps || {}, a = after.rsvps || {};
  const changed = Object.keys(a).find(u => a[u] !== b[u] && u !== after.hostId);
  if (changed) {
    const nm = await names([changed]);
    const word = { going: "is going to", maybe: "might come to", no: "can't make", waitlist: "joined the waitlist for", pending: "requested to join" }[a[changed]] || "updated";
    await notify([after.hostId], firstName(nm[changed]) + " " + word, after.title, "/#/e/" + id, { type: "rsvp", actorId: changed });
    if (a[changed] === "going" && (b[changed] === "waitlist" || b[changed] === "pending"))
      await notify([changed], "You're in! " + after.title, b[changed] === "waitlist" ? "A spot opened up and it's yours." : "The host approved you.", "/#/e/" + id, { type: "rsvp" });
  }
  // Edits to the essentials -> bump the sequence once and re-send invites.
  const essentials = ["title", "date", "time", "endTime", "location", "notes"];
  if (essentials.some(k => (before[k] || "") !== (after[k] || ""))) {
    const seq = Number(after.sequence || 0) + 1;
    await e.data.after.ref.update({ sequence: seq });
    await sendInviteEmails(id, { ...after, sequence: seq }, "REQUEST");
  } else {
    const added = (after.invitedUids || []).filter(u => !(before.invitedUids || []).includes(u));
    if (added.length) await sendInviteEmails(id, after, "REQUEST", added);
  }
  await writePreview(id, after);
});

// 9am daily (project timezone): day-of reminders, the next occurrence of
// repeating events, and gentle money reminders.
exports.dailyReminders = onSchedule({ schedule: "0 9 * * *", timeZone: "America/Chicago", ...MAIL }, async () => {
  const d = new Date();
  const today = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const snap = await db.collection("events").where("date", "==", today).get();
  for (const doc of snap.docs) {
    const ev = doc.data();
    const going = (ev.invitedUids || []).filter(u => ["going", "maybe"].includes((ev.rsvps || {})[u]));
    await notify(going, "Today: " + ev.title, (ev.time ? "Starts " + ev.time + ". " : "") + (ev.location || "See you there!"), "/#/e/" + doc.id, { type: "reminder" });
  }
  logger.info("Sent reminders for " + snap.size + " events");

  // Repeating events: once an occurrence has passed, create the next one
  // (copies everything, resets RSVPs) and retire the old one from the series.
  const rep = await db.collection("events").where("repeat", "in", ["weekly", "biweekly", "monthly"]).where("date", "<", today).get();
  for (const doc of rep.docs) {
    const ev = doc.data(); let next = ev.date; let guard = 0;
    while (next < today && guard++ < 400) next = addPeriod(next, ev.repeat);
    const copy = { ...ev, date: next, rsvps: { [ev.hostId]: "going" }, plusOnes: {}, hypes: {}, answers: {}, createdAt: Date.now(), sequence: 0, seriesId: ev.seriesId || doc.id, prevId: doc.id };
    delete copy.nextId;
    const ref = await db.collection("events").add(copy);
    await doc.ref.update({ repeat: "", nextId: ref.id });
  }
  if (rep.size) logger.info("Rolled " + rep.size + " repeating events forward");

  // Money: whoever has owed the same person for a while gets a nudge, at most every 3 days.
  const [xs, ss, logSnap] = await Promise.all([db.collection("expenses").get(), db.collection("settlements").get(), db.collection("nudgeLog").get()]);
  const owes = {}; const add = (from, to, cents) => { if (from === to || !cents) return; (owes[from] = owes[from] || {})[to] = (owes[from][to] || 0) + cents; };
  xs.forEach(x => { const e = x.data(); if (e.shares) Object.entries(e.shares).forEach(([u, c]) => add(u, e.paidBy, c)); else { const split = e.split || []; if (!split.length) return; const base = Math.floor(e.amountCents / split.length); let rem = e.amountCents - base * split.length; split.forEach(u => add(u, e.paidBy, base + (rem-- > 0 ? 1 : 0))); } });
  ss.forEach(s => { const e = s.data(); add(e.to, e.from, e.amountCents); });
  const log = {}; logSnap.forEach(l => log[l.id] = l.data().at || 0);
  let nudged = 0;
  for (const from in owes) for (const to in owes[from]) {
    const net = (owes[from][to] || 0) - ((owes[to] || {})[from] || 0);
    if (net < 100) continue;
    const key = from + "_" + to; if (Date.now() - (log[key] || 0) < 3 * 86400e3) continue;
    const nm = await names([to]);
    await notify([from], "You still owe " + firstName(nm[to]) + " $" + (net / 100).toFixed(2), "Settle up from the Money tab.", "/#/money", { type: "money" });
    await db.doc("nudgeLog/" + key).set({ at: Date.now() }); nudged++;
  }
  if (nudged) logger.info("Money reminders sent: " + nudged);
});
