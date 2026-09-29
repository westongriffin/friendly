# Friendly on Google Play (paste-ready)

Everything Play Console asks for, in the order it asks. Items marked **[you]** need your account or a decision.

## Create app (Play Console → Home → Create app)
- **App name (30):** `Friendly: Plans & More`
- **Default language:** English (United States)
- **App or game:** App
- **Free or paid:** Free
- Declarations: tick the Developer Program Policies and US export laws boxes **[you]**

## Main store listing (Grow users → Store presence → Main store listing)
- **Short description (80):**
  `Your friend group's home base: plan nights out, invite friends, and settle up.`
- **Full description (4000):**

```
Friendly is your friend group's home base, the one app you use together to plan everything and settle up afterwards.

MAKE IT AN EVENT
Give every get-together a look with animated themes and a cover you upload or have AI paint for you. Set the date, place, spots, and a few questions for guests. Doing more than one thing? Add stops like dinner, bowling, and dessert, and Friendly turns them into a timeline with directions to each one.

MEET DOT
Dot is Friendly's little helper. Tell Dot the plan in one sentence, like "tacos Friday at 7 with the crew," and Dot fills in the event for you to check before anything sends.

NEED AN IDEA? CURATE
Curate finds real things to do near you, paired with a place to eat and the timing worked out. Pick one and it becomes a plan, or send a few to your group as a poll.

INVITE THE RIGHT PEOPLE
Build groups from your contacts and invite by name or phone number. Friends who aren't on Friendly yet get a text with a link. Each event is private to the people you invite.

EVERYONE'S IN THE LOOP
Guests RSVP, bring a +1, claim items on the bring list, share rides, drop photos on the party wall, vote in polls, and add songs to the playlist. Hosts can approve guests, manage a waitlist, and mark answers for friends who replied by text.

SETTLE UP, NO SPREADSHEET
Log what people paid, split it fairly, and see who owes whom at a glance. Pay back with Venmo, Zelle, or Cash App.

Friendly is free, private by design, and built for real friend groups, not followers.
```

- **App icon (512×512):** `app-native/android/store/play-icon-512.png`
- **Feature graphic (1024×500):** `app-native/android/store/feature-graphic.png`
- **Phone screenshots (2 to 8):** `app-native/android/store/screens/`
- **Category:** Social
- **Tags:** Events, Social networking
- **Contact email:** **[you]** (shown publicly; for example support@officialfriendly.com)
- **Website:** `https://officialfriendly.com`
- **Privacy policy:** `https://officialfriendly.com/privacy.html`

## App content (Policy → App content)
- **Privacy policy:** `https://officialfriendly.com/privacy.html`
- **Ads:** No, the app does not contain ads.
- **App access:** All or some functionality is restricted → add login instructions:
  - Phone: `+1 512 555 0199`, Password: `FriendlyReview2026!` (Sam Rivera, reviewer account used for Apple too)
  - Note: "Sign in with the phone number and password. The account has a group, events, polls, and a shared expense to explore."
- **Content rating:** see the questionnaire answers below.
- **Target audience:** 18 and over (friend groups planning outings; some events involve bars).
- **News app:** No.
- **Government app:** No. **Financial features:** None (the app links out to Venmo, Zelle, and Cash App but does not move money).
- **Health:** No.
- **Data safety:** see below.
- **Child safety standards** (required for Social apps): URL `https://officialfriendly.com/child-safety.html`, contact = developer account email. Two declarations (in-app child safety reporting; complies with child safety laws and reports to authorities) are ticked by the owner. In-app: Report → "Child safety concern" (urgent push to admins, sorted first in the moderation queue).

### Content rating questionnaire (IARC)
- Category: **Social / Communication** (not a game); sub-type **Communication** (people you already know)
- Block users: **Yes**. Report users/content: **Yes**. Chat moderation: **Yes**. Interactions limited to invited friends: **Yes**. Result (Sept 29 2026): ESRB Everyone, "Users Interact".
- Violence, sexuality, language, controlled substances, gambling: **No**
- Does the app allow users to interact or exchange content with other users? **Yes** (party wall, photos, polls)
- Can users share their physical location with other users? **No** (event addresses are typed in by hosts; no device location is shared)
- Does the app allow users to purchase digital goods? **No**
- Unrestricted internet access (web browser)? **No**
- Moderation: users can report and block; admins review reports.

### Data safety
Data is encrypted in transit: **Yes**. Users can request deletion: **Yes** (Profile → Delete account deletes the account and data).
Data collected (all **collected**, none **shared** with third parties, none used for ads):

| Data type | Why | Optional? |
|---|---|---|
| Name | Account management, app functionality | Required |
| Email address | Account management, calendar invites | Optional |
| Phone number | Account sign-in, matching invites | Required |
| Contacts | Only the people you choose to invite (name and phone); the address book is never uploaded | Optional |
| Photos | Party wall, covers, profile photo, receipts | Optional |
| Other user-generated content | Messages, polls, playlists, event details | Optional |
| Other financial info | Venmo, Zelle, and Cash App handles you add so friends can pay you back | Optional |
| Date of birth | Birthday reminders for your friends | Optional |
| App interactions / crash logs | Not collected | n/a |

Approximate or precise location: **not collected** (the city you type for Curate is stored as text you entered, under "Other user-generated content").

## Release (Test and release → Production)
- Upload `app-native/android/friendly-1.0.3.aab` **[you, first upload through the Console]**
- Release name: `1.0.3 (1)`
- Release notes: `Friendly is here on Android: plan events with your friends, invite by text, RSVP, share photos, find nights out with Curate, and settle up.`
- Countries: United States (add more anytime)

## Signing
- Play App Signing: accept Google's default (Google holds the app signing key).
- Upload key: `~/.private_keys/friendly-upload.jks` (password in the Mac's login keychain as `friendly-android-upload-key`; also in `~/.private_keys/friendly-android.properties`). SHA-256 of the upload key:
  `AA:B6:6A:43:49:E8:D0:EE:E0:59:7D:C6:8C:50:59:AE:E7:E4:62:94:09:47:B8:98:53:E8:F0:45:90:A1:14:92`
- After the first upload, copy the **App signing key SHA-256** from Play Console (Test and release → Setup → App signing) so links to officialfriendly.com open the app (Android App Links, `/.well-known/assetlinks.json`).
