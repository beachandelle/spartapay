// firebase.js
// - Browser ES module for Firebase Auth (no require())
// - Keeps client idToken and profile in localStorage
// - Calls POST /session after sign-in to upsert the user on the server
// - Added: map known officer emails to their organization and persist officerOrg/officerProfiles
//   (keeps the previous behavior and demo fallback intact)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// Firebase configuration (keep this as-is for your project)
const firebaseConfig = {
  apiKey: "AIzaSyC7z_Fko_YdPHmQ6AWn0102k4qcmpO2Y4Q",
  authDomain: "spartapay-web.firebaseapp.com",
  projectId: "spartapay-web",
  storageBucket: "spartapay-web.appspot.com",
  messagingSenderId: "93903890719",
  appId: "1:93903890719:web:7c6cabcf0ca50ff205682a",
  measurementId: "G-KB31Q0LD29"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// Keep auth available for ad-hoc console testing
window._firebaseAuth = auth;

// server base URL (adjust if your server uses a different host/port)
// Use localhost only for local development; on deployed site use same-origin (empty string -> '/session' resolves to '/session')
const SERVER_BASE = window.SERVER_BASE || ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:3001' : '');

// Helper: call server /session to upsert user in Firestore (server verifies idToken)
async function callServerSession(idToken) {
  if (!idToken) return null;
  try {
    const res = await fetch(`${SERVER_BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=>'');
      console.warn('/session returned non-OK:', res.status, txt);
      return null;
    }
    const json = await res.json();
    if (json.uid) localStorage.setItem("spartapay_uid", json.uid);
    if (json.role) localStorage.setItem("spartapay_role", json.role);

    // If server returned authoritative org/profile, persist them locally so all devices use authoritative mapping
    try {
      if (json.org) {
        // profile may be present or not; if present prefer it
        const profileFromServer = json.profile && typeof json.profile === 'object' ? json.profile : {};
        persistOfficerOrgToLocalStorage(json.org, profileFromServer);
      } else if (json.profile && typeof json.profile === 'object') {
        // If server returned profile but not top-level org, still store profile keys (useful for students)
        try {
          if (json.profile.displayName) localStorage.setItem("studentName", json.profile.displayName);
          if (json.profile.email) localStorage.setItem("studentEmail", json.profile.email);
          if (json.profile.photoURL) localStorage.setItem("studentPhotoURL", json.profile.photoURL);
        } catch (e) {
          // ignore
        }
      } else {
        // If server returned nothing about org/profile, explicitly remove officerOrg for this newly-signed-in user
        // so we don't keep a stale org from a previous login.
        try {
          // Do not remove the entire officerProfiles map (that's a cache); just clear the active session's officerOrg and single-key profile
          localStorage.removeItem('officerOrg');
          localStorage.removeItem('officerProfile');
          localStorage.removeItem('officerOrgId');
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      console.warn('Failed to persist server session org/profile locally:', e);
    }

    return json;
  } catch (err) {
    console.error("Failed to POST /session", err);
    return null;
  }
}

// Small helper: persist officer organization mapping into localStorage structures
function persistOfficerOrgToLocalStorage(orgName, profileInfo = {}) {
  if (!orgName) return;
  try {
    // Save explicit current org (overwrite any stale value)
    localStorage.setItem("officerOrg", orgName);

    // Build or merge into officerProfiles map
    const pm = JSON.parse(localStorage.getItem("officerProfiles") || "{}");
    pm[orgName] = Object.assign({}, pm[orgName] || {}, profileInfo, { org: orgName });
    localStorage.setItem("officerProfiles", JSON.stringify(pm));

    // Keep single-key compatibility
    try { localStorage.setItem("officerProfile", JSON.stringify(pm[orgName])); } catch (e) {}

    // Save a lastOfficerUsername if provided
    if (profileInfo && profileInfo.username) {
      try { localStorage.setItem("lastOfficerUsername", profileInfo.username); } catch (e) {}
    }

    // Mark role locally (useful for UI)
    try { localStorage.setItem("spartapay_role", "officer"); } catch (e) {}
  } catch (e) {
    console.warn('persistOfficerOrgToLocalStorage failed:', e);
  }
}

// Keep client-side token and basic profile in sync
onAuthStateChanged(auth, async (user) => {
  if (user) {
    try {
      // Force a fresh token so server verification is reliable
      const token = await user.getIdToken(true);
      localStorage.setItem("idToken", token);

      // Clear any stale per-session org/profile before we handle the newly-signed-in user.
      // This prevents a previous officerOrg from sticking around across sign-ins.
      try {
        localStorage.removeItem('officerOrg');
        localStorage.removeItem('officerProfile');
        localStorage.removeItem('officerOrgId');
      } catch (e) { /* ignore */ }

      // Call server to create/update Firestore user doc and capture server response (authoritative org/profile)
      try {
        const sessionJson = await callServerSession(token);
        if (sessionJson) {
          // If server returned profile, mirror basic UI keys
          if (sessionJson.profile && typeof sessionJson.profile === 'object') {
            try {
              if (sessionJson.profile.displayName) localStorage.setItem("studentName", sessionJson.profile.displayName);
              if (sessionJson.profile.email) localStorage.setItem("studentEmail", sessionJson.profile.email);
              if (sessionJson.profile.photoURL) localStorage.setItem("studentPhotoURL", sessionJson.profile.photoURL);
            } catch (e) { /* ignore */ }
          }
          // If server returned org, persistOfficerOrgToLocalStorage already called inside callServerSession
        }
      } catch (e) {
        console.warn('callServerSession failed from onAuthStateChanged:', e);
      }
    } catch (err) {
      console.error("Failed to retrieve idToken in onAuthStateChanged:", err);
      localStorage.removeItem("idToken");
    }

    // Basic profile info for UI (fallback to firebase user if server didn't provide)
    localStorage.setItem("studentName", user.displayName || localStorage.getItem("studentName") || "");
    localStorage.setItem("studentEmail", user.email || localStorage.getItem("studentEmail") || "");
    localStorage.setItem("studentPhotoURL", user.photoURL || localStorage.getItem("studentPhotoURL") || "");
  } else {
    // Signed out — remove client-side stored pieces including per-session officer keys
    localStorage.removeItem("idToken");
    localStorage.removeItem("studentName");
    localStorage.removeItem("studentEmail");
    localStorage.removeItem("studentPhotoURL");
    localStorage.removeItem("spartapay_uid");
    localStorage.removeItem("spartapay_role");
    // remove per-session officer keys so next login doesn't inherit previous org
    localStorage.removeItem("officerOrg");
    localStorage.removeItem("officerProfile");
    localStorage.removeItem("officerOrgId");
    localStorage.removeItem("officerLoggedIn");
    // keep officerProfiles map (cache) intact
  }
});

// Wrap DOM wiring in DOMContentLoaded to ensure elements exist before attaching listeners
document.addEventListener("DOMContentLoaded", () => {
  // USER TYPE SELECTION
  const selectStudent = document.getElementById("selectStudent");
  const selectOfficer = document.getElementById("selectOfficer");
  const studentLoginSection = document.getElementById("studentLogin");
  const officerLoginSection = document.getElementById("officerLogin");

  if (selectStudent && selectOfficer) {
    selectStudent.addEventListener("click", () => {
      if (studentLoginSection) studentLoginSection.style.display = "block";
      if (officerLoginSection) officerLoginSection.style.display = "none";
    });

    selectOfficer.addEventListener("click", () => {
      if (officerLoginSection) officerLoginSection.style.display = "block";
      if (studentLoginSection) studentLoginSection.style.display = "none";
    });
  } else {
    console.warn('selectStudent/selectOfficer not found in DOM');
  }

  // GOOGLE STUDENT LOGIN (updated: store idToken and profile, then redirect)
  const googleBtn = document.getElementById("googleSignIn");
  if (googleBtn) {
    googleBtn.addEventListener("click", async () => {
      try {
        const result = await signInWithPopup(auth, provider);
        const user = result.user;

        // Try to get a fresh ID token and store it client-side for subsequent API calls
        let token = null;
        try {
          token = await user.getIdToken(true);
          localStorage.setItem("idToken", token);
        } catch (tokenErr) {
          console.error("Failed to get idToken after signInWithPopup:", tokenErr);
        }

        // Save student profile basics using keys expected by the dashboard
        localStorage.setItem("studentName", user.displayName || "");
        localStorage.setItem("studentEmail", user.email || "");
        localStorage.setItem("studentPhotoURL", user.photoURL || "");

        // Call server session to upsert user in Firestore and use response if available
        if (token) {
          try {
            const sessionJson = await callServerSession(token);
            if (sessionJson && sessionJson.profile && typeof sessionJson.profile === 'object') {
              if (sessionJson.profile.displayName) localStorage.setItem("studentName", sessionJson.profile.displayName);
              if (sessionJson.profile.email) localStorage.setItem("studentEmail", sessionJson.profile.email);
              if (sessionJson.profile.photoURL) localStorage.setItem("studentPhotoURL", sessionJson.profile.photoURL);
            }
          } catch (e) {
            console.warn('callServerSession failed after Google sign-in:', e);
          }
        }

        // Redirect to the dashboard (client will read localStorage for profile and token)
        window.location.href = "student-dashboard.html";
      } catch (error) {
        console.error("Google Sign-In error:", error);
        alert("Google Sign-In failed. Please try again.");
      }
    });
  }

  // Expose sign-out helper for convenience
  window.signOutUser = async function () {
    try {
      await signOut(auth);
      // onAuthStateChanged will clear localStorage; force a reload to update the UI
      location.reload();
    } catch (e) {
      console.error("Sign-out failed", e);
      alert("Sign out failed. Check console for details.");
    }
  };

  // Known officer-email -> org mapping
  // You can extend this list or move it to a server-side mapping if you prefer.
  const officerEmailToOrg = {
    "jiecep@officer.com": "JIECEP",
    "aeess@officer.com": "AeESS",
    "aices@officer.com": "AICES",
    "mexess@officer.com": "MEXESS",
    "abmes@officer.com": "ABMES"
  };

  // Small helper to infer org from email prefix if explicit mapping missing
  function inferOrgFromEmail(email) {
    if (!email || typeof email !== 'string') return "";
    const local = email.split('@')[0] || "";
    // Try to convert typical patterns to org name: jiecep -> JIECEP, mexess -> MEXESS, etc.
    const cleaned = local.replace(/[_\.\-]/g, '').toUpperCase();
    // If cleaned looks like an acronym/short name we expect, return it
    if (cleaned.length >= 3 && cleaned.length <= 10) return cleaned;
    return "";
  }

  // OFFICER LOGIN (Firebase email/password preferred, fallback to manual demo array)
  const loginBtn = document.getElementById("loginBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      const username = (document.getElementById("email")?.value || "").trim();
      const password = (document.getElementById("password")?.value || "").trim();

      if (!username || !password) {
        alert("Please enter username/email and password.");
        return;
      }

      // Map short usernames (if UI uses them) to an email address — ensure such email exists in Firebase Auth
      const email = username.includes("@") ? username : `${username}@officer.com`;

      // Try Firebase email/password sign-in first (preferred)
      try {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        const user = cred.user;

        // Get fresh token and persist
        let sessionJson = null;
        try {
          const token = await user.getIdToken(true);
          localStorage.setItem("idToken", token);
          // Let server upsert session (server verifies token) and capture response
          sessionJson = await callServerSession(token);
        } catch (tErr) {
          console.warn("Failed to obtain or POST idToken after officer sign-in:", tErr);
        }

        // Persist basic UI profile info (prefer server profile if returned)
        if (sessionJson && sessionJson.profile && typeof sessionJson.profile === 'object') {
          if (sessionJson.profile.displayName) localStorage.setItem("studentName", sessionJson.profile.displayName);
          if (sessionJson.profile.email) localStorage.setItem("studentEmail", sessionJson.profile.email);
          if (sessionJson.profile.photoURL) localStorage.setItem("studentPhotoURL", sessionJson.profile.photoURL);
        } else {
          localStorage.setItem("studentName", user.displayName || "");
          localStorage.setItem("studentEmail", user.email || "");
          localStorage.setItem("studentPhotoURL", user.photoURL || "");
        }

        // Determine organization for this officer: prefer server response, else mapping/inference
        let org = null;
        if (sessionJson && sessionJson.org) {
          org = sessionJson.org;
        } else {
          const normalizedEmail = (user.email || "").toLowerCase();
          org = officerEmailToOrg[normalizedEmail] || inferOrgFromEmail(normalizedEmail);
        }

        if (org) {
          // Build a minimal officer profile object to keep old UX working
          const usernamePrefix = (user.email || "").split('@')[0] || '';
          const officerProfile = {
            username: usernamePrefix,
            name: (sessionJson && sessionJson.profile && sessionJson.profile.displayName) ? sessionJson.profile.displayName : (user.displayName || org),
            org: org,
            photoURL: (sessionJson && sessionJson.profile && sessionJson.profile.photoURL) ? sessionJson.profile.photoURL : (user.photoURL || "")
          };
          persistOfficerOrgToLocalStorage(org, officerProfile);
        } else {
          // No mapping found — do not block sign-in, but leave org unset.
          console.warn('No officer->org mapping found for', user.email || email);
        }

        // Redirect to officer dashboard
        window.location.href = "officer-dashboard.html";
        return;
      } catch (firebaseErr) {
        console.warn("Firebase officer sign-in failed (falling back to local demo credentials):", firebaseErr);
        // fallback to legacy local demo accounts for development/testing
        const officers = [
          { username: "jiecep_officer", password: "jiecep123", name: "JIECEP Officer", org: "JIECEP" },
          { username: "aeess_officer", password: "aeess123", name: "AeESS Officer", org: "AeESS" },
          { username: "aices_officer", password: "aices123", name: "AICES Officer", org: "AICES" },
          { username: "mexess_officer", password: "mexess123", name: "MEXESS Officer", org: "MEXESS" },
          { username: "abmes_officer", password: "abmes123", name: "ABMES Officer", org: "ABMES" }
        ];

        const officer = officers.find(o => o.username === username && o.password === password);
        if (officer) {
          // Build the minimal profile we get from login
          const loginProfile = {
            username: officer.username,
            name: officer.name,
            org: officer.org
          };

          // Load existing map of profiles (per-org). If none, start with empty object.
          const profilesMap = JSON.parse(localStorage.getItem("officerProfiles") || "{}");

          // Merge strategy (preserve previously saved fields for this org)
          const existing = profilesMap[officer.org] || {};

          let mergedName = existing.name || loginProfile.name;

          const mergedProfile = Object.assign({}, existing, {
            username: existing.username || loginProfile.username,
            org: existing.org || loginProfile.org,
            name: mergedName
          });

          // Save back into the map (this will preserve other saved fields)
          profilesMap[officer.org] = mergedProfile;
          localStorage.setItem("officerProfiles", JSON.stringify(profilesMap));

          // Keep the legacy single-key for compatibility
          localStorage.setItem("officerProfile", JSON.stringify(mergedProfile));

          // Set current org and logged-in flags
          localStorage.setItem("officerOrg", officer.org);
          localStorage.setItem("officerLoggedIn", "true");
          localStorage.setItem("lastOfficerUsername", officer.username);

          // Redirect to officer dashboard
          window.location.href = "officer-dashboard.html";
        } else {
          alert("Invalid officer credentials. Please try again.");
        }
      }
    });
  }
});

