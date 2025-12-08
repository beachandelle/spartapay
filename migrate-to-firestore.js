// migrate-to-firestore.js
// Run once to migrate local data.json -> Firestore
// Usage:
//   node migrate-to-firestore.js [--dry-run] [--no-backup]
// Requirements: FIREBASE_SERVICE_ACCOUNT env var (path to JSON or JSON string).
// This script writes to collections: organizations, events and payments, and will also create users/{uid}/payments docs where submittedByUid exists.
// It will also populate orgId on events (by canonicalizing org names and upserting organizations).
//
// Behavior:
// - By default it backups data.json -> data.json.bak.TIMESTAMP before modifying local file.
// - --dry-run will print planned changes without writing to Firestore or modifying data.json.
// - --no-backup skips the local backup step.
//
// Note: This script is conservative and attempts to preserve fields while adding orgId to events
// and creating canonical organization docs. It deduplicates organizations by canonical name
// (trim, lower-case, remove diacritics) and prefers existing org.id when present.

const fs = require('fs');
const path = require('path');

function usageAndExit() {
  console.log('Usage: node migrate-to-firestore.js [--dry-run] [--no-backup]');
  process.exit(1);
}

function canonicalizeName(name) {
  if (!name && name !== '') return '';
  try {
    // normalize NFKD and strip diacritics, trim and lower-case
    const s = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return s.trim().toLowerCase();
  } catch (e) {
    return String(name || '').trim().toLowerCase();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noBackup = args.includes('--no-backup');

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
    // initializeApp may already have been called in other contexts; catch that case
    admin.initializeApp({ credential: admin.credential.cert(serviceAccountObj) });
  } catch (err) {
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

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to parse data.json:', err);
    process.exit(1);
  }

  const payments = Array.isArray(raw.payments) ? raw.payments : [];
  const events = Array.isArray(raw.events) ? raw.events : [];
  const organizations = Array.isArray(raw.organizations) ? raw.organizations : [];

  console.log(`Loaded data.json: ${events.length} events, ${payments.length} payments, ${organizations.length} organizations (existing).`);
  if (dryRun) console.log('Running in dry-run mode — no writes to Firestore or data.json will be performed.');

  // Build canonical org map from existing organizations (local) and from events fallback
  const canonMap = new Map(); // canon -> { id, name, displayName, sources: { orgRecords: [], derivedFromEvents: [] }, createdAt }

  // Seed from explicit organizations array
  for (const o of organizations) {
    const name = o && (o.name || o.displayName || o.id || '');
    const canon = canonicalizeName(o && (o.canonicalName || name));
    if (!canon) continue;
    if (!canonMap.has(canon)) {
      canonMap.set(canon, {
        id: o.id || null,
        name: o.name || o.displayName || o.id || '',
        displayName: o.displayName || o.name || o.id || '',
        createdAt: o.createdAt || null,
        sourceRecords: [o],
      });
    } else {
      const ex = canonMap.get(canon);
      // prefer existing id or pick id if available
      if (!ex.id && o.id) ex.id = o.id;
      // prefer displayName if more expressive
      if ((!ex.displayName || ex.displayName === ex.name) && o.displayName && o.displayName !== o.name) ex.displayName = o.displayName;
      if ((!ex.name || ex.name === ex.displayName) && o.name && o.name !== o.displayName) ex.name = o.name;
      if (!ex.createdAt && o.createdAt) ex.createdAt = o.createdAt;
      ex.sourceRecords.push(o);
    }
  }

  // Also derive org names from events to capture orgs not present in organizations[]
  for (const ev of events) {
    const name = ev && (ev.org || '');
    const canon = canonicalizeName(name);
    if (!canon) continue;
    if (!canonMap.has(canon)) {
      canonMap.set(canon, {
        id: null,
        name: name,
        displayName: name,
        createdAt: ev.createdAt || null,
        sourceRecords: [],
      });
    } else {
      // ensure we at least have a human-readable name
      const ex = canonMap.get(canon);
      if ((!ex.name || ex.name === ex.displayName) && name) ex.name = name;
      if (!ex.displayName && name) ex.displayName = name;
    }
  }

  // Summary counts
  const canonicalEntries = Array.from(canonMap.entries()).map(([k, v]) => ({ canon: k, ...v }));
  console.log(`Identified ${canonicalEntries.length} canonical organizations (after merging local/org-derived).`);

  // Prepare to create orgs in Firestore (or reuse existing ids if present)
  // We'll create a mapping canon -> orgId (string)
  const canonToOrgId = new Map();
  const createdOrgs = [];
  const reusedOrgs = [];

  // If dry-run, we just simulate IDs (generate random doc ids locally) but don't write to Firestore.
  // Otherwise, we will upsert organization docs in Firestore using stored id when available (prefer).
  for (const entry of canonicalEntries) {
    let orgId = entry.id || null;

    if (dryRun) {
      if (!orgId) orgId = firestore.collection('organizations').doc().id; // generate id but do not write
      canonToOrgId.set(entry.canon, orgId);
      if (entry.id) reusedOrgs.push({ canon: entry.canon, id: orgId, name: entry.name });
      else createdOrgs.push({ canon: entry.canon, id: orgId, name: entry.name });
      continue;
    }

    // Real run: create or reuse in Firestore
    try {
      if (orgId) {
        // verify doc exists; if not, create with given id
        const docRef = firestore.collection('organizations').doc(orgId);
        const doc = await docRef.get();
        if (doc.exists) {
          // update/merge minimal fields
          await docRef.set({
            id: orgId,
            name: entry.name,
            displayName: entry.displayName || entry.name,
            canonicalName: entry.canon,
            createdAt: entry.createdAt || admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          canonToOrgId.set(entry.canon, orgId);
          reusedOrgs.push({ canon: entry.canon, id: orgId, name: entry.name });
        } else {
          // create doc with provided id
          await docRef.set({
            id: orgId,
            name: entry.name,
            displayName: entry.displayName || entry.name,
            canonicalName: entry.canon,
            createdAt: entry.createdAt || admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          canonToOrgId.set(entry.canon, orgId);
          createdOrgs.push({ canon: entry.canon, id: orgId, name: entry.name });
        }
      } else {
        // no id present -> create new doc with generated id
        const docRef = firestore.collection('organizations').doc();
        orgId = docRef.id;
        await docRef.set({
          id: orgId,
          name: entry.name,
          displayName: entry.displayName || entry.name,
          canonicalName: entry.canon,
          createdAt: entry.createdAt || admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        canonToOrgId.set(entry.canon, orgId);
        createdOrgs.push({ canon: entry.canon, id: orgId, name: entry.name });
      }
    } catch (err) {
      console.error('Failed to create/upsert organization in Firestore for canon:', entry.canon, err);
      // still map a generated id locally to allow event mapping to proceed
      try {
        if (!orgId) orgId = firestore.collection('organizations').doc().id;
        canonToOrgId.set(entry.canon, orgId);
      } catch (e) {
        // fallback: leave unmapped
      }
    }
  }

  // Report planned/actual org operations
  console.log(`Organizations: will create ${createdOrgs.length} and reuse ${reusedOrgs.length} (dryRun=${dryRun}).`);
  if (dryRun) {
    createdOrgs.forEach(o => console.log('  [DRY] create org:', o.id, o.name));
    reusedOrgs.forEach(o => console.log('  [DRY] reuse org:', o.id, o.name));
  }

  // Next: update events to include orgId (mapping by canonical name). Also normalize event.org to canonical displayName.
  let eventsUpdated = 0;
  const updatedEventsForWrite = [];
  for (const ev of events) {
    const orgName = ev && (ev.org || '');
    const canon = canonicalizeName(orgName);
    const mappedOrgId = canonToOrgId.get(canon) || null;
    if (mappedOrgId && (!ev.orgId || ev.orgId !== mappedOrgId)) {
      ev.orgId = mappedOrgId;
      // also normalize human-readable org name to the canonical displayName if available
      const orgEntry = canonicalEntries.find(e => e.canon === canon);
      if (orgEntry && orgEntry.name) ev.org = orgEntry.name;
      eventsUpdated++;
    } else if (!ev.orgId && mappedOrgId) {
      ev.orgId = mappedOrgId;
      eventsUpdated++;
    }
    updatedEventsForWrite.push(ev);
  }

  console.log(`Events: ${eventsUpdated} events will be updated with orgId (dryRun=${dryRun}).`);

  // Payments: no changes to org mapping currently, but we will write payments to Firestore as before.
  // Backup local data.json unless disabled
  if (!dryRun && !noBackup) {
    try {
      const bakName = `data.json.bak.${Date.now()}`;
      fs.copyFileSync(DB_FILE, path.join(__dirname, bakName));
      console.log('Created backup:', bakName);
    } catch (err) {
      console.warn('Failed to create backup, continuing:', err);
    }
  } else if (dryRun) {
    console.log('Dry-run: skipping backup.');
  } else if (noBackup) {
    console.log('--no-backup specified: not creating a backup.');
  }

  // If not dry-run, write updated local data.json (events updated and organizations canonicalized)
  if (!dryRun) {
    try {
      // Build canonical organizations array from canonToOrgId and canonicalEntries
      const orgsOut = canonicalEntries.map(e => {
        return {
          id: canonToOrgId.get(e.canon) || e.id || null,
          name: e.name || e.displayName || '',
          displayName: e.displayName || e.name || '',
          canonicalName: e.canon,
          createdAt: e.createdAt || null
        };
      });

      const out = Object.assign({}, raw, {
        events: updatedEventsForWrite,
        organizations: orgsOut
      });
      fs.writeFileSync(DB_FILE, JSON.stringify(out, null, 2));
      console.log('Updated local data.json with orgId on events and canonical organizations.');
    } catch (err) {
      console.error('Failed to write updated data.json:', err);
    }
  } else {
    console.log('Dry-run: not writing data.json changes.');
  }

  // Finally push events and payments to Firestore (if not dry-run)
  if (dryRun) {
    console.log('Dry-run complete. Summary:');
    console.log(`  Organizations to create: ${createdOrgs.length}`);
    console.log(`  Organizations to reuse: ${reusedOrgs.length}`);
    console.log(`  Events to update with orgId: ${eventsUpdated} / ${events.length}`);
    console.log(`  Payments to write: ${payments.length}`);
    process.exit(0);
  }

  // Real write: events
  console.log('Writing events to Firestore...');
  for (const ev of updatedEventsForWrite) {
    const id = ev.id || firestore.collection('events').doc().id;
    try {
      await firestore.collection('events').doc(id).set(Object.assign({}, ev, { id }), { merge: true });
      console.log('Wrote event', id, ev.name || '');
    } catch (err) {
      console.error('Failed to write event', id, err);
    }
  }

  // Payments
  console.log('Writing payments to Firestore (and per-user subcollections)...');
  for (const p of payments) {
    const id = p.id || firestore.collection('payments').doc().id;
    try {
      await firestore.collection('payments').doc(id).set(Object.assign({}, p, { id }), { merge: true });
      console.log('Wrote payment', id, p.reference || p.name || '');
      if (p.submittedByUid) {
        try {
          await firestore.collection('users').doc(p.submittedByUid).collection('payments').doc(id).set(Object.assign({}, p, { id }), { merge: true });
        } catch (err) {
          console.warn('Failed to create per-user payment doc for', p.submittedByUid, id, err);
        }
      }
    } catch (err) {
      console.error('Failed to write payment', id, err);
    }
  }

  console.log('Migration to Firestore completed successfully.');
  process.exit(0);
}

main().catch(err => {
  console.error('Migration script error:', err);
  process.exit(1);
});
