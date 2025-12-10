/**
 * scripts/set_officer_orgs.js
 *
 * One-off admin script to populate users/{uid}.org and users/{uid}.role = 'officer'
 * for a defined mapping of officer emails -> organization names.
 *
 * Usage:
 *  - Install dependencies: npm install firebase-admin
 *  - Provide service account via environment variable FIREBASE_SERVICE_ACCOUNT:
 *      - Either a path to the JSON file, or the JSON text itself.
 *  - Run:
 *      node scripts/set_officer_orgs.js
 *
 * Alternatively you can pass a path as the first argument:
 *    node scripts/set_officer_orgs.js /path/to/service-account.json
 *
 * What it does:
 *  - For each email in the mapping it looks up the Firebase Auth user by email
 *    to obtain the UID, then writes { org: <ORG>, role: 'officer' } to
 *    Firestore document users/{uid} (merge: true).
 *
 * Notes:
 *  - This requires Firestore access in the service account.
 *  - If a user email is not found in Auth the script logs and skips it.
 *  - The mapping below uses the emails/orgs you provided — edit if needed.
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

async function loadServiceAccount() {
  // Priority: CLI arg path -> FIREBASE_SERVICE_ACCOUNT env (file path or JSON string)
  const maybePath = process.argv[2];
  if (maybePath) {
    const p = path.resolve(maybePath);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    // if not a file, try parse as JSON
    try { return JSON.parse(maybePath); } catch (e) { /* continue */ }
  }

  const env = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!env) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT not provided (env or first arg). Provide path or JSON string.');
  }

  // If env is a path to an existing file, read it; else try parse JSON
  if (fs.existsSync(env)) return JSON.parse(fs.readFileSync(env, 'utf8'));
  try {
    return JSON.parse(env);
  } catch (e) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT provided but is not valid JSON or file path');
  }
}

async function main() {
  try {
    const serviceAccount = await loadServiceAccount();
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    const firestore = admin.firestore();

    // Edit this mapping if emails or org names differ
    const mapping = {
      "jiecep@officer.com": "JIECEP",
      "abmes@officer.com": "ABMES",
      "aicess@officer.com": "AICESS", // note: double-check spelling (aices vs aicess)
      "mexess@officer.com": "MEXESS",
      "aeess@officer.com": "AEESS"
    };

    console.log('Starting officer org assignment for', Object.keys(mapping).length, 'entries');

    for (const [email, org] of Object.entries(mapping)) {
      try {
        // Lookup user by email to get UID
        const userRecord = await admin.auth().getUserByEmail(email);
        const uid = userRecord.uid;
        console.log(`Found user ${email} -> uid=${uid}. Setting org=${org}`);

        // Persist to Firestore users/{uid} with merge true
        await firestore.collection('users').doc(uid).set({
          org: org,
          role: 'officer'
        }, { merge: true });

        console.log(`✔ Set users/${uid} { org: "${org}", role: "officer" }`);
      } catch (err) {
        if (err.code === 'auth/user-not-found' || err.code === 'auth/user-not-found') {
          console.warn(`⚠ User not found in Firebase Auth for email: ${email}. Skipping.`);
        } else {
          console.error(`✖ Failed for ${email}:`, err && err.message ? err.message : err);
        }
      }
    }

    console.log('Done. Verify Firestore users docs or use /api/my-profile to confirm.');
    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

main();
