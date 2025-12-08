// migrate-to-firestore.js
// Run once to migrate local data.json -> Firestore
// Usage: node migrate-to-firestore.js [--dry-run] [--no-backup] [--dedupe-orgs]
// Requirements: FIREBASE_SERVICE_ACCOUNT env var (path to JSON or JSON string).
// This script writes to collections: organizations, events and payments, and will also create users/{uid}/payments docs where submittedByUid exists.
// It will also populate orgId on events (and payments) by matching canonical organization names.
// Options:
//   --dry-run       : Do not modify files or write to Firestore; print intended changes.
//   --no-backup     : Do not create a backup copy of data.json before modifying it (default is to create backup).
//   --dedupe-orgs   : Merge duplicate organizations by canonicalName (remap events/payments to canonical id).

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noBackup = args.includes('--no-backup');
  const dedupeOrgs = args.includes('--dedupe-orgs');

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
  raw.payments = Array.isArray(raw.payments) ? raw.payments : [];
  raw.events = Array.isArray(raw.events) ? raw.events : [];
  raw.organizations = Array.isArray(raw.organizations) ? raw.organizations : [];

  console.log(`Found ${raw.organizations.length} organizations, ${raw.events.length} events, ${raw.payments.length} payments in ${DB_FILE}`);
  if (dryRun) console.log('DRY RUN enabled - no files or Firestore writes will be performed.');

  // helpers
  function canonicalOrgName(name) {
    try { return String(name || '').trim().toLowerCase(); } catch (e) { return String(name || '').trim(); }
  }

  function backupFile(filePath) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = `${filePath}.bak.${ts}`;
      fs.copyFileSync(filePath, dest);
      console.log(`Backed up ${filePath} -> ${dest}`);
    } catch (e) {
      console.warn('Failed to create backup of', filePath, e);
    }
  }

  // Build canonical org map from raw.organizations
  const orgsByCanon = new Map(); // canon -> canonical org (first encountered)
  const duplicatesByCanon = new Map(); // canon -> [org,...] (all)
  for (const o of raw.organizations) {
    const canon = canonicalOrgName(o.name || o.displayName || o.id || '');
    if (!orgsByCanon.has(canon)) {
      orgsByCanon.set(canon, Object.assign({}, o));
      duplicatesByCanon.set(canon, [o]);
    } else {
      duplicatesByCanon.get(canon).push(o);
    }
  }

  // Optionally dedupe organizations (in-memory remap)
  const remapOrgId = {}; // oldId -> canonicalId
  if (dedupeOrgs) {
    console.log('Deduplicating organizations by canonicalName...');
    for (const [canon, list] of duplicatesByCanon.entries()) {
      if (!list || list.length <= 1) continue;
      const canonical = list[0];
      for (let i = 1; i < list.length; i++) {
        const dup = list[i];
        if (dup && dup.id && canonical && canonical.id) {
          remapOrgId[dup.id] = canonical.id;
        }
      }
    }
    const dupCount = Object.keys(remapOrgId).length;
    console.log(`Found ${dupCount} duplicate organization ids to remap.`);
    // Apply remap to raw.events and raw.payments (events may not yet have orgId)
    let remappedEvents = 0;
    for (const ev of raw.events) {
      if (ev.orgId && remapOrgId[ev.orgId]) {
        ev.orgId = remapOrgId[ev.orgId];
        remappedEvents++;
      }
    }
    let remappedPayments = 0;
    for (const p of raw.payments) {
      if (p.orgId && remapOrgId[p.orgId]) {
        p.orgId = remapOrgId[p.orgId];
        remappedPayments++;
      }
    }
    console.log(`Applied remap to ${remappedEvents} events and ${remappedPayments} payments (by orgId).`);

    // Remove duplicate org entries from raw.organizations (keep canonical entries)
    const canonSet = new Set(Array.from(orgsByCanon.keys()));
    const canonicalIds = new Set(Array.from(orgsByCanon.values()).map(o => o.id));
    const filteredOrgs = [];
    const seenCanon = new Set();
    for (const o of raw.organizations) {
      const c = canonicalOrgName(o.name || o.displayName || o.id || '');
      if (!seenCanon.has(c)) {
        filteredOrgs.push(orgsByCanon.get(c)); // canonical object
        seenCanon.add(c);
      } // else skip duplicates
    }
    raw.organizations = filteredOrgs;
    console.log(`Reduced organizations to ${raw.organizations.length} canonical records.`);
  }

  // Ensure events have orgId where possible; create orgs for unmatched names.
  let createdOrgsForEvents = 0;
  let updatedEventsWithOrgId = 0;
  // rebuild org lookup by canonical name (since dedupe or creations may have modified raw.organizations)
  const orgLookupByCanon = {};
  for (const o of raw.organizations) {
    const c = canonicalOrgName(o.name || o.displayName || '');
    if (c) orgLookupByCanon[c] = o;
  }

  for (const ev of raw.events) {
    // if event already has orgId, continue
    if (ev.orgId) {
      // if remap should be applied
      if (remapOrgId[ev.orgId]) {
        ev.orgId = remapOrgId[ev.orgId];
        updatedEventsWithOrgId++;
      }
      continue;
    }

    const eventOrgName = ev.org || ev.organization || '';
    const canon = canonicalOrgName(eventOrgName || '');
    if (!canon) continue;

    let orgObj = orgLookupByCanon[canon];
    if (!orgObj) {
      // create new org record locally
      const newOrg = {
        id: uuidv4(),
        name: eventOrgName || canon,
        canonicalName: canon,
        displayName: eventOrgName || canon,
        logoUrl: null,
        contactEmail: null,
        metadata: {},
        createdAt: new Date().toISOString()
      };
      raw.organizations.unshift(newOrg);
      orgLookupByCanon[canon] = newOrg;
      orgObj = newOrg;
      createdOrgsForEvents++;
      if (!dryRun) console.log(`Created org for event org="${eventOrgName}" -> id=${newOrg.id}`);
    }
    ev.orgId = orgObj.id;
    // keep human-readable ev.org as-is for compatibility
    updatedEventsWithOrgId++;
  }

  // Also attempt to populate payment.orgId from payment.org (if present)
  let updatedPaymentsWithOrgId = 0;
  for (const p of raw.payments) {
    if (p.orgId) continue;
    const payOrgName = p.org || '';
    const canon = canonicalOrgName(payOrgName || '');
    if (!canon) continue;
    const orgObj = orgLookupByCanon[canon];
    if (orgObj) { p.orgId = orgObj.id; updatedPaymentsWithOrgId++; }
  }

  console.log(`Will populate orgId on ${updatedEventsWithOrgId} events and ${updatedPaymentsWithOrgId} payments. Created ${createdOrgsForEvents} new org records for unmatched event names.`);

  // Backup local file if needed
  if (!dryRun && !noBackup) {
    try {
      backupFile(DB_FILE);
    } catch (e) {
      console.warn('Backup step failed:', e);
    }
  }

  // If not dry-run, persist updated local data.json (with new orgs and orgId fields)
  if (!dryRun) {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(raw, null, 2));
      console.log(`Wrote updated ${DB_FILE} with orgId populated (and canonical organizations).`);
    } catch (e) {
      console.error('Failed to write updated data.json:', e);
      process.exit(1);
    }
  } else {
    console.log('Dry-run: not writing updates to data.json.');
  }

  // Now migrate to Firestore
  console.log(`Migrating to Firestore${dryRun ? ' (DRY RUN - no writes)' : ''}...`);

  // Write organizations to Firestore
  let orgsWritten = 0;
  for (const o of raw.organizations) {
    const id = o.id || uuidv4();
    const doc = Object.assign({}, o, { id });
    if (!dryRun) {
      try {
        await firestore.collection('organizations').doc(id).set(doc, { merge: true });
        orgsWritten++;
      } catch (err) {
        console.error('Failed to write organization to Firestore:', id, err);
      }
    } else {
      console.log(`[DRY] Would write organization id=${id} name="${o.name}"`);
    }
  }

  // Events
  let eventsWritten = 0;
  for (const ev of raw.events) {
    const id = ev.id || uuidv4();
    const toWrite = Object.assign({}, ev, { id });
    if (!dryRun) {
      try {
        await firestore.collection('events').doc(id).set(toWrite, { merge: true });
        eventsWritten++;
        console.log('Migrated event', id, ev.name || '');
      } catch (err) {
        console.error('Failed to migrate event', id, err);
      }
    } else {
      console.log(`[DRY] Would migrate event ${id} "${ev.name || ''}" (orgId=${ev.orgId || ''})`);
    }
  }

  // Payments (and per-user subcollections)
  let paymentsWritten = 0;
  for (const p of raw.payments) {
    const id = p.id || uuidv4();
    const toWrite = Object.assign({}, p, { id });
    if (!dryRun) {
      try {
        await firestore.collection('payments').doc(id).set(toWrite, { merge: true });
        paymentsWritten++;
        if (p.submittedByUid) {
          try {
            await firestore.collection('users').doc(p.submittedByUid).collection('payments').doc(id).set(toWrite, { merge: true });
          } catch (err) {
            console.warn('Failed to create per-user payment doc for', p.submittedByUid, id, err);
          }
        }
        console.log('Migrated payment', id, p.reference || p.name || '');
      } catch (err) {
        console.error('Failed to migrate payment', id, err);
      }
    } else {
      console.log(`[DRY] Would migrate payment ${id} reference="${p.reference || ''}" submittedByUid=${p.submittedByUid || ''}`);
    }
  }

  console.log('Migration summary:');
  if (!dryRun) {
    console.log(`  Organizations written: ${orgsWritten}`);
    console.log(`  Events written:        ${eventsWritten}`);
    console.log(`  Payments written:      ${paymentsWritten}`);
    console.log('Migration completed.');
  } else {
    console.log(`  (DRY RUN) Organizations to write: approx ${raw.organizations.length}`);
    console.log(`  (DRY RUN) Events to write: approx ${raw.events.length}`);
    console.log(`  (DRY RUN) Payments to write: approx ${raw.payments.length}`);
    console.log('Dry-run completed. No writes performed.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Migration script error:', err);
  process.exit(1);
});
