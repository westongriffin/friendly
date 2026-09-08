# Friendly

Plan hangouts, invite the group, and settle up afterwards, all in one shared,
installable web app. Lives at **https://officialfriendly.com**.

- **Frontend**: a static PWA (this repo), hosted on GitHub Pages. Friends can
  install it from the browser: "Add to Home Screen" on a phone, "Install app"
  on desktop Chrome/Edge.
- **Backend**: a Google Sheet, fronted by a Google Apps Script web app
  ([`apps-script/Code.gs`](apps-script/Code.gs)). Every member, event, expense,
  and settlement is a row you can see and edit right in the sheet. Event
  invites are emailed automatically via the script.

## Connect the Google Sheet backend (one-time, ~3 minutes)

1. Create a new Google Sheet: <https://sheets.new> (name it e.g. "Friendly DB").
2. **Extensions → Apps Script**. Delete the starter code, paste in the whole
   contents of [`apps-script/Code.gs`](apps-script/Code.gs), and save.
3. **Deploy → New deployment**, gear icon → type **Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**

   Click **Deploy** and authorize the permissions it asks for (Sheets +
   sending email, used for invite emails).
4. Copy the **Web app URL** (ends in `/exec`) into [`config.js`](config.js):

   ```js
   window.FRIENDLY_CONFIG = { scriptUrl: "https://script.google.com/macros/s/…/exec" };
   ```

5. Commit and push. Done. The site now reads and writes your sheet.

To update the script later: paste the new code in the Apps Script editor, then
**Deploy → Manage deployments → ✏️ → New version**. The URL stays the same.

Set `SEND_EMAIL_INVITES = false` at the top of `Code.gs` to turn off invite
emails.

## Custom domain (officialfriendly.com)

The repo's [`CNAME`](CNAME) file tells GitHub Pages to serve the site at
officialfriendly.com. At your DNS provider, add:

| Type  | Host | Value               |
|-------|------|---------------------|
| A     | `@`  | `185.199.108.153`   |
| A     | `@`  | `185.199.109.153`   |
| A     | `@`  | `185.199.110.153`   |
| A     | `@`  | `185.199.111.153`   |
| CNAME | `www`| `westongriffin.github.io` |

Then in the repo's **Settings → Pages**, confirm the custom domain shows
officialfriendly.com and tick **Enforce HTTPS** once the certificate is issued
(can take up to an hour after DNS propagates).

Until DNS is set up, the site also works at
<https://westongriffin.github.io/friendly/>.

## How it works

- Everyone shares one group. On first visit you create a profile (name +
  email) or pick your existing one; your browser remembers who you are.
- **Events**: create with date/time/place/notes, choose invitees, RSVP with
  Going / Maybe / Can't. New events email the invitees.
- **Money**: add expenses split evenly among chosen friends, see who owes
  whom, and record reimbursements ("Record payment") to zero things out.
- **Paying each other**: profiles can hold a Venmo username and a phone
  number. Settle-up rows then get one-tap buttons: Venmo opens prefilled
  with recipient/amount/note (or a Request for money owed to you), and the
  Apple Cash button opens Messages to that friend (Apple Cash is attached
  there; Apple offers no deeper integration). Money never moves through the
  app itself: pay in Venmo/Messages, then tap Record payment.
- **Push notifications**: enable per device from the Friends tab: invites,
  new expenses, payments, and RSVPs. On iPhone this requires iOS 16.4+ and
  the app installed to the home screen first (Apple's rule for web push).
  The backend signs Web Push (VAPID/ES256) itself; the private key lives in
  the Apps Script's Script Properties (`VAPID_PRIVATE_KEY`), not in this repo.
- The app polls the sheet every 20 seconds, so everyone converges on the
  same state; a service worker caches the shell so the installed app opens
  instantly.

## Caveats worth knowing

- Identity is trust-based: anyone with the link can claim any profile. Fine
  for a friend group; don't use it with strangers.
- The Apps Script URL in `config.js` is public; anyone who has it can read
  and write the group's data. Don't put anything sensitive in the sheet.
- Editing sheet rows by hand is fine, but keep the `id` column intact and
  JSON columns (`invitees`, `rsvps`, `split`) valid.
