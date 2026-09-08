/**
 * Friendly — Google Sheets backend (Google Apps Script).
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
    cols: ["id", "name", "email", "createdAt"],
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
  }
};

function doGet(e) {
  ensureSheets();
  return jsonOut({ ok: true, data: readAll() });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ensureSheets();
    var req = JSON.parse(e.postData.contents);
    if (!TABLES[req.table]) throw new Error("Unknown table: " + req.table);
    if (req.action === "upsert") {
      upsertRow(req.table, req.row);
    } else if (req.action === "delete") {
      deleteRow(req.table, req.id);
    } else if (req.action === "rsvp") {
      rsvpMerge(req.eventId, req.memberId, req.status);
    } else {
      throw new Error("Unknown action: " + req.action);
    }
    return jsonOut({ ok: true, data: readAll() });
  } catch (err) {
    return jsonOut({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
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
  }
}

function readAll() {
  var out = {};
  for (var name in TABLES) out[name] = readTable(name);
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
          "— Friendly, on behalf of " + host.name,
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
