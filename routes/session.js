// routes/session.js
// POST /session handler: verifies Firebase ID token, upserts a minimal user doc in Firestore (if available),
// and returns { uid, role } to the client.
//
// Usage: require('./routes/session')(admin, firestore) -> returns an async Express handler.

module.exports = function (admin, firestore) {
  return async function (req, res) {
    if (!admin) {
      return res.status(503).json({ error: 'firebase-admin not configured on server' });
    }

    try {
      const idToken =
        (req.body && req.body.idToken) ||
        (req.headers && (req.headers.authorization || req.headers.Authorization)
          ? String(req.headers.authorization).replace(/^Bearer\s+/i, '')
          : null);

      if (!idToken) return res.status(400).json({ error: 'idToken required' });

      // Verify token and get decoded claims
      const decoded = await admin.auth().verifyIdToken(idToken);
      const uid = decoded.uid;

      // Build a minimal user object
      const userObj = {
        uid,
        email: decoded.email || null,
        name: decoded.name || decoded.displayName || null,
        picture: decoded.picture || null,
        lastSeen: new Date().toISOString()
      };

      // Extract role from custom claims if present
      const role = decoded.role || (decoded && decoded.claims && decoded.claims.role) || null;

      // If the client supplied a richer profile payload, pick it up (optional)
      // Expectation: req.body.profile is an object with keys like displayName, year, college, department, program, photoURL, etc.
      const profileFromBody = req.body && req.body.profile && typeof req.body.profile === 'object' ? req.body.profile : null;

      // Upsert in Firestore if available (non-blocking to client response is attempted, but we await to ensure persistence)
      if (firestore) {
        try {
          // Merge minimal user fields + role first
          await firestore.collection('users').doc(uid).set(Object.assign({}, userObj, role ? { role } : {}), { merge: true });

          // If a profile object was provided, merge it into users/{uid}.profile
          if (profileFromBody) {
            // Normalize simple fields where appropriate (do not alter incoming shape)
            await firestore.collection('users').doc(uid).set({ profile: profileFromBody }, { merge: true });
          }
        } catch (err) {
          console.warn('Failed to upsert session user in Firestore:', err && err.message ? err.message : err);
        }
      }

      // Return minimal info expected by client
      return res.json({ uid, role: role || null });
    } catch (err) {
      console.error('/session handler error:', err && err.message ? err.message : err);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
};
