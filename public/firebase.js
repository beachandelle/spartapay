// firebase.js
// - Browser ES module for Firebase Auth (no require())
// - Keeps client idToken and profile in localStorage
// - Calls POST /session after sign-in to upsert the user on the server

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
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
      const txt = await res.text();
      console.warn('/session returned non-OK:', res.status, txt);
      return null;
    }
    const json = await res.json();
    if (json.uid) localStorage.setItem("spartapay_uid", json.uid);
    if (json.role) localStorage.setItem("spartapay_role", json.role);
    return json;
  } catch (err) {
    console.error("Failed to POST /session", err);
    return null;
  }
}

// Keep client-side token and basic profile in sync
onAuthStateChanged(auth, async (user) => {
  if (user) {
    try {
      // Force a fresh token so server verification is reliable
      const token = await user.getIdToken(true);
      localStorage.setItem("idToken", token);

      // Call server to create/update Firestore user doc
      await callServerSession(token);
    } catch (err) {
      console.error("Failed to retrieve idToken in onAuthStateChanged:", err);
      localStorage.removeItem("idToken");
    }

    // Basic profile info for UI
    // store both the legacy student keys and the profilePic key the dashboard reads
    localStorage.setItem("studentName", user.displayName || "");
    localStorage.setItem("studentEmail", user.email || "");
    localStorage.setItem("studentPhotoURL", user.photoURL || "");
    // Make sure dashboard can read the photo immediately (it checks 'profilePic')
    if (user.photoURL) {
      try { localStorage.setItem("profilePic", user.photoURL); } catch (e) { /* ignore */ }
    }
  } else {
    // Signed out — remove client-side stored pieces
    localStorage.removeItem("idToken");
    localStorage.removeItem("studentName");
    localStorage.removeItem("studentEmail");
    localStorage.removeItem("studentPhotoURL");
    localStorage.removeItem("profilePic");
    localStorage.removeItem("spartapay_uid");
    localStorage.removeItem("spartapay_role");
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
        // ensure dashboard sees the picture immediately
        if (user.photoURL) {
          try { localStorage.setItem("profilePic", user.photoURL); } catch (e) { /* ignore */ }
        }

        // Call server session to upsert user in Firestore
        if (token) {
          await callServerSession(token);
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

  // OFFICER LOGIN (Manual)
  const loginBtn = document.getElementById("loginBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      const username = (document.getElementById("email")?.value || "").trim();
      const password = (document.getElementById("password")?.value || "").trim();

      // Hard-coded demo officer accounts (DEV ONLY)
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

        // Prevent a stale officerOrgId from persisting
        try {
          localStorage.removeItem("officerOrgId");
        } catch (e) {
          // ignore storage errors
        }

        // Try to resolve canonical org id from server so dashboard can select the correct orgId when available.
        // This is non-fatal; if it fails we'll just proceed without setting officerOrgId.
        try {
          const res = await fetch(`${SERVER_BASE}/api/orgs`);
          if (res.ok) {
            const orgs = await res.json();
            const found = (orgs || []).find(o => {
              const name = String(o.name || o.displayName || o.id || '').toLowerCase();
              return name === String(officer.org).toLowerCase();
            });
            if (found && found.id) {
              try { localStorage.setItem("officerOrgId", found.id); } catch (e) { /* ignore */ }
            }
          }
        } catch (e) {
          // ignore fetch errors - we already removed stale id
          console.warn("Failed to resolve orgId for officer login:", e);
        }

        // Redirect to officer dashboard
        window.location.href = "officer-dashboard.html";
      } else {
        alert("Invalid officer credentials. Please try again.");
      }
    });
  }
});
