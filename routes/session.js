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

      // We'll try to read any existing user doc so we can return/store an authoritative org if present.
      let existingUserDoc = null;
      let existingUserData = null;
      if (firestore) {
        try {
          const snap = await firestore.collection('users').doc(uid).get();
          if (snap && snap.exists) {
            existingUserDoc = snap;
            existingUserData = snap.data() || null;
          }
        } catch (err) {
          console.warn('Failed to read existing user doc in /session:', err && err.message ? err.message : err);
        }
      }

      // Determine org to persist / return:
      // Priority:
      // 1) profileFromBody.org (explicit client-supplied)
      // 2) existing user doc top-level org
      // 3) existing user doc profile.org
      // 4) null (unknown)
      let orgToSave = null;
      if (profileFromBody && profileFromBody.org) {
        orgToSave = profileFromBody.org;
      } else if (existingUserData) {
        if (existingUserData.org) orgToSave = existingUserData.org;
        else if (existingUserData.profile && existingUserData.profile.org) orgToSave = existingUserData.profile.org;
      }

      // Upsert in Firestore if available (we await to ensure persistence so clients get consistent state)
      if (firestore) {
        try {
          // Merge minimal user fields + role + org (if determined)
          const baseSet = Object.assign({}, userObj, role ? { role } : {});
          if (orgToSave) baseSet.org = orgToSave;

          await firestore.collection('users').doc(uid).set(baseSet, { merge: true });

          // If a profile object was provided, merge it into users/{uid}.profile
          if (profileFromBody) {
            await firestore.collection('users').doc(uid).set({ profile: profileFromBody }, { merge: true });

            // If profileFromBody contained an org but we didn't previously set orgToSave, ensure top-level org also set
            if (!orgToSave && profileFromBody.org) {
              orgToSave = profileFromBody.org;
              try {
                await firestore.collection('users').doc(uid).set({ org: orgToSave }, { merge: true });
              } catch (e) {
                console.warn('Failed to persist org to top-level users/{uid}.org after profile merge:', e && e.message ? e.message : e);
              }
            }
          }
        } catch (err) {
          console.warn('Failed to upsert session user in Firestore:', err && err.message ? err.message : err);
        }
      }

      // Re-read user doc if we can to include authoritative profile/org in response
      let returnedOrg = orgToSave || null;
      let returnedProfile = null;
      if (firestore) {
        try {
          const snap2 = await firestore.collection('users').doc(uid).get();
          if (snap2 && snap2.exists) {
            const d = snap2.data() || {};
            // prefer explicit top-level org, else profile.org
            returnedOrg = d.org || (d.profile && d.profile.org) || returnedOrg || null;
            returnedProfile = d.profile || (profileFromBody ? profileFromBody : null);
          } else {
            // no doc, but client provided profileFromBody: return that
            returnedProfile = profileFromBody || null;
          }
        } catch (err) {
          console.warn('Failed to re-read user doc for response in /session:', err && err.message ? err.message : err);
          returnedProfile = profileFromBody || null;
        }
      } else {
        returnedProfile = profileFromBody || null;
      }

      // Return minimal info expected by client, plus authoritative org/profile if we have them.
      return res.json({
        uid,
        role: role || null,
        org: returnedOrg || null,
        profile: returnedProfile || null
      });
    } catch (err) {
      console.error('/session handler error:', err && err.message ? err.message : err);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
};
