// server.js
// SpartaPay server with Supabase private-bucket support (signed URLs)
// - Serves static frontend from ./public
// - POST /session: verifies Firebase ID token and upserts users/{uid} in Firestore
// - POST /api/payments: accepts multipart/form-data (proof file), uploads to Supabase (or local fallback), stores proofObjectPath and metadata
// - GET /api/payments: returns payments, injecting fresh signed URLs for proofFile when available
// - GET /api/my-payments: returns authenticated user's payments, injecting fresh signed URLs
// - GET /api/payments/:id/proof-url: returns a signed URL for a single payment (auth + authorization)
// - POST /api/payments/:id/approve, /unapprove and /reject
// - NEW: GET /api/events, POST /api/events (multipart support), PUT /api/events/:id (multipart support added), DELETE /api/events/:id
// - NEW: GET /api/orgs, GET /api/orgs/:id, POST /api/orgs, PUT /api/orgs/:id, DELETE /api/orgs/:id
// - NEW: GET /api/officer-profiles, GET /api/officer-profiles/:id, POST /api/officer-profiles (upsert)
//   These endpoints persist officer profiles to Firestore when configured, otherwise to local data.json
//
// Environment variables (in .env):
// PORT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET, FIREBASE_SERVICE_ACCOUNT
//
// Notes:
// - Keep SUPABASE_BUCKET = the exact bucket name (case-sensitive), e.g. "spartapay"
// - This server will generate signed URLs for private buckets (default TTL 3600s).
// - Store only proofObjectPath in DB; signed URLs are created on demand.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
require('dotenv').config();

const PORT = process.env.PORT || 3001;
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Local uploads fallback folder
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Local DB fallback file (now includes payments, events AND organizations and officerProfiles)
const DB_FILE = path.join(__dirname, 'data.json');
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ payments: [], events: [], organizations: [], officerProfiles: {}, users: {} }, null, 2));

function readDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // ensure required keys exist for backward compatibility
    if (!db.payments) db.payments = [];
    if (!db.events) db.events = [];
    if (!db.organizations) db.organizations = [];
    if (!db.officerProfiles) db.officerProfiles = {};
    if (!db.users) db.users = {};
    return db;
  } catch (e) {
    console.warn('readDB error:', e);
    return { payments: [], events: [], organizations: [], officerProfiles: {}, users: {} };
  }
}
function writeDB(db) {
  // ensure arrays exist
  if (!db.payments) db.payments = [];
  if (!db.events) db.events = [];
  if (!db.organizations) db.organizations = [];
  if (!db.officerProfiles) db.officerProfiles = {};
  if (!db.users) db.users = {};
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Multer memory storage for uploads
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

// Supabase init (server-side service role)
let supabase = null;
let supabaseBucket = process.env.SUPABASE_BUCKET || 'public';
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    console.log('Supabase client initialized. Bucket:', supabaseBucket);
  } catch (err) {
    console.warn('Failed to init Supabase client:', err);
    supabase = null;
  }
} else {
  console.log('SUPABASE not configured; uploads will be stored on local disk (/uploads)');
}

// Firebase Admin (optional) — used for token verification and Firestore
let admin = null;
let firestore = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin = require('firebase-admin');
    const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
    let serviceAccountObj;
    if (fs.existsSync(svc)) {
      serviceAccountObj = JSON.parse(fs.readFileSync(svc, 'utf8'));
    } else {
      serviceAccountObj = JSON.parse(svc);
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountObj)
    });
    firestore = admin.firestore();
    console.log('firebase-admin initialized for token verification and Firestore.');
  } catch (err) {
    console.warn('Failed to initialize firebase-admin:', err && err.message ? err.message : err);
    admin = null;
    firestore = null;
  }
} else {
  console.warn('No FIREBASE_SERVICE_ACCOUNT provided — token verification and Firestore disabled.');
}

// Register POST /session route (verifies ID token and upserts user into Firestore)
// This expects a routes/session.js that exports a function (admin, firestore) => handler
try {
  const sessionRoute = require('./routes/session')(admin, firestore);
  app.post('/session', sessionRoute);
  console.log('POST /session route registered');
} catch (e) {
  console.warn('Failed to register /session route:', e);
}

// Middleware: verify Firebase ID token (if admin configured)
async function verifyFirebaseToken(req, res, next) {
  if (!admin) return next(); // skip verification if not configured
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const match = String(authHeader).match(/Bearer (.+)/);
    if (!match) return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    const idToken = match[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.firebaseUser = decoded; // { uid, email, name, ... }
    return next();
  } catch (err) {
    console.error('Token verify error:', err && err.message ? err.message : err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Helper: create signed URL (preferred for private buckets), fallback to public URL
async function makeFileUrl(pathOnBucket, { expires = 60 * 60 } = {}) {
  if (!supabase) return null;
  try {
    // Try signed URL first (for private buckets)
    try {
      const { data: signedData, error: signedError } = await supabase.storage.from(supabaseBucket).createSignedUrl(pathOnBucket, expires);
      if (!signedError && signedData && (signedData.signedUrl || signedData.signedURL)) {
        return signedData.signedUrl || signedData.signedURL;
      }
      // signedError may indicate object missing or permission issues
    } catch (err) {
      // continue to try public URL
      console.warn('createSignedUrl call failed:', err && err.message ? err.message : err);
    }

    // Fallback to public URL (works if bucket is public)
    try {
      const { data } = supabase.storage.from(supabaseBucket).getPublicUrl(pathOnBucket);
      if (data && (data.publicUrl || data.publicURL)) return data.publicUrl || data.publicURL;
    } catch (err) {
      // ignore
    }
    return null;
  } catch (err) {
    console.warn('makeFileUrl error:', err && err.message ? err.message : err);
    return null;
  }
}

// Helper: canonicalize org name for comparisons
function canonicalOrgName(name) {
  try {
    return String(name || '').trim().toLowerCase();
  } catch (e) {
    return String(name || '').trim();
  }
}

// Helper: normalize arbitrary filter strings for matching (trim, collapse whitespace, lower-case)
function normalizeFilterValue(val) {
  try {
    return String(val || '').trim().replace(/\s+/g, ' ').toLowerCase();
  } catch (e) {
    return String(val || '').trim().toLowerCase();
  }
}

// Helper: upsert organization by name (returns the org object)
async function upsertOrganizationByName(orgName, { displayName = null, logoUrl = null, contactEmail = null, metadata = null } = {}) {
  if (!orgName) return null;
  const canon = canonicalOrgName(orgName);
  const db = readDB();
  db.organizations = db.organizations || [];

  // Find existing org by canonical name
  let existing = db.organizations.find(o => (o.canonicalName || canonicalOrgName(o.name)) === canon);
  if (existing) {
    // Optionally merge displayName/logo/contact if provided and missing
    let changed = false;
    if (displayName && !existing.displayName) { existing.displayName = displayName; changed = true; }
    if (logoUrl && !existing.logoUrl) { existing.logoUrl = logoUrl; changed = true; }
    if (contactEmail && !existing.contactEmail) { existing.contactEmail = contactEmail; changed = true; }
    if (metadata && !existing.metadata) { existing.metadata = metadata; changed = true; }
    if (changed) {
      existing.updatedAt = new Date().toISOString();
      writeDB(db);
      if (firestore) {
        firestore.collection('organizations').doc(existing.id).set(existing, { merge: true }).catch(err => {
          console.warn('Firestore update on organization failed:', err);
        });
      }
    }
    return existing;
  }

  // Create new org
  const org = {
    id: uuidv4(),
    name: String(orgName),
    canonicalName: canon,
    displayName: displayName || String(orgName),
    logoUrl: logoUrl || null,
    contactEmail: contactEmail || null,
    metadata: metadata || {},
    createdAt: new Date().toISOString()
  };

  db.organizations.unshift(org);
  writeDB(db);

  if (firestore) {
    try {
      await firestore.collection('organizations').doc(org.id).set(org);
    } catch (err) {
      console.warn('Failed to persist organization to Firestore:', err && err.message ? err.message : err);
    }
  }

  return org;
}

// Helper: get org by id (Firestore preferred, fallback to local)
async function getOrgById(orgId) {
  if (!orgId) return null;
  if (firestore) {
    try {
      const doc = await firestore.collection('organizations').doc(String(orgId)).get();
      if (doc.exists) return doc.data();
    } catch (e) { /* ignore */ }
  }
  const db = readDB();
  return (db.organizations || []).find(o => o.id === orgId || o.name === orgId) || null;
}

// Helper: get user by uid (Firestore preferred, fallback to local data.json)
async function getUserByUid(uid) {
  if (!uid) return null;
  if (firestore) {
    try {
      const doc = await firestore.collection('users').doc(String(uid)).get();
      if (doc.exists) return doc.data();
    } catch (e) {
      console.warn('getUserByUid firestore error:', e);
    }
  }
  // fallback to local DB
  try {
    const db = readDB();
    if (db.users && db.users[uid]) return db.users[uid];
  } catch (e) {
    // ignore
  }
  return null;
}

// ----------------------
// Helper: Firestore-backed read helpers (used when Firestore is configured)
// ----------------------
async function listEventsFirestore(orgFilter = null) {
  if (!firestore) return null;
  try {
    let q = firestore.collection('events');
    // support filtering by org (name) OR orgId (id)
    if (orgFilter && typeof orgFilter === 'object') {
      if (orgFilter.orgId) q = q.where('orgId', '==', orgFilter.orgId);
      else if (orgFilter.orgName) q = q.where('org', '==', orgFilter.orgName);
    } else if (orgFilter) {
      // legacy: treat as org name
      q = q.where('org', '==', String(orgFilter));
    }
    const snap = await q.get();
    return snap.docs.map(d => d.data());
  } catch (err) {
    console.warn('listEventsFirestore failed:', err);
    return null;
  }
}

async function getEventFirestoreById(id) {
  if (!firestore) return null;
  try {
    const doc = await firestore.collection('events').doc(id).get();
    return doc.exists ? doc.data() : null;
  } catch (err) {
    console.warn('getEventFirestoreById failed:', err);
    return null;
  }
}

async function listOrgsFirestore() {
  if (!firestore) return null;
  try {
    const snap = await firestore.collection('organizations').get();
    return snap.docs.map(d => d.data());
  } catch (err) {
    console.warn('listOrgsFirestore failed:', err);
    return null;
  }
}

async function listPaymentsFirestoreFiltered({ eventId = null } = {}) {
  if (!firestore) return null;
  try {
    let q = firestore.collection('payments');
    if (eventId) q = q.where('eventId', '==', String(eventId));
    const snap = await q.get();
    return snap.docs.map(d => d.data());
  } catch (err) {
    console.warn('listPaymentsFirestoreFiltered failed:', err);
    return null;
  }
}

async function listPaymentsFirestore() {
  if (!firestore) return null;
  try {
    const snap = await firestore.collection('payments').get();
    return snap.docs.map(d => d.data());
  } catch (err) {
    console.warn('listPaymentsFirestore failed:', err);
    return null;
  }
}

async function listPaymentsForUserFirestore(uid, email) {
  if (!firestore) return null;
  try {
    if (uid) {
      const snap = await firestore.collection('payments').where('submittedByUid', '==', uid).get();
      return snap.docs.map(d => d.data());
    }
    if (email) {
      const snap = await firestore.collection('payments').where('submittedByEmail', '==', email).get();
      return snap.docs.map(d => d.data());
    }
    return [];
  } catch (err) {
    console.warn('listPaymentsForUserFirestore failed:', err);
    return null;
  }
}

// ----------------------
// Organizations endpoints (NEW)
// - GET /api/orgs
// - GET /api/orgs/:id
// - POST /api/orgs
// - PUT /api/orgs/:id
// - DELETE /api/orgs/:id
// Organizations are stored in local data.json and in Firestore collection 'organizations' when configured.
// These endpoints are intentionally public for now (no verifyFirebaseToken). Add verifyFirebaseToken if you want to restrict changes.
// ----------------------

// Helper to dedupe organization objects by canonicalName and merge basic fields
function dedupeOrgsArray(orgs) {
  const map = new Map(); // canonicalName -> org object
  for (const o of orgs || []) {
    const name = o && (o.name || o.displayName || o.id || '');
    const canon = canonicalOrgName(o && (o.canonicalName || name));
    if (!canon) continue;
    if (!map.has(canon)) {
      // shallow clone
      map.set(canon, Object.assign({}, o, { canonicalName: canon }));
    } else {
      const existing = map.get(canon);
      // merge fields conservatively
      if (!existing.id && o.id) existing.id = o.id;
      if ((!existing.displayName || existing.displayName === existing.name) && o.displayName && o.displayName !== o.name) existing.displayName = o.displayName;
      if ((!existing.name || existing.name === existing.displayName) && o.name && o.name !== o.displayName) existing.name = o.name;
      if (!existing.logoUrl && o.logoUrl) existing.logoUrl = o.logoUrl;
      if (!existing.contactEmail && o.contactEmail) existing.contactEmail = o.contactEmail;
      if (!existing.metadata && o.metadata) existing.metadata = o.metadata;
      // earliest createdAt
      try {
        const ea = existing.createdAt ? new Date(existing.createdAt).getTime() : Infinity;
        const oa = o.createdAt ? new Date(o.createdAt).getTime() : Infinity;
        if ((!existing.createdAt || (oa && oa < ea)) && o.createdAt) existing.createdAt = o.createdAt;
      } catch (e) { /* ignore */ }
    }
  }
  return Array.from(map.values());
}

// GET /api/orgs - return list of organizations (deduped by canonicalName)
app.get('/api/orgs', async (req, res) => {
  try {
    if (firestore) {
      const orgs = await listOrgsFirestore();
      if (Array.isArray(orgs)) {
        const deduped = dedupeOrgsArray(orgs);
        return res.json(deduped);
      }
      // else fallthrough to local
    }

    const db = readDB();
    let orgs = (db.organizations || []).map(o => ({ ...o }));
    // If no explicit organizations exist, derive from events (helpful fallback)
    if ((!orgs || orgs.length === 0) && Array.isArray(db.events) && db.events.length > 0) {
      const names = Array.from(new Set(db.events.map(e => e.org).filter(Boolean)));
      orgs = names.map(n => ({ id: n, name: n, displayName: n, canonicalName: canonicalOrgName(n), createdAt: null }));
    }

    // Deduplicate local list as well before returning
    const dedupedLocal = dedupeOrgsArray(orgs);
    return res.json(dedupedLocal);
  } catch (err) {
    console.error('GET /api/orgs error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/orgs/:id - get single org
app.get('/api/orgs/:id', async (req, res) => {
  try {
    if (firestore) {
      try {
        const doc = await firestore.collection('organizations').doc(req.params.id).get();
        if (doc.exists) return res.json(doc.data());
      } catch (e) {
        // ignore and fallback
      }
    }
    const db = readDB();
    const org = (db.organizations || []).find(o => o.id === req.params.id || o.name === req.params.id);
    if (!org) return res.status(404).json({ error: 'not found' });
    return res.json(org);
  } catch (err) {
    console.error('GET /api/orgs/:id error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/orgs - create organization (idempotent/upsert by canonical name)
app.post('/api/orgs', async (req, res) => {
  try {
    const { name, displayName, logoUrl, contactEmail, metadata } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const org = await upsertOrganizationByName(name, { displayName, logoUrl, contactEmail, metadata });
    return res.json(org);
  } catch (err) {
    console.error('POST /api/orgs error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/orgs/:id - update organization (partial)
app.put('/api/orgs/:id', async (req, res) => {
  try {
    const db = readDB();
    db.organizations = db.organizations || [];
    const idx = db.organizations.findIndex(o => o.id === req.params.id || o.name === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    const update = req.body || {};
    const allowed = ['name', 'displayName', 'logoUrl', 'contactEmail', 'metadata'];
    allowed.forEach(k => {
      if (typeof update[k] !== 'undefined') db.organizations[idx][k] = update[k];
    });
    // Refresh canonicalName if name changed
    if (update.name) db.organizations[idx].canonicalName = canonicalOrgName(update.name);
    db.organizations[idx].updatedAt = new Date().toISOString();

    writeDB(db);

    if (firestore) {
      firestore.collection('organizations').doc(db.organizations[idx].id).set(db.organizations[idx], { merge: true }).catch(err => {
        console.warn('Firestore update on organization failed:', err);
      });
    }

    return res.json(db.organizations[idx]);
  } catch (err) {
    console.error('PUT /api/orgs/:id error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/orgs/:id - delete organization
app.delete('/api/orgs/:id', async (req, res) => {
  try {
    const db = readDB();
    db.organizations = db.organizations || [];
    const idx = db.organizations.findIndex(o => o.id === req.params.id || o.name === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    const removed = db.organizations.splice(idx, 1)[0];
    writeDB(db);

    if (firestore) {
      firestore.collection('organizations').doc(removed.id).delete().catch(err => {
        console.warn('Firestore delete organization failed:', err);
      });
    }

    return res.json({ ok: true, id: removed.id });
  } catch (err) {
    console.error('DELETE /api/orgs/:id error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ----------------------
// Officer profiles endpoints
// - GET /api/officer-profiles            -> list all or filter by ?org= or ?orgId=
// - GET /api/officer-profiles/:id        -> get profile by id (orgId or canonical org name)
// - POST /api/officer-profiles           -> upsert profile (requires auth when Firebase admin is configured)
// Stored in Firestore collection 'officerProfiles' when available, otherwise in data.json.officerProfiles (object keyed by canonical org name)
// ----------------------

function canonicalKeyForOrg(orgName) {
  return canonicalOrgName(orgName || '');
}

async function readOfficerProfilesFromDB() {
  const db = readDB();
  // store as object keyed by canonical org name -> profile object
  return db.officerProfiles || {};
}

async function writeOfficerProfilesToDB(mapObj) {
  const db = readDB();
  db.officerProfiles = mapObj || {};
  writeDB(db);
}

async function upsertOfficerProfileToFirestore(orgKey, payload) {
  // orgKey: prefer orgId if provided else canonical org name
  if (!firestore) throw new Error('Firestore not configured');
  try {
    const docId = String(orgKey);
    const docRef = firestore.collection('officerProfiles').doc(docId);
    const toSave = Object.assign({}, payload, { id: docId, orgKey });
    await docRef.set(toSave, { merge: true });
    return toSave;
  } catch (err) {
    throw err;
  }
}

async function getOfficerProfileFromFirestoreByKey(orgKey) {
  if (!firestore) return null;
  try {
    const doc = await firestore.collection('officerProfiles').doc(String(orgKey)).get();
    if (!doc.exists) return null;
    return doc.data();
  } catch (err) {
    console.warn('getOfficerProfileFromFirestoreByKey error:', err);
    return null;
  }
}

async function listOfficerProfilesFromFirestore() {
  if (!firestore) return [];
  try {
    const snap = await firestore.collection('officerProfiles').get();
    return snap.docs.map(d => d.data());
  } catch (err) {
    console.warn('listOfficerProfilesFromFirestore error:', err);
    return [];
  }
}

// GET /api/officer-profiles
app.get('/api/officer-profiles', async (req, res) => {
  try {
    const orgQuery = req.query.org ? String(req.query.org) : null;
    const orgIdQuery = req.query.orgId ? String(req.query.orgId) : null;

    if (firestore) {
      // if filtering, try to read specific doc
      if (orgIdQuery) {
        const doc = await getOfficerProfileFromFirestoreByKey(orgIdQuery);
        return res.json(doc ? [doc] : []);
      }
      if (orgQuery) {
        const key = canonicalKeyForOrg(orgQuery);
        const doc = await getOfficerProfileFromFirestoreByKey(key);
        return res.json(doc ? [doc] : []);
      }
      const list = await listOfficerProfilesFromFirestore();
      return res.json(list);
    }

    // fallback: read from local data.json
    const map = await readOfficerProfilesFromDB();
    if (orgIdQuery) {
      const p = map[orgIdQuery] || null;
      return res.json(p ? [p] : []);
    }
    if (orgQuery) {
      const key = canonicalKeyForOrg(orgQuery);
      const p = map[key] || null;
      return res.json(p ? [p] : []);
    }
    // return all values
    const vals = Object.keys(map).map(k => map[k]);
    return res.json(vals);
  } catch (err) {
    console.error('GET /api/officer-profiles error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/officer-profiles/:id
app.get('/api/officer-profiles/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (firestore) {
      const doc = await getOfficerProfileFromFirestoreByKey(id);
      if (!doc) return res.status(404).json({ error: 'not found' });
      return res.json(doc);
    }
    const map = await readOfficerProfilesFromDB();
    const profile = map[id] || map[canonicalKeyForOrg(id)] || null;
    if (!profile) return res.status(404).json({ error: 'not found' });
    return res.json(profile);
  } catch (err) {
    console.error('GET /api/officer-profiles/:id error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/officer-profiles - upsert profile
// Body: { org, orgId (optional), profile: { name: {surname,given,middle}, designation, year, college, department, program, photoURL, username } }
// Requires authentication when Firebase admin is configured (verifyFirebaseToken). When admin not configured, endpoint still works (no auth).
app.post('/api/officer-profiles', verifyFirebaseToken, async (req, res) => {
  try {
    const body = req.body || {};
    const org = body.org || null;
    const orgId = body.orgId || null;
    const profile = body.profile || body; // allow full profile in root
    if (!org && !orgId) return res.status(400).json({ error: 'org or orgId is required' });

    // Normalize key: prefer orgId as key else canonical org name
    const key = orgId ? String(orgId) : canonicalKeyForOrg(org);

    // Build profile object to persist
    const profileObj = Object.assign({}, profile, {
      org: org || profile.org || '',
      orgId: orgId || profile.orgId || null,
      updatedAt: new Date().toISOString()
    });

    // Persist to local data.json map (non-blocking for firestore path)
    try {
      const map = await readOfficerProfilesFromDB();
      map[key] = Object.assign({}, map[key] || {}, profileObj);
      await writeOfficerProfilesToDB(map);
    } catch (e) {
      console.warn('Failed to write officer profile to local DB:', e);
    }

    // Persist to Firestore if configured
    if (firestore) {
      try {
        // Use orgId as document id when present else canonical org name
        const docId = key;
        await upsertOfficerProfileToFirestore(docId, profileObj);
      } catch (e) {
        console.warn('Failed to persist officer profile to Firestore:', e);
      }
    }

    // Signal other tabs/clients via localStorage key if running in same browser (server can't set localStorage on clients)
    // Client code already writes orgsLastUpdated when saving locally; keep that behavior on client.
    console.log('Officer profile upserted for key=', key);
    return res.json(map[key] || profileObj);
  } catch (err) {
    console.error('POST /api/officer-profiles error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ----------------------
// New: GET /api/my-profile - returns the authenticated user's stored profile (users/{uid}.profile)
// Requires verifyFirebaseToken. Falls back to local data.json users map when Firestore not configured.
// Response: { uid, profile, role }
// ----------------------
app.get('/api/my-profile', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.firebaseUser && req.firebaseUser.uid;
    if (!uid) return res.status(401).json({ error: 'not authenticated' });

    if (firestore) {
      try {
        const doc = await firestore.collection('users').doc(uid).get();
        if (doc.exists) {
          const data = doc.data();
          const profile = data.profile || null;
          const role = data.role || null;
          return res.json({ uid, profile, role });
        }
      } catch (e) {
        console.warn('GET /api/my-profile firestore read failed:', e);
        // fallthrough to local fallback
      }
    }

    // Local fallback: read from data.json users map if present
    try {
      const db = readDB();
      if (db.users && db.users[uid]) {
        const userRec = db.users[uid];
        const profile = userRec.profile || userRec || null;
        const role = userRec.role || null;
        return res.json({ uid, profile, role });
      }
    } catch (e) {
      // ignore and return empty
    }

    return res.json({ uid, profile: null, role: null });
  } catch (err) {
    console.error('GET /api/my-profile error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ----------------------
// Events endpoints (NEW)
// - GET /api/events (supports optional ?org=ORG_NAME or ?orgId=ORG_ID filter)
// - POST /api/events (multipart support)
// - PUT /api/events/:id (multipart support added)
// - DELETE /api/events/:id
// These use the local data.json fallback (db.events) and also persist to Firestore if configured.
// When Firestore is configured, GET endpoints will read from Firestore.
// ----------------------

// GET /api/events - list all events (server-authoritative); supports optional org filter (by name) or orgId
app.get('/api/events', async (req, res) => {
  try {
    const orgFilter = req.query.org ? String(req.query.org) : null;
    const orgIdFilter = req.query.orgId ? String(req.query.orgId) : null;

    if (firestore) {
      // prefer Firestore read; support filtering by orgId or org (name)
      const events = await listEventsFirestore(orgIdFilter ? { orgId: orgIdFilter } : (orgFilter ? { orgName: orgFilter } : null));
      if (Array.isArray(events)) {
        return res.json(events);
      }
      // else fallthrough to local DB
    }

    const db = readDB();
    let events = (db.events || []).map(e => ({ ...e }));
    if (orgIdFilter) events = events.filter(ev => ev.orgId === orgIdFilter);
    if (orgFilter) events = events.filter(ev => ev && ev.org === orgFilter);
    // return a shallow clone to avoid accidental mutation
    res.json(events);
  } catch (err) {
    console.error('GET /api/events error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/events/:id - single event
app.get('/api/events/:id', async (req, res) => {
  try {
    // Try Firestore first
    if (firestore) {
      const ev = await getEventFirestoreById(req.params.id);
      if (ev) {
        // Attempt to inject fresh signed URL for receiver QR when possible (so clients get usable QR)
        try {
          if (ev.receiver && ev.receiver.qrObjectPath) {
            const signed = await makeFileUrl(ev.receiver.qrObjectPath);
            if (signed) ev.receiver.qr = signed;
          } else if (ev.receiver && ev.receiver.qrObjectIsLocal && ev.receiver.qrObjectPath) {
            ev.receiver.qr = `${req.protocol}://${req.get('host')}/uploads/${ev.receiver.qrObjectPath}`;
          }
        } catch (e) { /* ignore signed url failure */ }
        return res.json(ev);
      }
      // else fallthrough to local
    }

    const db = readDB();
    const ev = (db.events || []).find(x => x.id === req.params.id);
    if (!ev) return res.status(404).json({ error: 'not found' });

    // Attempt to inject fresh signed URL for local-stored event receiver
    try {
      if (ev.receiver && ev.receiver.qrObjectPath) {
        const signed = await makeFileUrl(ev.receiver.qrObjectPath);
        if (signed) ev.receiver.qr = signed;
      } else if (ev.receiver && ev.receiver.qrObjectIsLocal && ev.receiver.qrObjectPath) {
        ev.receiver.qr = `${req.protocol}://${req.get('host')}/uploads/${ev.receiver.qrObjectPath}`;
      }
    } catch (e) { /* ignore signed url failure */ }

    res.json(ev);
  } catch (err) {
    console.error('GET /api/events/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// NEW endpoint: GET /api/events/:id/qr-url - return a fresh signed URL (or local URL) for an event's receiver QR
app.get('/api/events/:id/qr-url', async (req, res) => {
  try {
    const id = req.params.id;
    let ev = null;

    if (firestore) {
      ev = await getEventFirestoreById(id);
    }
    if (!ev) {
      const db = readDB();
      ev = (db.events || []).find(x => x.id === id);
    }

    if (!ev) return res.status(404).json({ error: 'not found' });

    const receiver = ev.receiver || {};
    // Prefer explicit local flag
    if (receiver.qrObjectIsLocal && receiver.qrObjectPath) {
      const url = `${req.protocol}://${req.get('host')}/uploads/${receiver.qrObjectPath}`;
      return res.json({ url, expiresIn: 0, local: true });
    }

    // If object path available, try to create a signed URL (Supabase) or public URL
    const objectPath = receiver.qrObjectPath || null;
    if (!objectPath) {
      // If event stored a data URL in receiver.qr (base64) return that as-is
      if (receiver.qr && String(receiver.qr).startsWith('data:')) {
        return res.json({ url: receiver.qr, expiresIn: 0, local: true });
      }
      return res.status(404).json({ error: 'no qr object path' });
    }

    if (!supabase) {
      return res.status(500).json({ error: 'storage not configured' });
    }

    const ttl = 60 * 60; // 1 hour
    // Use makeFileUrl helper for signed URL creation (it tries signed URL then public)
    try {
      const url = await makeFileUrl(objectPath, { expires: ttl });
      if (!url) {
        console.warn('makeFileUrl returned null for', objectPath);
        return res.status(500).json({ error: 'could not create signed url' });
      }
      return res.json({ url, expiresIn: ttl, local: false });
    } catch (e) {
      console.warn('Failed to create signed URL for event QR:', e);
      return res.status(500).json({ error: 'could not create signed url' });
    }
  } catch (err) {
    console.error('GET /api/events/:id/qr-url error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/events - create event (accept JSON body OR multipart/form-data with receiverQR file)
// Accepts either org (name) or orgId (canonical) from client. If orgId provided, server will resolve org name if possible.
app.post('/api/events', upload.single('receiverQR'), async (req, res) => {
  try {
    // Accept both JSON and multipart/form-data
    // If multipart, form fields come in req.body as strings; receiver may be passed as JSON string
    let { name, fee, deadline } = req.body || {};
    let org = req.body && req.body.org ? req.body.org : null;
    const orgIdFromClient = req.body && req.body.orgId ? req.body.orgId : null;
    let receiver = req.body && req.body.receiver ? req.body.receiver : null;

    // If receiver is a JSON string (sent by the client), parse it
    if (receiver && typeof receiver === 'string') {
      try { receiver = JSON.parse(receiver); } catch (e) { /* leave as string fallback */ }
    }

    // Validate required fields
    if (!name || (!org && !orgIdFromClient)) {
      return res.status(400).json({ error: 'name and org or orgId are required' });
    }

    // Normalize values
    name = String(name);
    fee = typeof fee !== 'undefined' ? Number(fee) : 0;
    deadline = deadline || null;

    // Resolve org: prefer orgId if provided
    let orgObj = null;
    if (orgIdFromClient) {
      orgObj = await getOrgById(orgIdFromClient);
      if (!orgObj && org) orgObj = await upsertOrganizationByName(org, { displayName: org });
    } else if (org) {
      orgObj = await upsertOrganizationByName(org, { displayName: org });
    }

    const newEvent = {
      id: uuidv4(),
      name,
      fee,
      deadline,
      status: 'Open',
      orgId: orgObj && orgObj.id ? orgObj.id : null,
      org: orgObj && orgObj.name ? orgObj.name : (org || ''),
      receiver: receiver && typeof receiver === 'object' ? Object.assign({}, receiver) : (receiver || {}),
      createdAt: new Date().toISOString()
    };

    // If a file was uploaded under 'receiverQR', upload to Supabase (or save locally)
    if (req.file) {
      try {
        const ext = path.extname(req.file.originalname) || '';
        const objectPath = `events/receiver_qr/${newEvent.id}${ext || '.png'}`;

        if (supabase) {
          const { data, error } = await supabase.storage.from(supabaseBucket).upload(objectPath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
          if (error) {
            console.warn('Supabase upload error for event QR:', error);
            // fallback to saving locally below
          } else {
            const storedPath = data && (data.path || data.Key || data.name) ? (data.path || data.Key || data.name) : objectPath;
            // store the object path in receiver.qrObjectPath so clients can request signed URLs
            newEvent.receiver = Object.assign({}, newEvent.receiver || {}, { qrObjectPath: storedPath });
            // Optionally add a temporary signed url for immediate client display (non-persistent)
            try {
              const signed = await makeFileUrl(storedPath);
              if (signed) newEvent.receiver.qr = signed;
            } catch (e) { /* ignore signed url failure */ }
          }
        } else {
          // Supabase not configured: write file to local uploads/ and set local path
          const filename = `${newEvent.id}${ext || '.png'}`;
          const dest = path.join(UPLOADS_DIR, filename);
          fs.writeFileSync(dest, req.file.buffer);
          newEvent.receiver = Object.assign({}, newEvent.receiver || {}, { qr: `${req.protocol}://${req.get('host')}/uploads/${filename}`, qrObjectIsLocal: true, qrObjectPath: filename });
        }
      } catch (err) {
        console.warn('Error handling uploaded receiverQR file:', err && err.message ? err.message : err);
      }
    } else {
      // No file uploaded; if client sent a data URL in receiver.qr (base64), leave it as-is for now.
      // We'll keep the data URL in receiver.qr (existing behavior) unless you later want to migrate them.
    }

    // Persist to local DB
    const db = readDB();
    db.events = db.events || [];
    db.events.unshift(newEvent);
    writeDB(db);

    // Auto-create/upsert organization record for this event's org (already handled above)
    try {
      if (!orgObj && newEvent.org) await upsertOrganizationByName(newEvent.org, { displayName: newEvent.org });
    } catch (err) {
      console.warn('Failed to upsert organization on event create:', err && err.message ? err.message : err);
    }

    // Persist to Firestore (non-blocking)
    if (firestore) {
      try {
        await firestore.collection('events').doc(newEvent.id).set(newEvent);
      } catch (err) {
        console.warn('Failed to persist event to Firestore:', err && err.message ? err.message : err);
      }
    }

    // Return created event to client
    return res.json(newEvent);
  } catch (err) {
    console.error('POST /api/events error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/events/:id - update event (partial) - now supports multipart (receiverQR) as well as JSON
app.put('/api/events/:id', upload.single('receiverQR'), async (req, res) => {
  try {
    const db = readDB();
    db.events = db.events || [];
    const idx = db.events.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    // req.body may be JSON (Content-Type: application/json) or strings (multipart)
    let update = req.body || {};

    // If receiver is a JSON string (from multipart), parse it
    if (update && update.receiver && typeof update.receiver === 'string') {
      try { update.receiver = JSON.parse(update.receiver); } catch (e) { /* leave as string if parse fails */ }
    }

    // If orgId or org provided, resolve canonical org and set orgId/org
    if (update.orgId || update.org) {
      let orgObj = null;
      if (update.orgId) orgObj = await getOrgById(update.orgId);
      if (!orgObj && update.org) orgObj = await upsertOrganizationByName(update.org, { displayName: update.org });
      if (orgObj) {
        db.events[idx].orgId = orgObj.id;
        db.events[idx].org = orgObj.name;
      } else if (update.org) {
        db.events[idx].org = update.org;
      }
    }

    // allow updating name, fee, deadline, status, receiver, org
    const allowed = ['name', 'fee', 'deadline', 'status', 'receiver', 'org'];
    allowed.forEach(k => {
      if (typeof update[k] !== 'undefined') {
        // For numeric fields like fee, coerce appropriately if needed
        if (k === 'fee') {
          db.events[idx][k] = Number(update[k]);
        } else {
          db.events[idx][k] = update[k];
        }
      }
    });

    // If a file was uploaded under 'receiverQR', upload/replace to Supabase (or save locally)
    if (req.file) {
      try {
        const ext = path.extname(req.file.originalname) || '';
        const objectPath = `events/receiver_qr/${req.params.id}${ext || '.png'}`; // use event id to replace

        if (supabase) {
          // Use upsert:true to allow replacing existing object
          const { data, error } = await supabase.storage.from(supabaseBucket).upload(objectPath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
          if (error) {
            console.warn('Supabase upload error for event QR (update):', error);
          } else {
            const storedPath = data && (data.path || data.Key || data.name) ? (data.path || data.Key || data.name) : objectPath;
            db.events[idx].receiver = Object.assign({}, db.events[idx].receiver || {}, { qrObjectPath: storedPath });
            // Optionally add a temporary signed url for immediate client display (non-persistent)
            try {
              const signed = await makeFileUrl(storedPath);
              if (signed) db.events[idx].receiver.qr = signed;
            } catch (e) { /* ignore signed url failure */ }
          }
        } else {
          // Supabase not configured: write file to local uploads/ and set local path
          const filename = `${req.params.id}${ext || '.png'}`;
          const dest = path.join(UPLOADS_DIR, filename);
          fs.writeFileSync(dest, req.file.buffer);
          db.events[idx].receiver = Object.assign({}, db.events[idx].receiver || {}, { qr: `${req.protocol}://${req.get('host')}/uploads/${filename}`, qrObjectIsLocal: true, qrObjectPath: filename });
        }
      } catch (err) {
        console.warn('Error handling uploaded receiverQR file on update:', err && err.message ? err.message : err);
      }
    }

    db.events[idx].updatedAt = new Date().toISOString();

    // If org changed, ensure organization exists (already handled above)
    try {
      if (update.org) {
        await upsertOrganizationByName(update.org, { displayName: update.org });
      }
    } catch (e) {
      console.warn('Failed to upsert organization on event update:', e);
    }

    writeDB(db);

    if (firestore) {
      firestore.collection('events').doc(db.events[idx].id).set(db.events[idx], { merge: true }).catch(err => {
        console.warn('Firestore update on event failed:', err);
      });
    }

    return res.json(db.events[idx]);
  } catch (err) {
    console.error('PUT /api/events/:id error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/events/:id - delete event
app.delete('/api/events/:id', async (req, res) => {
  try {
    const db = readDB();
    db.events = db.events || [];
    const idx = db.events.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    const removed = db.events.splice(idx, 1)[0];
    writeDB(db);

    if (firestore) {
      firestore.collection('events').doc(removed.id).delete().catch(err => {
        console.warn('Firestore delete event failed:', err);
      });
    }

    return res.json({ ok: true, id: removed.id });
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ----------------------
// Payments endpoints (existing)
// ----------------------

// GET /api/payments - list all payments (inject signed URLs when possible)
// Supports optional server-side filtering when query params (eventId, year, block) are provided.
// If no filter params are provided, returns the legacy array shape for backward compatibility.
// If filter params are provided, returns an object: { payments: [...], totals: {...}, availableFilters: {...} }
app.get('/api/payments', async (req, res) => {
  try {
    // parse filter query params
    const eventId = req.query.eventId || req.query.event_id || null;
    // year and block may be provided multiple times or as comma-separated lists
    const rawYears = req.query.year || req.query.years || null;
    const rawBlocks = req.query.block || req.query.blocks || null;

    function toArrayOrNull(raw) {
      if (!raw && raw !== 0) return null;
      if (Array.isArray(raw)) return raw;
      // comma-separated
      return String(raw).split(',').map(s => s.trim()).filter(Boolean);
    }

    const yearsArr = toArrayOrNull(rawYears);
    const blocksArr = toArrayOrNull(rawBlocks);

    const hasFilter = Boolean(eventId || (yearsArr && yearsArr.length > 0) || (blocksArr && blocksArr.length > 0));

    // Helper to normalize string for comparison
    const normalize = (v) => normalizeFilterValue(v);

    // Fetch payments source depending on Firestore vs local
    let paymentsSource = null;
    if (firestore) {
      // If eventId present, narrow by eventId in Firestore to reduce data transferred
      if (eventId) {
        const list = await listPaymentsFirestoreFiltered({ eventId });
        if (Array.isArray(list)) paymentsSource = list.map(p => (p && typeof p === 'object') ? Object.assign({}, p) : p);
      } else {
        const list = await listPaymentsFirestore();
        if (Array.isArray(list)) paymentsSource = list.map(p => (p && typeof p === 'object') ? Object.assign({}, p) : p);
      }
    }

    if (!paymentsSource) {
      const db = readDB();
      // If eventId provided and not using Firestore, narrow locally
      paymentsSource = (db.payments || []).map(p => Object.assign({}, p));
      if (eventId) {
        paymentsSource = paymentsSource.filter(p => p.eventId === eventId || p.event === eventId);
      }
    }

    // Derive availableFilters (distinct years/blocks) from event-scoped payments (prefer event-scoped if eventId provided)
    const availableYearsSet = new Set();
    const availableBlocksSet = new Set();
    paymentsSource.forEach(p => {
      if (p.studentYear) availableYearsSet.add(String(p.studentYear).trim());
      if (p.studentBlock) availableBlocksSet.add(String(p.studentBlock).trim());
    });

    const availableFilters = {
      years: Array.from(availableYearsSet).sort(),
      blocks: Array.from(availableBlocksSet).sort()
    };

    // If no filters requested, maintain legacy behavior by returning array (but still inject proofFile URLs)
    if (!hasFilter) {
      // Inject proofFile signed URLs where possible (async)
      if (supabase) {
        await Promise.all(paymentsSource.map(async (p) => {
          if (p.proofObjectPath) {
            try {
              const url = await makeFileUrl(p.proofObjectPath);
              if (url) p.proofFile = url;
            } catch (err) {
              console.warn('Failed to create signed URL for', p.proofObjectPath, err && err.message ? err.message : err);
            }
          }
        }));
      }
      return res.json(paymentsSource);
    }

    // Otherwise apply server-side filtering with normalization
    const yearsNormalized = new Set((yearsArr || []).map(y => normalize(y)));
    const blocksNormalized = new Set((blocksArr || []).map(b => normalize(b)));

    const filtered = paymentsSource.filter(p => {
      // Year filter: if specified, require match; else allow
      if (yearsNormalized.size > 0) {
        const py = normalize(p.studentYear || p.year || '');
        if (!yearsNormalized.has(py)) return false;
      }
      // Block filter: if specified, require normalized equality
      if (blocksNormalized.size > 0) {
        const pb = normalize(p.studentBlock || p.block || '');
        if (!blocksNormalized.has(pb)) return false;
      }
      return true;
    });

    // Inject proofFile signed URLs where possible
    if (supabase) {
      await Promise.all(filtered.map(async (p) => {
        if (p.proofObjectPath) {
          try {
            const url = await makeFileUrl(p.proofObjectPath);
            if (url) p.proofFile = url;
          } catch (err) {
            console.warn('Failed to create signed URL for', p.proofObjectPath, err && err.message ? err.message : err);
          }
        }
      }));
    }

    // Compute totals for filtered set
    let totalCount = filtered.length;
    let approvedCount = 0;
    let totalAmount = 0;
    filtered.forEach(p => {
      if (p.status && String(p.status).toLowerCase() === 'approved') approvedCount++;
      const amt = parseFloat(p.amount || 0) || 0;
      totalAmount += amt;
    });

    // Return advanced response shape for filtered queries
    return res.json({
      payments: filtered,
      totals: {
        totalCount,
        approvedCount,
        totalAmount
      },
      availableFilters
    });
  } catch (err) {
    console.error('GET /api/payments error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/my-payments - payments for authenticated user (returns signed URLs)
app.get('/api/my-payments', verifyFirebaseToken, async (req, res) => {
  try {
    const uid = req.firebaseUser && req.firebaseUser.uid;
    const email = req.firebaseUser && req.firebaseUser.email;

    if (firestore) {
      const list = await listPaymentsForUserFirestore(uid, email);
      if (Array.isArray(list)) {
        if (supabase) {
          await Promise.all(list.map(async (p) => {
            if (p.proofObjectPath) {
              try {
                const url = await makeFileUrl(p.proofObjectPath);
                if (url) p.proofFile = url;
              } catch (err) {
                console.warn('Failed to create signed URL for', p.proofObjectPath, err && err.message ? err.message : err);
              }
            }
          }));
        }
        return res.json(list);
      }
      // else fallthrough
    }

    const db = readDB();
    let list = db.payments.filter(p => (p.submittedByUid && p.submittedByUid === uid) || (p.submittedByEmail && p.submittedByEmail === email));

    if (supabase) {
      await Promise.all(list.map(async (p) => {
        if (p.proofObjectPath) {
          try {
            const url = await makeFileUrl(p.proofObjectPath);
            if (url) p.proofFile = url;
          } catch (err) {
            console.warn('Failed to create signed URL for', p.proofObjectPath, err && err.message ? err.message : err);
          }
        }
      }));
    }
    return res.json(list);
  } catch (err) {
    console.error('GET /api/my-payments error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/payments - create a payment with optional file 'proof'
app.post('/api/payments', verifyFirebaseToken, upload.single('proof'), async (req, res) => {
  try {
    const { name, amount, purpose } = req.body;
    if (!name || !amount) {
      return res.status(400).json({ error: 'name and amount are required' });
    }

    // Optional client fields
    const reference = req.body.reference || req.body.referenceNumber || req.body.ref || null;
    let org = req.body.org || null;
    let event = req.body.event || null;
    // new: accept canonical ids if provided
    const orgIdFromClient = req.body.orgId || req.body.org_id || null;
    const eventIdFromClient = req.body.eventId || req.body.event_id || null;

    const studentNameFromClient = req.body.studentName || req.body.student_name || null;
    const studentYear = req.body.studentYear || req.body.student_year || null;
    const studentCollege = req.body.studentCollege || req.body.student_college || null;
    const studentDepartment = req.body.studentDepartment || req.body.student_department || null;
    const studentProgram = req.body.studentProgram || req.body.student_program || null;
    // Accept block variations from client
    const studentBlock = req.body.studentBlock || req.body.student_block || req.body.block || null;

    // If client provided orgId but not org name, attempt to resolve org name for readability
    if (orgIdFromClient && !org) {
      try {
        const resolvedOrg = await getOrgById(orgIdFromClient);
        if (resolvedOrg && resolvedOrg.name) {
          org = resolvedOrg.name;
        }
      } catch (e) {
        // ignore resolution failure
      }
    }

    // If client provided eventId but not event name, attempt to resolve event name (Firestore preferred, fallback local)
    if (eventIdFromClient && !event) {
      try {
        let ev = null;
        if (firestore) {
          ev = await getEventFirestoreById(eventIdFromClient);
        }
        if (!ev) {
          const dbTmp = readDB();
          ev = (dbTmp.events || []).find(e => e.id === eventIdFromClient) || null;
        }
        if (ev && ev.name) event = ev.name;
      } catch (e) {
        // ignore resolution failure
      }
    }

    // Upload file to Supabase if configured
    let proofUrl = null; // url we may include in this response (signed/public), may expire
    let storedPath = null; // object path stored permanently in DB

    if (req.file && supabase) {
      try {
        const uid = (req.firebaseUser && req.firebaseUser.uid) ? req.firebaseUser.uid : 'anon';
        const ext = path.extname(req.file.originalname) || '';
        const objectPath = `proofs/${uid}/${Date.now()}-${uuidv4()}${ext}`;

        const { data, error } = await supabase.storage.from(supabaseBucket).upload(objectPath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
        if (error) {
          console.warn('Supabase upload error:', error);
        } else {
          // storedPath is object path; Supabase may return data with path/name
          storedPath = data && (data.path || data.Key || data.name) ? (data.path || data.Key || data.name) : objectPath;
          // generate a signed URL for immediate response (it will expire) - useful so client can show image immediately
          const url = await makeFileUrl(storedPath);
          if (url) proofUrl = url;
        }
      } catch (err) {
        console.warn('Supabase upload exception:', err && err.message ? err.message : err);
      }
    }

    // Fallback: save to local disk and return local URL
    if (!proofUrl && req.file) {
      const filename = `${uuidv4()}${path.extname(req.file.originalname) || ''}`;
      const dest = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(dest, req.file.buffer);
      storedPath = filename;
      proofUrl = `${req.protocol}://${req.get('host')}/uploads/${filename}`;
    }

    // Resolve student name/email from token if client didn't provide
    let resolvedStudentName = studentNameFromClient && studentNameFromClient.trim() ? studentNameFromClient.trim() : null;
    let submittedEmail = req.body.submittedByEmail || null;
    if ((!resolvedStudentName || resolvedStudentName === '') && req.firebaseUser) {
      resolvedStudentName = req.firebaseUser.name || req.firebaseUser.full_name || req.firebaseUser.displayName || null;
    }
    if (!submittedEmail && req.firebaseUser && req.firebaseUser.email) {
      submittedEmail = req.firebaseUser.email;
    }

    // Build payment object and persist
    const db = readDB();
    const payment = {
      id: uuidv4(),
      name,
      amount: parseFloat(amount),
      purpose: purpose || null,
      org: org || null,
      orgId: orgIdFromClient || null,    // persist canonical orgId when present
      event: event || null,
      eventId: eventIdFromClient || null, // persist canonical eventId when present
      reference: reference || null,
      // proofObjectPath stores either Supabase object path (for cloud) or local filename (if fallback)
      proofObjectPath: storedPath || null,
      // proofFile is a usable URL for immediate display (may be signed and expire)
      proofFile: proofUrl || null,
      proofObjectIsLocal: storedPath && !supabase ? true : false,
      status: 'pending',
      createdAt: new Date().toISOString(),
      notes: req.body.notes || '',
      studentName: resolvedStudentName || null,
      studentYear: studentYear || null,
      studentCollege: studentCollege || null,
      studentDepartment: studentDepartment || null,
      studentProgram: studentProgram || null,
      // persist student block so filters can use it
      studentBlock: studentBlock || null,
      submittedByUid: req.firebaseUser ? req.firebaseUser.uid : null,
      submittedByEmail: submittedEmail || null
    };

    db.payments.unshift(payment);
    writeDB(db);

    // Persist to Firestore (non-blocking)
    if (firestore) {
      try {
        await firestore.collection('payments').doc(payment.id).set(payment);
        if (payment.submittedByUid) {
          await firestore.collection('users').doc(payment.submittedByUid).collection('payments').doc(payment.id).set(payment);
        }
      } catch (err) {
        console.warn('Failed to persist payment to Firestore:', err && err.message ? err.message : err);
      }
    }

    console.log('Payment created', { id: payment.id, orgId: payment.orgId, eventId: payment.eventId, reference: payment.reference });

    // Return the created payment (includes proofFile for immediate viewing)
    return res.json(payment);
  } catch (err) {
    console.error('Error POST /api/payments:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/payments/:id/proof-url - return a fresh signed URL for a given payment (auth + authorization)
app.get('/api/payments/:id/proof-url', verifyFirebaseToken, async (req, res) => {
  try {
    // Prefer Firestore lookup when available
    let payment = null;
    if (firestore) {
      try {
        const doc = await firestore.collection('payments').doc(req.params.id).get();
        if (doc.exists) payment = doc.data();
      } catch (e) {
        // ignore and fallback to local
      }
    }
    if (!payment) {
      const db = readDB();
      payment = db.payments.find(p => p.id === req.params.id);
    }

    if (!payment) return res.status(404).json({ error: 'not found' });
    if (!payment.proofObjectPath) return res.status(404).json({ error: 'no proof object path' });

    // Authorization: owner or officer
    const uid = req.firebaseUser && req.firebaseUser.uid;
    const email = req.firebaseUser && req.firebaseUser.email;
    const isOwner = (payment.submittedByUid && payment.submittedByUid === uid) || (payment.submittedByEmail && payment.submittedByEmail === email);
    // Optionally determine officer role from Firestore or token claim
    const isOfficer = req.firebaseUser && req.firebaseUser.role === 'officer'; // adjust as needed

    if (!isOwner && !isOfficer) return res.status(403).json({ error: 'forbidden' });

    // If storedPath indicates local file (fallback), return local URL
    if (payment.proofObjectIsLocal) {
      const url = `${req.protocol}://${req.get('host')}/uploads/${payment.proofObjectPath}`;
      return res.json({ url, expiresIn: 0, local: true });
    }

    if (!supabase) return res.status(500).json({ error: 'storage not configured' });

    const ttl = 60 * 60; // 1 hour
    const { data, error } = await supabase.storage.from(supabaseBucket).createSignedUrl(payment.proofObjectPath, ttl);
    if (error || !data) {
      console.warn('createSignedUrl failed for', payment.proofObjectPath, error);
      return res.status(500).json({ error: 'could not create signed url' });
    }
    return res.json({ url: data.signedUrl || data.signedURL, expiresIn: ttl, local: false });
  } catch (err) {
    console.error('GET /api/payments/:id/proof-url error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// New: Unapprove endpoint - change status back to pending and clear approval metadata
// Matches the storage/update pattern used by approve/reject endpoints (persist to data.json and Firestore)
app.post('/api/payments/:id/unapprove', async (req, res) => {
  try {
    const db = readDB();
    const payment = db.payments.find(p => p.id === req.params.id);
    if (!payment) return res.status(404).json({ error: 'not found' });

    payment.status = 'pending';
    // remove approval-related fields
    delete payment.approvedAt;
    delete payment.verifiedBy;
    delete payment.rejectedAt;

    writeDB(db);

    if (firestore) {
      firestore.collection('payments').doc(payment.id).set(payment, { merge: true }).catch(err => {
        console.warn('Firestore update on unapprove failed:', err);
      });
      if (payment.submittedByUid) {
        firestore.collection('users').doc(payment.submittedByUid).collection('payments').doc(payment.id).set(payment, { merge: true }).catch(err => {
          console.warn('Firestore per-user update on unapprove failed:', err);
        });
      }
    }

    return res.json(payment);
  } catch (err) {
    console.error('Error /unapprove:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Approve endpoint
app.post('/api/payments/:id/approve', async (req, res) => {
  try {
    const db = readDB();
    const payment = db.payments.find(p => p.id === req.params.id);
    if (!payment) return res.status(404).json({ error: 'not found' });
    payment.status = 'approved';
    payment.approvedAt = new Date().toISOString();
    writeDB(db);
    if (firestore) {
      firestore.collection('payments').doc(payment.id).set(payment, { merge: true }).catch(err => {
        console.warn('Firestore update on approve failed:', err);
      });
      if (payment.submittedByUid) {
        firestore.collection('users').doc(payment.submittedByUid).collection('payments').doc(payment.id).set(payment, { merge: true }).catch(err => {
          console.warn('Firestore per-user update on approve failed:', err);
        });
      }
    }
    return res.json(payment);
  } catch (err) {
    console.error('Error /approve:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Serve local uploads publicly
app.use('/uploads', express.static(UPLOADS_DIR));

// Start server
app.listen(PORT, () => {
  console.log(`🚀 SpartaPay running on http://localhost:${PORT}`);
});
