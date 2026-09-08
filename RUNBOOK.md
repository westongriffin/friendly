# Friendly — deploy runbook

The web app auto-deploys to https://officialfriendly.com from `main` (GitHub
Pages). Two things run on your accounts and need a few manual steps.

## A. Cloud Functions (push notifications, reminders) — needs Blaze (enabled)

From this repo root, in your own terminal:

```bash
npm install -g firebase-tools     # one time
firebase login                    # opens a browser; sign in as the project owner
cd functions && npm install && cd ..
firebase deploy --only functions
```

This deploys:
- **push on new events, comments, and RSVPs** (to devices that registered a token),
- **day-of reminders** at 9am (`America/Chicago` — change in `functions/index.js`).

Push needs the native app (below) registered for APNs. For web-only push later,
we'd add a Firebase Cloud Messaging web key.

### Optional: SMS blasts (Twilio)
```bash
firebase functions:config:set twilio.sid=ACxxxx twilio.token=xxxx twilio.from=+15551234567
firebase deploy --only functions
```
(Twilio account + a phone number, ~$1/mo + ~1¢/text. The SMS hook is stubbed in
`functions/index.js` to activate when these are set.)

## B. Native iOS app (App Store) — needs a Mac with full Xcode

The Capacitor project lives in `app-native/`. It wraps officialfriendly.com and
adds native **Contacts** (real phone-contact invites) and **Push**.

One-time setup on your Mac:
1. Install **Xcode** from the Mac App Store (free, large), then run
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` and open it
   once to accept the license.
2. Install CocoaPods: `sudo gem install cocoapods` (or `brew install cocoapods`).
3. Enroll in the **Apple Developer Program** ($99/year): https://developer.apple.com/programs/

Build:
```bash
cd app-native
npm install
npx cap sync ios
npx cap open ios          # opens Xcode
```
In Xcode:
- Select the **App** target → **Signing & Capabilities** → pick your Team (the
  bundle id is `com.officialfriendly.app`).
- Click **+ Capability → Push Notifications**, and **+ Capability → Background
  Modes → Remote notifications**.
- For push to actually deliver: in the Firebase console add an **iOS app**
  (`com.officialfriendly.app`), download **GoogleService-Info.plist** into
  `app-native/ios/App/App/`, and upload your **APNs Auth Key** under Firebase →
  Project settings → Cloud Messaging.
- Choose a device/Simulator and **Run** to test; then **Product → Archive →
  Distribute App → App Store Connect** to submit.

Because the app adds native contacts + push (not just a web view), it clears
App Store guideline 4.2 (minimum functionality).
