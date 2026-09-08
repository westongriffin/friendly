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

function sendInvites(ev) {
  if (!SEND_EMAIL_INVITES) return;
  try {
    var members = {};
    readTable("members").forEach(function (m) { members[m.id] = m; });
    var host = members[ev.createdBy];
    var when = ev.date + (ev.time ? " at " + ev.time : "");
    (ev.invitees || []).forEach(function (id) {
      if (id === ev.createdBy) return;
      var m = members[id];
      if (!m || !m.email || m.email.indexOf("@") === -1) return;
      MailApp.sendEmail({
        to: m.email,
        subject: "You're invited: " + ev.title,
        body:
          "Hi " + m.name.split(" ")[0] + ",\n\n" +
          (host ? host.name : "A friend") + " invited you to \"" + ev.title + "\".\n\n" +
          "When: " + when + "\n" +
          (ev.location ? "Where: " + ev.location + "\n" : "") +
          (ev.notes ? "Notes: " + ev.notes + "\n" : "") +
          "\nRSVP here: " + SITE_URL + "\n\n" +
          "— Friendly"
      });
    });
  } catch (err) {
    // Email is best-effort; never fail the event creation over it.
    console.error("Invite email failed: " + err);
  }
}
