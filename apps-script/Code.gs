/**
 * Friendly - Google Sheets backend (Google Apps Script).
 *
 * SETUP (once, ~3 minutes):
 *  1. Create a new Google Sheet (sheets.new). Name it anything, e.g. "Friendly DB".
 *  2. Extensions → Apps Script. Delete the starter code, paste this whole file, save.
 *  3. Deploy → New deployment → type "Web app".
 *       - Execute as: Me
 *       - Who has access: Anyone
 *     Authorize when asked (it needs Sheets + Mail access for invite emails).
 *  4. Copy the Web app URL (ends in /exec) into config.js in the website repo.
 *
 * The script creates its own sheet tabs (members, events, expenses, settlements)
 * with header rows on first use. Rows are plain text; arrays/objects are JSON.
 *
 * To update the script later: paste the new code, then Deploy → Manage
 * deployments → edit → New version. The URL stays the same.
 */

var SEND_EMAIL_INVITES = true; // set false to turn off invite emails
var SITE_URL = "https://officialfriendly.com";

var TABLES = {
  members: {
    cols: ["id", "name", "email", "createdAt", "venmo", "phone", "pinHash"],
    json: [], num: ["createdAt"]
  },
  events: {
    cols: ["id", "title", "date", "time", "location", "notes", "createdBy",
           "invitees", "rsvps", "cancelled", "createdAt"],
    json: ["invitees", "rsvps"], num: ["createdAt"]
  },
  expenses: {
    cols: ["id", "desc", "amountCents", "paidBy", "split", "eventId",
           "addedBy", "createdAt"],
    json: ["split"], num: ["amountCents", "createdAt"]
  },
  settlements: {
    cols: ["id", "from", "to", "amountCents", "note", "addedBy", "createdAt"],
    json: [], num: ["amountCents", "createdAt"]
  },
  pushsubs: {
    cols: ["id", "memberId", "endpoint", "createdAt"],
    json: [], num: ["createdAt"], internal: true
  }
};

function doGet(e) {
  ensureSheets();
  var action = e && e.parameter && e.parameter.action;
  if (action === "latest") {
    return jsonOut({ ok: true, msg: PropertiesService.getScriptProperties().getProperty("LATEST_MSG") || "" });
  }
  if (action === "vapidtest") {
    // Fixed audience: verifiable by the site author, useless to anyone else.
    return jsonOut({ ok: true, jwt: vapidJwt("https://vapid.test"), pub: VAPID_PUBLIC_KEY });
  }
  return jsonOut({ ok: true, data: readAll() });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var result, notify = null;
  try {
    ensureSheets();
    var req = JSON.parse(e.postData.contents);
    if (req.action === "subscribe") {
      subscribePush(req.memberId, req.endpoint);
    } else if (req.action === "unsubscribe") {
      unsubscribePush(req.endpoint);
    } else if (!TABLES[req.table] || TABLES[req.table].internal) {
      throw new Error("Unknown table: " + req.table);
    } else if (req.action === "upsert") {
      var isNew = upsertRow(req.table, req.row);
      if (isNew && req.table === "events") notify = function () { notifyEvent(req.row); };
      if (isNew && req.table === "expenses") notify = function () { notifyExpense(req.row); };
      if (isNew && req.table === "settlements") notify = function () { notifySettlement(req.row); };
    } else if (req.action === "delete") {
      deleteRow(req.table, req.id);
    } else if (req.action === "rsvp") {
      rsvpMerge(req.eventId, req.memberId, req.status);
      notify = function () { notifyRsvp(req.eventId, req.memberId, req.status); };
    } else {
      throw new Error("Unknown action: " + req.action);
    }
    result = { ok: true, data: readAll() };
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  } finally {
    lock.releaseLock();
  }
  // Notifications go out after the lock is released so writers aren't blocked.
  if (notify) { try { notify(); } catch (e2) { console.error("notify: " + e2); } }
  return jsonOut(result);
}

// ---------- sheet plumbing ----------

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ensureSheets() {
  var ss = SpreadsheetApp.getActive();
  for (var name in TABLES) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      // Plain-text format everywhere so dates/times/ids stay exactly as written.
      sh.getRange(1, 1, sh.getMaxRows(), TABLES[name].cols.length).setNumberFormat("@");
      sh.getRange(1, 1, 1, TABLES[name].cols.length).setValues([TABLES[name].cols])
        .setFontWeight("bold");
      sh.setFrozenRows(1);
    }
    // Keep the header row in sync when an update appends new columns
    // (new columns are only ever added at the end, so old rows stay valid).
    var want = TABLES[name].cols;
    var have = sh.getRange(1, 1, 1, want.length).getValues()[0].map(String);
    if (have.join("|") !== want.join("|")) {
      sh.getRange(1, 1, sh.getMaxRows(), want.length).setNumberFormat("@");
      sh.getRange(1, 1, 1, want.length).setValues([want]).setFontWeight("bold");
    }
  }
}

function readAll() {
  var out = {};
  for (var name in TABLES) { if (!TABLES[name].internal) out[name] = readTable(name); }
  return out;
}

function readTable(name) {
  var t = TABLES[name];
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, t.cols.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (!v[0]) continue; // skip blank rows
    var row = {};
    for (var c = 0; c < t.cols.length; c++) {
      var col = t.cols[c], raw = v[c];
      if (t.json.indexOf(col) !== -1) {
        try { row[col] = raw ? JSON.parse(raw) : null; } catch (e) { row[col] = null; }
      } else if (t.num.indexOf(col) !== -1) {
        row[col] = Number(raw) || 0;
      } else if (col === "cancelled") {
        row[col] = raw === true || String(raw).toUpperCase() === "TRUE";
      } else {
        row[col] = String(raw);
      }
    }
    rows.push(row);
  }
  return rows;
}

function serialize(name, row) {
  var t = TABLES[name];
  return t.cols.map(function (col) {
    var val = row[col];
    if (t.json.indexOf(col) !== -1) return JSON.stringify(val == null ? null : val);
    if (val === undefined || val === null) return "";
    return String(val);
  });
}

function findRowIndex(name, id) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // 1-based sheet row
  }
  return -1;
}

function upsertRow(name, row) {
  if (!row || !row.id) throw new Error("Row needs an id");
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  var t = TABLES[name];
  var idx = findRowIndex(name, row.id);
  var isNew = idx === -1;
  var values = serialize(name, row);
  if (isNew) {
    sh.appendRow(values);
  } else {
    sh.getRange(idx, 1, 1, t.cols.length).setValues([values]);
  }
  if (isNew && name === "events") sendInvites(row);
  return isNew;
}

// Merge one member's RSVP into the event row instead of rewriting the whole
// row, so two friends answering at the same time can't clobber each other.
function rsvpMerge(eventId, memberId, status) {
  var idx = findRowIndex("events", eventId);
  if (idx === -1) throw new Error("Event not found");
  var sh = SpreadsheetApp.getActive().getSheetByName("events");
  var col = TABLES.events.cols.indexOf("rsvps") + 1;
  var rsvps;
  try { rsvps = JSON.parse(sh.getRange(idx, col).getValue()) || {}; }
  catch (e) { rsvps = {}; }
  rsvps[memberId] = status;
  sh.getRange(idx, col).setValue(JSON.stringify(rsvps));
}

function deleteRow(name, id) {
  var idx = findRowIndex(name, id);
  if (idx !== -1) SpreadsheetApp.getActive().getSheetByName(name).deleteRow(idx);
}

// ---------- invite emails ----------
// Emails are sent through the account that owns this script (Google doesn't
// allow sending as someone else's address), but each invite is dressed as the
// event's organizer: their name in the From line, replies go to their email,
// and the attached calendar invite (.ics) lists them as ORGANIZER so the
// event shows the real host when added to a calendar.

function sendInvites(ev) {
  if (!SEND_EMAIL_INVITES) return;
  try {
    var members = {};
    readTable("members").forEach(function (m) { members[m.id] = m; });
    var host = members[ev.createdBy] || { name: "A friend", email: "" };
    var hostFirst = host.name.split(" ")[0];
    var hostHasEmail = !!(host.email && host.email.indexOf("@") !== -1);
    var when = ev.date + (ev.time ? " at " + ev.time : "");
    var ics = buildIcs(ev, host, members);
    (ev.invitees || []).forEach(function (id) {
      if (id === ev.createdBy) return;
      var m = members[id];
      if (!m || !m.email || m.email.indexOf("@") === -1) return;
      var opts = {
        to: m.email,
        subject: hostFirst + " invited you: " + ev.title,
        body:
          "Hi " + m.name.split(" ")[0] + ",\n\n" +
          host.name + " invited you to \"" + ev.title + "\".\n\n" +
          "When: " + when + "\n" +
          (ev.location ? "Where: " + ev.location + "\n" : "") +
          (ev.notes ? "Notes: " + ev.notes + "\n" : "") +
          "\nThe attached invite adds it to your calendar." +
          "\nRSVP here: " + SITE_URL + "\n\n" +
          "Sent by Friendly on behalf of " + host.name,
        name: host.name + " via Friendly",
        attachments: [Utilities.newBlob(ics, "text/calendar", "invite.ics")]
      };
      if (hostHasEmail) opts.replyTo = host.email;
      MailApp.sendEmail(opts);
    });
  } catch (err) {
    // Email is best-effort; never fail the event creation over it.
    console.error("Invite email failed: " + err);
  }
}

function icsEscape(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
}

function buildIcs(ev, host, members) {
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var parts = ev.date.split("-").map(Number);
  var lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Friendly//" + SITE_URL.replace("https://", "") + "//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:" + ev.id + "@officialfriendly.com",
    "DTSTAMP:" + Utilities.formatDate(new Date(), "UTC", "yyyyMMdd'T'HHmmss'Z'")
  ];
  if (ev.time) {
    // Floating local time: starts at the event time in each viewer's timezone.
    var hm = ev.time.split(":").map(Number);
    var start = new Date(parts[0], parts[1] - 1, parts[2], hm[0], hm[1]);
    var end = new Date(start.getTime() + 2 * 3600 * 1000); // default 2h
    var fmt = function (d) {
      return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
             "T" + pad(d.getHours()) + pad(d.getMinutes()) + "00";
    };
    lines.push("DTSTART:" + fmt(start), "DTEND:" + fmt(end));
  } else {
    var day = ev.date.replace(/-/g, "");
    var next = new Date(parts[0], parts[1] - 1, parts[2] + 1);
    lines.push("DTSTART;VALUE=DATE:" + day,
               "DTEND;VALUE=DATE:" + next.getFullYear() + pad(next.getMonth() + 1) + pad(next.getDate()));
  }
  var hostMail = (host.email && host.email.indexOf("@") !== -1) ? host.email : "noreply@officialfriendly.com";
  lines.push("ORGANIZER;CN=" + icsEscape(host.name) + ":mailto:" + hostMail);
  (ev.invitees || []).forEach(function (id) {
    var m = members[id];
    if (m && m.email && m.email.indexOf("@") !== -1) {
      lines.push("ATTENDEE;CN=" + icsEscape(m.name) + ";RSVP=TRUE:mailto:" + m.email);
    }
  });
  lines.push(
    "SUMMARY:" + icsEscape(ev.title),
    ev.location ? "LOCATION:" + icsEscape(ev.location) : null,
    ev.notes ? "DESCRIPTION:" + icsEscape(ev.notes + "\nRSVP: " + SITE_URL) : "DESCRIPTION:" + icsEscape("RSVP: " + SITE_URL),
    "URL:" + SITE_URL,
    "END:VEVENT",
    "END:VCALENDAR"
  );
  return lines.filter(Boolean).join("\r\n");
}

// ---------- push notifications (Web Push, payload-less) ----------
// Each device subscribes from the app; we store the endpoint per member.
// A push carries no payload (Apps Script can't do the required encryption),
// so the service worker fetches ?action=latest to get the text to show.
// Sending requires a VAPID JWT signed with ES256, implemented below.

var VAPID_PUBLIC_KEY = "BMZ2sS0QE3ElRD78S_7PV_dqhea8wBey9W033-FRmFdQK-GdnwaW3cCDq9DM9NURsNkTVf8mfF8EGkbkEFkKpjE";
var VAPID_SUBJECT = "mailto:weston.griffin@yahoo.com";

// The private key lives in Script Properties (Project Settings → Script
// properties → VAPID_PRIVATE_KEY), never in the public repo.
function vapidPrivateKey() {
  var k = PropertiesService.getScriptProperties().getProperty("VAPID_PRIVATE_KEY");
  if (!k) throw new Error("VAPID_PRIVATE_KEY script property is not set");
  return k;
}

function md5hex(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s).map(function (b) {
    b = b < 0 ? b + 256 : b; return (b < 16 ? "0" : "") + b.toString(16);
  }).join("");
}

function subscribePush(memberId, endpoint) {
  if (!memberId || !endpoint || String(endpoint).indexOf("https://") !== 0) throw new Error("Bad subscription");
  upsertRow("pushsubs", { id: md5hex(endpoint), memberId: memberId, endpoint: endpoint, createdAt: Date.now() });
}
function unsubscribePush(endpoint) { deleteRow("pushsubs", md5hex(String(endpoint))); }

function membersById() {
  var mm = {};
  readTable("members").forEach(function (m) { mm[m.id] = m; });
  return mm;
}
function firstName(mm, id, fallback) {
  return mm[id] ? mm[id].name.split(" ")[0] : (fallback || "Someone");
}

function notifyEvent(ev) {
  var mm = membersById();
  pushToMembers(
    (ev.invitees || []).filter(function (id) { return id !== ev.createdBy; }),
    firstName(mm, ev.createdBy) + " invited you: " + ev.title);
}
function notifyExpense(x) {
  var mm = membersById();
  pushToMembers(
    (x.split || []).filter(function (id) { return id !== x.addedBy; }),
    firstName(mm, x.paidBy) + " paid $" + (x.amountCents / 100).toFixed(2) + " for " + x.desc);
}
function notifySettlement(s) {
  var mm = membersById();
  pushToMembers(
    [s.from, s.to].filter(function (id) { return id !== s.addedBy; }),
    firstName(mm, s.from) + " paid " + firstName(mm, s.to, "someone") + " $" + (s.amountCents / 100).toFixed(2));
}
function notifyRsvp(eventId, memberId, status) {
  var idx = findRowIndex("events", eventId);
  if (idx === -1) return;
  var t = TABLES.events;
  var v = SpreadsheetApp.getActive().getSheetByName("events").getRange(idx, 1, 1, t.cols.length).getValues()[0];
  var creator = String(v[t.cols.indexOf("createdBy")]);
  if (creator === memberId) return;
  var title = String(v[t.cols.indexOf("title")]);
  var mm = membersById();
  var word = status === "going" ? "is going to" : status === "maybe" ? "might come to" : "can't make";
  pushToMembers([creator], firstName(mm, memberId) + " " + word + " " + title);
}

function pushToMembers(memberIds, msg) {
  try {
    if (!memberIds || !memberIds.length) return;
    PropertiesService.getScriptProperties().setProperty("LATEST_MSG", msg);
    var want = {};
    memberIds.forEach(function (id) { want[id] = true; });
    var subs = readTable("pushsubs").filter(function (s) { return want[s.memberId]; });
    var jwts = {};
    subs.forEach(function (s) {
      try {
        var aud = s.endpoint.match(/^https:\/\/[^\/]+/)[0];
        if (!jwts[aud]) jwts[aud] = vapidJwt(aud);
        var res = UrlFetchApp.fetch(s.endpoint, {
          method: "post",
          muteHttpExceptions: true,
          headers: {
            TTL: "86400",
            Urgency: "normal",
            Authorization: "vapid t=" + jwts[aud] + ", k=" + VAPID_PUBLIC_KEY
          }
        });
        var code = res.getResponseCode();
        if (code === 404 || code === 410) deleteRow("pushsubs", s.id); // expired subscription
        else if (code >= 400) console.error("push " + code + ": " + res.getContentText().slice(0, 200));
      } catch (e2) { console.error("push send: " + e2); }
    });
  } catch (err) { console.error("pushToMembers: " + err); }
}

// ----- ES256 (ECDSA P-256, deterministic per RFC 6979) for VAPID JWTs -----
// Apps Script has no native ECDSA; V8's BigInt + Utilities' SHA-256/HMAC
// make a compact, deterministic (no weak randomness) implementation possible.

var B0 = BigInt(0), B1 = BigInt(1), B2 = BigInt(2), B3 = BigInt(3),
    B8 = BigInt(8), B255 = BigInt(255);

var P256 = {
  p: BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff"),
  n: BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"),
  gx: BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
  gy: BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5")
};

function bmod(a, m) { var r = a % m; return r < B0 ? r + m : r; }
function modInv(a, m) {
  var lm = B1, hm = B0, low = bmod(a, m), high = m;
  while (low > B1) {
    var q = high / low;
    var nm = hm - lm * q, nw = high - low * q;
    hm = lm; high = low; lm = nm; low = nw;
  }
  return bmod(lm, m);
}
function ptAdd(P, Q) {
  var p = P256.p, s;
  if (!P) return Q;
  if (!Q) return P;
  if (P[0] === Q[0]) {
    if (bmod(P[1] + Q[1], p) === B0) return null;
    s = bmod((B3 * P[0] * P[0] - B3) * modInv(bmod(B2 * P[1], p), p), p);
  } else {
    s = bmod((Q[1] - P[1]) * modInv(bmod(Q[0] - P[0], p), p), p);
  }
  var x = bmod(s * s - P[0] - Q[0], p);
  return [x, bmod(s * (P[0] - x) - P[1], p)];
}
function ptMul(k, P) {
  var R = null, A = P;
  while (k > B0) {
    if (k & B1) R = ptAdd(R, A);
    A = ptAdd(A, A);
    k >>= B1;
  }
  return R;
}

function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Utilities.base64Decode(s);
}
function bytesToB64u(bytes) {
  return Utilities.base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function bytesToBig(bytes) {
  var v = B0;
  for (var i = 0; i < bytes.length; i++) {
    v = (v << B8) | BigInt(bytes[i] < 0 ? bytes[i] + 256 : bytes[i]);
  }
  return v;
}
function bigTo32(v) {
  var out = [];
  for (var i = 31; i >= 0; i--) {
    var b = Number((v >> BigInt(8 * i)) & B255);
    out.push(b > 127 ? b - 256 : b);
  }
  return out;
}
function utf8Bytes(s) { return Utilities.newBlob(s).getBytes(); }
function hmac256(key, msg) { return Utilities.computeHmacSha256Signature(msg, key); }

// RFC 6979 deterministic nonce: unpredictable without any RNG.
function deterministicK(d, hBytes) {
  var x = bigTo32(d);
  var h1 = bigTo32(bmod(bytesToBig(hBytes), P256.n));
  var V = [], K = [];
  for (var i = 0; i < 32; i++) { V.push(1); K.push(0); }
  K = hmac256(K, V.concat([0]).concat(x).concat(h1));
  V = hmac256(K, V);
  K = hmac256(K, V.concat([1]).concat(x).concat(h1));
  V = hmac256(K, V);
  for (var tries = 0; tries < 100; tries++) {
    V = hmac256(K, V);
    var k = bytesToBig(V);
    if (k >= B1 && k < P256.n) return k;
    K = hmac256(K, V.concat([0]));
    V = hmac256(K, V);
  }
  throw new Error("no k");
}

function es256Sign(signingInput) {
  var d = bytesToBig(b64uToBytes(vapidPrivateKey()));
  var h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, utf8Bytes(signingInput));
  var e = bmod(bytesToBig(h), P256.n);
  var k = deterministicK(d, h);
  var R = ptMul(k, [P256.gx, P256.gy]);
  var r = bmod(R[0], P256.n);
  var s = bmod(modInv(k, P256.n) * (e + r * d), P256.n);
  if (r === B0 || s === B0) throw new Error("degenerate signature");
  return bytesToB64u(bigTo32(r).concat(bigTo32(s)));
}

function vapidJwt(aud) {
  var enc = function (o) { return bytesToB64u(utf8Bytes(JSON.stringify(o))); };
  var input = enc({ typ: "JWT", alg: "ES256" }) + "." +
              enc({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT });
  return input + "." + es256Sign(input);
}
