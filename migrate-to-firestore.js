// migrate-to-firestore.js
// Run once to migrate local data.json -> Firestore
// Usage: node migrate-to-firestore.js
// Requirements: FIREBASE_SERVICE_ACCOUNT env var (path to JSON or JSON string).
// This script writes to collections: events and payments, and will also create users/{uid}/payments docs where submittedByUid exists.

const fs = require('fs');
const path = require('path');

async function main() {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!svc) {
    console.error('FIREBASE_SERVICE_ACCOUNT is not set. Set it to the path to your serviceAccountKey.json or to the JSON string.');
    process.exit(1);
  }

  let serviceAccountObj;
  try {
    if (fs.existsSync(svc)) {
      serviceAccountObj = JSON.parse(fs.readFileSync(svc, 'utf8'));
    } else {
      serviceAccountObj = JSON.parse(svc);
    }
  } catch (err) {
    console.error('Failed to read/parse FIREBASE_SERVICE_ACCOUNT:', err);
    process.exit(1);
  }

  const admin = require('firebase-admin');
  try {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccountObj) });
  } catch (err) {
    // If initialized already in the same process, ignore
    if (!/already exists/u.test(String(err))) {
      console.error('Failed to initialize firebase-admin:', err);
      process.exit(1);
    }
  }
  const firestore = admin.firestore();

  const DB_FILE = path.join(__dirname, 'data.json');
  if (!fs.existsSync(DB_FILE)) {
    console.error('data.json not found at project root. Nothing to migrate.');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const payments = Array.isArray(raw.payments) ? raw.payments : [];
  const events = Array.isArray(raw.events) ? raw.events : [];

  console.log(`Migrating ${events.length} events and ${payments.length} payments to Firestore...`);

  // Events
  for (const ev of events) {
    const id = ev.id || firestore.collection('events').doc().id;
    try {
      await firestore.collection('events').doc(id).set(Object.assign({}, ev, { id }), { merge: true });
      console.log('Migrated event', id, ev.name || '');
    } catch (err) {
      console.error('Failed to migrate event', id, err);
    }
  }

  // Payments (and per-user subcollections)
  for (const p of payments) {
    const id = p.id || firestore.collection('payments').doc().id;
    try {
      await firestore.collection('payments').doc(id).set(Object.assign({}, p, { id }), { merge: true });
      console.log('Migrated payment', id, p.reference || p.name || '');
      // Also add under users/{uid}/payments if submittedByUid exists
      if (p.submittedByUid) {
        try {
          await firestore.collection('users').doc(p.submittedByUid).collection('payments').doc(id).set(Object.assign({}, p, { id }), { merge: true });
        } catch (err) {
          console.warn('Failed to create per-user payment doc for', p.submittedByUid, id, err);
        }
      }
    } catch (err) {
      console.error('Failed to migrate payment', id, err);
    }
  }

  console.log('Migration completed.');
  process.exit(0);
}

main().catch(err => {
  console.error('Migration script error:', err);
  process.exit(1);
});