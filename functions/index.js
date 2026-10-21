// Friendly Cloud Functions: push notifications, day-of reminders, and an
// optional SMS path. Deploy with:  firebase deploy --only functions
// (Requires the Blaze plan, which is enabled.)
//
// Push works once the native app registers an FCM token (saved to
// users/{uid}.pushTokens by the client). SMS is only active if you set Twilio
// credentials:  firebase functions:config:set twilio.sid=... twilio.token=... twilio.from=+1...
const { onDocumentCreated, onDocumentWritten, onDocumentUpdated, onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const nodeCrypto = require("crypto");
const functionsV1 = require("firebase-functions/v1");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const webpush = require("web-push");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { getStorage } = require("firebase-admin/storage");
const { getAuth } = require("firebase-admin/auth");
const { GoogleAuth } = require("google-auth-library");
const sharp = require("sharp");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

// Web push (installed PWA / browsers). Public key also lives in firebase-config.js;
// the private key is a Functions secret (firebase functions:secrets:set VAPID_PRIVATE_KEY).
const VAPID_PUBLIC = "BAG0yqJjd5-thc9sQ3g9oG95zpXkbsUTLn2uJ0_nzx2n9IZ4cSgrQ5pLhTuVVexRrnUBNSOYLJDmyDs-paqWTN8";
const VAPID_PRIVATE = defineSecret("VAPID_PRIVATE_KEY");
// iPhone pushes go straight to Apple (APNs over HTTP/2, token auth) rather than
// through FCM: the app has no Firebase iOS SDK, so its push plugin hands back a
// raw APNs device token (64 hex chars), which is exactly what APNs wants and
// exactly what FCM can't use. The .p8 is the Functions secret APNS_KEY.
const APNS_KEY = defineSecret("APNS_KEY");
const APNS_KEY_ID = "657K4Q24NF", APNS_TEAM_ID = "L7H9872BR2", APNS_TOPIC = "com.officialfriendly.app";
const PUSH = { secrets: [VAPID_PRIVATE, APNS_KEY] };   // spread into every function that calls notify()
const isApnsToken = t => /^[0-9a-f]{64}$/i.test(t);
let apnsJwt = { token: "", at: 0 };
function apnsAuth() {
  const key = APNS_KEY.value(); if (!key) return "";
  if (Date.now() - apnsJwt.at < 45 * 60 * 1000) return apnsJwt.token;   // Apple: reuse 20-60 min
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = b64({ alg: "ES256", kid: APNS_KEY_ID }) + "." + b64({ iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) });
  const sig = require("crypto").sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  apnsJwt = { token: unsigned + "." + sig, at: Date.now() };
  return apnsJwt.token;
}
// Sends one alert to each APNs token; resolves to the tokens Apple says are dead.
// badgeOf(token) = the red number for that phone's app icon (the owner's unread Activity count).
function apnsSend(tokens, title, body, url, badgeOf = () => undefined) {
  const auth = apnsAuth(); if (!auth || !tokens.length) return Promise.resolve([]);
  const http2 = require("http2");
  return new Promise(resolve => {
    const dead = []; let left = tokens.length;
    const client = http2.connect("https://api.push.apple.com");
    client.on("error", err => { logger.warn("apns connect: " + err.message); resolve(dead); });
    const payloadFor = t => { const b = badgeOf(t); return JSON.stringify({ aps: { alert: { title, body }, sound: "default", "mutable-content": 0, ...(b != null ? { badge: b } : {}) }, url }); };
    const finish = () => { if (--left === 0) { client.close(); resolve(dead); } };
    for (const t of tokens) {
      const req = client.request({ ":method": "POST", ":path": "/3/device/" + t, authorization: "bearer " + auth, "apns-topic": APNS_TOPIC, "apns-push-type": "alert", "apns-priority": "10", "content-type": "application/json" });
      let resBody = "", status = 0;
      req.on("response", h => { status = h[":status"]; });
      req.on("data", d => { resBody += d; });
      req.on("end", () => {
        if (status !== 200) {
          let reason = ""; try { reason = JSON.parse(resBody).reason || ""; } catch {}
          if (status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic") dead.push(t);
          else logger.warn("apns " + status + " " + reason);
        }
        finish();
      });
      req.on("error", err => { logger.warn("apns req: " + err.message); finish(); });
      req.end(payloadFor(t));
    }
  });
}

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
// Covers and icons someone asks for (events, groups) use the top-quality model first (about 3x the cost per image);
// Curate's nightly covers stay on the fast tier above.
const IMAGE_MODELS_PRO = [{ model: "gemini-3-pro-image", location: "global" }, ...IMAGE_MODELS];
// The most relaxed setting Google lets us choose for each adjustable filter (Wes, Oct 19 2026). Google's own fixed
// filters (explicit content, minors, real public figures) still apply and can't be turned off.
const IMAGE_SAFETY = ["HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_DANGEROUS_CONTENT", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_HARASSMENT"].map(category => ({ category, threshold: "OFF" }));
// When the model answers without an image, say why in plain words (shown to the person who asked).
function imageRefusal(j) {
  const c = (j.candidates || [])[0] || {}, why = String(c.finishReason || "") + " " + String((j.promptFeedback || {}).blockReason || "");
  const said = (((c.content || {}).parts) || []).map(p => p.text || "").join(" ").replace(/\s+/g, " ").trim().slice(0, 180);
  if (/RECITATION/.test(why)) return "That came out too close to an existing copyrighted image. Try changing the idea a little.";
  if (/PROHIBITED|BLOCKLIST/.test(why)) return "Google won't make images of that (usually real people, celebrities, brands, or explicit content). Try a different idea.";
  if (/SAFETY|SPII/.test(why)) return "Google's image filter flagged this one. Try rewording it.";
  if (said) return "Google's image model said: " + said;
  return "";
}
const vertexHost = loc => (loc === "global" ? "" : loc + "-") + "aiplatform.googleapis.com";
const gauth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

// "Invitation art" made models paint dates/RSVP text onto covers; ask for pure imagery instead. The look comes
// from the prompt itself (the app adds the style the host picked). This used to force "vibrant celebratory
// illustration, bold colors" onto every cover, which made them all look alike: cartoonish and the same palette.
const FLAIR = ". High quality, well composed. Pure imagery only: no text, no words, no letters, no numbers, no dates, no calendars, no signs or banners with writing";

// Firestore docs cap at 1MB and these models return multi-MB PNGs, so
// normalize to a ~1024px JPEG data URL (~100-200KB).
async function toCoverJpeg(buf) {
  const out = await sharp(buf).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return "data:image/jpeg;base64," + out.toString("base64");
}

// Preferred generator: a Gemini image model on Vertex (as our own service account).
async function geminiGenerate(prompt, { models = IMAGE_MODELS, aspect = "16:9" } = {}) {
  const token = (await (await gauth.getClient()).getAccessToken()).token;
  let lastErr, refusal = "";
  for (const { model, location } of models) {
    const url = `https://${vertexHost(location)}/v1/projects/${PROJECT}/locations/${location}/publishers/google/models/${model}:generateContent`;
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt + FLAIR }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: aspect } },
      safetySettings: IMAGE_SAFETY
    };
    try {
      const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(model + " " + r.status + ": " + (await r.text()).slice(0, 160));
      const j = await r.json();
      const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      const img = parts.find(p => p.inlineData && p.inlineData.data);
      if (!img) { const why = imageRefusal(j); if (why) refusal = why; throw new Error(model + ": no image in response" + (why ? " (" + why + ")" : "")); }
      return { image: await toCoverJpeg(Buffer.from(img.inlineData.data, "base64")), model };
    } catch (e) { lastErr = e; logger.warn(e.message + ", trying next model"); }
  }
  if (refusal) lastErr.refusal = refusal;   // every model said no: tell the person why
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

exports.onCoverRequest = onDocumentCreated({ document: "coverRequests/{id}", region: "us-central1", timeoutSeconds: 180, memory: "512MiB" }, async e => {
  const d = e.data && e.data.data(); if (!d || !d.prompt) return;
  const ref = e.data.ref;
  const prompt = String(d.prompt).slice(0, 700), aspect = ["1:1", "16:9", "3:2", "4:3"].includes(d.aspect) ? d.aspect : "16:9";
  let image = null, source = null, error = "Dot couldn't make it just now. Try again in a minute.";
  try { const g = await geminiGenerate(prompt, { models: IMAGE_MODELS_PRO, aspect }); image = g.image; source = g.model; }
  catch (err) {
    logger.warn("cover generation failed: " + err.message);
    if (err.refusal) { await ref.update({ status: "error", error: err.refusal, refused: true }); return; }
    if (/ 429/.test(err.message)) error = "Dot's image studio is swamped right now. Try again in a minute.";
  }
  if (image) await ref.update({ status: "done", source, image });
  else await ref.update({ status: "error", error });
});

// ---- Receipt reading (Gemini vision) ----
// Same request/response-doc pattern as covers: the app writes
// receiptRequests/{id} with a photo; we write back itemized JSON.
const RECEIPT_MODEL = "gemini-2.5-flash";
// Every charge on the receipt: items (a price in the price column on an indented add-on line counts, e.g. a $10
// "Margarita" upgrade under a drink), fees and surcharges kept apart from tax, tax, tip. The answer is checked
// against the printed subtotal and total; if it doesn't add up, the model is shown exactly what is off and asked
// again (twice at most), and the reading that adds up best wins.
const RECEIPT_PROMPT = `Read this receipt and return every charge on it.
- items: one entry per printed line item, in the order printed.
  - qty: the quantity printed before the item's name (for example the 2 in "2 Creste di Gallo $34.00"); 0 when the line has no quantity of its own.
  - name: the item's name without the quantity, written the way a menu would (Title Case, not ALL CAPS).
  - price: the amount in the price column for that line, which is the line's total (quantity × unit price). If only a unit price is printed next to a quantity, multiply.
  - A line with no quantity of its own that sits under an item (an add-on or modifier like "Add Truffle $3.00" under "Side of Fries") keeps qty 0 and its own price; it is still listed.
  - A discount or comp line (a minus sign like "- $8.00", or a percent off like "Food- Celebration (100%)") is listed where it is printed with a NEGATIVE price (-8 for "- $8.00").
  - A price shown in parentheses inside an item's description (for example "House Milk ($0.26)") is usually already included in that item's price: do not add it again.
- fees: every surcharge, service charge, credit card fee, delivery, kitchen, health, or similar fee, each with its name and amount. Never fold a fee into tax.
- tax: all sales taxes added together (for example a state tax plus a local tax). tip: gratuity or tip, including an automatic gratuity (0 if none is printed).
- subtotal: the subtotal AFTER discounts (when both a pre-discount subtotal and a subtotal are printed, use the second). total exactly as printed. merchant: the restaurant or store name.
Check your work before answering: the items (discounts included as negatives) must add up to the subtotal, and subtotal + tax + fees + tip must equal the printed total. Prices on long receipts can sit a line above or below their item; use the subtotal to tell which line a price belongs to. Amounts are dollars as numbers. Ignore payment, change, card, and loyalty lines.`;
const RECEIPT_SCHEMA = { type: "OBJECT", required: ["items"], properties: {
  merchant: { type: "STRING" },
  items: { type: "ARRAY", items: { type: "OBJECT", required: ["name", "price"], properties: { qty: { type: "NUMBER" }, name: { type: "STRING" }, price: { type: "NUMBER" } } } },
  fees: { type: "ARRAY", items: { type: "OBJECT", required: ["name", "amount"], properties: { name: { type: "STRING" }, amount: { type: "NUMBER" } } } },
  subtotal: { type: "NUMBER" }, tax: { type: "NUMBER" }, tip: { type: "NUMBER" }, total: { type: "NUMBER" }
} };
// Turns the reading into lines people can pick from: "2× Creste di Gallo"; an add-on (no quantity of its own, under
// an item, on a receipt that prints quantities) joins the item above ("Side of Fries + Truffle"); a discount comes
// off the item right above it (a 100% comp makes that item free) or, when there's nothing to take it from, becomes
// a negative fee that splits in proportion like tax. Zero-price lines left over are dropped.
function tidyReceipt(d) {
  const raw = (d.items || []).map(i => ({ qty: Math.max(0, Math.round(Number(i.qty) || 0)), name: String(i.name || "Item").trim(), price: Number(i.price) || 0 }));
  const printsQty = raw.filter(i => i.qty > 0).length >= Math.max(2, raw.length / 2), out = [], fees = [...(d.fees || [])];
  for (const i of raw) {
    const prev = out[out.length - 1];
    if (i.price < 0) {
      if (prev && prev.price + i.price >= -0.005) { prev.price = Math.round((prev.price + i.price) * 100) / 100; prev.note = i.name; }
      else fees.push({ name: i.name || "Discount", amount: i.price });
      continue;
    }
    if (printsQty && i.qty === 0 && prev && i.price >= 0) { prev.price = Math.round((prev.price + i.price) * 100) / 100; prev.name += " + " + i.name.replace(/^(add|extra|sub)\s+/i, ""); continue; }
    out.push({ ...i });
  }
  d.items = out.filter(i => i.price > 0 || /free|comp/i.test(i.note || "")).map(i => ({ name: (i.qty > 1 ? i.qty + "× " : "") + i.name + (i.price === 0 && i.note ? " (comped)" : ""), price: i.price, qty: i.qty || 1 }));
  d.fees = fees; return d;
}
const toC = v => Math.round((Number(v) || 0) * 100);
function receiptGaps(d) {
  const items = (d.items || []).reduce((n, i) => n + toC(i.price), 0), fees = (d.fees || []).reduce((n, f) => n + toC(f.amount), 0);
  const sub = d.subtotal ? toC(d.subtotal) : null, total = d.total ? toC(d.total) : null;
  const itemGap = sub == null ? 0 : sub - items, totalGap = total == null ? 0 : total - ((sub == null ? items : sub) + toC(d.tax) + fees + toC(d.tip));
  return { items, fees, itemGap, totalGap, off: Math.abs(itemGap) + Math.abs(totalGap) };
}
async function askReceipt(mime, b64, extra) {
  const token = (await (await gauth.getClient()).getAccessToken()).token;
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${RECEIPT_MODEL}:generateContent`;
  const body = { contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: b64 } }, { text: RECEIPT_PROMPT + (extra ? "\n\n" + extra : "") }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: RECEIPT_SCHEMA } };
  const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(RECEIPT_MODEL + " " + r.status + ": " + (await r.text()).slice(0, 160));
  const j = await r.json();
  return JSON.parse(((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || "").join(""));
}
async function readReceipt(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(dataUrl); if (!m) throw new Error("not an image");
  let best = await askReceipt(m[1], m[2]), g = receiptGaps(best), tries = 1;
  const $ = c => "$" + (Math.abs(c) / 100).toFixed(2);
  while (g.off > 1 && tries < 3) {
    const sum = (best.subtotal ? toC(best.subtotal) : g.items) + toC(best.tax) + g.fees + toC(best.tip);
    const fix = "Your last reading does not add up." +
      (g.itemGap ? ` Your items add to ${$(g.items)} but the printed subtotal is ${$(toC(best.subtotal))} (${$(g.itemGap)} ${g.itemGap > 0 ? "missing: look for a priced add-on line" : "too much"}).` : "") +
      (g.totalGap ? ` Subtotal + tax + fees + tip comes to ${$(sum)} but the printed total is ${$(toC(best.total))} (${$(g.totalGap)} ${g.totalGap > 0 ? "missing: look for a fee or surcharge line" : "too much"}).` : "") +
      " Look at the receipt again line by line and answer with the corrected reading. Your last reading was: " + JSON.stringify(best);
    let next; try { next = await askReceipt(m[1], m[2], fix); } catch (err) { logger.warn("receipt retry failed: " + err.message); break; }
    const ng = receiptGaps(next); tries++;
    if (ng.off < g.off && Array.isArray(next.items) && next.items.length) { best = next; g = ng; }
  }
  if (!Array.isArray(best.items) || !best.items.length) throw new Error("no line items found");
  tidyReceipt(best);
  best.check = { itemGap: g.itemGap, totalGap: g.totalGap, tries };
  logger.info(`receipt read in ${tries} tr${tries > 1 ? "ies" : "y"}, off by ${g.off} cents`);
  return best;
}

exports.onReceiptRequest = onDocumentCreated({ document: "receiptRequests/{id}", region: "us-central1", timeoutSeconds: 120, memory: "512MiB" }, async e => {
  const d = e.data && e.data.data(); if (!d || !d.image) return;
  const ref = e.data.ref;
  try { const data = await readReceipt(String(d.image)); await ref.update({ status: "done", data, image: FieldValue.delete() }); }
  catch (err) { logger.error("receipt read failed: " + err.message); await ref.update({ status: "error", error: "couldn't read that receipt", image: FieldValue.delete() }); }
});

// ---- "Let me plan it": planRequests/{id} holds what the user said (typed or dictated);
//      we write back a structured event draft the app pours into the composer.
//      The user always reviews it before anything is created or sent.
const PLAN_MODEL = "gemini-2.5-flash";
const THEME_IDS = ["confetti", "citrus", "bubblegum", "sunset", "golden", "blossom", "garden", "aurora", "midnight", "cosmic", "rave", "disco", "y2k", "retro"];
const str = { type: "STRING" };
// Cutting text by length can split an emoji in half, and Firestore rejects the leftover half ("INVALID_ARGUMENT").
const noLone = t => String(t).replace(/[\uD800-\uDBFF]$/, "").replace(/^[\uDC00-\uDFFF]/, "");
const clean = (arr, n, len) => (Array.isArray(arr) ? arr : []).slice(0, n).map(x => noLone(String(x || "").replace(/[\r\n;]+/g, " ").slice(0, len))).filter(Boolean);
const sv = (v, n) => noLone(String(v || "").trim().slice(0, n));
async function askGemini(prompt, schema, temperature = 0.2) {
  const token = (await (await gauth.getClient()).getAccessToken()).token;
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${PLAN_MODEL}:generateContent`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature, responseMimeType: "application/json", responseSchema: schema } };
  const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(PLAN_MODEL + " " + r.status + ": " + (await r.text()).slice(0, 160));
  const j = await r.json();
  return JSON.parse(((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || "").join(""));
}
function whenContext(d) {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(d.today || "") ? d.today : new Date().toISOString().slice(0, 10);
  return `Today is ${today} (${sv(d.weekday, 12)}), local time ${sv(d.now, 5)}, time zone ${sv(d.tz, 40)}. Resolve relative dates ("next Friday", "tomorrow", "the 14th") to YYYY-MM-DD in the user's zone; a bare weekday means the next one coming. Times as 24-hour HH:MM; if a time is vague ("evening"), leave it empty.`;
}
const DOT = "You are Dot, the helper inside Friendly, an app friends use to plan get-togethers and split costs. Only include what the user actually said; never invent people, places, or facts. Always use the Oxford comma in lists (\"tacos, drinks, and dessert\").";

// mode "event": what the user said -> an event draft, plus a few concrete ideas that would make the invite better organised.
// An event's stops ("6:00 PM Dinner at Hat Creek"), for calendar descriptions.
function stopsText(ev) {
  const st = (Array.isArray(ev && ev.stops) ? ev.stops : []).filter(x => x && (x.name || x.place));
  if (st.length < 2) return "";
  const t12 = t => { if (!/^\d{2}:\d{2}$/.test(t || "")) return ""; let [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + ":" + String(m).padStart(2, "0") + " " + ap; };
  return "The plan:\n" + st.map(x => (x.time ? t12(x.time) + " " : "") + (x.name || x.place) + (x.name && x.place ? " at " + x.place : "")).join("\n") + "\n\n";
}
async function draftPlan(d) {
  const text = sv(d.text, 1500); if (text.length < 4) throw new Error("nothing to plan");
  const people = clean(d.people, 150, 40), groups = clean(d.groups, 40, 40);
  const prompt = `${DOT}
Turn what the user said into an event draft. ${whenContext(d)}
Rules:
- Leave anything unknown empty and name it in "missing" using only: date, time, location, guests.
- guests: the people the user named. When a name matches one of the user's friends below, use the friend's exact spelling. Do not add people who weren't mentioned.
- group: if the user names one of their groups (or clearly means it, e.g. "the crew" when they have one group${d.groupHint ? `; the user is currently looking at the group "${sv(d.groupHint, 40)}", so "everyone" or "the group" means that one` : ""}), set it to the group's exact name and do not list its members as guests. Otherwise empty.
- bring: things people are asked to bring, one entry each, with a quantity only if stated.
- capacity: a maximum head count if stated, else 0. questions: RSVP questions the host wants to ask, if any.
- kind: "meeting" only for plain calendar meetings (work, practice, appointments, calls). Everything social is "event".
- emoji: exactly one emoji that fits. theme: one id from ${THEME_IDS.join(", ")} matching the vibe (sunset or golden for dinners, confetti for parties and birthdays, garden or blossom for brunch and outdoors, midnight or cosmic for nights out, disco, rave or retro for dance and costume nights, citrus or bubblegum for playful daytime plans).
- title: short and natural, the way the user would name it (e.g. "Taco Night", "Sam's 30th").
- food: what's being served or the food plan ("tacos and margs, BYOB", "we'll order pizza"), or empty. Things guests are asked to bring go in bring, not food.
- notes: details that don't fit elsewhere (dress code, parking, what to expect), in the user's words, or empty.
- stops: ONLY when the plan has two or more activities in sequence (dinner then bowling, drinks then a show then dessert), list each in order: time as 24-hour "HH:MM" if stated or clearly implied (else empty), name as a short label for the activity ("Dinner", "Bowling", "Dessert"), place as the venue or address if named (else empty), emoji as one emoji for that stop. When there are stops, set time to the first stop's time and location to the first stop's place. A single activity means stops is empty.
- summary: one warm sentence in Dot's voice, starting "Here's what I heard:", restating the plan in plain words. No emoji.
- ideas: 2 to 4 concrete, specific suggestions that would make THIS invite clearer or better organised, each as something the app can add with one tap. Think like a good host: an RSVP question the guests would need answering (dietary needs, plus-ones, who's driving), an item people always forget for this kind of plan (ice, cups, a speaker, sunscreen), an end time so people can plan around it, a head count if space is tight, a note about parking, what to wear or where to meet. Never suggest something the user already covered. Each idea: "label" is the chip text starting with a verb ("Ask about dietary needs", "Add ice to the bring list", "End it at 10 PM"); "kind" is one of question, bring, note, endTime, capacity; "value" is exactly what to add (the question text, the item, the note sentence, HH:MM, or a number).
Friends: ${people.join("; ") || "(none)"}.
Groups: ${groups.join("; ") || "(none)"}.

What the user said:
${text}`;
  const schema = { type: "OBJECT", required: ["title", "kind", "summary"], properties: {
    kind: { type: "STRING", enum: ["event", "meeting"] }, title: str, emoji: str, theme: { type: "STRING", enum: THEME_IDS },
    date: str, time: str, endTime: str, location: str, food: str, notes: str, capacity: { type: "INTEGER" },
    stops: { type: "ARRAY", items: { type: "OBJECT", required: ["name"], properties: { time: str, name: str, place: str, emoji: str } } },
    guests: { type: "ARRAY", items: str }, group: str,
    bring: { type: "ARRAY", items: { type: "OBJECT", required: ["item"], properties: { item: str, qty: str } } },
    questions: { type: "ARRAY", items: str },
    missing: { type: "ARRAY", items: { type: "STRING", enum: ["date", "time", "location", "guests"] } },
    ideas: { type: "ARRAY", items: { type: "OBJECT", required: ["label", "kind", "value"], properties: { label: str, kind: { type: "STRING", enum: ["question", "bring", "note", "endTime", "capacity"] }, value: str } } },
    summary: str } };
  const out = await askGemini(prompt, schema);
  const data = {
    kind: out.kind === "meeting" ? "meeting" : "event",
    title: sv(out.title, 80) || "New plan",
    emoji: noLone(sv(out.emoji, 8).replace(/[A-Za-z0-9\s]/g, "").slice(0, 4)),
    theme: THEME_IDS.includes(out.theme) ? out.theme : "",
    date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || "") ? out.date : "",
    time: /^\d{2}:\d{2}$/.test(out.time || "") ? out.time : "",
    endTime: /^\d{2}:\d{2}$/.test(out.endTime || "") ? out.endTime : "",
    location: sv(out.location, 200), food: sv(out.food, 120), notes: sv(out.notes, 1000),
    capacity: Math.max(0, Math.min(500, parseInt(out.capacity, 10) || 0)),
    guests: clean(out.guests, 30, 60), group: sv(out.group, 60),
    bring: (Array.isArray(out.bring) ? out.bring : []).slice(0, 12).map(b => ({ item: sv(b && b.item, 60), qty: sv(b && b.qty, 20) })).filter(b => b.item),
    questions: clean(out.questions, 5, 120),
    stops: (Array.isArray(out.stops) ? out.stops : []).slice(0, 8).map(x => ({ time: /^\d{2}:\d{2}$/.test((x && x.time) || "") ? x.time : "", name: sv(x && x.name, 60), place: sv(x && x.place, 120), emoji: noLone(sv(x && x.emoji, 8).replace(/[A-Za-z0-9\s]/g, "").slice(0, 4)) || "📍" })).filter(x => x.name || x.place),
    missing: clean(out.missing, 4, 12).filter(m => ["date", "time", "location", "guests"].includes(m)),
    ideas: (Array.isArray(out.ideas) ? out.ideas : []).slice(0, 4).map(x => ({ label: sv(x && x.label, 60), kind: sv(x && x.kind, 12), value: sv(x && x.value, 200) }))
      .filter(x => x.label && x.value && ["question", "bring", "note", "endTime", "capacity"].includes(x.kind))
      .filter(x => x.kind !== "endTime" || /^\d{2}:\d{2}$/.test(x.value)).filter(x => x.kind !== "capacity" || /^\d{1,3}$/.test(x.value)),
    summary: sv(out.summary, 300) || "Here's what I heard."
  };
  if (!data.date && !data.missing.includes("date")) data.missing.push("date");
  return data;
}

// mode "expense": what the user said -> an expense draft (what, how much, who paid, who splits).
async function draftExpense(d) {
  const text = sv(d.text, 1500); if (text.length < 4) throw new Error("nothing to add");
  const people = clean(d.people, 150, 40);
  const prompt = `${DOT}
Turn what the user said into a shared-expense draft. "I"/"me" is the user. ${whenContext(d)}
- desc: a short label for what was bought ("Pizza & drinks", "Uber home").
- amount: the total in dollars as a number, 0 if not said.
- paidBy: "me" if the user paid, otherwise the friend's exact name from the list, or empty if unclear.
- splitWith: the people sharing it, using exact names from the list when they match; include "me" if the user is in on it (assume the user is, unless they say otherwise). If the user says everyone / all of us / the whole group, set splitEveryone true and leave splitWith empty.
- missing: name what wasn't said, from: amount, split, payer.
- summary: one sentence in Dot's voice starting "Here's what I heard:".
Friends: ${people.join("; ") || "(none)"}.

What the user said:
${text}`;
  const schema = { type: "OBJECT", required: ["desc", "summary"], properties: {
    desc: str, amount: { type: "NUMBER" }, paidBy: str, splitWith: { type: "ARRAY", items: str }, splitEveryone: { type: "BOOLEAN" },
    missing: { type: "ARRAY", items: { type: "STRING", enum: ["amount", "split", "payer"] } }, summary: str } };
  const out = await askGemini(prompt, schema);
  return {
    desc: sv(out.desc, 80) || "Expense", amount: Math.max(0, Math.min(100000, Number(out.amount) || 0)),
    paidBy: sv(out.paidBy, 60), splitWith: clean(out.splitWith, 30, 60), splitEveryone: !!out.splitEveryone,
    missing: clean(out.missing, 3, 10).filter(m => ["amount", "split", "payer"].includes(m)), summary: sv(out.summary, 300) || "Here's what I heard."
  };
}

// mode "edit": what the user said about an existing event -> only the fields that change.
async function draftEdit(d) {
  const text = sv(d.text, 1500); if (text.length < 3) throw new Error("nothing to change");
  const cur = d.current && typeof d.current === "object" ? d.current : {};
  const current = { title: sv(cur.title, 80), date: sv(cur.date, 10), time: sv(cur.time, 5), endTime: sv(cur.endTime, 5), location: sv(cur.location, 200), food: sv(cur.food, 120), notes: sv(cur.notes, 1000), capacity: Math.max(0, parseInt(cur.capacity, 10) || 0) };
  const prompt = `${DOT}
The user wants to change an existing event. ${whenContext(d)}
Current event: ${JSON.stringify(current)}
Return ONLY the fields that should change, with their new values; leave every other field out (empty string means "do not change"). For notes, return the full new notes text (keep what is there unless the user says to remove it). capacity as a number, 0 to leave unchanged. If something is unclear, say so in "unclear" (one short sentence), otherwise leave it empty.
summary: one sentence in Dot's voice starting "Here's what I'll change:".

What the user said:
${text}`;
  const schema = { type: "OBJECT", required: ["summary"], properties: { title: str, date: str, time: str, endTime: str, location: str, food: str, notes: str, capacity: { type: "INTEGER" }, unclear: str, summary: str } };
  const out = await askGemini(prompt, schema, 0.1);
  const patch = {};
  if (sv(out.title, 80) && sv(out.title, 80) !== current.title) patch.title = sv(out.title, 80);
  if (/^\d{4}-\d{2}-\d{2}$/.test(out.date || "") && out.date !== current.date) patch.date = out.date;
  if (/^\d{2}:\d{2}$/.test(out.time || "") && out.time !== current.time) patch.time = out.time;
  if (/^\d{2}:\d{2}$/.test(out.endTime || "") && out.endTime !== current.endTime) patch.endTime = out.endTime;
  if (sv(out.location, 200) && sv(out.location, 200) !== current.location) patch.location = sv(out.location, 200);
  if (sv(out.food, 120) && sv(out.food, 120) !== current.food) patch.food = sv(out.food, 120);
  if (sv(out.notes, 1000) && sv(out.notes, 1000) !== current.notes) patch.notes = sv(out.notes, 1000);
  const cap = parseInt(out.capacity, 10); if (cap > 0 && cap !== current.capacity) patch.capacity = Math.min(500, cap);
  return { patch, unclear: sv(out.unclear, 200), summary: sv(out.summary, 300) || "Here's what I'll change." };
}
// mode "ask": a question, answered from the user's own plans (a compact context the app sends) and what the app can do.
const APP_FACTS = `Friendly is an app for friend groups: plan events (themes, AI-painted covers, RSVPs with plus-ones, guest list, bring list, carpool, polls, playlist, photo wall, party wall, hype, RSVP questions, waitlists and capacity, "on my way / running late" on the day, calendar invites by email and calendar sync), plain meetings, groups (invite by phone, group chat, birthdays reminded a month out), and money (shared expenses, receipt scanning that itemizes, "fewest payments" settling, Venmo one-tap pay, mark as paid). Dot, the helper, can be tapped in the bottom-right corner on any page to: plan an event from a spoken description, set up an expense from a description, change an event you host by describing the change, or answer questions. Tapping the yellow dot in the logo gives a tip. Hosts can nudge people who haven't answered, duplicate an event, add co-hosts, and remove guests. Notifications are turned on from the profile. The app is free.`;
async function answerQuestion(d) {
  const q = sv(d.text, 600); if (q.length < 2) throw new Error("no question");
  const ctx = d.context && typeof d.context === "object" ? d.context : {};
  const events = (Array.isArray(ctx.events) ? ctx.events : []).slice(0, 15).map(e => ({ id: sv(e.id, 40), title: sv(e.title, 80), date: sv(e.date, 10), time: sv(e.time, 5), location: sv(e.location, 80), kind: sv(e.kind, 8), going: parseInt(e.going, 10) || 0, invited: parseInt(e.invited, 10) || 0, unanswered: parseInt(e.unanswered, 10) || 0, me: sv(e.me, 10), host: sv(e.host, 30), mine: !!e.mine }));
  const groups = (Array.isArray(ctx.groups) ? ctx.groups : []).slice(0, 12).map(g => ({ id: sv(g.id, 40), name: sv(g.name, 60), members: parseInt(g.members, 10) || 0 }));
  const money = ctx.money && typeof ctx.money === "object" ? { iOwe: sv(ctx.money.iOwe, 12), owed: sv(ctx.money.owed, 12), pairs: (Array.isArray(ctx.money.pairs) ? ctx.money.pairs : []).slice(0, 8).map(x => sv(x, 80)) } : {};
  const prompt = `${DOT} Answer the user's question in Dot's voice: warm, brief (one to three short sentences), specific. Use ONLY the user's data below and the app facts; if the answer isn't there, say you don't know and say where in the app they could look. Never invent events, people or numbers. ${whenContext(d)}
The user's first name: ${sv(ctx.me, 30) || "friend"}.
Upcoming events (JSON): ${JSON.stringify(events)}
Groups (JSON): ${JSON.stringify(groups)}
Money: ${JSON.stringify(money)}
App facts: ${APP_FACTS}
If one or two of these would help, return actions: kind "open_event" with the event id (label = the event title), or kind "plan" (label "Plan something"), "expense" (label "Add an expense"), "money", "groups", or "profile". Otherwise return no actions.

Question:
${q}`;
  const schema = { type: "OBJECT", required: ["answer"], properties: { answer: str, actions: { type: "ARRAY", items: { type: "OBJECT", required: ["kind", "label"], properties: { kind: { type: "STRING", enum: ["open_event", "plan", "expense", "money", "groups", "profile"] }, label: str, id: str } } } } };
  const out = await askGemini(prompt, schema, 0.3);
  const ids = new Set(events.map(e => e.id));
  return {
    answer: sv(out.answer, 600) || "I'm not sure about that one.",
    actions: (Array.isArray(out.actions) ? out.actions : []).slice(0, 2).map(a => ({ kind: sv(a && a.kind, 12), label: sv(a && a.label, 40), id: sv(a && a.id, 40) }))
      .filter(a => a.kind && a.label && (a.kind !== "open_event" || ids.has(a.id)))
  };
}
// ---- Curate: Dot finds real things happening nearby (Gemini with Google Search grounding), pairs each
//      with a place to eat and the logistics, and the app turns a pick into a plan, a poll, tickets or a table.
//      curated/{cityKey} is rebuilt nightly for every city someone has set; "night" mode builds three on demand.
const TAGS = ["weekend", "tonight", "date", "group", "cheap", "family", "late"];
// The search tool sometimes loops on a broken call (empty answer) or apologizes instead of searching.
// Try fast first, then with a little thinking, then once more with a bit more variety; each try has its own time limit.
async function askGroundedReliably(prompt, maxTokens, onPhase, label) {
  const tries = [{ thinking: 0, timeoutMs: 45000 }, { thinking: 1024, timeoutMs: 80000 }, { thinking: 1024, timeoutMs: 80000, temperature: 0.9 }];   // worst case ~3.5 min
  let last;
  for (let i = 0; i < tries.length; i++) {
    try { return await askGrounded(prompt, maxTokens, i ? null : onPhase, tries[i].thinking, tries[i]); }
    catch (err) { last = err; logger.warn(`${label} try ${i + 1} failed: ${err.message.slice(0, 100)}`); }
  }
  throw last;
}
async function askGrounded(prompt, maxTokens = 6000, onPhase, thinking = 0, opts = {}) {
  const token = (await (await gauth.getClient()).getAccessToken()).token;
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${PLAN_MODEL}:generateContent`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ googleSearch: {} }], generationConfig: { temperature: opts.temperature || 0.4, maxOutputTokens: maxTokens + (thinking ? 3000 : 0), thinkingConfig: { thinkingBudget: thinking } } };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 200000);
  const t0 = Date.now(); if (onPhase) await onPhase("searching");
  let r; try { r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal }); }
  catch (e) { throw new Error(e.name === "AbortError" ? "the search took too long" : e.message); } finally { clearTimeout(timer); }
  if (!r.ok) throw new Error(PLAN_MODEL + " " + r.status + ": " + (await r.text()).slice(0, 160));
  const j = await r.json();
  logger.info("grounded call took " + Math.round((Date.now() - t0) / 1000) + "s");
  const text = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || "").join("");
  if (onPhase) await onPhase("sorting");
  const m = text.replace(/```json|```/g, "").match(/\[[\s\S]*\]/); if (!m) throw new Error("no JSON in answer: " + text.slice(0, 80));
  return JSON.parse(m[0]);
}
const isUrl = u => /^https?:\/\//i.test(String(u || ""));
// cut long text at a word boundary with an ellipsis instead of mid-word
const clip = (v, n) => { const t = String(v || "").trim().replace(/\s+/g, " "); if (t.length <= n) return t; const cut = noLone(t.slice(0, n - 1)); const sp = cut.lastIndexOf(" "); return (sp > n * .6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, "") + "…"; };
// The same venue twice in a row ("Palato at 7:00", "Palato at 7:30") is one stop: keep the first time, merge the notes.
const venueKey = v => String(v || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
// "Live Music at Palato" and "Palato Italian Kitchen and Lounge" are one place: compare the part after " at " too.
const atPart = v => { const m = / at (?:the )?(.+)$/i.exec(String(v || "")); return m ? venueKey(m[1]) : ""; };
const sameVenue = (a, b) => { const ka = venueKey(a), kb = venueKey(b); if (!ka || !kb) return false; if (ka === kb) return true;
  const starts = (x, y) => x.length >= 4 && (y === x || y.startsWith(x + " "));
  const aa = atPart(a), ab = atPart(b);
  return starts(aa, kb) || starts(ab, ka) || starts(kb, aa) || starts(ka, ab) || (aa && aa === ab); };
function mergeRepeatStops(stops) {
  const out = [];
  for (const x of stops) {
    const prev = out[out.length - 1];
    if (prev && sameVenue(prev.name, x.name)) { if (x.note && !prev.note.includes(x.note)) prev.note = clip(prev.note + " " + x.note, 220); if (!prev.url && x.url) prev.url = x.url; if (x.kind === "eat" || prev.kind === "eat") prev.kind = prev.kind === "do" || x.kind === "do" ? "do" : "eat"; continue; }
    out.push({ ...x });
  }
  return out;
}
function cleanNight(n) {
  const stops = mergeRepeatStops((Array.isArray(n.stops) ? n.stops : []).slice(0, 5).map(x => ({ time: sv(x && x.time, 10), name: sv(x && x.name, 80), note: clip(x && x.note, 170), kind: ["eat", "do", "go"].includes(x && x.kind) ? x.kind : "do", url: isUrl(x && x.url) ? sv(x.url, 300) : "" })).filter(x => x.name));
  return {
    title: sv(n.title, 80), date: /^\d{4}-\d{2}-\d{2}$/.test(n.date || "") ? n.date : "", start: /^\d{2}:\d{2}$/.test(n.start || "") ? n.start : "",
    tags: clean(n.tags, 6, 10).filter(t => TAGS.includes(t)), stops,
    cost: clip(n.cost, 50), size: clip(n.size, 40), parking: clip(n.parking, 120), why: clip(n.why, 260), ticketUrl: isUrl(n.ticketUrl) ? sv(n.ticketUrl, 300) : "",
    emoji: noLone(sv(n.emoji, 8).replace(/[A-Za-z0-9\s]/g, "").slice(0, 4)), emojis: noLone(sv(n.emojis, 12).replace(/[A-Za-z0-9\s]/g, "").slice(0, 8)),
    scene: sv(n.scene, 140), theme: THEME_IDS.includes(n.theme) ? n.theme : "midnight",
    // v3: keyed by the main spot, not the date, so a place that comes back next week keeps its cover (curateCovers/{id}).
    coverId: nodeCrypto.createHash("md5").update("v3|" + ((stops.find(x => x.kind === "do") || stops[0] || {}).name || sv(n.title, 80)).toLowerCase().trim()).digest("hex").slice(0, 12)
  };
}
const nightShape = `Return ONLY a JSON array, no prose: [{"title": short and specific, "date": "YYYY-MM-DD", "start": 24-hour "HH:MM" of the first stop, "tags": [any of weekend, tonight, date, group, cheap, family], "stops": [{"time": like "5:30 PM", "name": the real venue or event name, "note": one useful detail (walk time, what to order, parking), "kind": "eat" | "do" | "go", "url": the listing or booking page if you found one}], "cost": like "$45 a head all in", "size": like "Best for 2–6", "parking": one short line, "why": one sentence in Dot's voice on why this night works, "ticketUrl": the ticket page if tickets are sold, "emoji": one emoji for the night, "emojis": exactly two emojis, the thing to do then the food (like "⚾🌮"), "scene": a 10-to-16-word visual description of the night for an illustration, concrete objects and setting only, no people's faces, no text (like "a baseball game under stadium lights beside a plate of street tacos"), "theme": the one of ${THEME_IDS.join(", ")} that fits the vibe (sunset or golden for dinners, confetti for parties, garden or blossom for brunch and outdoors, midnight or cosmic for nights out and shows, disco, rave or retro for dance and costume nights, citrus or bubblegum for playful daytime plans, aurora for big arena events)}]. Every stop is a different venue; never list the same place twice. Only include things you actually found; never invent an event, a venue, or a price. Times must make sense in sequence. Always use the Oxford comma in lists.`;
// Four nights per filter: one grounded search per category, run in parallel, then merged and de-duplicated.
const CURATE_KINDS = {
  weekend: from => `for the coming weekend (Friday evening through Sunday, starting ${from}); a mix of the best things on`,
  tonight: (from, today) => `for TONIGHT only (${today}), starting no earlier than an hour from now; things with tickets still available or no ticket needed`,
  date: () => `as date nights for two in the next 9 days: a good table and something to do before or after`,
  group: () => `for groups of 6 to 12 in the next 9 days: places that take big groups (bar tables, counter service, group tickets, bays or lanes)`,
  cheap: () => `under $40 a person all in, in the next 9 days: free events, cheap eats, happy hours`,
  family: () => `family-friendly with kids in the next 9 days: daytime or early evening, kid-easy food`,
  // Coral's picks: the late ones
  late: () => `for late nights in the next 9 days: things that start at 9 PM or later or run past midnight (late-night food, live music, karaoke, comedy, dancing, a late show); nothing family-oriented`
};
async function curateCity(d, onPhase) {
  const city = sv(d.city, 60); if (city.length < 2) throw new Error("no city");
  const today = /^\d{4}-\d{2}-\d{2}$/.test(d.today || "") ? d.today : new Date().toISOString().slice(0, 10);
  const end = new Date(today + "T12:00:00Z"); end.setUTCDate(end.getUTCDate() + 9); const endStr = end.toISOString().slice(0, 10);
  const dow = new Date(today + "T12:00:00Z").getUTCDay(); const toFri = dow <= 5 ? 5 - dow : 6;
  const fri = new Date(today + "T12:00:00Z"); if (dow !== 6 && dow !== 0) fri.setUTCDate(fri.getUTCDate() + toFri); const weekendFrom = fri.toISOString().slice(0, 10);
  const area = nearArea(city, d.miles);
  let started = false;
  const one = async kind => {
    const prompt = `You are Dot, the helper in Friendly, an app friends use to plan nights out. Using search, find real, specific things happening ${area} (today is ${today}, ${sv(d.weekday, 10)}; nothing after ${endStr}). Build exactly 4 different nights ${CURATE_KINDS[kind](weekendFrom, today)}. Each pairs one thing to do with one real place to eat or drink within a short walk or drive, with times that work in sequence. Make the 4 genuinely different (different neighborhoods or kinds of thing). Only things friends would actually want to go out for: skip civic and informational events (safety fairs, seminars, council meetings, workshops, expos for businesses). Include "${kind}" in every night's tags, plus any other tags that apply. Keep strings short; at most 3 stops per night; no markdown. ${nightShape}`;
    // Fast first; if the search tool answers with an apology, try again letting the model think (slower, far more reliable).
    const raw = await askGroundedReliably(prompt, 2600, started ? null : (started = true, onPhase), "curate " + kind);
    return raw.map(cleanNight).map(n => ({ ...n, src: kind, tags: [...new Set([kind, ...n.tags])] }));
  };
  const results = await Promise.allSettled(Object.keys(CURATE_KINDS).map(one));
  if (onPhase) await onPhase("sorting");
  // The same event often comes back from several searches under different names ("Oktoberfest at The Star",
  // "Frisco Oktoberfest Celebration"): collapse nights whose main event shares most of its words, keeping the first.
  const STOP = new Set(["the", "and", "at", "with", "for", "night", "dinner", "celebration", "annual", "event", ...city.toLowerCase().split(/[^a-z]+/)]);
  const toks = t => new Set(String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
  const jac = (a, b) => { if (!a.size || !b.size) return 0; let k = 0; a.forEach(w => { if (b.has(w)) k++; }); return k / (a.size + b.size - k); };
  const kept = [];
  for (const r of results) if (r.status === "fulfilled") for (const n of r.value) {
    if (!n.title || !n.date || n.date < today || n.date > endStr || !n.stops.length) continue;
    const main = (n.stops.find(x => x.kind === "do") || n.stops[0]).name;
    const mt = toks(main), tt = toks(n.title);
    const dup = kept.find(k => jac(k._mt, mt) >= 0.5 || (k.date === n.date && jac(k._tt, tt) >= 0.6));
    if (dup) { dup.tags = [...new Set([...dup.tags, ...n.tags])]; continue; }
    kept.push({ ...n, _mt: mt, _tt: tt });
  }
  const byKey = new Map(kept.map((n, i) => { const { _mt, _tt, ...clean } = n; return [i, clean]; }));
  const failed = results.filter(r => r.status === "rejected").map(r => r.reason && r.reason.message);
  if (failed.length) logger.warn("curate: " + failed.length + " of 6 searches failed for " + city + ": " + failed.join(" | ").slice(0, 300));
  const nights = [...byKey.values()].slice(0, 30);
  if (!nights.length) throw new Error(failed[0] || "nothing found");
  return nights;
}
const cityKeyOf = c => String(c || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
// How far out to look. 25 miles is the default and keeps the plain city key; the others get their own cache ("frisco-tx--10mi").
const CURATE_MILES = [5, 10, 25, 50], DEFAULT_MILES = 25;
const milesOf = m => CURATE_MILES.includes(Number(m)) ? Number(m) : DEFAULT_MILES;
const curatedKey = (city, miles) => cityKeyOf(city) + (milesOf(miles) === DEFAULT_MILES ? "" : "--" + milesOf(miles) + "mi");
const nearArea = (city, miles) => { const m = milesOf(miles); return m <= 5 ? `in ${city} itself, within about 5 miles of it (nothing farther)` : `in or around ${city}, within about ${m} miles of it (nothing farther)`; };
async function buildAndCacheCity(city, tz, today, weekday, onPhase, miles) {
  const nights = await curateCity({ city, tz, today, weekday, miles }, onPhase);
  await db.doc("curated/" + curatedKey(city, miles)).set({ city, miles: milesOf(miles), nights, updatedAt: Date.now(), forDate: today, v: 4 });
  return nights;
}
async function buildNight(d) {
  const city = sv(d.city, 60); if (city.length < 2) throw new Error("no city");
  const today = /^\d{4}-\d{2}-\d{2}$/.test(d.today || "") ? d.today : new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(d.from || "") ? d.from : today, to = /^\d{4}-\d{2}-\d{2}$/.test(d.to || "") ? d.to : from;
  const prompt = `You are Dot, the helper in Friendly, an app friends use to plan nights out. Build 3 different nights out ${nearArea(city, d.miles)} for ${from === to ? from : from + " to " + to} (today is ${today}, ${sv(d.weekday, 10)}), using search to find real, specific events, venues, restaurants and bars.
The ask: vibe "${sv(d.vibe, 30) || "surprise me"}", for ${sv(d.who, 30) || "a few friends"}, budget ${sv(d.budget, 30) || "flexible"} per person all in.${d.free ? " Also: " + sv(d.free, 300) + "." : ""}
Make the three genuinely different from each other (different neighborhoods or kinds of thing). Each pairs one thing to do with one real place to eat or drink nearby, with times that work in sequence. Respect the budget and the group size (bar tables and counter service for big groups, a reservation for a date). ${nightShape}`;
  // The search tool now and then answers with an apology instead of results; one retry usually gets them.
  const raw = await askGroundedReliably(prompt, 3000, d.onPhase, "night build");
  const nights = raw.map(cleanNight).filter(n => n.title && n.date && n.stops.length).slice(0, 3);
  if (!nights.length) throw new Error("nothing found");
  return nights;
}
// Browse ideas: single things to do (not a sequenced night), by category or anything typed
// ("book a massage", "pottery class"). Real places from search, each one turnable into a plan.
async function buildIdeas(d) {
  const city = sv(d.city, 60); if (city.length < 2) throw new Error("no city");
  const today = /^\d{4}-\d{2}-\d{2}$/.test(d.today || "") ? d.today : new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(d.from || "") ? d.from : today, to = /^\d{4}-\d{2}-\d{2}$/.test(d.to || "") ? d.to : from;
  const what = d.free ? `exactly what they asked for: "${sv(d.free, 200)}"` : `the category "${sv(d.category, 40) || "anything fun"}"`;
  const avoid = Array.isArray(d.avoid) && d.avoid.length ? ` Don't repeat any of these: ${d.avoid.slice(0, 24).map(x => sv(x, 60)).join("; ")}.` : "";
  const prompt = `You are Dot, the helper in Friendly, an app friends use to plan things together. Find 6 different individual things to do ${nearArea(city, d.miles)} between ${from} and ${to} (today is ${today}, ${sv(d.weekday, 10)}) for ${what}. Use search to find real, current options: specific venues, shows, classes, spots, or services. For something like booking a massage, list real spas or studios and how to book. Each idea is ONE activity, not a night with several stops. Mix well-known and hidden-gem picks.${avoid}
Reply with ONLY a JSON array of objects with these keys: "emoji" (one emoji), "title" (short and specific, under 60 characters), "place" (venue or business name), "area" (neighborhood or city), "date" (YYYY-MM-DD if it is a dated event in that window, else ""), "time" (24-hour HH:MM if dated, else ""), "price" (like "$25", "Free", or "$$"), "blurb" (one friendly sentence, Oxford comma, no em-dashes), "url" (the official page if you found one, else "").`;
  const raw = await askGroundedReliably(prompt, 2500, d.onPhase, "ideas");
  return raw.map(x => ({
    emoji: (() => { try { const g = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(String(x.emoji || "").trim())][0]; return g ? g.segment : "✨"; } catch { return "✨"; } })(), title: clip(x.title, 70), place: clip(x.place, 80), area: clip(x.area, 60),
    date: /^\d{4}-\d{2}-\d{2}$/.test(x.date || "") ? x.date : "", time: /^\d{2}:\d{2}$/.test(x.time || "") ? x.time : "",
    price: clip(x.price, 20), blurb: clip(x.blurb, 200), url: isUrl(x.url) ? String(x.url).slice(0, 300) : ""
  })).filter(x => x.title).slice(0, 6);
}
const CURATE_STYLES = ["candid documentary photograph", "35mm film photograph with fine grain", "editorial lifestyle photograph, shallow depth of field", "wide establishing photograph of the place", "close-up detail photograph of the food, drinks or activity", "street photography, candid moment"];
// Each night gets a small painted cover made from its own scene (the ballgame and the tacos, not a stock palette).
// Runs after curated/{city} changes; covers are keyed by title+date so unchanged nights keep theirs across rebuilds.
// One painter per city at a time, one picture at a time, waiting out "busy" (429) answers: the nightly build writes
// every city within minutes, and the old parallel painters (each publish re-triggering another painter for the same
// nights) ran into Vertex's rate limit so most nights went without a cover. Our own coverIds/paintingUntil writes
// don't start another painter; curateCoverSweep below picks up whatever is still missing.
// Covers are painted only when someone is about to look at them: the app writes the ids it is showing to
// coverWants/{cityKey}, and the painter fills in the missing ones (a few at a time, up to a daily cap per city). A
// nightly rebuild paints nothing by itself; repeats of a spot reuse its cover from curateCovers/{id}.
const COVERS = () => db.collection("curateCovers");
const PAINT_PER_RUN = 6, PAINT_PER_DAY = 14, WANT_KEEP = 40;
const coverIdsOf = x => ((x && x.nights) || []).map(n => n.coverId).filter(Boolean).sort().join();
const dayKey = () => new Date().toISOString().slice(0, 10);
async function haveCovers(ids) {
  const out = new Set(); if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 100) { const snaps = await db.getAll(...ids.slice(i, i + 100).map(id => COVERS().doc(id)), { fieldMask: ["createdAt"] }); snaps.forEach(d => { if (d.exists) out.add(d.id); }); }
  return out;
}
async function publishCovers(ref, after, have) {
  const ids = (after.nights || []).map(n => n.coverId).filter(id => id && have.has(id)).sort();
  if (ids.join() !== (after.coverIds || []).slice().sort().join()) await ref.update({ coverIds: ids });
  return ids;
}
async function paintWanted(ref, cityKey, t0) {
  const snap = await ref.get(); if (!snap.exists) return 0; const after = snap.data();
  const nights = (after.nights || []).filter(n => n.coverId), ids = [...new Set(nights.map(n => n.coverId))];
  const have = await haveCovers(ids);
  // Covers painted before this change live under the city doc; they still count (and serve) until the nights rotate,
  // and the ones no current night uses are dropped.
  const oldCol = ref.collection("covers"), oldIds = (await oldCol.select().get()).docs.map(d => d.id);
  oldIds.forEach(id => { if (ids.includes(id)) have.add(id); });
  await Promise.all(oldIds.filter(id => !ids.includes(id)).map(id => oldCol.doc(id).delete().catch(() => {})));
  const wantsSnap = await db.doc("coverWants/" + cityKey).get(); const wants = wantsSnap.exists ? (wantsSnap.get("ids") || []) : [];
  const todo = wants.filter(id => have.has(id) === false && ids.includes(id));
  const today = dayKey(), used = after.paintDay === today ? (after.paints || 0) : 0, room = Math.max(0, PAINT_PER_DAY - used);
  const batch = todo.slice(0, Math.min(PAINT_PER_RUN, room));
  // Touch covers in use, so the cleanup keeps them.
  const touch = [...have].filter(id => wants.includes(id)); if (touch.length) await Promise.all(touch.slice(0, 40).map(id => COVERS().doc(id).set({ lastUsedAt: Date.now() }, { merge: true }).catch(() => {})));
  await publishCovers(ref, after, have);
  if (!batch.length) { if (todo.length && !room) logger.info(`covers: ${cityKey} hit today's cap (${PAINT_PER_DAY})`); return 0; }
  const shrink = async dataUrl => { const b64 = String(dataUrl).split(",")[1]; const out = await sharp(Buffer.from(b64, "base64")).resize({ width: 720, withoutEnlargement: true }).jpeg({ quality: 74 }).toBuffer(); return "data:image/jpeg;base64," + out.toString("base64"); };
  let painted = 0;
  for (const id of batch) {
    if (Date.now() - t0 > 420e3) break;
    const n = nights.find(x => x.coverId === id);
    // Each cover gets its own photographic look, lit for when the night happens, so the feed doesn't repeat one palette.
    const h = parseInt(id.slice(0, 6), 16) || 0, hr = parseInt((n.start || "19:00").slice(0, 2), 10);
    const light = hr < 11 ? "soft morning daylight" : hr < 17 ? "bright natural daylight" : hr < 20 ? "early evening light" : "night, lit by the venue's own lights";
    const prompt = `${n.scene || n.title}, ${n.title || ""}. ${CURATE_STYLES[h % CURATE_STYLES.length]}, ${light}, real people and real places, natural true-to-life colors, not a cartoon`;
    let image = null;
    for (let a = 0; a < 4 && !image; a++) {
      try { image = (await geminiGenerate(prompt)).image; }
      catch (err) { if (!/ 429/.test(err.message) || Date.now() - t0 > 400e3) { logger.warn("cover failed: " + err.message.slice(0, 120)); break; } await new Promise(r => setTimeout(r, 10e3 * 2 ** a + Math.random() * 5e3)); }
    }
    if (!image) continue;
    try { image = await shrink(image); } catch (e3) {}
    await COVERS().doc(id).set({ image, title: n.title, city: cityKey, createdAt: Date.now(), lastUsedAt: Date.now() }); have.add(id); painted++;
    await ref.update({ paints: FieldValue.increment(1), paintDay: today }).catch(() => {});
    await publishCovers(ref, { ...after, paints: used + painted }, have);
  }
  if (painted) logger.info(`covers: painted ${painted} for ${cityKey}`);
  return painted;
}
// One painter per city at a time (a lease on the city doc); whoever finds it busy leaves it to the sweep.
async function paintWithLease(ref, cityKey) {
  const t0 = Date.now();
  const got = await db.runTransaction(async t => { const d = await t.get(ref); if (!d.exists || (d.get("paintingUntil") || 0) > t0) return false; t.update(ref, { paintingUntil: t0 + 540e3 }); return true; });
  if (!got) return;
  try { await paintWanted(ref, cityKey, t0); } finally { await ref.update({ paintingUntil: 0 }).catch(() => {}); }
}
exports.onCuratedWritten = onDocumentWritten({ document: "curated/{cityKey}", region: "us-central1", timeoutSeconds: 540, memory: "1GiB" }, async e => {
  const after = e.data && e.data.after && e.data.after.exists ? e.data.after.data() : null; if (!after) return;
  const before = e.data.before && e.data.before.exists ? e.data.before.data() : null;
  const nudged = !before || (after.coverNudge || 0) !== (before.coverNudge || 0);
  if (before && coverIdsOf(before) === coverIdsOf(after) && !nudged) return;   // our own bookkeeping writes
  await paintWithLease(e.data.after.ref, e.params.cityKey);
});
exports.onCoverWant = onDocumentWritten({ document: "coverWants/{cityKey}", region: "us-central1", timeoutSeconds: 540, memory: "1GiB" }, async e => {
  const after = e.data && e.data.after && e.data.after.exists ? e.data.after.data() : null; if (!after) return;
  const ids = (after.ids || []).filter(x => typeof x === "string" && /^[a-f0-9]{12}$/.test(x));
  if (ids.length > WANT_KEEP) { await e.data.after.ref.set({ ids: ids.slice(-WANT_KEEP) }, { merge: true }); return; }   // trimmed; this write comes back around
  const before = e.data.before && e.data.before.exists ? (e.data.before.get("ids") || []) : [];
  if (before.length && ids.every(id => before.includes(id)) && ids.length === before.length) return;   // nothing new asked for
  await paintWithLease(db.doc("curated/" + e.params.cityKey), e.params.cityKey);
});
// Every 20 minutes: retry the one city with the most covers still wanted and missing (a painter that hit the
// rate limit or the lease). Cheap when everything asked for is painted.
exports.curateCoverSweep = onSchedule({ schedule: "every 20 minutes", timeZone: "America/Chicago", timeoutSeconds: 60, memory: "256MiB" }, async () => {
  const [q, w] = await Promise.all([db.collection("curated").get(), db.collection("coverWants").get()]), now = Date.now();
  const wants = Object.fromEntries(w.docs.map(d => [d.id, d.get("ids") || []]));
  const missing = d => { const x = d.data(), have = new Set(x.coverIds || []), ids = new Set((x.nights || []).map(n => n.coverId)); return (wants[d.id] || []).filter(id => ids.has(id) && !have.has(id)).length; };
  const best = q.docs.filter(d => (d.get("paintingUntil") || 0) < now && missing(d) > 0).sort((a, b) => missing(b) - missing(a))[0];
  if (best) { logger.info(`cover sweep: ${best.id} wants ${missing(best)} more`); await best.ref.update({ coverNudge: now }); }
});
exports.curateCover = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB" }, async (req, res) => {
  const c = String(req.query.c || "").replace(/[^a-z0-9-]/g, "").slice(0, 60), id = String(req.query.id || "").replace(/[^a-f0-9]/g, "").slice(0, 12);
  if (!c || !id) { res.status(400).end(); return; }
  let snap = await COVERS().doc(id).get(); if (!snap.exists) snap = await db.doc(`curated/${c}/covers/${id}`).get();
  const img = snap.exists ? String(snap.data().image || "") : ""; const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(img);
  if (!m) { res.set("Cache-Control", "public, max-age=60").status(404).end(); return; }
  res.set("Content-Type", m[1]).set("Cache-Control", "public, max-age=2592000, immutable").send(Buffer.from(m[2], "base64"));
});
exports.curateNightly = onSchedule({ schedule: "30 3 * * *", timeZone: "America/Chicago", timeoutSeconds: 540, memory: "512MiB" }, async () => {
  const cities = await db.collection("curateCities").get();
  const cutoff = Date.now() - 14 * 864e5;   // the app stamps seenAt when someone opens Curate or the picks tray in that city
  let built = 0, skipped = 0;
  for (const doc of cities.docs) {
    const c = doc.data(); if (!c.city || Math.max(c.seenAt || 0, c.updatedAt || 0) < cutoff) { skipped++; continue; } built++;
    try {
      const tz = c.tz || "America/Chicago";
      const now = new Date(); const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      const today = fmt.format(now); const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
      await buildAndCacheCity(c.city, tz, today, weekday, null, c.miles);
    } catch (err) { logger.warn("curate failed for " + c.city + ": " + err.message); }
  }
  logger.info(`curateNightly: built ${built} cities, skipped ${skipped} nobody opened in two weeks`);
  const stale = await COVERS().where("lastUsedAt", "<", Date.now() - 60 * 864e5).limit(200).get();
  await Promise.all(stale.docs.map(d => d.ref.delete().catch(() => {})));
  if (stale.size) logger.info(`curateNightly: dropped ${stale.size} covers unused for 60 days`);
});

exports.onPlanRequest = onDocumentCreated({ document: "planRequests/{id}", region: "us-central1", timeoutSeconds: 300, memory: "512MiB" }, async e => {
  const d = e.data && e.data.data(); if (!d) return;
  if (!d.text && !["curate-city", "night", "ideas"].includes(d.mode)) return;   // the curate modes carry no text
  const ref = e.data.ref;
  try {
    const data = d.mode === "expense" ? await draftExpense(d) : d.mode === "edit" ? await draftEdit(d) : d.mode === "ask" ? await answerQuestion(d)
      : d.mode === "curate-city" ? { nights: await buildAndCacheCity(sv(d.city, 60), sv(d.tz, 40), d.today, d.weekday, phase => ref.update({ phase }).catch(() => {}), d.miles) }
      : d.mode === "night" ? { nights: await buildNight({ ...d, onPhase: phase => ref.update({ phase }).catch(() => {}) }) }
      : d.mode === "ideas" ? { ideas: await buildIdeas({ ...d, onPhase: phase => ref.update({ phase }).catch(() => {}) }) }
      : await draftPlan(d);
    await ref.update({ status: "done", data });
  }
  catch (err) { logger.error("plan draft failed (" + (d.mode || "event") + "): " + err.message); await ref.update({ status: "error", error: (d.mode === "curate-city" || d.mode === "night" || d.mode === "ideas") ? err.message.slice(0, 120) : "couldn't work that out" }); }
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
const MAIL = { secrets: [VAPID_PRIVATE, APNS_KEY, MAILGUN_API_KEY] };
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
    "DESCRIPTION:" + icsEsc(stopsText(ev) + (ev.notes ? ev.notes + "\n\n" : "") + "RSVP and details in Friendly: " + FN_BASE + "/share/p/" + id),
    "URL:" + FN_BASE + "/share/p/" + id,
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
    ${method === "CANCEL" ? "" : `<p style="margin:20px 0"><a href="${FN_BASE}/share/p/${id}" style="background:#FF6B57;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600;display:inline-block">RSVP in Friendly</a></p>
    <p style="color:#8C7C70;font-size:13px">Optional: the attached invite adds this one event to your calendar. Skip it if you already use Calendar sync in Friendly, so it doesn't show up twice.</p>`}
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
  // The host gets their own copy on creation, so the plan lands in their calendar too.
  if (method === "REQUEST" && !onlyUids && !seq && host.email) {
    const form = new FormData();
    form.append("from", MAIL_FROM("Friendly")); form.append("to", host.email);
    form.append("subject", "You're hosting: " + (kind === "event" && ev.emoji ? ev.emoji + " " : "") + ev.title);
    form.append("html", html.replace("invited you to a " + kind, "you're hosting this " + kind).replace(/Optional: the attached invite[^<]*/, "The attached invite adds it to your calendar (skip it if you use Calendar sync in Friendly)."));
    form.append("attachment", new Blob([ics], { type: "text/calendar; method=" + method }), "invite.ics");
    const r = await fetch(MAILGUN_API + "/messages", { method: "POST", headers: { Authorization: "Basic " + Buffer.from("api:" + key).toString("base64") }, body: form });
    if (!r.ok) logger.warn("mailgun host copy " + r.status);
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

// ---- Event covers live outside the event record ----
// Every guest downloads every event they're invited to on each fresh sign-in, so a 350KB cover inside the
// event made sign-in slow (2.5MB for one account). Any event saved with a big cover gets it moved to
// eventCovers/{id} (the app fetches it only on the event page) and keeps a ~35KB preview for cards and lists.
const COVER_SLIM_OVER = 100000;   // data-URL characters (~75KB of image)
async function coverThumb(dataUrl) {
  const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(dataUrl || ""); if (!m) return null;
  const out = await sharp(Buffer.from(m[1], "base64")).resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 66, mozjpeg: true }).toBuffer();
  return "data:image/jpeg;base64," + out.toString("base64");
}
async function slimCover(ref, ev) {
  const cover = ev && typeof ev.cover === "string" ? ev.cover : "";
  if (cover.length > COVER_SLIM_OVER) {
    const thumb = await coverThumb(cover); if (!thumb || thumb.length >= cover.length) return false;
    await db.doc("eventCovers/" + ref.id).set({ cover, updatedAt: Date.now() });
    await ref.update({ cover: thumb, coverFull: true });
    return true;
  }
  if (!cover && ev && ev.coverFull) { await db.doc("eventCovers/" + ref.id).delete().catch(() => {}); await ref.update({ coverFull: FieldValue.delete() }); }
  return false;
}
exports.slimEventCover = onDocumentWritten({ document: "events/{id}", region: "us-central1", memory: "512MiB" }, async e => {
  if (!e.data.after.exists) { await db.doc("eventCovers/" + e.params.id).delete().catch(() => {}); return; }
  try { await slimCover(e.data.after.ref, e.data.after.data()); } catch (err) { logger.error("slimEventCover " + e.params.id + ": " + err.message); }
});

// ---- Event photos: small previews, full image on demand, comments ----
// Photo walls and Memories download every photo doc, so the doc keeps a ~480px preview and the full image
// moves to events/{e}/photoFull/{p} (fetched when someone opens the photo).
const PHOTO_SLIM_OVER = 70000;
exports.slimEventPhoto = onDocumentWritten({ document: "events/{eid}/photos/{pid}", region: "us-central1", memory: "512MiB" }, async e => {
  const { eid, pid } = e.params, fullRef = db.doc(`events/${eid}/photoFull/${pid}`);
  if (!e.data.after.exists) {   // photo removed: its full image, its original in storage, and its comments go too
    await fullRef.delete().catch(() => {});
    await getStorage().bucket().deleteFiles({ prefix: `events/${eid}/photos/${pid}/` }).catch(err => logger.warn("photo file delete " + err.message));
    await db.recursiveDelete(db.collection(`events/${eid}/photos/${pid}/comments`)).catch(() => {});
    return;
  }
  const img = e.data.after.get("img");
  if (typeof img !== "string" || img.length <= PHOTO_SLIM_OVER) return;
  try {
    const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(img); if (!m) return;
    const out = await sharp(Buffer.from(m[1], "base64")).rotate().resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70, mozjpeg: true }).toBuffer();
    const thumb = "data:image/jpeg;base64," + out.toString("base64");
    if (thumb.length >= img.length) return;
    await fullRef.set({ img, createdAt: Date.now() });
    await e.data.after.ref.update({ img: thumb, full: true });
  } catch (err) { logger.error("slimEventPhoto " + eid + "/" + pid + ": " + err.message); }
});
// New photos on a wall: one alert per burst ("Jordan added 4 photos to Taco Tuesday"), not one per photo, to the
// host and everyone who's going. The first photo of a burst claims photoBursts/{event}_{uploader}, waits a minute
// for the rest to land, then counts them (by the uploader's own clock, so phone clock drift doesn't matter).
exports.onEventPhotoAdded = onDocumentCreated({ document: "events/{eid}/photos/{pid}", ...PUSH, timeoutSeconds: 120 }, async e => {
  const p = e.data && e.data.data(); if (!p || !isRealUid(p.addedBy)) return;
  const { eid } = e.params, uid = p.addedBy, ref = db.doc(`photoBursts/${eid}_${uid}`), now = Date.now();
  const claimed = await db.runTransaction(async t => { const b = await t.get(ref); if (b.exists && (b.get("until") || 0) > now) return false; t.set(ref, { eid, uid, until: now + 90000 }); return true; });
  if (!claimed) return;
  await new Promise(r => setTimeout(r, 60000));
  const since = (Number(p.createdAt) || now) - 2000;
  const [ev, snap, u] = await Promise.all([db.doc("events/" + eid).get(), db.collection(`events/${eid}/photos`).where("createdAt", ">=", since).get(), db.doc("users/" + uid).get()]);
  await ref.set({ until: 0 }, { merge: true }).catch(() => {});   // later photos start a new burst
  if (!ev.exists) return;
  const x = ev.data(), count = snap.docs.filter(d => d.get("addedBy") === uid).length || 1;
  const going = (x.invitedUids || []).filter(v => (x.rsvps || {})[v] === "going");
  const to = [...new Set([x.hostId, ...going])].filter(v => isRealUid(v) && v !== uid);
  await notify(to, `${firstName(u.exists && u.get("name"))} added ${count === 1 ? "a photo" : count + " photos"} to ${x.title || "your event"}`, "Tap to see them on the photo wall.",
    `/#/e/${eid}?to=photosCard`, { type: "photo", actorId: uid });
});
// Reactions on a post or a photo: only the person who posted it hears, and reactions on the same thing within an
// hour fold into one alert ("Jordan, Priya, and 2 others reacted to your photo") instead of buzzing each time.
// Bring-list claims and ride offers live under `reactions` too (claim, ride, claimNames, claimQty); those aren't reactions.
const RX_NAMED_EMOJI = { heart: "❤️", laugh: "😂", fire: "🔥", up: "👍", wow: "😮" };
const rxEmojiOf = k => RX_NAMED_EMOJI[k] || (/^e[0-9a-f_]+$/.test(k) ? k.slice(1).split("_").map(h => String.fromCodePoint(parseInt(h, 16))).join("") : "");
const newReactors = (before, after) => { const was = before.reactions || {}, now = after.reactions || {}, out = [];
  for (const [k, us] of Object.entries(now)) { const emoji = rxEmojiOf(k); if (!emoji || !Array.isArray(us)) continue; for (const u of us) if (!(was[k] || []).includes(u)) out.push([u, emoji]); }
  return out; };
const andNames = ns => ns.length <= 1 ? (ns[0] || "Someone") : ns.length === 2 ? ns.join(" and ") : ns.length === 3 ? `${ns[0]}, ${ns[1]}, and ${ns[2]}` : `${ns[0]}, ${ns[1]}, and ${ns.length - 2} others`;
const RX_GROUP_MS = 60 * 60e3;
async function notifyReactions(before, after, owner, what, where, url, key) {
  const added = newReactors(before, after).filter(([u]) => u !== owner && isRealUid(u)); if (!added.length || !isRealUid(owner)) return;
  const snaps = await db.getAll(...added.map(([u]) => db.doc("users/" + u)));
  const names = added.map(([u], i) => firstName(snaps[i].exists && snaps[i].get("name")));
  const q = await db.collection("activity").where("key", "==", key).get();
  const recent = q.docs.filter(d => (d.get("uids") || []).includes(owner)).sort((a, b) => (b.get("createdAt") || 0) - (a.get("createdAt") || 0))[0];
  const title = (ns, emoji) => ns.length === 1 ? `${ns[0]} reacted ${emoji} to your ${what}` : `${andNames(ns)} reacted to your ${what}`;
  if (recent && Date.now() - (recent.get("createdAt") || 0) < RX_GROUP_MS) {
    const actors = [...recent.get("actors") || []], actorNames = [...recent.get("actorNames") || []];
    added.forEach(([u], i) => { if (!actors.includes(u)) { actors.push(u); actorNames.push(names[i]); } });
    await recent.ref.update({ actors, actorNames, title: title(actorNames, added[added.length - 1][1]) });
    return;
  }
  const actors = [...new Set(added.map(([u]) => u))], actorNames = actors.map(u => names[added.findIndex(([v]) => v === u)]);
  await notify([owner], title(actorNames, added[added.length - 1][1]), where, url, { type: "comment", actorId: actors[0], key, actors, actorNames });
}
const commentWhere = c => { const t = String(c.text || "").trim(); return t ? `“${t.slice(0, 80)}${t.length > 80 ? "…" : ""}”` : c.img ? "Your photo comment" : ""; };
exports.onCommentReaction = onDocumentUpdated({ document: "events/{id}/comments/{cid}", ...PUSH }, async e => {
  const b = e.data.before.data(), a = e.data.after.data(); if (!newReactors(b, a).length) return;
  const ev = (await db.doc("events/" + e.params.id).get()).data(); if (!ev) return;
  await notifyReactions(b, a, a.authorId, "comment", [commentWhere(a), ev.title].filter(Boolean).join(" · "), `/#/e/${e.params.id}?to=wall&c=${e.params.cid}`, `rx:e/${e.params.id}/${e.params.cid}`);
});
exports.onGroupCommentReaction = onDocumentUpdated({ document: "groups/{gid}/comments/{cid}", ...PUSH }, async e => {
  const b = e.data.before.data(), a = e.data.after.data(); if (!newReactors(b, a).length) return;
  const g = (await db.doc("groups/" + e.params.gid).get()).data(); if (!g) return;
  await notifyReactions(b, a, a.authorId, "message", [commentWhere(a), g.name].filter(Boolean).join(" · "), `/#/g/${e.params.gid}?to=wall&c=${e.params.cid}`, `rx:g/${e.params.gid}/${e.params.cid}`);
});
exports.onExpenseCommentReaction = onDocumentUpdated({ document: "expenses/{xid}/comments/{cid}", ...PUSH }, async e => {
  const b = e.data.before.data(), a = e.data.after.data(); if (!newReactors(b, a).length) return;
  const x = (await db.doc("expenses/" + e.params.xid).get()).data(); if (!x) return;
  await notifyReactions(b, a, a.authorId, "comment", [commentWhere(a), x.desc].filter(Boolean).join(" · "), `/#/x/${e.params.xid}?to=wall&c=${e.params.cid}`, `rx:x/${e.params.xid}/${e.params.cid}`);
});
exports.onPhotoReaction = onDocumentUpdated({ document: "events/{eid}/photos/{pid}", ...PUSH }, async e => {
  const b = e.data.before.data(), a = e.data.after.data(); if (!newReactors(b, a).length) return;
  const ev = (await db.doc("events/" + e.params.eid).get()).data(); if (!ev) return;
  await notifyReactions(b, a, a.addedBy, "photo", ev.title || "", `/#/e/${e.params.eid}?photo=${e.params.pid}`, `rx:p/${e.params.eid}/${e.params.pid}`);
});
// A comment on a photo: keep the count on the photo and tell whoever posted it.
exports.onPhotoComment = onDocumentCreated({ document: "events/{eid}/photos/{pid}/comments/{cid}", ...PUSH }, async e => {
  const c = e.data && e.data.data(); if (!c) return;
  const { eid, pid } = e.params;
  const pref = db.doc(`events/${eid}/photos/${pid}`);
  await pref.update({ commentCount: FieldValue.increment(1) }).catch(() => {});
  const [p, ev] = await Promise.all([pref.get(), db.doc("events/" + eid).get()]);
  const owner = p.exists && p.get("addedBy");
  if (owner && owner !== c.authorId)
    await notify([owner], `${firstName(c.authorName || "Someone")} commented on your photo`, `“${String(c.text || "").slice(0, 120)}” · ${ev.exists ? ev.get("title") : "your event"}`,
      `/#/e/${eid}?photo=${pid}&c=${e.params.cid}`, { type: "comment", actorId: c.authorId });
});
exports.onPhotoCommentDeleted = onDocumentDeleted({ document: "events/{eid}/photos/{pid}/comments/{cid}" }, async e => {
  await db.doc(`events/${e.params.eid}/photos/${e.params.pid}`).update({ commentCount: FieldValue.increment(-1) }).catch(() => {});
});

// ---- Recurring events: the next occurrence is created the day after one passes ----
// ev.repeat: weekly | biweekly | monthly | custom (repeatEvery 1-30 × repeatUnit day|week|month); ev.repeatUntil ends the series.
function addPeriod(date, ev) {
  const r = typeof ev === "string" ? { repeat: ev } : (ev || {});
  let unit = "week", n = 1;
  if (r.repeat === "biweekly") n = 2;
  else if (r.repeat === "monthly") unit = "month";
  else if (r.repeat === "custom") { unit = ["day", "week", "month"].includes(r.repeatUnit) ? r.repeatUnit : "week"; n = Math.max(1, Math.min(30, parseInt(r.repeatEvery, 10) || 1)); }
  const [y, m, d] = date.split("-").map(Number);
  const x = unit === "month" ? new Date(Date.UTC(y, m - 1 + n, Math.min(d, 28))) : new Date(Date.UTC(y, m - 1, d + (unit === "day" ? n : 7 * n)));
  return x.toISOString().slice(0, 10);
}

// ---- Public HTTP endpoints (org policy now allows public invokers) ----
const FN_BASE = "https://us-central1-friendly-6992a.cloudfunctions.net";
const htmlEsc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Rich link previews for texted/shared invites: /p/{eventId} serves OpenGraph
// tags (iMessage, WhatsApp, Slack unfurl them) then sends people on to the app;
// /p/{eventId}/cover.jpg serves the preview's cover image.
exports.share = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB" }, async (req, res) => {
  // /g/{groupId}: a group invite. A compact card (square icon) instead of the App Store's tall screenshot card.
  const gm = /^\/g\/([A-Za-z0-9_-]{8,64})\/?$/.exec(req.path || "");
  if (gm) {
    const gid = gm[1]; const gs = await db.doc("groups/" + gid).get(); const g = gs.exists ? gs.data() : null;
    const title = g ? `Join ${g.emoji ? g.emoji + " " : ""}${g.name} on Friendly` : "Join the crew on Friendly";
    const n = g ? (g.memberUids || []).length : 0;
    const desc = "Your crew's home base for plans, invites, photos, and settling up." + (n > 1 ? ` ${n} friends are already in.` : "");
    const target = SITE + "/#/join/" + gid, openUrl = SITE + "/?g=" + gid, img = SITE + "/icons/icon-512.png";
    const ogTags = `<meta property="og:type" content="website"><meta property="og:site_name" content="Friendly">
<meta property="og:title" content="${htmlEsc(title)}"><meta property="og:description" content="${htmlEsc(desc)}">
<meta property="og:image" content="${img}"><meta property="og:image:width" content="512"><meta property="og:image:height" content="512"><meta property="og:url" content="${FN_BASE}/share/g/${gid}">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${htmlEsc(title)}"><meta name="twitter:description" content="${htmlEsc(desc)}"><meta name="twitter:image" content="${img}">`;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(req.get("user-agent") || "");
    res.set("Cache-Control", "public, max-age=300");
    if (isMobile) { res.type("html").send(mobileGateHtml({ title, desc: "Get the app and sign up with the phone number that got this text. You'll be in the group automatically.", target, openUrl, extraHead: ogTags, appFirst: true })); return; }
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${htmlEsc(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1">${ogTags}
<meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)});</script></head><body><p><a href="${target}">Open Friendly</a></p></body></html>`);
    return;
  }
  const m = /^\/p\/([a-f0-9]{8,64})(\/cover\.jpg)?\/?$/i.exec(req.path || "");
  if (!m) { res.redirect(302, SITE); return; }
  const id = m[1]; const snap = await db.doc("previews/" + id).get(); const p = snap.exists ? snap.data() : null;
  if (m[2]) {
    const c = p && p.cover ? /^data:image\/jpeg;base64,(.+)$/i.exec(p.cover) : null;
    if (!c) { res.redirect(302, SITE + "/icons/icon-512.png"); return; }
    res.set("Cache-Control", "public, max-age=600"); res.type("image/jpeg").send(Buffer.from(c[1], "base64")); return;
  }
  const target = SITE + "/#/e/" + id;
  const openUrl = SITE + "/?p=" + id;   // Universal Link: opens the app if installed
  // No Universal Links are registered yet, so we can't silently open the native
  // app -- the honest thing on a phone is to offer the App Store instead of
  // guessing. Desktop just goes straight to the web RSVP page, like before.
  const isMobile = /iPhone|iPad|iPod|Android/i.test(req.get("user-agent") || "");
  if (!p) {
    if (!isMobile) { res.redirect(302, target); return; }
    res.set("Cache-Control", "no-store");
    res.type("html").send(mobileGateHtml({ title: "You're invited!", desc: "Open your invite in Friendly.", target, openUrl }));
    return;
  }
  const title = (p.kind === "meeting" ? "📅 " : (p.emoji ? p.emoji + " " : "")) + p.title;
  const when = humanWhen({ date: p.date, time: p.time, endTime: p.endTime });
  const desc = when + (p.location ? " · " + p.location : "") + (p.hostName ? " · hosted by " + p.hostName : "") + (p.going ? " · " + p.going + " going" : "");
  const img = p.cover ? FN_BASE + "/share/p/" + id + "/cover.jpg" : SITE + "/icons/icon-512.png";
  const ogTags = `<meta property="og:type" content="website"><meta property="og:site_name" content="Friendly">
<meta property="og:title" content="${htmlEsc(title)}"><meta property="og:description" content="${htmlEsc(desc)}">
<meta property="og:image" content="${img}"><meta property="og:url" content="${FN_BASE}/share/p/${id}">
<meta name="twitter:card" content="${p.cover ? "summary_large_image" : "summary"}"><meta name="twitter:title" content="${htmlEsc(title)}"><meta name="twitter:description" content="${htmlEsc(desc)}"><meta name="twitter:image" content="${img}">`;
  res.set("Cache-Control", isMobile ? "no-store" : "public, max-age=300");
  if (isMobile) { res.type("html").send(mobileGateHtml({ title, desc, target, openUrl, extraHead: ogTags })); return; }
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${htmlEsc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${ogTags}
<meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)});</script></head>
<body style="font-family:-apple-system,system-ui,sans-serif;padding:24px;color:#2A2019"><p>Opening your invite… <a href="${target}">Tap here if it doesn't open.</a></p></body></html>`);
});
// Shown instead of the instant redirect on a phone: there's no Universal Link
// registered (see comment above), so we can't tell if Friendly is installed.
// Offer the App Store as the clear first move, with the web invite one tap away.
const APP_STORE_URL = "https://apps.apple.com/app/id6810875052";
function mobileGateHtml({ title, desc, target, openUrl, extraHead = "", appFirst = false }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${htmlEsc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${extraHead}
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#FFFEFC;color:#2A2019;margin:0;padding:28px 20px;text-align:center}
  .brand{font-size:22px;font-weight:800;margin:6px 0 18px}
  .brand .tilt{color:#FF6B57}
  h1{font-size:19px;margin:0 0 6px}
  p.sub{color:#8C7C70;margin:0 0 26px;font-size:15px}
  a.btn{display:block;text-decoration:none;border-radius:14px;padding:14px 18px;font-weight:700;font-size:16px;margin:0 0 12px}
  a.primary{background:#FF6B57;color:#fff}
  a.secondary{background:#FFF3E6;color:#2A2019}
</style></head>
<body>
  <div class="brand">Friend<span class="tilt">l</span>y</div>
  <h1>${htmlEsc(title)}</h1>
  <p class="sub">${htmlEsc(desc)}</p>
  ${appFirst ? `<a class="btn primary" href="${APP_STORE_URL}">Get the Friendly app</a>
  <a class="btn secondary" href="${openUrl || target}">I already have Friendly</a>` : `<a class="btn primary" href="${openUrl || target}">Open in Friendly</a>
  <a class="btn secondary" href="${APP_STORE_URL}">Get the Friendly app</a>`}
</body></html>`;
}

// Phone-based sign-in fell back to us: the account predates phone sign-in, so
// it's still keyed by its real email in Firebase Auth. We look the account up
// by phone, verify the password server-side via Identity Toolkit (the client
// never learns the real email), and hand back a one-time custom token.
const WEB_API_KEY = "AIzaSyA_lgyYmCL6HnoFPn4Ux89bD6iI_fazkmA";
// The page's watchdog thread reports a hung main thread (and the recovery). Lands in the bug feed as a diag line.
exports.hang = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB", maxInstances: 2 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "POST, OPTIONS"); res.set("Access-Control-Allow-Headers", "Content-Type"); res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).send(""); return; }
  let d = {}; try { d = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch {}
  if (d.kind !== "hung" && d.kind !== "resumed") { res.status(400).send(""); return; }
  const steps = (Array.isArray(d.steps) ? d.steps : []).slice(-10).map(s => String(s).slice(0, 120));
  const text = d.kind === "hung"
    ? `WATCHDOG: the page's main thread stopped answering for ${Number(d.gapS) || 0}s (reported by its worker thread, so the process was alive: a hang, not a kill). Page ${d.vis === false ? "thought it was hidden" : "on screen"}, at ${String(d.route || "?").slice(0, 80)}. Last steps:\n` + steps.join("\n")
    : `WATCHDOG: the page came back after ${Number(d.hungFor) || 0}s, at ${String(d.route || "?").slice(0, 80)}. Last steps:\n` + steps.join("\n");
  await db.collection("bugs").add({ uid: String(d.uid || "").slice(0, 40) || "unknown", name: "diag", diag: true, status: "open", platform: "ios", version: String(d.v || "").slice(0, 40), route: "", createdAt: Date.now(), text }).catch(() => {});
  res.status(200).send("ok");
});
exports.phoneSignIn = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB" }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", SITE);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { phoneE164, password } = req.body || {};
  if (!phoneE164 || !password) { res.status(400).json({ error: "Missing phoneE164 or password" }); return; }
  try {
    const snap = await db.collection("users").where("phoneE164", "==", phoneE164).limit(1).get();
    if (snap.empty) { res.status(401).json({ error: "No account" }); return; }
    const uid = snap.docs[0].id;
    const authUser = await getAuth().getUser(uid).catch(e => { logger.error("phoneSignIn getUser", e); return null; });
    if (!authUser || !authUser.email) { res.status(401).json({ error: "No account" }); return; }
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: authUser.email, password, returnSecureToken: true }),
    });
    if (!r.ok) { res.status(401).json({ error: "Wrong password" }); return; }
    const token = await getAuth().createCustomToken(uid);
    res.json({ token });
  } catch (e) { logger.error("phoneSignIn", e); res.status(500).json({ error: "Server error" }); }
});

// Forgot password: look the account up by phone, and if it has a real email on
// file, email a Firebase password-reset link there (never to the synthetic
// <digits>@phone.officialfriendly.com auth address, which isn't a real inbox).
// Always responds the same way whether or not an account/email was found, so
// this can't be used to check which phone numbers have accounts.
exports.requestPasswordReset = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB", secrets: [MAILGUN_API_KEY] }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", SITE);
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const { phoneE164 } = req.body || {};
  if (!phoneE164) { res.status(400).json({ error: "Missing phoneE164" }); return; }
  try {
    const key = MAILGUN_API_KEY.value();
    const snap = key && key !== "unset" ? await db.collection("users").where("phoneE164", "==", phoneE164).limit(1).get() : null;
    const userDoc = snap && !snap.empty ? snap.docs[0] : null;
    const toEmail = userDoc ? String(userDoc.get("email") || "").toLowerCase().trim() : "";
    if (userDoc && toEmail.includes("@")) {
      const authUser = await getAuth().getUser(userDoc.id).catch(() => null);
      if (authUser && authUser.email) {
        // generatePasswordResetLink always points at the firebaseapp.com hosted
        // action handler regardless of actionCodeSettings -- pull out just the
        // oobCode and build our own link so it opens Friendly's own reset screen.
        const raw = await getAuth().generatePasswordResetLink(authUser.email, { url: SITE + "/" });
        const oobCode = new URL(raw).searchParams.get("oobCode");
        const link = `${SITE}/?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}`;
        const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#2A2019">
          <h2 style="margin:0 0 14px;font-size:22px">Reset your Friendly password</h2>
          <p style="margin:0 0 20px">Tap below to choose a new one. This link works once and expires soon.</p>
          <p style="margin:0 0 20px"><a href="${link}" style="background:#FF6B57;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600;display:inline-block">Reset password</a></p>
          <p style="color:#8C7C70;font-size:13px">Didn't ask for this? You can ignore this email -- your password stays the same.</p>
        </div>`;
        const form = new FormData();
        form.append("from", MAIL_FROM("Friendly")); form.append("to", toEmail);
        form.append("subject", "Reset your Friendly password"); form.append("html", html);
        const r = await fetch(MAILGUN_API + "/messages", { method: "POST", headers: { Authorization: "Basic " + Buffer.from("api:" + key).toString("base64") }, body: form });
        if (!r.ok) logger.warn("mailgun password reset " + r.status + ": " + (await r.text()).slice(0, 200));
      }
    }
  } catch (e) { logger.error("requestPasswordReset", e); }
  res.json({ ok: true });
});

// Calendar subscription: /cal?u=<uid>&t=<token> is a live .ics feed of every
// event the user is invited to (subscribe once in iPhone/Google Calendar).
// The token lives on the user's profile; the app makes it on first use.
// Calendar feed (?u=&t=) and single-event download (?u=&t=&e=). Times go out in UTC ("Z"), converted
// from the wall-clock time in the event's own time zone (ev.tz, set when it was made; older events
// are Central), so every calendar app shows the right moment wherever the guest is.
const DEFAULT_TZ = "America/Chicago";
function tzOffsetMs(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs;
}
function zonedUtc(date, mins, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, 0) + mins * 60000;
  let utc = wall - tzOffsetMs(wall, tz); utc = wall - tzOffsetMs(utc, tz);   // second pass settles DST edges
  return new Date(utc).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}
function icsEvent(id, ev, u, stamp) {
  const my = (ev.rsvps || {})[u] || "no answer yet";
  let tz = ev.tz || DEFAULT_TZ; try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = DEFAULT_TZ; }
  let dt;
  if (!ev.time) dt = `DTSTART;VALUE=DATE:${ev.date.replace(/-/g, "")}\r\nDTEND;VALUE=DATE:${nextDay(ev.date).replace(/-/g, "")}`;
  else { const s0 = minutes(ev.time); let e = ev.endTime ? minutes(ev.endTime) : s0 + 120; if (e <= s0) e = e + 1440 > s0 + 1440 ? s0 + 120 : e + 1440; dt = `DTSTART:${zonedUtc(ev.date, s0, tz)}\r\nDTEND:${zonedUtc(ev.date, e, tz)}`; }
  return ["BEGIN:VEVENT", "UID:" + id + "@officialfriendly.com", "DTSTAMP:" + stamp, dt,
    "SUMMARY:" + icsEsc((ev.kind === "meeting" ? "" : (ev.emoji ? ev.emoji + " " : "")) + ev.title),
    ev.location ? "LOCATION:" + icsEsc(ev.location) : null,
    "DESCRIPTION:" + icsEsc("Your RSVP: " + my + (ev.hostName ? "\nHost: " + ev.hostName : "") + (stopsText(ev) ? "\n\n" + stopsText(ev).trim() : "") + (ev.notes ? "\n\n" + ev.notes : "") + "\n\n" + SITE + "/#/e/" + id),
    "URL:" + SITE + "/#/e/" + id, "STATUS:" + (my === "no" ? "CANCELLED" : "CONFIRMED"), "END:VEVENT"];
}
exports.cal = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB" }, async (req, res) => {
  const u = String(req.query.u || ""), t = String(req.query.t || ""), e = String(req.query.e || "");
  if (!/^[A-Za-z0-9-]{6,64}$/.test(u) || !/^[a-f0-9]{24,64}$/i.test(t) || (e && !/^[A-Za-z0-9_-]{4,80}$/.test(e))) { res.status(400).send("bad request"); return; }
  const user = await db.doc("users/" + u).get();
  // The full feed needs Calendar sync's token; one event also accepts the add-to-calendar token.
  const okToken = user.exists && (user.get("calToken") === t || (e && user.get("icsToken") === t));
  if (!okToken) { res.status(403).send("forbidden"); return; }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Friendly//officialfriendly.com//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  if (e) {
    const d = await db.doc("events/" + e).get(); const ev = d.exists && d.data();
    if (!ev || !(ev.invitedUids || []).includes(u) || !ev.date || !ev.title) { res.status(404).send("not found"); return; }
    lines.push(...icsEvent(d.id, ev, u, stamp));
  } else {
    lines.push("X-WR-CALNAME:Friendly", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H");
    const snap = await db.collection("events").where("invitedUids", "array-contains", u).get();
    snap.forEach(d => { const ev = d.data(); if (ev.date && ev.title) lines.push(...icsEvent(d.id, ev, u, stamp)); });
  }
  lines.push("END:VCALENDAR");
  res.set("Cache-Control", "private, max-age=300");
  res.set("Content-Disposition", e ? 'inline; filename="event.ics"' : 'inline; filename="friendly.ics"');
  res.type("text/calendar; charset=utf-8").send(lines.filter(Boolean).map(icsFold).join("\r\n") + "\r\n");
});

const firstName = n => (n || "Someone").split(" ")[0];

const commentPreview = c => c.img && !c.text ? "📷 Photo" : String(c.text || "").slice(0, 120);
// People named with @ get their own line in the feed / a push of their own.
const mentionNotify = (c, url, where) => (c.mentions && c.mentions.length) ? notify(c.mentions.filter(u => u !== c.authorId), firstName(c.authorName) + " mentioned you" + (where ? " in " + where : ""), commentPreview(c), url, { type: "mention", actorId: c.authorId }) : Promise.resolve();

// Which notifCategory toggle (profile > Notifications) a push type falls under.
// Types with no entry here (money reminders, admin content reports) always send --
// only the four categories the person can actually see and turn off are gated.
const NOTIF_CATEGORY = { event: "invites", meeting: "invites", rsvp: "invites", nudge: "reminders", reminder: "reminders", mention: "chat", comment: "chat", dm: "chat", friend: "invites", birthday: "birthdays", money: "money", photo: "photos" };
// Every device for a set of users (native FCM tokens + web push subscriptions):
// send, prune anything dead, and log the item to the Activity feed so it shows
// in-app even for people who keep notifications (or this category) off.
async function notify(uids, title, body, url = "/", extra = {}) {
  const ids = [...new Set(uids)].filter(Boolean);
  if (!ids.length) return;
  // Private messages live in their own Messages inbox, so they skip the Activity feed.
  if (!extra.skipActivity) await db.collection("activity").add({ uids: ids, title, body, url, type: extra.type || "", actorId: extra.actorId || "", ...(extra.sid ? { sid: extra.sid } : {}), ...(extra.key ? { key: extra.key, actors: extra.actors || [], actorNames: extra.actorNames || [] } : {}), createdAt: Date.now() })
    .catch(err => logger.warn("activity: " + err.message));
  const category = NOTIF_CATEGORY[extra.type];
  const snaps = await db.getAll(...ids.map(id => db.doc("users/" + id)));
  const tokenOwner = {}, tokens = [], apns = [], subs = [];
  snaps.forEach(s => {
    if (category && s.get(`notifPrefs.${category}`) === false) return;
    (s.get("pushTokens") || []).forEach(t => { (isApnsToken(t) ? apns : tokens).push(t); tokenOwner[t] = s.id; });
    (s.get("webPush") || []).forEach(sub => subs.push({ sub, uid: s.id }));
  });
  // App icon badge = unread Activity (newer than the last time they opened Activity), the same
  // number as the bell in the app. Counted only for people with a phone to send to.
  const badge = {};
  // Items they already opened (users.peeked, written by the app) don't count, same as the bell.
  // Phones get a badge only once their app can clear it (users.badgeOk, iOS 1.0.3+ / Android 1.0.4+).
  await Promise.all(snaps.filter(s => (s.get("badgeOk") && (s.get("pushTokens") || []).length) || (s.get("webPush") || []).length).map(async s => {
    try {
      const q = await db.collection("activity").where("uids", "array-contains", s.id).where("createdAt", ">", Number(s.get("activitySeenAt") || 0)).orderBy("createdAt", "desc").limit(100).get();
      const peeked = s.get("peeked") || {};
      const key = url => { const t = String(url || ""); const i = t.indexOf("#"); return (i < 0 ? "" : t.slice(i).split("?")[0]).replace(/^#\//, "").replace(/[^A-Za-z0-9_-]/g, "_"); };
      const acts = q.docs.filter(d => { const a = d.data(); const k = key(a.url); return !(k && (peeked[k] || 0) >= a.createdAt); }).length;
      // Plus private conversations with something new from the other person (the Messages count in the app).
      const threads = await db.collection("dms").where("uids", "array-contains", s.id).get();
      const cleared = s.get("hiddenDms") || {}, blockedU = s.get("blockedUids") || [];
      const dms = threads.docs.filter(d => { const t = d.data(); return t.lastBy && t.lastBy !== s.id && !blockedU.includes(t.lastBy) && (t.lastAt || 0) > ((t.readAt || {})[s.id] || 0) && (t.lastAt || 0) > (cleared[d.id] || 0); }).length;
      badge[s.id] = Math.min(99, acts + dms);
    } catch (err) { logger.warn("badge count: " + err.message); }
  }));
  const badgeOk = new Set(snaps.filter(s => s.get("badgeOk")).map(s => s.id));
  const badgeOf = t => badgeOk.has(tokenOwner[t]) ? badge[tokenOwner[t]] : undefined;
  const jobs = [];
  if (apns.length) jobs.push(apnsSend(apns, title, body, url, badgeOf).then(async dead => {
    const byUser = {}; dead.forEach(t => { (byUser[tokenOwner[t]] = byUser[tokenOwner[t]] || []).push(t); });
    await Promise.all(Object.entries(byUser).map(([uid, ts]) => db.doc("users/" + uid).update({ pushTokens: FieldValue.arrayRemove(...ts) }).catch(() => {})));
  }));
  if (tokens.length) jobs.push(getMessaging().sendEach(tokens.map(token => {
    const b = badgeOf(token);
    return { token, notification: { title, body }, data: { url, ...(b != null ? { badge: String(b) } : {}) },
      android: { notification: b != null ? { notificationCount: b } : {} },
      apns: { payload: { aps: { sound: "default", ...(b != null ? { badge: b } : {}) } } } };
  })).then(async res => {
    const dead = [];
    res.responses.forEach((r, i) => { if (!r.success) { const c = r.error && r.error.code; if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-argument") dead.push(tokens[i]); } });
    const byUser = {}; dead.forEach(t => { (byUser[tokenOwner[t]] = byUser[tokenOwner[t]] || []).push(t); });
    await Promise.all(Object.entries(byUser).map(([uid, ts]) => db.doc("users/" + uid).update({ pushTokens: FieldValue.arrayRemove(...ts) }).catch(() => {})));
  }).catch(err => logger.warn("fcm: " + err.message)));
  if (subs.length && VAPID_PRIVATE.value()) {
    webpush.setVapidDetails("mailto:wes@wes-griffin.com", VAPID_PUBLIC, VAPID_PRIVATE.value());
    jobs.push(...subs.map(({ sub, uid }) => webpush.sendNotification(sub, JSON.stringify({ title, body, url, badge: badge[uid] })).catch(err => {
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
    "/#/e/" + e.params.id + "?to=rsvpCard", { type: kind, actorId: ev.hostId });
  await Promise.all([sendInviteEmails(e.params.id, ev, "REQUEST"), writePreview(e.params.id, ev)]);
});

// Event deleted -> cancel the calendar entries, drop the preview.
exports.onEventDeleted = onDocumentDeleted({ document: "events/{id}", ...MAIL }, async e => {
  const ev = e.data && e.data.data(); if (!ev) return;
  await Promise.all([sendInviteEmails(e.params.id, ev, "CANCEL"), db.doc("previews/" + e.params.id).delete().catch(() => {}), notifyCanceled(e.params.id, ev),
    getStorage().bucket().deleteFiles({ prefix: `events/${e.params.id}/` }).catch(err => logger.warn("event files delete " + err.message))]);
});
// "Taco Tuesday was canceled": everyone invited to an upcoming event hears when it's deleted.
const todayIn = tz => new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
async function notifyCanceled(id, ev) {
  try {
    if (ev.draft || !ev.date || ev.date < todayIn(ev.tz)) return;
    const by = ev.updatedBy || ev.hostId, byName = firstName((ev.names || {})[by]) || "The host";
    const to = (ev.invitedUids || []).filter(u => isRealUid(u) && u !== by);
    await notify(to, `${ev.title || "An event"} was canceled`, `${byName} took it off the calendar.`, "/#/", { type: "event", actorId: by });
  } catch (err) { logger.warn("notifyCanceled " + id + ": " + err.message); }
}
// A new time or place for an upcoming event: everyone invited hears, with the new details.
const niceWhen = (date, time) => { const [y, m, d] = String(date || "").split("-").map(Number); if (!y) return "";
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const t = /^(\d{2}):(\d{2})$/.exec(time || ""); if (!t) return day; let h = +t[1]; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${day} · ${h}${t[2] === "00" ? "" : ":" + t[2]} ${ap}`; };
exports.onEventChanged = onDocumentUpdated({ document: "events/{id}", ...PUSH }, async e => {
  const b = e.data.before.data(), a = e.data.after.data();
  if (a.draft || b.draft || !a.date || a.date < todayIn(a.tz)) return;
  const when = a.date !== b.date || (a.time || "") !== (b.time || ""), where = (a.location || "") !== (b.location || "");
  if (!when && !where) return;
  const by = a.updatedBy || a.hostId, byName = firstName((a.names || {})[by]) || "The host";
  const to = (a.invitedUids || []).filter(u => isRealUid(u) && u !== by); if (!to.length) return;
  const title = when && where ? `${a.title}: new time and place` : when ? `${a.title} moved to ${niceWhen(a.date, a.time)}` : `${a.title} has a new place`;
  const body = (when && where ? `Now ${niceWhen(a.date, a.time)} at ${a.location}. ` : where ? `Now at ${a.location}. ` : b.date !== a.date ? `Was ${niceWhen(b.date, b.time)}. ` : `Was ${niceWhen(b.date, b.time).split(" · ")[1] || "another time"}. `) + `${byName} changed it.`;
  await notify(to, title, body, `/#/e/${e.params.id}?to=dayCard`, { type: "event", actorId: by });
});

// ---- Deleted accounts: scrub (or migrate) their memberships everywhere ----
// The app's own delete flow only removed the person from groups, never from
// events, and an account deleted from the Firebase console cleaned up nothing.
// The leftover uid then kept matching that person's phone number in the "Add
// people" picker, so re-inviting them silently re-added the dead account
// instead of texting the new one. `replacement` is the same person's new
// account (matched by phone), in which case memberships move to it instead.
const toE164 = p => { const d = String(p || "").trim(); if (!d) return ""; const n = d.replace(/\D/g, ""); if (d.startsWith("+")) return "+" + n; if (n.length === 10) return "+1" + n; if (n.length === 11 && n[0] === "1") return "+" + n; return n ? "+" + n : ""; };
async function scrubUid(uid, replacement) {
  const nu = replacement && replacement.uid;
  for (const c of ["friendships", "dms"]) { const q = await db.collection(c).where("uids", "array-contains", uid).get(); for (const d of q.docs) await d.ref.delete().catch(() => {}); }
  const groups = await db.collection("groups").where("memberUids", "array-contains", uid).get();
  for (const g of groups.docs) {
    const d = g.data(); const up = {};
    const rest = (d.memberUids || []).filter(u => u !== uid);
    up.memberUids = nu && !rest.includes(nu) ? [...rest, nu] : rest;
    const hosts = (d.hostUids || []).filter(u => u !== uid);
    up.hostUids = nu && (d.hostUids || []).includes(uid) && !hosts.includes(nu) ? [...hosts, nu] : hosts;
    const members = { ...(d.members || {}) }; const old = members[uid]; delete members[uid];
    if (nu && old) members[nu] = { ...old, name: replacement.name || old.name };
    up.members = members;
    if (d.ownerId === uid) up.ownerId = nu || up.hostUids[0] || rest[0] || null;
    if (!up.memberUids.length) { await g.ref.delete(); continue; }
    await g.ref.update(up);
  }
  const events = await db.collection("events").where("invitedUids", "array-contains", uid).get();
  for (const e of events.docs) {
    const d = e.data(); const up = {};
    const rest = (d.invitedUids || []).filter(u => u !== uid);
    up.invitedUids = nu && !rest.includes(nu) ? [...rest, nu] : rest;
    const co = (d.cohostUids || []).filter(u => u !== uid);
    up.cohostUids = nu && (d.cohostUids || []).includes(uid) && !co.includes(nu) ? [...co, nu] : co;
    for (const k of ["rsvps", "plusOnes", "plusNames", "hypes", "answers", "names"]) {
      const m = { ...(d[k] || {}) }; if (!(uid in m)) continue;
      const v = m[uid]; delete m[uid]; if (nu) m[nu] = k === "names" ? (replacement.name || v) : v; up[k] = m;
    }
    if (d.hostId === uid && nu) up.hostId = nu;
    await e.ref.update(up);
  }
  return { groups: groups.size, events: events.size };
}
// In-app deletion removes users/{uid} first; console deletion fires the auth trigger.
exports.onUserDeleted = onDocumentDeleted({ document: "users/{uid}" }, async e => {
  const n = await scrubUid(e.params.uid); logger.info("scrubbed deleted user " + e.params.uid, n);
});
exports.onAuthUserDeleted = functionsV1.auth.user().onDelete(async user => {
  await db.doc("users/" + user.uid).delete().catch(() => {});
  const n = await scrubUid(user.uid); logger.info("scrubbed auth-deleted user " + user.uid, n);
});
// One-off repair for accounts deleted before the triggers above existed: find
// every uid still referenced by a group or event whose Firebase Auth user is
// gone, migrate it to the same person's new account (matched by phone) when
// there is one, otherwise scrub it. Guarded by a secret; returns a summary.
const MAINT_KEY = defineSecret("MAINT_KEY");
exports.scrubOrphans = onRequest({ region: "us-central1", invoker: "public", memory: "512MiB", timeoutSeconds: 300, secrets: [MAINT_KEY] }, async (req, res) => {
  if (!MAINT_KEY.value() || String(req.query.key || "") !== MAINT_KEY.value()) { res.status(403).send("forbidden"); return; }
  const uids = new Set();
  (await db.collection("groups").get()).forEach(g => (g.get("memberUids") || []).forEach(u => uids.add(u)));
  (await db.collection("events").get()).forEach(e => (e.get("invitedUids") || []).forEach(u => uids.add(u)));
  const all = [...uids]; const gone = [];
  for (let i = 0; i < all.length; i += 100) {
    const r = await getAuth().getUsers(all.slice(i, i + 100).map(uid => ({ uid })));
    r.notFound.forEach(x => gone.push(x.uid));
  }
  const report = [];
  for (const uid of gone) {
    let replacement = null;
    const oldDoc = await db.doc("users/" + uid).get();
    let phone = oldDoc.exists ? (oldDoc.get("phoneE164") || toE164(oldDoc.get("phone"))) : "";
    if (!phone) {
      const g = await db.collection("groups").where("memberUids", "array-contains", uid).limit(1).get();
      const m = g.empty ? null : (g.docs[0].get("members") || {})[uid]; phone = m && m.phone ? toE164(m.phone) : "";
    }
    if (phone) { const q = await db.collection("users").where("phoneE164", "==", phone).limit(1).get(); if (!q.empty && q.docs[0].id !== uid) replacement = { uid: q.docs[0].id, name: q.docs[0].get("name") || "" }; }
    const n = await scrubUid(uid, replacement);
    if (oldDoc.exists) await oldDoc.ref.delete().catch(() => {});
    report.push({ uid, migratedTo: replacement ? replacement.uid : null, ...n });
  }
  res.json({ checked: all.length, gone: gone.length, report });
});

// ---------- public demo (wes-griffin.com "Try the demo" and ?demo=1) ----------
// A dedicated sandbox account, separate from any real user or App Store
// review account. demoLogin hands back a sign-in token for it -- no password
// ever reaches the browser, so there is nothing in the client to leak.
// resetDemoData (re)writes its group and events to a known-good state on a
// fixed set of doc ids and removes anything a visitor added outside them, so
// the sandbox self-heals from whatever the public does to it. Runs nightly
// and can be called by hand.
const DEMO_UID = "demo-riley", DEMO_JORDAN = "demo-jordan", DEMO_CASEY = "demo-casey";
const DEMO_GROUP = "demo-squad", DEMO_EVENTS = ["demo-evt-1", "demo-evt-2", "demo-evt-3"], DEMO_EXPENSE = "demo-exp-1";
const demoEmail = uid => uid.replace(/[^a-z0-9]/gi, "") + "@phone.officialfriendly.com";
async function ensureDemoAuthUsers() {
  for (const [uid, name] of [[DEMO_UID, "Riley"], [DEMO_JORDAN, "Jordan"], [DEMO_CASEY, "Casey"]]) {
    await getAuth().getUser(uid).catch(() => getAuth().createUser({ uid, email: demoEmail(uid), emailVerified: true, displayName: name }));
  }
}
async function seedDemoData() {
  await ensureDemoAuthUsers();
  const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const members = { [DEMO_UID]: { name: "Riley", venmo: "@riley-demo", phone: "" }, [DEMO_JORDAN]: { name: "Jordan", venmo: "@jordan-demo", phone: "" }, [DEMO_CASEY]: { name: "Casey", venmo: "@casey-demo", phone: "" } };
  const memberUids = [DEMO_UID, DEMO_JORDAN, DEMO_CASEY];
  await db.doc("users/" + DEMO_UID).set({ name: "Riley", phone: "", phoneE164: "+15550001001", email: "", venmo: "@riley-demo", photo: "", birthday: "", blockedUids: [], hiddenIds: [], pushTokens: [], webPush: [], onboarded: true, createdAt: Date.now() }, { merge: true });
  await db.doc("users/" + DEMO_JORDAN).set({ name: "Jordan", phone: "", phoneE164: "+15550001002", email: "", venmo: "@jordan-demo", onboarded: true, createdAt: Date.now() }, { merge: true });
  await db.doc("users/" + DEMO_CASEY).set({ name: "Casey", phone: "", phoneE164: "+15550001003", email: "", venmo: "@casey-demo", onboarded: true, createdAt: Date.now() }, { merge: true });
  await db.doc("groups/" + DEMO_GROUP).set({ name: "Demo Squad", emoji: "🎈", color: "#FFE0B2", ownerId: DEMO_UID, memberUids, members, createdAt: Date.now() });
  const names = Object.fromEntries(memberUids.map(u => [u, members[u].name]));
  const base = { groupId: DEMO_GROUP, invitedUids: memberUids, names, cohostUids: [], plusOnes: {}, hypes: {}, answers: {}, questions: [], openLink: true, kind: "event", repeat: "", invitedPhones: [], invitedPhoneNames: {}, guestEmails: [], sequence: 0, createdAt: Date.now() };
  await db.doc("events/demo-evt-1").set({ ...base, hostId: DEMO_UID, hostName: "Riley", title: "Board Game Night", emoji: "🎲", theme: "cosmic", customTheme: null, date: addDays(5), time: "19:00", endTime: "22:00", location: "Riley's place", notes: "Bring a game if you've got a favorite. Snacks are covered.", capacity: 8, approval: false, rsvps: { [DEMO_UID]: "going", [DEMO_JORDAN]: "going", [DEMO_CASEY]: "maybe" } });
  await db.doc("events/demo-evt-2").set({ ...base, hostId: DEMO_UID, hostName: "Riley", title: "Beach Cleanup + Picnic", emoji: "🏖️", theme: "garden", customTheme: null, date: addDays(12), time: "10:00", endTime: "13:00", location: "Sunset Beach, north lot", notes: "Gloves and bags provided, just bring sunscreen. Picnic after.", capacity: 12, approval: false, rsvps: { [DEMO_UID]: "going", [DEMO_JORDAN]: "maybe" } });
  await db.doc("events/demo-evt-3").set({ ...base, hostId: DEMO_UID, hostName: "Riley", title: "Housewarming Party", emoji: "🏠", theme: "disco", customTheme: null, date: addDays(-9), time: "20:00", endTime: "23:30", location: "Riley's new place", notes: "First party in the new spot!", capacity: 15, approval: false, rsvps: { [DEMO_UID]: "going", [DEMO_JORDAN]: "going", [DEMO_CASEY]: "going" } });
  await db.doc("expenses/" + DEMO_EXPENSE).set({ desc: "Pizza & drinks", amountCents: 6820, paidBy: DEMO_JORDAN, split: memberUids, involved: memberUids, eventId: "demo-evt-3", groupId: DEMO_GROUP, addedBy: DEMO_JORDAN, createdAt: Date.now() });
  // Remove anything a visitor created outside the fixed seed set, on the demo
  // accounts only -- this is what makes the sandbox self-heal on a reset:
  // extra events/groups, visitor chat/photos/polls/songs on the seeded events,
  // extra expenses and settlements, and the demo accounts' activity feed.
  const demoUids = [DEMO_UID, DEMO_JORDAN, DEMO_CASEY];
  const [evSnap, grpSnap] = await Promise.all([
    db.collection("events").where("hostId", "in", demoUids).get(),
    db.collection("groups").where("ownerId", "in", demoUids).get(),
  ]);
  for (const d of evSnap.docs) if (!DEMO_EVENTS.includes(d.id)) await db.recursiveDelete(d.ref).catch(() => {});
  for (const d of grpSnap.docs) if (d.id !== DEMO_GROUP) await db.recursiveDelete(d.ref).catch(() => {});
  for (const id of DEMO_EVENTS) for (const sub of ["comments", "photos", "polls", "songs"]) {
    const snap = await db.collection("events/" + id + "/" + sub).get();
    for (const d of snap.docs) if (!(id === "demo-evt-3" && sub === "comments" && d.get("seed"))) await d.ref.delete().catch(() => {});
  }
  for (const sub of ["comments", "polls"]) { const snap = await db.collection("groups/" + DEMO_GROUP + "/" + sub).get(); for (const d of snap.docs) await d.ref.delete().catch(() => {}); }
  const seedWall = db.collection("events/demo-evt-3/comments");
  if ((await seedWall.where("seed", "==", true).limit(1).get()).empty) {
    await seedWall.add({ seed: true, authorId: DEMO_CASEY, authorName: "Casey", text: "This place is so much bigger than the old one 😍", createdAt: Date.now() - 3600000 });
    await seedWall.add({ seed: true, authorId: DEMO_UID, authorName: "Riley", text: "Right?! Still finding boxes I forgot about", createdAt: Date.now() - 3500000 });
  }
  for (const col of ["expenses", "settlements"]) {
    const snap = await db.collection(col).where("involved", "array-contains-any", demoUids).get();
    for (const d of snap.docs) if (d.id !== DEMO_EXPENSE) await db.recursiveDelete(d.ref).catch(() => {});
  }
  const act = await db.collection("activity").where("uids", "array-contains-any", demoUids).get();
  for (const d of act.docs) await d.ref.delete().catch(() => {});
  // Friendships and private conversations visitors made between the demo people.
  for (const col of ["friendships", "dms"]) {
    const snap = await db.collection(col).where("uids", "array-contains-any", demoUids).get();
    for (const d of snap.docs) await db.recursiveDelete(d.ref).catch(() => {});
  }
}
// Cheap brake on the public token endpoint: a few instances, a per-instance
// per-minute budget, and one token per IP per 10 seconds.
const demoBudget = { minute: 0, count: 0, byIp: new Map() };
exports.demoLogin = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB", maxInstances: 3 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", SITE);
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
  const now = Date.now(), minute = Math.floor(now / 60000);
  if (demoBudget.minute !== minute) { demoBudget.minute = minute; demoBudget.count = 0; demoBudget.byIp.clear(); }
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  if (++demoBudget.count > 60 || (demoBudget.byIp.get(ip) || 0) > now - 10000) { res.status(429).json({ error: "Slow down" }); return; }
  demoBudget.byIp.set(ip, now);
  try {
    await getAuth().getUser(DEMO_UID).catch(() => seedDemoData());
    const token = await getAuth().createCustomToken(DEMO_UID);
    res.json({ token });
  } catch (e) { logger.error("demoLogin", e); res.status(500).json({ error: "Server error" }); }
});
exports.resetDemoData = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB", secrets: [MAINT_KEY] }, async (req, res) => {
  if (!MAINT_KEY.value() || String(req.query.key || "") !== MAINT_KEY.value()) { res.status(403).send("forbidden"); return; }
  try { await seedDemoData(); res.json({ ok: true }); } catch (e) { logger.error("resetDemoData", e); res.status(500).json({ error: String(e.message || e) }); }
});
exports.resetDemoDataNightly = onSchedule({ schedule: "17 4 * * *", timeZone: "America/Chicago" }, async () => {
  await seedDemoData(); logger.info("Demo sandbox reset");
});

// Someone nudged the guests who haven't answered.
exports.onNudge = onDocumentCreated({ document: "nudges/{id}", ...PUSH }, async e => {
  const n = e.data && e.data.data(); if (!n) return;
  // A reminder about one person's share of an expense, from whoever paid or added it; at most one per 12 hours.
  if (n.expenseId) {
    const x = (await db.doc("expenses/" + n.expenseId).get()).data(); if (!x || !n.to) return;
    if (n.by !== x.paidBy && n.by !== x.addedBy) return;
    if (!(x.split || []).includes(n.to) || n.to === x.paidBy || String(n.to).startsWith("ph:")) return;
    const key = "x_" + n.expenseId + "_" + n.to, logRef = db.doc("nudgeLog/" + key), last = (await logRef.get()).get("at") || 0;
    if (Date.now() - last < 12 * 3600e3) { await e.data.ref.update({ sent: 0, at: Date.now(), skipped: "too soon" }); return; }
    const share = x.shares ? (x.shares[n.to] || 0) : Math.round(x.amountCents / ((x.split || []).length || 1));
    const nm = await names([n.by, x.paidBy]);
    await notify([n.to], firstName(nm[n.by]) + " sent a reminder: " + (x.desc || "an expense"), `Your share is ${dollars(share)} · pay ${firstName(nm[x.paidBy])} from the expense or the Money tab.`, "/#/x/" + n.expenseId + "?who=" + encodeURIComponent(n.to), { type: "money", actorId: n.by });
    await logRef.set({ at: Date.now() }); await e.data.ref.update({ sent: 1, at: Date.now() });
    return;
  }
  if (!n.eventId) return;
  const evSnap = await db.doc("events/" + n.eventId).get(); const ev = evSnap.data(); if (!ev) return;
  if (n.by !== ev.hostId && !(ev.cohostUids || []).includes(n.by)) return;
  const targets = (ev.invitedUids || []).filter(u => u !== ev.hostId && !(ev.rsvps || {})[u]);
  const nm = await names([n.by]);
  await notify(targets, firstName(nm[n.by]) + " is waiting on your RSVP", (ev.emoji || "📅") + " " + ev.title, "/#/e/" + n.eventId + "?to=rsvpCard", { type: "nudge", actorId: n.by });
  await e.data.ref.update({ sent: targets.length, at: Date.now() });
});

// New party-wall comment -> tell the other guests.

exports.onComment = onDocumentCreated({ document: "events/{id}/comments/{cid}", ...PUSH }, async e => {
  const c = e.data && e.data.data(); if (!c) return;
  const ev = (await db.doc("events/" + e.params.id).get()).data(); if (!ev) return;
  await notify((ev.invitedUids || []).filter(u => u !== c.authorId),
    firstName(c.authorName) + " on " + ev.title, commentPreview(c),
    "/#/e/" + e.params.id + "?to=wall&c=" + e.params.cid, { type: "comment", actorId: c.authorId });
  await mentionNotify(c, "/#/e/" + e.params.id + "?to=wall&c=" + e.params.cid, ev.title);
});

// Group chat message -> tell the other members.
exports.onGroupComment = onDocumentCreated({ document: "groups/{gid}/comments/{cid}", ...PUSH }, async e => {
  const c = e.data && e.data.data(); if (!c) return;
  const g = (await db.doc("groups/" + e.params.gid).get()).data(); if (!g) return;
  await notify((g.memberUids || []).filter(u => u !== c.authorId),
    firstName(c.authorName) + " in " + g.name, commentPreview(c),
    "/#/g/" + e.params.gid + "?to=wall&c=" + e.params.cid, { type: "comment", actorId: c.authorId });
  await mentionNotify(c, "/#/g/" + e.params.gid + "?to=wall&c=" + e.params.cid, g.name);
});

// Expense discussion -> tell the people involved.
// A new expense tells everyone on it what they owe (or, for the payer, what's owed to them). The person who
// added it already knows. Guests keyed by phone have no account to reach.
const dollars = c => "$" + (Math.round(c || 0) / 100).toFixed(2);
exports.onExpenseAdded = onDocumentCreated({ document: "expenses/{xid}", ...PUSH }, async e => {
  const x = e.data && e.data.data(); if (!x || !x.amountCents) return;
  const people = [...new Set((x.involved || []).filter(u => typeof u === "string" && u && !u.startsWith("ph:")))];
  const adder = x.addedBy || "", adderSnap = adder ? await db.doc("users/" + adder).get() : null; const adderName = firstName(adderSnap && adderSnap.get("name")) || "Someone";
  const payerSnap = x.paidBy && x.paidBy !== adder ? await db.doc("users/" + x.paidBy).get().catch(() => null) : null;
  const payerName = x.paidBy === adder ? adderName : (payerSnap && payerSnap.exists ? firstName(payerSnap.get("name")) : (x.guestNames || {})[x.paidBy] || "someone");
  const split = (x.split || []).filter(Boolean), even = split.length ? Math.floor(x.amountCents / split.length) : 0;
  const shareOf = u => x.shares ? (x.shares[u] || 0) : (split.includes(u) ? even : 0);
  const url = "/#/x/" + e.params.xid, desc = x.desc || "an expense";
  for (const u of people) {
    if (u === adder) continue;
    const share = shareOf(u);
    let body;
    if (u === x.paidBy) { const owed = x.amountCents - share; body = `You paid ${dollars(x.amountCents)}; ${owed > 0 ? dollars(owed) + " is owed back to you" : "nothing is owed back"}.`; }
    else if (share > 0) body = `Your share is ${dollars(share)} · ${payerName} paid.`;
    else continue;
    await notify([u], `${adderName} added ${desc}`, body, url + "?who=" + encodeURIComponent(u), { type: "money", actorId: adder });
  }
});
// Pick your items: tell people when they're added to a shared receipt, and tell the creator once everyone else
// has tapped I'm done. Picks themselves don't notify (they'd buzz on every tap).
exports.onReceiptSplit = onDocumentWritten({ document: "receiptSplits/{sid}", ...PUSH }, async e => {
  const after = e.data && e.data.after && e.data.after.exists ? e.data.after.data() : null; if (!after || after.status !== "open") return;
  const before = e.data.before && e.data.before.exists ? e.data.before.data() : null;
  const creator = after.createdBy, url = "/#/pick/" + e.params.sid, desc = after.desc || after.merchant || "a receipt";
  const total = (after.items || []).reduce((n, it) => n + (it.cents || 0), 0) + (after.tax || 0) + (after.fees || 0) + (after.tip || 0);
  const had = new Set((before && before.uids) || []), added = (after.uids || []).filter(u => u !== creator && !had.has(u));
  const others = (after.uids || []).filter(u => u !== creator);
  const allDone = d => others.length > 0 && others.every(u => !!((d && d.done) || {})[u]);
  const finishedNow = allDone(after) && !allDone(before);
  if (!added.length && !finishedNow) return;
  const name = firstName((await db.doc("users/" + creator).get()).get("name"));
  if (added.length) await notify(added, `${name} wants you to pick your items`, `${desc} · ${dollars(total)}. Tap what you had; everyone's picks show up live.`, url, { type: "money", actorId: creator });
  if (finishedNow) await notify([creator], "Everyone picked their items", `${desc}: hand out anything left, then tap Finish.`, url, { type: "money" });
});
exports.onExpenseComment = onDocumentCreated({ document: "expenses/{xid}/comments/{cid}", ...PUSH }, async e => {
  const c = e.data && e.data.data(); if (!c) return;
  const x = (await db.doc("expenses/" + e.params.xid).get()).data(); if (!x) return;
  await notify((x.involved || []).filter(u => u !== c.authorId),
    firstName(c.authorName) + " on " + (x.desc || "an expense"), commentPreview(c),
    "/#/x/" + e.params.xid + "?to=wall&c=" + e.params.cid, { type: "comment", actorId: c.authorId });
  await mentionNotify(c, "/#/x/" + e.params.xid + "?to=wall&c=" + e.params.cid, x.desc || "an expense");
});

// Content reported -> tell the moderators (we promise a 24-hour review).
// Keep in sync with adminUids in firebase-config.js and isAdmin() in the rules.
const ADMIN_UIDS = ["zzJY7MHFnyN2kAqq13hv79rZTVF2", "TUngQGsAKTRtHBpVEpZwFFHE0sP2"];
exports.onReport = onDocumentCreated({ document: "reports/{id}", ...PUSH }, async e => {
  const r = e.data && e.data.data(); if (!r) return;
  // Child safety reports jump the queue: an urgent title so they're handled first (see child-safety.html).
  const urgent = /child safety/i.test(r.reason || "");
  await notify(ADMIN_UIDS, urgent ? "URGENT child safety report" : "Content reported: " + (r.reason || "review needed"), String(r.snippet || r.kind || "").slice(0, 120), "/#/profile?to=reportsCard");
});

// Bug report (shake or Profile › Report a bug) -> push the admins.
exports.onBug = onDocumentCreated({ document: "bugs/{id}", ...PUSH }, async e => {
  const b = e.data && e.data.data(); if (!b || b.diag) return;   // app diagnostics: no push
  await notify(ADMIN_UIDS, "🐞 Bug report from " + firstName(b.name), String(b.text || "").slice(0, 120), "/#/profile?to=bugsCard", { type: "bug" });
});
// A phone invite for someone who is already a member/guest (the host typed or
// picked a number the picker couldn't recognize) is redundant: drop it so no
// permanent "Hasn't joined yet" row lingers. Server-side because only the Admin
// SDK can look a phone number up across all profiles.
async function dropRedundantPhoneInvites(ref, before, after, memberUids) {
  const fresh = (after.invitedPhones || []).filter(p => !(before.invitedPhones || []).includes(p));
  if (!fresh.length) return;
  const drop = [];
  for (const p of fresh) {
    // Every account with this number counts (a stray or duplicate sign-up with the same number can sit first).
    const q = await db.collection("users").where("phoneE164", "==", p).get();
    if (q.docs.some(d => memberUids.includes(d.id))) drop.push(p);
  }
  if (!drop.length) return;
  const up = { invitedPhones: FieldValue.arrayRemove(...drop) };
  drop.forEach(p => { up["invitedPhoneNames." + p] = FieldValue.delete(); });
  await ref.update(up).catch(err => logger.warn("dropRedundantPhoneInvites: " + err.message));
}
// Someone texted an event invite joins Friendly (or adds their phone) later: turn every
// "not on Friendly yet" phone invite into a real invite for their account, exactly like
// tapping the link would (joinViaLink): carry a host-marked RSVP along, and clear the
// phone row. Without this they stay a phone number on the event until they open the
// link, so group pages (which need every member invited) and guest lists miss them.
const phoneKeyOf = e164 => require("crypto").createHash("sha256").update("friendly:" + e164).digest().subarray(0, 12).toString("hex");
async function claimPhoneInvites(uid, phone, name) {
  let n = 0;
  const evs = await db.collection("events").where("invitedPhones", "array-contains", phone).get();
  for (const d of evs.docs) {
    const ev = d.data();
    const up = { invitedPhones: FieldValue.arrayRemove(phone), ["invitedPhoneNames." + phone]: FieldValue.delete(), ["phoneRsvps." + phone]: FieldValue.delete() };
    if (!(ev.invitedUids || []).includes(uid)) {
      up.invitedUids = FieldValue.arrayUnion(uid);
      up["names." + uid] = name || (ev.invitedPhoneNames || {})[phone] || "Friend";
      up["phoneKeys." + uid] = phoneKeyOf(phone);
      const pre = (ev.phoneRsvps || {})[phone];
      if (pre && pre.status && !(ev.rsvps || {})[uid]) { up["rsvps." + uid] = pre.status; up["rsvpSetBy." + uid] = { by: pre.by || ev.hostId, at: pre.at || Date.now() }; }
      if (pre && Number(pre.plus) > 0 && !(ev.plusOnes || {})[uid]) up["plusOnes." + uid] = Number(pre.plus);
    }
    await d.ref.update(up).then(() => n++).catch(err => logger.warn("claimPhoneInvites " + d.id + ": " + err.message));
  }
  // Friend requests sent to this number before they joined: now a real request they can accept.
  const frs = await db.collection("friendRequests").where("phone", "==", phone).where("status", "==", "notOnFriendly").get();
  for (const r of frs.docs) { await makeFriendRequest(r.get("from"), uid, r.get("fromName"), name).catch(() => {}); await r.ref.update({ status: "sent", toUid: uid }).catch(() => {}); }
  // Groups: a pending phone invite for someone who is already a member is stale. (A real
  // pending group invite stays, so they still get to accept or decline it.)
  const gs = await db.collection("groups").where("invitedPhones", "array-contains", phone).get();
  for (const g of gs.docs) if ((g.data().memberUids || []).includes(uid))
    await g.ref.update({ invitedPhones: FieldValue.arrayRemove(phone), ["invitedPhoneNames." + phone]: FieldValue.delete() }).catch(() => {});
  return n;
}
// Pay handles ride on each expense (`pay.{uid}`), so the people on it can settle up even when they share no
// group with the person they owe (an event guest who paid, say). Groups carry a copy too, but that one is
// written once at join time; this one is refreshed from the profile whenever it changes.
const PAY_KEYS = ["venmo", "zelle", "cashapp", "payPref", "phone", "os"];   // os ("ios"/"android", set by the app) decides who gets an Apple Cash button
const payOf = u => { const o = {}; for (const k of PAY_KEYS) o[k] = String((u && u[k]) || ""); return o; };
const samePay = (x, y) => PAY_KEYS.every(k => String((x && x[k]) || "") === String((y && y[k]) || ""));
exports.onExpensePay = onDocumentWritten({ document: "expenses/{id}" }, async e => {
  const after = e.data.after.exists ? e.data.after.data() : null; if (!after) return;
  const uids = [...new Set((after.involved || []).filter(u => typeof u === "string" && u && !u.startsWith("demo-") && !u.startsWith("ph:")))]; if (!uids.length) return;
  const have = after.pay || {}; const missing = uids.filter(u => !have[u]); if (!missing.length) return;   // a profile change comes through onUserPhone
  const snaps = await db.getAll(...missing.map(u => db.doc("users/" + u)));
  const up = {}; snaps.forEach((s, i) => { up["pay." + missing[i]] = payOf(s.exists ? s.data() : null); });
  await e.data.after.ref.update(up).catch(err => logger.warn("onExpensePay " + err.message));
});
// A payback recorded from the Money tab (no expense named) is applied to that pair's unpaid expenses, oldest
// first, so each expense's Paid marks agree with the balances. Removing a payback takes its marks back.
exports.onSettlementWritten = onDocumentWritten({ document: "settlements/{id}", ...PUSH }, async e => {
  const before = e.data.before.exists ? e.data.before.data() : null, after = e.data.after.exists ? e.data.after.data() : null;
  const s = after || before; if (!s || !s.from || !s.to) return;
  if (before && after) { await notifyPayReactions(e.params.id, before, after).catch(err => logger.warn("payment reactions: " + err.message)); return; }
  if (after) await notifyPayment(e.params.id, after).catch(err => logger.warn("payment alert: " + err.message));
  if (s.expenseId) {
    const ref = db.doc("expenses/" + s.expenseId), x = (await ref.get()).data(); if (!x) return;
    const mark = (x.paid || {})[s.from];
    if (after && !mark) await ref.update({ ["paid." + s.from]: { at: s.createdAt || Date.now(), by: s.addedBy || s.from, sid: e.params.id } });
    if (!after && mark && mark.sid === e.params.id) await ref.update({ ["paid." + s.from]: FieldValue.delete() });
    return;
  }
  await allocatePaybacks(s.from, s.to);
});
// "Jordan paid you $24.10": the person paid hears about it, or the payer does when the person paid marked it.
// The alert carries the payment id (sid) so Activity can show reactions on it.
const PAY_APPS = ["Venmo", "Zelle", "Cash App", "Apple Cash", "Apple Pay", "PayPal"];
const isRealUid = u => typeof u === "string" && u && !u.startsWith("ph:");
async function payNames(s) {
  const [f, t, x] = await Promise.all([db.doc("users/" + s.from).get(), db.doc("users/" + s.to).get(), s.expenseId ? db.doc("expenses/" + s.expenseId).get() : null]);
  return { from: firstName(f.exists && f.get("name")), to: firstName(t.exists && t.get("name")), what: (x && x.exists && x.get("desc")) || "" };
}
async function notifyPayment(sid, s) {
  const recorder = s.addedBy || s.from, target = recorder === s.to ? s.from : s.to;
  if (!isRealUid(target) || target === recorder) return;
  const n = await payNames(s), amt = dollars(s.amountCents);
  const how = PAY_APPS.includes(s.note) ? "with " + s.note : "";
  const what = n.what || (!how && s.note) || "";
  const title = target === s.to ? `${n.from} paid you ${amt}` : `${n.to} marked your ${amt} as paid`;
  const body = [what, how].filter(Boolean).join(" · ") + (target === s.to ? (what || how ? ". " : "") + "Send a thank-you reaction." : "");
  await notify([target], title, body || "Settled up.", `/#/money?pay=${sid}`, { type: "money", actorId: recorder, sid });
}
// A reaction on a payment goes to the other side of it: "Wes reacted 🙏 to your $24.10 payment".
const RX_NAMED = { heart: "❤️", laugh: "😂", fire: "🔥", up: "👍", wow: "😮" };
const rxEmoji = k => RX_NAMED[k] || (/^e[0-9a-f_]+$/.test(k) ? k.slice(1).split("_").map(h => String.fromCodePoint(parseInt(h, 16))).join("") : "");
async function notifyPayReactions(sid, before, after) {
  const was = before.reactions || {}, now = after.reactions || {}, added = [];
  for (const [k, us] of Object.entries(now)) if (Array.isArray(us) && rxEmoji(k)) for (const u of us) if (!(was[k] || []).includes(u)) added.push([u, rxEmoji(k)]);
  if (!added.length) return;
  const n = await payNames(after), amt = dollars(after.amountCents);
  for (const [u, emoji] of added) {
    if (u !== after.from && u !== after.to) continue;
    const other = u === after.to ? after.from : after.to; if (!isRealUid(other)) continue;
    const who = u === after.to ? n.to : n.from;
    await notify([other], `${who} reacted ${emoji} to ${other === after.from ? "your" : "the"} ${amt} payment`, n.what || "Tap to see it on Money.", `/#/money?pay=${sid}`, { type: "money", actorId: u, sid });
  }
}
async function allocatePaybacks(from, to) {
  if (!from || !to || from === to) return 0;
  const [xs, ss] = await Promise.all([db.collection("expenses").where("involved", "array-contains", from).get(), db.collection("settlements").where("involved", "array-contains", from).get()]);
  const pool = ss.docs.filter(d => d.get("from") === from && d.get("to") === to && !d.get("expenseId"));
  let left = pool.reduce((n, d) => n + (d.get("amountCents") || 0), 0); const sids = pool.map(d => d.id).sort(), sid = sids[0] || "";
  const owed = xs.docs.filter(d => d.get("paidBy") === to && (d.get("split") || []).includes(from)).sort((a, b) => (a.get("createdAt") || 0) - (b.get("createdAt") || 0));
  let changed = 0;
  for (const d of owed) {
    const x = d.data(), share = x.shares ? (x.shares[from] || 0) : Math.round((x.amountCents || 0) / ((x.split || []).length || 1)), mark = (x.paid || {})[from];
    if (mark && !mark.auto) continue;   // marked by hand or by a payback that named this expense
    if (share > 0 && left >= share) { left -= share; if (!mark || (mark.sids || []).join() !== sids.join()) { await d.ref.update({ ["paid." + from]: { at: (mark && mark.at) || Date.now(), by: from, sid, sids, auto: true } }); changed++; } }
    else if (mark) { await d.ref.update({ ["paid." + from]: FieldValue.delete() }); changed++; }
  }
  return changed;
}
// Area code → the nearest big city and its time zone, for people who never set a city. Metro-level on purpose.
const AREA_CITIES = { "212":["New York, NY","America/New_York"], "646":["New York, NY","America/New_York"], "332":["New York, NY","America/New_York"], "917":["New York, NY","America/New_York"], "718":["New York, NY","America/New_York"], "347":["New York, NY","America/New_York"], "929":["New York, NY","America/New_York"], "516":["Long Island, NY","America/New_York"], "631":["Long Island, NY","America/New_York"], "914":["White Plains, NY","America/New_York"], "716":["Buffalo, NY","America/New_York"], "585":["Rochester, NY","America/New_York"], "315":["Syracuse, NY","America/New_York"], "680":["Syracuse, NY","America/New_York"], "518":["Albany, NY","America/New_York"], "838":["Albany, NY","America/New_York"], "201":["Jersey City, NJ","America/New_York"], "551":["Jersey City, NJ","America/New_York"], "973":["Newark, NJ","America/New_York"], "862":["Newark, NJ","America/New_York"], "732":["New Brunswick, NJ","America/New_York"], "848":["New Brunswick, NJ","America/New_York"], "908":["Elizabeth, NJ","America/New_York"], "609":["Trenton, NJ","America/New_York"], "640":["Trenton, NJ","America/New_York"], "856":["Cherry Hill, NJ","America/New_York"], "215":["Philadelphia, PA","America/New_York"], "267":["Philadelphia, PA","America/New_York"], "445":["Philadelphia, PA","America/New_York"], "412":["Pittsburgh, PA","America/New_York"], "878":["Pittsburgh, PA","America/New_York"], "717":["Harrisburg, PA","America/New_York"], "570":["Scranton, PA","America/New_York"], "272":["Scranton, PA","America/New_York"], "617":["Boston, MA","America/New_York"], "857":["Boston, MA","America/New_York"], "781":["Boston, MA","America/New_York"], "339":["Boston, MA","America/New_York"], "508":["Worcester, MA","America/New_York"], "774":["Worcester, MA","America/New_York"], "978":["Lowell, MA","America/New_York"], "351":["Lowell, MA","America/New_York"], "413":["Springfield, MA","America/New_York"], "203":["New Haven, CT","America/New_York"], "475":["New Haven, CT","America/New_York"], "860":["Hartford, CT","America/New_York"], "959":["Hartford, CT","America/New_York"], "401":["Providence, RI","America/New_York"], "603":["Manchester, NH","America/New_York"], "802":["Burlington, VT","America/New_York"], "207":["Portland, ME","America/New_York"], "202":["Washington, DC","America/New_York"], "703":["Arlington, VA","America/New_York"], "571":["Arlington, VA","America/New_York"], "301":["Bethesda, MD","America/New_York"], "240":["Bethesda, MD","America/New_York"], "410":["Baltimore, MD","America/New_York"], "443":["Baltimore, MD","America/New_York"], "667":["Baltimore, MD","America/New_York"], "302":["Wilmington, DE","America/New_York"], "757":["Virginia Beach, VA","America/New_York"], "804":["Richmond, VA","America/New_York"], "540":["Roanoke, VA","America/New_York"], "434":["Charlottesville, VA","America/New_York"], "304":["Charleston, WV","America/New_York"], "681":["Charleston, WV","America/New_York"], "704":["Charlotte, NC","America/New_York"], "980":["Charlotte, NC","America/New_York"], "919":["Raleigh, NC","America/New_York"], "984":["Raleigh, NC","America/New_York"], "336":["Greensboro, NC","America/New_York"], "743":["Greensboro, NC","America/New_York"], "910":["Wilmington, NC","America/New_York"], "828":["Asheville, NC","America/New_York"], "252":["Greenville, NC","America/New_York"], "803":["Columbia, SC","America/New_York"], "839":["Columbia, SC","America/New_York"], "843":["Charleston, SC","America/New_York"], "854":["Charleston, SC","America/New_York"], "864":["Greenville, SC","America/New_York"], "404":["Atlanta, GA","America/New_York"], "470":["Atlanta, GA","America/New_York"], "678":["Atlanta, GA","America/New_York"], "770":["Atlanta, GA","America/New_York"], "943":["Atlanta, GA","America/New_York"], "912":["Savannah, GA","America/New_York"], "478":["Macon, GA","America/New_York"], "305":["Miami, FL","America/New_York"], "786":["Miami, FL","America/New_York"], "954":["Fort Lauderdale, FL","America/New_York"], "754":["Fort Lauderdale, FL","America/New_York"], "561":["West Palm Beach, FL","America/New_York"], "407":["Orlando, FL","America/New_York"], "321":["Orlando, FL","America/New_York"], "689":["Orlando, FL","America/New_York"], "813":["Tampa, FL","America/New_York"], "656":["Tampa, FL","America/New_York"], "727":["St. Petersburg, FL","America/New_York"], "904":["Jacksonville, FL","America/New_York"], "850":["Tallahassee, FL","America/New_York"], "352":["Gainesville, FL","America/New_York"], "239":["Fort Myers, FL","America/New_York"], "941":["Sarasota, FL","America/New_York"], "772":["Port St. Lucie, FL","America/New_York"], "863":["Lakeland, FL","America/New_York"], "386":["Daytona Beach, FL","America/New_York"], "205":["Birmingham, AL","America/Chicago"], "659":["Birmingham, AL","America/Chicago"], "251":["Mobile, AL","America/Chicago"], "334":["Montgomery, AL","America/Chicago"], "256":["Huntsville, AL","America/Chicago"], "938":["Huntsville, AL","America/Chicago"], "615":["Nashville, TN","America/Chicago"], "629":["Nashville, TN","America/Chicago"], "901":["Memphis, TN","America/Chicago"], "865":["Knoxville, TN","America/New_York"], "423":["Chattanooga, TN","America/New_York"], "502":["Louisville, KY","America/New_York"], "859":["Lexington, KY","America/New_York"], "270":["Bowling Green, KY","America/Chicago"], "364":["Bowling Green, KY","America/Chicago"], "504":["New Orleans, LA","America/Chicago"], "225":["Baton Rouge, LA","America/Chicago"], "318":["Shreveport, LA","America/Chicago"], "337":["Lafayette, LA","America/Chicago"], "601":["Jackson, MS","America/Chicago"], "769":["Jackson, MS","America/Chicago"], "228":["Gulfport, MS","America/Chicago"], "501":["Little Rock, AR","America/Chicago"], "479":["Fayetteville, AR","America/Chicago"], "614":["Columbus, OH","America/New_York"], "380":["Columbus, OH","America/New_York"], "216":["Cleveland, OH","America/New_York"], "440":["Cleveland, OH","America/New_York"], "513":["Cincinnati, OH","America/New_York"], "283":["Cincinnati, OH","America/New_York"], "937":["Dayton, OH","America/New_York"], "326":["Dayton, OH","America/New_York"], "419":["Toledo, OH","America/New_York"], "567":["Toledo, OH","America/New_York"], "330":["Akron, OH","America/New_York"], "234":["Akron, OH","America/New_York"], "313":["Detroit, MI","America/New_York"], "248":["Detroit, MI","America/New_York"], "947":["Detroit, MI","America/New_York"], "586":["Detroit, MI","America/New_York"], "734":["Ann Arbor, MI","America/New_York"], "616":["Grand Rapids, MI","America/New_York"], "517":["Lansing, MI","America/New_York"], "269":["Kalamazoo, MI","America/New_York"], "810":["Flint, MI","America/New_York"], "989":["Saginaw, MI","America/New_York"], "231":["Traverse City, MI","America/New_York"], "317":["Indianapolis, IN","America/Indiana/Indianapolis"], "463":["Indianapolis, IN","America/Indiana/Indianapolis"], "219":["Gary, IN","America/Chicago"], "574":["South Bend, IN","America/Indiana/Indianapolis"], "260":["Fort Wayne, IN","America/Indiana/Indianapolis"], "812":["Evansville, IN","America/Chicago"], "930":["Evansville, IN","America/Chicago"], "765":["Lafayette, IN","America/Indiana/Indianapolis"], "312":["Chicago, IL","America/Chicago"], "773":["Chicago, IL","America/Chicago"], "872":["Chicago, IL","America/Chicago"], "708":["Chicago, IL","America/Chicago"], "847":["Chicago, IL","America/Chicago"], "224":["Chicago, IL","America/Chicago"], "630":["Chicago, IL","America/Chicago"], "331":["Chicago, IL","America/Chicago"], "464":["Chicago, IL","America/Chicago"], "815":["Rockford, IL","America/Chicago"], "779":["Rockford, IL","America/Chicago"], "309":["Peoria, IL","America/Chicago"], "217":["Springfield, IL","America/Chicago"], "447":["Springfield, IL","America/Chicago"], "414":["Milwaukee, WI","America/Chicago"], "262":["Milwaukee, WI","America/Chicago"], "608":["Madison, WI","America/Chicago"], "920":["Green Bay, WI","America/Chicago"], "612":["Minneapolis, MN","America/Chicago"], "763":["Minneapolis, MN","America/Chicago"], "952":["Minneapolis, MN","America/Chicago"], "651":["St. Paul, MN","America/Chicago"], "218":["Duluth, MN","America/Chicago"], "320":["St. Cloud, MN","America/Chicago"], "507":["Rochester, MN","America/Chicago"], "515":["Des Moines, IA","America/Chicago"], "319":["Cedar Rapids, IA","America/Chicago"], "563":["Davenport, IA","America/Chicago"], "712":["Sioux City, IA","America/Chicago"], "314":["St. Louis, MO","America/Chicago"], "557":["St. Louis, MO","America/Chicago"], "636":["St. Louis, MO","America/Chicago"], "816":["Kansas City, MO","America/Chicago"], "975":["Kansas City, MO","America/Chicago"], "417":["Springfield, MO","America/Chicago"], "573":["Columbia, MO","America/Chicago"], "913":["Overland Park, KS","America/Chicago"], "316":["Wichita, KS","America/Chicago"], "785":["Topeka, KS","America/Chicago"], "402":["Omaha, NE","America/Chicago"], "531":["Omaha, NE","America/Chicago"], "605":["Sioux Falls, SD","America/Chicago"], "701":["Fargo, ND","America/Chicago"], "405":["Oklahoma City, OK","America/Chicago"], "572":["Oklahoma City, OK","America/Chicago"], "918":["Tulsa, OK","America/Chicago"], "539":["Tulsa, OK","America/Chicago"], "214":["Dallas, TX","America/Chicago"], "469":["Dallas, TX","America/Chicago"], "972":["Dallas, TX","America/Chicago"], "945":["Dallas, TX","America/Chicago"], "817":["Fort Worth, TX","America/Chicago"], "682":["Fort Worth, TX","America/Chicago"], "713":["Houston, TX","America/Chicago"], "281":["Houston, TX","America/Chicago"], "832":["Houston, TX","America/Chicago"], "346":["Houston, TX","America/Chicago"], "512":["Austin, TX","America/Chicago"], "737":["Austin, TX","America/Chicago"], "210":["San Antonio, TX","America/Chicago"], "726":["San Antonio, TX","America/Chicago"], "915":["El Paso, TX","America/Denver"], "806":["Lubbock, TX","America/Chicago"], "325":["Abilene, TX","America/Chicago"], "432":["Midland, TX","America/Chicago"], "361":["Corpus Christi, TX","America/Chicago"], "956":["McAllen, TX","America/Chicago"], "903":["Tyler, TX","America/Chicago"], "430":["Tyler, TX","America/Chicago"], "936":["Conroe, TX","America/Chicago"], "940":["Denton, TX","America/Chicago"], "254":["Waco, TX","America/Chicago"], "830":["New Braunfels, TX","America/Chicago"], "409":["Beaumont, TX","America/Chicago"], "979":["College Station, TX","America/Chicago"], "505":["Albuquerque, NM","America/Denver"], "575":["Las Cruces, NM","America/Denver"], "303":["Denver, CO","America/Denver"], "720":["Denver, CO","America/Denver"], "983":["Denver, CO","America/Denver"], "719":["Colorado Springs, CO","America/Denver"], "970":["Fort Collins, CO","America/Denver"], "801":["Salt Lake City, UT","America/Denver"], "385":["Salt Lake City, UT","America/Denver"], "435":["St. George, UT","America/Denver"], "602":["Phoenix, AZ","America/Phoenix"], "480":["Phoenix, AZ","America/Phoenix"], "623":["Phoenix, AZ","America/Phoenix"], "520":["Tucson, AZ","America/Phoenix"], "928":["Flagstaff, AZ","America/Phoenix"], "702":["Las Vegas, NV","America/Los_Angeles"], "725":["Las Vegas, NV","America/Los_Angeles"], "775":["Reno, NV","America/Los_Angeles"], "208":["Boise, ID","America/Boise"], "986":["Boise, ID","America/Boise"], "406":["Billings, MT","America/Denver"], "307":["Cheyenne, WY","America/Denver"], "206":["Seattle, WA","America/Los_Angeles"], "425":["Bellevue, WA","America/Los_Angeles"], "253":["Tacoma, WA","America/Los_Angeles"], "509":["Spokane, WA","America/Los_Angeles"], "503":["Portland, OR","America/Los_Angeles"], "971":["Portland, OR","America/Los_Angeles"], "541":["Eugene, OR","America/Los_Angeles"], "458":["Eugene, OR","America/Los_Angeles"], "213":["Los Angeles, CA","America/Los_Angeles"], "323":["Los Angeles, CA","America/Los_Angeles"], "310":["Los Angeles, CA","America/Los_Angeles"], "424":["Los Angeles, CA","America/Los_Angeles"], "818":["Los Angeles, CA","America/Los_Angeles"], "747":["Los Angeles, CA","America/Los_Angeles"], "626":["Pasadena, CA","America/Los_Angeles"], "562":["Long Beach, CA","America/Los_Angeles"], "714":["Anaheim, CA","America/Los_Angeles"], "657":["Anaheim, CA","America/Los_Angeles"], "949":["Irvine, CA","America/Los_Angeles"], "909":["San Bernardino, CA","America/Los_Angeles"], "951":["Riverside, CA","America/Los_Angeles"], "619":["San Diego, CA","America/Los_Angeles"], "858":["San Diego, CA","America/Los_Angeles"], "415":["San Francisco, CA","America/Los_Angeles"], "628":["San Francisco, CA","America/Los_Angeles"], "510":["Oakland, CA","America/Los_Angeles"], "341":["Oakland, CA","America/Los_Angeles"], "925":["Walnut Creek, CA","America/Los_Angeles"], "650":["San Mateo, CA","America/Los_Angeles"], "408":["San Jose, CA","America/Los_Angeles"], "669":["San Jose, CA","America/Los_Angeles"], "831":["Santa Cruz, CA","America/Los_Angeles"], "916":["Sacramento, CA","America/Los_Angeles"], "279":["Sacramento, CA","America/Los_Angeles"], "559":["Fresno, CA","America/Los_Angeles"], "661":["Bakersfield, CA","America/Los_Angeles"], "805":["Santa Barbara, CA","America/Los_Angeles"], "820":["Santa Barbara, CA","America/Los_Angeles"], "707":["Santa Rosa, CA","America/Los_Angeles"], "209":["Stockton, CA","America/Los_Angeles"], "808":["Honolulu, HI","Pacific/Honolulu"], "907":["Anchorage, AK","America/Anchorage"] };
exports.onUserPhone = onDocumentWritten({ document: "users/{uid}" }, async e => {
  const before = e.data.before.exists ? e.data.before.data() : {}, after = e.data.after.exists ? e.data.after.data() : null;
  if (!after) return;
  if (!samePay(before, after)) {
    const q = await db.collection("expenses").where("involved", "array-contains", e.params.uid).get();
    const pay = payOf(after); let n = 0;
    for (let i = 0; i < q.docs.length; i += 400) { const b = db.batch(); q.docs.slice(i, i + 400).forEach(d => { if (!samePay((d.get("pay") || {})[e.params.uid], pay)) { b.update(d.ref, { ["pay." + e.params.uid]: pay }); n++; } }); await b.commit(); }
    if (n) logger.info(`onUserPhone: refreshed pay handles on ${n} expense(s) for ${e.params.uid}`);
  }
  // No city yet: guess one from the phone's area code so Curate has somewhere to look. The app shows it as a guess
  // with a way to change it; picking a real city clears cityGuess.
  if (after.phoneE164 && !String(after.city || "").trim() && !after.cityGuess) {
    const g = AREA_CITIES[String(after.phoneE164).replace(/^\+1/, "").slice(0, 3)];
    if (g && /^\+1\d{10}$/.test(after.phoneE164)) {
      const [city, tz] = g, miles = CURATE_MILES.includes(after.curateMiles) ? after.curateMiles : DEFAULT_MILES, key = cityKeyOf(city) + (miles === DEFAULT_MILES ? "" : "--" + miles + "mi");
      await Promise.all([e.data.after.ref.update({ city, cityGuess: true }), db.doc("curateCities/" + key).set({ key, city, miles, tz, updatedAt: Date.now() }, { merge: true })]).catch(err => logger.warn("city guess: " + err.message));
      logger.info(`onUserPhone: guessed ${city} for ${e.params.uid} from the area code`);
    }
  }
  if (!after.phoneE164 || after.phoneE164 === before.phoneE164) return;
  const n = await claimPhoneInvites(e.params.uid, after.phoneE164, after.name);
  if (n) logger.info(`onUserPhone: linked ${n} texted event invite(s) to ${e.params.uid}`);
  const m = await claimGuestMoney(e.params.uid, after.phoneE164);
  if (m) logger.info(`onUserPhone: ${m} expense/payment record(s) moved from phone guest to ${e.params.uid}`);
});
// Expenses and paybacks that named this person by phone ("ph:+1…") before they joined now carry their uid.
async function claimGuestMoney(uid, phoneE164) {
  const gid = "ph:" + phoneE164; let n = 0;
  const swap = v => v === gid ? uid : v;
  const rekey = o => { if (!o || typeof o !== "object") return o; const r = {}; for (const [k, v] of Object.entries(o)) r[swap(k)] = v; return r; };
  for (const col of ["expenses", "settlements"]) {
    const q = await db.collection(col).where("involved", "array-contains", gid).get();
    for (const d of q.docs) {
      const x = d.data(); const up = { involved: [...new Set((x.involved || []).map(swap))] };
      if (x.split) up.split = [...new Set(x.split.map(swap))];
      if (x.paidBy) up.paidBy = swap(x.paidBy); if (x.from) up.from = swap(x.from); if (x.to) up.to = swap(x.to);
      if (x.shares) up.shares = rekey(x.shares);
      if (Array.isArray(x.items)) up.items = x.items.map(it => ({ ...it, uids: [...new Set((it.uids || []).map(swap))] }));
      if (x.guestNames && x.guestNames[gid]) { up.guestNames = { ...x.guestNames }; delete up.guestNames[gid]; }
      if (x.pay !== undefined) up["pay." + uid] = payOf((await db.doc("users/" + uid).get()).data());
      await d.ref.update(up); n++;
    }
  }
  return n;
}
// ---------- Friends & private messages ----------
// friendships/{a_b} (uids sorted) = a request (status "pending", requestedBy) or a friendship
// ("accepted"). dms/{a_b} is the conversation (written here from each message) and
// dms/{a_b}/messages the messages. Only accepted friends can message (firestore.rules).
const pairId = (a, b) => [a, b].sort().join("_");
async function makeFriendRequest(from, to, fromName, toName) {
  if (!from || !to || from === to) return "self";
  const [fu, tu] = await db.getAll(db.doc("users/" + from), db.doc("users/" + to));
  if (!tu.exists) return "missing";
  if ((tu.get("blockedUids") || []).includes(from) || (fu.get("blockedUids") || []).includes(to)) return "blocked";
  const ref = db.doc("friendships/" + pairId(from, to)); const cur = await ref.get();
  const people = { [from]: { name: fromName || fu.get("name") || "Friend", photo: fu.get("photoSm") || fu.get("photo") || "" }, [to]: { name: toName || tu.get("name") || "Friend", photo: tu.get("photoSm") || tu.get("photo") || "" } };
  if (cur.exists) {
    const d = cur.data();
    if (d.status === "accepted") return "already";
    if (d.requestedBy === to) { await ref.update({ status: "accepted", acceptedAt: Date.now() }); return "accepted"; }   // they'd asked too
    return "pending";
  }
  await ref.set({ uids: [from, to].sort(), requestedBy: from, status: "pending", people, createdAt: Date.now() });
  return "sent";
}
// Someone typed or picked a phone number: find the account behind it (only the server can look
// numbers up). Not on Friendly yet: the request waits and becomes real when they join.
exports.onFriendRequest = onDocumentCreated({ document: "friendRequests/{id}" }, async e => {
  const r = e.data && e.data.data(); if (!r || !r.from || !r.phone) return;
  const q = await db.collection("users").where("phoneE164", "==", r.phone).limit(1).get();
  if (q.empty) { await e.data.ref.update({ status: "notOnFriendly" }); return; }
  const res = await makeFriendRequest(r.from, q.docs[0].id, r.fromName, "");
  await e.data.ref.update({ status: res, toUid: q.docs[0].id });
});
exports.onFriendship = onDocumentWritten({ document: "friendships/{fid}", ...PUSH }, async e => {
  const before = e.data.before.exists ? e.data.before.data() : null, after = e.data.after.exists ? e.data.after.data() : null;
  if (!after) return;
  const by = after.requestedBy, other = (after.uids || []).find(u => u !== by);
  const nm = u => firstName(((after.people || {})[u] || {}).name || "Someone");
  if (!before && after.status === "pending")
    await notify([other], nm(by) + " wants to be friends on Friendly", "Accept to message each other.", "/#/friends?to=reqCard&who=" + encodeURIComponent(by), { type: "friend", actorId: by });
  else if (after.status === "accepted" && (!before || before.status !== "accepted") && after.via !== "group")
    await notify([by], nm(other) + " accepted your friend request", "Say hi! 👋", "/#/m/" + e.params.fid, { type: "friend", actorId: other });
});
exports.onDmMessage = onDocumentCreated({ document: "dms/{fid}/messages/{mid}", ...PUSH }, async e => {
  const m = e.data && e.data.data(); if (!m) return;
  const uids = e.params.fid.split("_"); const other = uids.find(u => u !== m.authorId);
  if (!other || !uids.includes(m.authorId)) return;
  const preview = dmPreview(m);
  await db.doc("dms/" + e.params.fid).set({ uids, lastText: preview, lastAt: m.createdAt || Date.now(), lastBy: m.authorId, readAt: { [m.authorId]: m.createdAt || Date.now() }, typing: { [m.authorId]: 0 } }, { merge: true });
  // "Hide alerts" on this conversation: no push (it still shows as unread in the app).
  const them = await db.doc("users/" + other).get();
  if ((them.get("mutedDms") || []).includes(e.params.fid)) return;
  await notify([other], m.authorName || "New message", preview + (m.effect ? " (sent with " + m.effect + ")" : ""), "/#/m/" + e.params.fid + "?c=" + e.params.mid, { type: "dm", actorId: m.authorId, skipActivity: true });
});
const dmPreview = m => m.text ? String(m.text).slice(0, 140) : m.photo ? "📷 Photo" : m.gif ? "GIF" : m.audio ? "🎤 Voice message" : "New message";
// Unsent (deleted) message: the inbox shows whatever is now the latest one.
exports.onDmMessageDeleted = onDocumentDeleted({ document: "dms/{fid}/messages/{mid}" }, async e => {
  const ref = db.doc("dms/" + e.params.fid); const t = await ref.get(); if (!t.exists) return;
  const gone = e.data && e.data.data(); if (gone && t.get("lastAt") && gone.createdAt < t.get("lastAt")) return;   // not the latest one
  const q = await ref.collection("messages").orderBy("createdAt", "desc").limit(1).get();
  if (q.empty) await ref.update({ lastText: "", lastAt: 0, lastBy: "" });
  else { const m = q.docs[0].data(); await ref.update({ lastText: dmPreview(m), lastAt: m.createdAt, lastBy: m.authorId }); }
});

// People who share a group are friends automatically (so they can message each other). Runs
// only for members who just joined, so removing a friend you share a group with sticks, and
// never between people where either one blocked the other.
async function groupFriends(g, newcomers) {
  const members = [...new Set(g.memberUids || [])]; if (members.length < 2 || !newcomers.length) return 0;
  const people = u => ({ name: ((g.members || {})[u] || {}).name || "Friend", photo: ((g.members || {})[u] || {}).photo || "" });
  const snaps = await db.getAll(...members.map(u => db.doc("users/" + u)));
  const blocked = {}; snaps.forEach(sn => { blocked[sn.id] = new Set((sn.exists && sn.get("blockedUids")) || []); });
  let n = 0; const done = new Set();
  for (const a of newcomers) for (const b of members) {
    if (a === b) continue;
    const id = pairId(a, b); if (done.has(id)) continue; done.add(id);
    if ((blocked[a] || new Set()).has(b) || (blocked[b] || new Set()).has(a)) continue;
    const ref = db.doc("friendships/" + id);
    await db.runTransaction(async tx => {
      const cur = await tx.get(ref);
      if (!cur.exists) { tx.set(ref, { uids: [a, b].sort(), requestedBy: a, status: "accepted", via: "group", people: { [a]: people(a), [b]: people(b) }, createdAt: Date.now(), acceptedAt: Date.now() }); n++; }
      else if (cur.get("status") === "pending") { tx.update(ref, { status: "accepted", acceptedAt: Date.now(), via: "group" }); n++; }
    }).catch(err => logger.warn("groupFriends " + id + ": " + err.message));
  }
  return n;
}
exports.onGroupCreated = onDocumentCreated({ document: "groups/{gid}" }, async e => {
  const g = e.data && e.data.data(); if (!g) return;
  await groupFriends(g, g.memberUids || []);
});
exports.onGroupUpdated = onDocumentUpdated({ document: "groups/{gid}" }, async e => {
  const before = e.data.before.data(), after = e.data.after.data();
  await dropRedundantPhoneInvites(e.data.after.ref, before, after, after.memberUids || []);
  const joined = (after.memberUids || []).filter(u => !(before.memberUids || []).includes(u));
  if (joined.length) await groupFriends(after, joined);
  const left = (before.memberUids || []).filter(u => !(after.memberUids || []).includes(u));
  if (left.length) await ungroupFriends(e.params.gid, left, after.memberUids || []);
});
exports.onGroupDeleted = onDocumentDeleted({ document: "groups/{gid}" }, async e => {
  const g = e.data && e.data.data(); if (!g) return;
  await ungroupFriends(e.params.gid, g.memberUids || [], g.memberUids || []);
});
// The reverse of groupFriends: someone leaves (or is removed, or the group goes away) and the friendships that
// existed only because of that group go too. A friendship stays when the two still share another group, when
// either of them asked for it, or when they've messaged each other.
async function ungroupFriends(gid, leavers, others) {
  let n = 0;
  for (const a of leavers) {
    const mine = await db.collection("groups").where("memberUids", "array-contains", a).get();
    const stillWith = new Set(); mine.docs.forEach(d => { if (d.id !== gid) (d.get("memberUids") || []).forEach(u => stillWith.add(u)); });
    for (const b of others) {
      if (a === b || stillWith.has(b)) continue;
      const id = pairId(a, b), ref = db.doc("friendships/" + id), f = await ref.get();
      if (!f.exists || f.get("via") !== "group") continue;
      const dm = await db.doc("dms/" + id).get(); if (dm.exists && dm.get("lastAt")) continue;
      await ref.delete().then(() => n++).catch(() => {});
      if (dm.exists) await dm.ref.delete().catch(() => {});
    }
  }
  if (n) logger.info(`ungroupFriends: ${n} group-made friendship(s) dropped after leaving ${gid}`);
  return n;
}

// Event updated: RSVP changes tell the host (and promote waitlisters), edits
// re-send calendar invites, new guests get theirs, and the preview refreshes.
exports.onRsvp = onDocumentUpdated({ document: "events/{id}", ...MAIL }, async e => {
  const before = e.data.before.data(), after = e.data.after.data();
  const id = e.params.id;
  const b = before.rsvps || {}, a = after.rsvps || {};
  const changed = Object.keys(a).find(u => a[u] !== b[u] && u !== after.hostId);
  const sbB = before.rsvpSetBy || {}, sbA = after.rsvpSetBy || {};
  const setNow = changed && sbA[changed] && JSON.stringify(sbA[changed]) !== JSON.stringify(sbB[changed] || null) ? sbA[changed] : null;
  if (changed && setNow) {
    // A host or co-host answered for this guest: tell the guest who did it, not the host.
    const nm = await names([setNow.by]);
    const word = { going: after.kind === "meeting" ? "accepted" : "going", maybe: "maybe", no: after.kind === "meeting" ? "declined" : "can't go" }[a[changed]] || a[changed];
    await notify([changed], `${firstName(nm[setNow.by])} marked you as ${word}`, after.title + ". Tap to change it.", "/#/e/" + id + "?to=rsvpCard", { type: "rsvp", actorId: setNow.by });
  } else if (changed) {
    // The guest answered themselves: drop any old "marked by the host" note.
    if (sbA[changed]) await e.data.after.ref.update({ ["rsvpSetBy." + changed]: FieldValue.delete() }).catch(() => {});
    const nm = await names([changed]);
    const word = { going: "is going to", maybe: "might come to", no: "can't make", waitlist: "joined the waitlist for", pending: "requested to join" }[a[changed]] || "updated";
    await notify([after.hostId], firstName(nm[changed]) + " " + word, after.title, "/#/e/" + id + "?to=guestCard&who=" + encodeURIComponent(changed), { type: "rsvp", actorId: changed });
    if (a[changed] === "going" && (b[changed] === "waitlist" || b[changed] === "pending"))
      await notify([changed], "You're in! " + after.title, b[changed] === "waitlist" ? "A spot opened up and it's yours." : "The host approved you.", "/#/e/" + id + "?to=rsvpCard", { type: "rsvp" });
  }
  await dropRedundantPhoneInvites(e.data.after.ref, before, after, after.invitedUids || []);
  const added = (after.invitedUids || []).filter(u => !(before.invitedUids || []).includes(u));
  // Someone joined through a shared link (not added by the host, not a group
  // member added automatically): tell the host and co-hosts, since nothing else would.
  const linkJoins = added.filter(u => (after.joinedVia || {})[u] === "link" && u !== after.hostId);
  if (linkJoins.length) {
    const nm = await names(linkJoins);
    for (const u of linkJoins) await notify([after.hostId, ...(after.cohostUids || [])].filter(h => h !== u), firstName(nm[u]) + " joined via your link", after.title, "/#/e/" + id + "?to=guestCard&who=" + encodeURIComponent(u), { type: "rsvp", actorId: u });
  }
  // Edits to the essentials -> bump the sequence once and re-send invites.
  const essentials = ["title", "date", "time", "endTime", "location", "notes"];
  if (essentials.some(k => (before[k] || "") !== (after[k] || "")) || stopsText(before) !== stopsText(after)) {
    const seq = Number(after.sequence || 0) + 1;
    await e.data.after.ref.update({ sequence: seq });
    await sendInviteEmails(id, { ...after, sequence: seq }, "REQUEST");
  } else if (added.length) await sendInviteEmails(id, after, "REQUEST", added);
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
    await notify(going, "Today: " + ev.title, (ev.time ? "Starts " + ev.time + ". " : "") + (ev.location || "See you there!"), "/#/e/" + doc.id + "?to=dayCard", { type: "reminder" });
  }
  logger.info("Sent reminders for " + snap.size + " events");

  // Birthdays: a month out, tell the rest of each group so someone can plan.
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 30);
  const mmdd = String(target.getMonth() + 1).padStart(2, "0") + "-" + String(target.getDate()).padStart(2, "0");
  const groups = await db.collection("groups").get(); let bdays = 0;
  for (const g of groups.docs) {
    const data = g.data(); const members = data.members || {};
    for (const [uid, info] of Object.entries(members)) {
      if (!info.birthday || !String(info.birthday).endsWith(mmdd)) continue;
      const others = (data.memberUids || []).filter(u => u !== uid); if (!others.length) continue;
      await notify(others, firstName(info.name || "A friend") + "'s birthday is a month away 🎂", "Plan something for " + (data.name || "the group") + " before the date fills up.", "/#/g/" + g.id + "?to=bdayCard", { type: "birthday", actorId: uid }); bdays++;
    }
  }
  if (bdays) logger.info("Birthday heads-ups sent: " + bdays);

  // Repeating events: once an occurrence has passed, create the next one
  // (copies everything, resets RSVPs) and retire the old one from the series.
  const rep = await db.collection("events").where("repeat", "in", ["weekly", "biweekly", "monthly", "custom"]).where("date", "<", today).get();
  for (const doc of rep.docs) {
    const ev = doc.data(); let next = ev.date; let guard = 0;
    while (next < today && guard++ < 400) next = addPeriod(next, ev);
    // Past the series' last date: the series simply ends.
    if (/^\d{4}-\d{2}-\d{2}$/.test(ev.repeatUntil || "") && next > ev.repeatUntil) { await doc.ref.update({ repeat: "" }); continue; }
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
    await notify([from], "You still owe " + firstName(nm[to]) + " $" + (net / 100).toFixed(2), "Settle up from the Money tab.", "/#/money?to=settleCard&pair=" + encodeURIComponent(from + "|" + to), { type: "money" });
    await db.doc("nudgeLog/" + key).set({ at: Date.now() }); nudged++;
  }
  if (nudged) logger.info("Money reminders sent: " + nudged);
});
