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
function apnsSend(tokens, title, body, url) {
  const auth = apnsAuth(); if (!auth || !tokens.length) return Promise.resolve([]);
  const http2 = require("http2");
  return new Promise(resolve => {
    const dead = []; let left = tokens.length;
    const client = http2.connect("https://api.push.apple.com");
    client.on("error", err => { logger.warn("apns connect: " + err.message); resolve(dead); });
    const payload = JSON.stringify({ aps: { alert: { title, body }, sound: "default", "mutable-content": 0 }, url });
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
      req.end(payload);
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

// ---- "Let me plan it": planRequests/{id} holds what the user said (typed or dictated);
//      we write back a structured event draft the app pours into the composer.
//      The user always reviews it before anything is created or sent.
const PLAN_MODEL = "gemini-2.5-flash";
const THEME_IDS = ["confetti", "citrus", "bubblegum", "sunset", "golden", "blossom", "garden", "aurora", "midnight", "cosmic", "rave", "disco", "y2k", "retro"];
const str = { type: "STRING" };
const clean = (arr, n, len) => (Array.isArray(arr) ? arr : []).slice(0, n).map(x => String(x || "").replace(/[\r\n;]+/g, " ").slice(0, len)).filter(Boolean);
const sv = (v, n) => String(v || "").trim().slice(0, n);
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
const DOT = "You are Dot, the helper inside Friendly, an app friends use to plan get-togethers and split costs. Only include what the user actually said; never invent people, places or facts.";

// mode "event": what the user said -> an event draft, plus a few concrete ideas that would make the invite better organised.
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
- summary: one warm sentence in Dot's voice, starting "Here's what I heard:", restating the plan in plain words. No emoji.
- ideas: 2 to 4 concrete, specific suggestions that would make THIS invite clearer or better organised, each as something the app can add with one tap. Think like a good host: an RSVP question the guests would need answering (dietary needs, plus-ones, who's driving), an item people always forget for this kind of plan (ice, cups, a speaker, sunscreen), an end time so people can plan around it, a head count if space is tight, a note about parking, what to wear or where to meet. Never suggest something the user already covered. Each idea: "label" is the chip text starting with a verb ("Ask about dietary needs", "Add ice to the bring list", "End it at 10 PM"); "kind" is one of question, bring, note, endTime, capacity; "value" is exactly what to add (the question text, the item, the note sentence, HH:MM, or a number).
Friends: ${people.join("; ") || "(none)"}.
Groups: ${groups.join("; ") || "(none)"}.

What the user said:
${text}`;
  const schema = { type: "OBJECT", required: ["title", "kind", "summary"], properties: {
    kind: { type: "STRING", enum: ["event", "meeting"] }, title: str, emoji: str, theme: { type: "STRING", enum: THEME_IDS },
    date: str, time: str, endTime: str, location: str, food: str, notes: str, capacity: { type: "INTEGER" },
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
    emoji: sv(out.emoji, 8).replace(/[A-Za-z0-9\s]/g, "").slice(0, 4),
    theme: THEME_IDS.includes(out.theme) ? out.theme : "",
    date: /^\d{4}-\d{2}-\d{2}$/.test(out.date || "") ? out.date : "",
    time: /^\d{2}:\d{2}$/.test(out.time || "") ? out.time : "",
    endTime: /^\d{2}:\d{2}$/.test(out.endTime || "") ? out.endTime : "",
    location: sv(out.location, 200), food: sv(out.food, 120), notes: sv(out.notes, 1000),
    capacity: Math.max(0, Math.min(500, parseInt(out.capacity, 10) || 0)),
    guests: clean(out.guests, 30, 60), group: sv(out.group, 60),
    bring: (Array.isArray(out.bring) ? out.bring : []).slice(0, 12).map(b => ({ item: sv(b && b.item, 60), qty: sv(b && b.qty, 20) })).filter(b => b.item),
    questions: clean(out.questions, 5, 120),
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
const TAGS = ["weekend", "tonight", "date", "group", "cheap", "family"];
async function askGrounded(prompt, maxTokens = 6000, onPhase) {
  const token = (await (await gauth.getClient()).getAccessToken()).token;
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${PLAN_MODEL}:generateContent`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ googleSearch: {} }], generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } } };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 200000);
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
const clip = (v, n) => { const t = String(v || "").trim().replace(/\s+/g, " "); if (t.length <= n) return t; const cut = t.slice(0, n - 1); const sp = cut.lastIndexOf(" "); return (sp > n * .6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, "") + "…"; };
function cleanNight(n) {
  const stops = (Array.isArray(n.stops) ? n.stops : []).slice(0, 5).map(x => ({ time: sv(x && x.time, 10), name: sv(x && x.name, 80), note: clip(x && x.note, 170), kind: ["eat", "do", "go"].includes(x && x.kind) ? x.kind : "do", url: isUrl(x && x.url) ? sv(x.url, 300) : "" })).filter(x => x.name);
  return {
    title: sv(n.title, 80), date: /^\d{4}-\d{2}-\d{2}$/.test(n.date || "") ? n.date : "", start: /^\d{2}:\d{2}$/.test(n.start || "") ? n.start : "",
    tags: clean(n.tags, 6, 10).filter(t => TAGS.includes(t)), stops,
    cost: clip(n.cost, 50), size: clip(n.size, 40), parking: clip(n.parking, 120), why: clip(n.why, 260), ticketUrl: isUrl(n.ticketUrl) ? sv(n.ticketUrl, 300) : "",
    emoji: sv(n.emoji, 8).replace(/[A-Za-z0-9\s]/g, "").slice(0, 4), emojis: sv(n.emojis, 12).replace(/[A-Za-z0-9\s]/g, "").slice(0, 8),
    scene: sv(n.scene, 140), theme: THEME_IDS.includes(n.theme) ? n.theme : "midnight",
    coverId: nodeCrypto.createHash("md5").update(sv(n.title, 80) + "|" + sv(n.date, 10)).digest("hex").slice(0, 12)
  };
}
const nightShape = `Return ONLY a JSON array, no prose: [{"title": short and specific, "date": "YYYY-MM-DD", "start": 24-hour "HH:MM" of the first stop, "tags": [any of weekend, tonight, date, group, cheap, family], "stops": [{"time": like "5:30 PM", "name": the real venue or event name, "note": one useful detail (walk time, what to order, parking), "kind": "eat" | "do" | "go", "url": the listing or booking page if you found one}], "cost": like "$45 a head all in", "size": like "Best for 2–6", "parking": one short line, "why": one sentence in Dot's voice on why this night works, "ticketUrl": the ticket page if tickets are sold, "emoji": one emoji for the night, "emojis": exactly two emojis, the thing to do then the food (like "⚾🌮"), "scene": a 10-to-16-word visual description of the night for an illustration, concrete objects and setting only, no people's faces, no text (like "a baseball game under stadium lights beside a plate of street tacos"), "theme": the one of ${THEME_IDS.join(", ")} that fits the vibe (sunset or golden for dinners, confetti for parties, garden or blossom for brunch and outdoors, midnight or cosmic for nights out and shows, disco, rave or retro for dance and costume nights, citrus or bubblegum for playful daytime plans, aurora for big arena events)}]. Only include things you actually found; never invent an event, a venue or a price. Times must make sense in sequence.`;
// Four nights per filter: one grounded search per category, run in parallel, then merged and de-duplicated.
const CURATE_KINDS = {
  weekend: from => `for the coming weekend (Friday evening through Sunday, starting ${from}); a mix of the best things on`,
  tonight: (from, today) => `for TONIGHT only (${today}), starting no earlier than an hour from now; things with tickets still available or no ticket needed`,
  date: () => `as date nights for two in the next 9 days: a good table and something to do before or after`,
  group: () => `for groups of 6 to 12 in the next 9 days: places that take big groups (bar tables, counter service, group tickets, bays or lanes)`,
  cheap: () => `under $40 a person all in, in the next 9 days: free events, cheap eats, happy hours`,
  family: () => `family-friendly with kids in the next 9 days: daytime or early evening, kid-easy food`
};
async function curateCity(d, onPhase) {
  const city = sv(d.city, 60); if (city.length < 2) throw new Error("no city");
  const today = /^\d{4}-\d{2}-\d{2}$/.test(d.today || "") ? d.today : new Date().toISOString().slice(0, 10);
  const end = new Date(today + "T12:00:00Z"); end.setUTCDate(end.getUTCDate() + 9); const endStr = end.toISOString().slice(0, 10);
  const dow = new Date(today + "T12:00:00Z").getUTCDay(); const toFri = dow <= 5 ? 5 - dow : 6;
  const fri = new Date(today + "T12:00:00Z"); if (dow !== 6 && dow !== 0) fri.setUTCDate(fri.getUTCDate() + toFri); const weekendFrom = fri.toISOString().slice(0, 10);
  let started = false;
  const one = async kind => {
    const prompt = `You are Dot, the helper in Friendly, an app friends use to plan nights out. Using search, find real, specific things happening in or near ${city} (today is ${today}, ${sv(d.weekday, 10)}; nothing after ${endStr}). Build exactly 4 different nights ${CURATE_KINDS[kind](weekendFrom, today)}. Each pairs one thing to do with one real place to eat or drink within a short walk or drive, with times that work in sequence. Make the 4 genuinely different (different neighborhoods or kinds of thing). Only things friends would actually want to go out for: skip civic and informational events (safety fairs, seminars, council meetings, workshops, expos for businesses). Include "${kind}" in every night's tags, plus any other tags that apply. Keep strings short; at most 3 stops per night; no markdown. ${nightShape}`;
    const raw = await askGrounded(prompt, 2600, started ? null : (started = true, onPhase));
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
async function buildAndCacheCity(city, tz, today, weekday, onPhase) {
  const nights = await curateCity({ city, tz, today, weekday }, onPhase);
  await db.doc("curated/" + cityKeyOf(city)).set({ city, nights, updatedAt: Date.now(), forDate: today, v: 4 });
  return nights;
}
async function buildNight(d) {
  const city = sv(d.city, 60); if (city.length < 2) throw new Error("no city");
  const today = /^\d{4}-\d{2}-\d{2}$/.test(d.today || "") ? d.today : new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(d.from || "") ? d.from : today, to = /^\d{4}-\d{2}-\d{2}$/.test(d.to || "") ? d.to : from;
  const prompt = `You are Dot, the helper in Friendly, an app friends use to plan nights out. Build 3 different nights out in or near ${city} for ${from === to ? from : from + " to " + to} (today is ${today}, ${sv(d.weekday, 10)}), using search to find real, specific events, venues, restaurants and bars.
The ask: vibe "${sv(d.vibe, 30) || "surprise me"}", for ${sv(d.who, 30) || "a few friends"}, budget ${sv(d.budget, 30) || "flexible"} per person all in.${d.free ? " Also: " + sv(d.free, 300) + "." : ""}
Make the three genuinely different from each other (different neighborhoods or kinds of thing). Each pairs one thing to do with one real place to eat or drink nearby, with times that work in sequence. Respect the budget and the group size (bar tables and counter service for big groups, a reservation for a date). ${nightShape}`;
  const raw = await askGrounded(prompt, 3000, d.onPhase);
  const nights = raw.map(cleanNight).filter(n => n.title && n.date && n.stops.length).slice(0, 3);
  if (!nights.length) throw new Error("nothing found");
  return nights;
}
// Each night gets a small painted cover made from its own scene (the ballgame and the tacos, not a stock palette).
// Runs after curated/{city} changes; covers are keyed by title+date so unchanged nights keep theirs across rebuilds.
exports.onCuratedWritten = onDocumentWritten({ document: "curated/{cityKey}", region: "us-central1", timeoutSeconds: 540, memory: "1GiB" }, async e => {
  const after = e.data && e.data.after && e.data.after.exists ? e.data.after.data() : null; if (!after) return;
  const nights = (after.nights || []).filter(n => n.coverId);
  const col = e.data.after.ref.collection("covers");
  const have = new Set((await col.get()).docs.map(d => d.id));
  const todo = nights.filter(n => !have.has(n.coverId)).slice(0, 30);
  const shrink = async dataUrl => { const b64 = String(dataUrl).split(",")[1]; const out = await sharp(Buffer.from(b64, "base64")).resize({ width: 720, withoutEnlargement: true }).jpeg({ quality: 74 }).toBuffer(); return "data:image/jpeg;base64," + out.toString("base64"); };
  const paint = async n => {
    const prompt = (n.scene || n.title) + ", " + (n.title || "") + ", warm evening light";
    let image = null;
    try { image = (await geminiGenerate(prompt)).image; } catch (err) { logger.warn("cover via vertex failed: " + err.message); try { image = await pollinationsGenerate(prompt); } catch (e2) { logger.warn("cover fallback failed: " + e2.message); } }
    if (image) { try { image = await shrink(image); } catch (e3) {} await col.doc(n.coverId).set({ image, title: n.title, createdAt: Date.now() }); have.add(n.coverId); }
  };
  const publish = async () => { const ids = nights.map(n => n.coverId).filter(id => have.has(id)).sort(); const prev = (after.coverIds || []).slice().sort(); if (ids.join() !== prev.join()) await e.data.after.ref.update({ coverIds: ids }); };
  await publish();
  for (let i = 0; i < todo.length; i += 3) { await Promise.all(todo.slice(i, i + 3).map(paint)); await publish(); }
  // drop covers no night uses any more
  const keep = new Set(nights.map(n => n.coverId));
  await Promise.all([...have].filter(id => !keep.has(id)).map(id => col.doc(id).delete().catch(() => {})));
});
exports.curateCover = onRequest({ region: "us-central1", invoker: "public", memory: "256MiB" }, async (req, res) => {
  const c = String(req.query.c || "").replace(/[^a-z0-9-]/g, "").slice(0, 60), id = String(req.query.id || "").replace(/[^a-f0-9]/g, "").slice(0, 12);
  if (!c || !id) { res.status(400).end(); return; }
  const snap = await db.doc(`curated/${c}/covers/${id}`).get();
  const img = snap.exists ? String(snap.data().image || "") : ""; const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(img);
  if (!m) { res.set("Cache-Control", "public, max-age=60").status(404).end(); return; }
  res.set("Content-Type", m[1]).set("Cache-Control", "public, max-age=2592000, immutable").send(Buffer.from(m[2], "base64"));
});
exports.curateNightly = onSchedule({ schedule: "30 3 * * *", timeZone: "America/Chicago", timeoutSeconds: 540, memory: "512MiB" }, async () => {
  const cities = await db.collection("curateCities").get();
  const cutoff = Date.now() - 45 * 864e5;
  for (const doc of cities.docs) {
    const c = doc.data(); if (!c.city || (c.updatedAt || 0) < cutoff) continue;
    try {
      const tz = c.tz || "America/Chicago";
      const now = new Date(); const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      const today = fmt.format(now); const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
      await buildAndCacheCity(c.city, tz, today, weekday);
    } catch (err) { logger.warn("curate failed for " + c.city + ": " + err.message); }
  }
});

exports.onPlanRequest = onDocumentCreated({ document: "planRequests/{id}", region: "us-central1", timeoutSeconds: 300, memory: "512MiB" }, async e => {
  const d = e.data && e.data.data(); if (!d) return;
  if (!d.text && d.mode !== "curate-city" && d.mode !== "night") return;   // the curate modes carry no text
  const ref = e.data.ref;
  try {
    const data = d.mode === "expense" ? await draftExpense(d) : d.mode === "edit" ? await draftEdit(d) : d.mode === "ask" ? await answerQuestion(d)
      : d.mode === "curate-city" ? { nights: await buildAndCacheCity(sv(d.city, 60), sv(d.tz, 40), d.today, d.weekday, phase => ref.update({ phase }).catch(() => {})) }
      : d.mode === "night" ? { nights: await buildNight({ ...d, onPhase: phase => ref.update({ phase }).catch(() => {}) }) }
      : await draftPlan(d);
    await ref.update({ status: "done", data });
  }
  catch (err) { logger.error("plan draft failed (" + (d.mode || "event") + "): " + err.message); await ref.update({ status: "error", error: (d.mode === "curate-city" || d.mode === "night") ? err.message.slice(0, 120) : "couldn't work that out" }); }
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
    "DESCRIPTION:" + icsEsc((ev.notes ? ev.notes + "\n\n" : "") + "RSVP and details in Friendly: " + FN_BASE + "/share/p/" + id),
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
function mobileGateHtml({ title, desc, target, openUrl, extraHead = "" }) {
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
  <a class="btn primary" href="${openUrl || target}">Open in Friendly</a>
  <a class="btn secondary" href="${APP_STORE_URL}">Get the Friendly app</a>
</body></html>`;
}

// Phone-based sign-in fell back to us: the account predates phone sign-in, so
// it's still keyed by its real email in Firebase Auth. We look the account up
// by phone, verify the password server-side via Identity Toolkit (the client
// never learns the real email), and hand back a one-time custom token.
const WEB_API_KEY = "AIzaSyA_lgyYmCL6HnoFPn4Ux89bD6iI_fazkmA";
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

// Which notifCategory toggle (profile > Notifications) a push type falls under.
// Types with no entry here (money reminders, admin content reports) always send --
// only the four categories the person can actually see and turn off are gated.
const NOTIF_CATEGORY = { event: "invites", meeting: "invites", rsvp: "invites", nudge: "reminders", reminder: "reminders", mention: "chat", comment: "chat", birthday: "birthdays" };
// Every device for a set of users (native FCM tokens + web push subscriptions):
// send, prune anything dead, and log the item to the Activity feed so it shows
// in-app even for people who keep notifications (or this category) off.
async function notify(uids, title, body, url = "/", extra = {}) {
  const ids = [...new Set(uids)].filter(Boolean);
  if (!ids.length) return;
  await db.collection("activity").add({ uids: ids, title, body, url, type: extra.type || "", actorId: extra.actorId || "", createdAt: Date.now() })
    .catch(err => logger.warn("activity: " + err.message));
  const category = NOTIF_CATEGORY[extra.type];
  const snaps = await db.getAll(...ids.map(id => db.doc("users/" + id)));
  const tokenOwner = {}, tokens = [], apns = [], subs = [];
  snaps.forEach(s => {
    if (category && s.get(`notifPrefs.${category}`) === false) return;
    (s.get("pushTokens") || []).forEach(t => { (isApnsToken(t) ? apns : tokens).push(t); tokenOwner[t] = s.id; });
    (s.get("webPush") || []).forEach(sub => subs.push({ sub, uid: s.id }));
  });
  const jobs = [];
  if (apns.length) jobs.push(apnsSend(apns, title, body, url).then(async dead => {
    const byUser = {}; dead.forEach(t => { (byUser[tokenOwner[t]] = byUser[tokenOwner[t]] || []).push(t); });
    await Promise.all(Object.entries(byUser).map(([uid, ts]) => db.doc("users/" + uid).update({ pushTokens: FieldValue.arrayRemove(...ts) }).catch(() => {})));
  }));
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

// A phone invite for someone who is already a member/guest (the host typed or
// picked a number the picker couldn't recognize) is redundant: drop it so no
// permanent "Hasn't joined yet" row lingers. Server-side because only the Admin
// SDK can look a phone number up across all profiles.
async function dropRedundantPhoneInvites(ref, before, after, memberUids) {
  const fresh = (after.invitedPhones || []).filter(p => !(before.invitedPhones || []).includes(p));
  if (!fresh.length) return;
  const drop = [];
  for (const p of fresh) {
    const q = await db.collection("users").where("phoneE164", "==", p).limit(1).get();
    if (!q.empty && memberUids.includes(q.docs[0].id)) drop.push(p);
  }
  if (!drop.length) return;
  const up = { invitedPhones: FieldValue.arrayRemove(...drop) };
  drop.forEach(p => { up["invitedPhoneNames." + p] = FieldValue.delete(); });
  await ref.update(up).catch(err => logger.warn("dropRedundantPhoneInvites: " + err.message));
}
exports.onGroupUpdated = onDocumentUpdated({ document: "groups/{gid}" }, async e => {
  const before = e.data.before.data(), after = e.data.after.data();
  await dropRedundantPhoneInvites(e.data.after.ref, before, after, after.memberUids || []);
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
  await dropRedundantPhoneInvites(e.data.after.ref, before, after, after.invitedUids || []);
  const added = (after.invitedUids || []).filter(u => !(before.invitedUids || []).includes(u));
  // Someone joined through a shared link (not added by the host, not a group
  // member added automatically): tell the host and co-hosts, since nothing else would.
  const linkJoins = added.filter(u => (after.joinedVia || {})[u] === "link" && u !== after.hostId);
  if (linkJoins.length) {
    const nm = await names(linkJoins);
    for (const u of linkJoins) await notify([after.hostId, ...(after.cohostUids || [])].filter(h => h !== u), firstName(nm[u]) + " joined via your link", after.title, "/#/e/" + id, { type: "rsvp", actorId: u });
  }
  // Edits to the essentials -> bump the sequence once and re-send invites.
  const essentials = ["title", "date", "time", "endTime", "location", "notes"];
  if (essentials.some(k => (before[k] || "") !== (after[k] || ""))) {
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
    await notify(going, "Today: " + ev.title, (ev.time ? "Starts " + ev.time + ". " : "") + (ev.location || "See you there!"), "/#/e/" + doc.id, { type: "reminder" });
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
      await notify(others, firstName(info.name || "A friend") + "'s birthday is a month away 🎂", "Plan something for " + (data.name || "the group") + " before the date fills up.", "/#/g/" + g.id, { type: "birthday", actorId: uid }); bdays++;
    }
  }
  if (bdays) logger.info("Birthday heads-ups sent: " + bdays);

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
