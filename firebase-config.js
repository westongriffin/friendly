// Friendly: Firebase project configuration.
// These values are safe to ship publicly; access is enforced by Firestore
// security rules (see firestore.rules), not by hiding this config.
export const firebaseConfig = {
  apiKey: "AIzaSyA_lgyYmCL6HnoFPn4Ux89bD6iI_fazkmA",
  authDomain: "friendly-6992a.firebaseapp.com",
  projectId: "friendly-6992a",
  storageBucket: "friendly-6992a.firebasestorage.app",
  messagingSenderId: "346490178887",
  appId: "1:346490178887:web:22cb83e10366d7e4c39062"
};

// Google Maps Platform key for address autocomplete in the event composer.
// Leave empty to keep a plain text box. To enable: Google Cloud console →
// APIs & Services → enable "Places API (New)" → Credentials → Create API key →
// restrict it to HTTP referrers https://officialfriendly.com/* and to the
// Places API (New) → paste it here.
export const mapsKey = "AIzaSyDGf2O_wK32SP2K6-4tSJRFPBrrnOe7IB8";

// Accounts that moderate reported content (see the Reports list on the profile
// page). Must match ADMIN_UIDS in functions/index.js and isAdmin() in firestore.rules.
export const adminUids = ["zzJY7MHFnyN2kAqq13hv79rZTVF2", "TUngQGsAKTRtHBpVEpZwFFHE0sP2"];

// Web push (VAPID) public key. The matching private key is a Cloud Functions secret.
export const vapidPublicKey = "BAG0yqJjd5-thc9sQ3g9oG95zpXkbsUTLn2uJ0_nzx2n9IZ4cSgrQ5pLhTuVVexRrnUBNSOYLJDmyDs-paqWTN8";
