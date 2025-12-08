// officer-dashboard.js - full script (complete).
// - Renders events, payments table, proof modal
// - Adds three separate stat cards under Payments heading (paid red, approved green, received black)
// - Keeps Home, Add Event, Edit, Delete, Profile (per-org) functionality and persistence
// - Prefers server events/orgs when available; falls back to localStorage.
// - When saving profile, upserts organization on server and signals other clients via localStorage.orgsLastUpdated
//
// NOTE: This file assumes your HTML contains:
// - #paymentStats element in the Payments view (we create stats cards inside it if empty)

let editingEventIndex = null;
let editingServerEventId = null;
let currentEventView = null;

document.addEventListener("DOMContentLoaded", () => {
  // ----------------------
  // DOM references
  // ----------------------
  const profileBtnWrapper = document.getElementById("profileBtnWrapper");
  const profileDropdown = document.getElementById("profileDropdown");
  const profileBtn = document.getElementById("profileBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  const profileForm = document.getElementById("profileForm");
  const editSaveProfileBtn = document.getElementById("editSaveProfileBtn");
  const cancelEditProfileBtn = document.getElementById("cancelEditProfileBtn");

  const profileOrg = document.getElementById("profileOrg");
  const surnameInput = document.getElementById("surname");
  const givenNameInput = document.getElementById("givenName");
  const middleInitialInput = document.getElementById("middleInitial");
  const designationInput = document.getElementById("designation");
  const yearSelect = document.getElementById("year");
  const collegeSelect = document.getElementById("college");
  const departmentSelect = document.getElementById("department");
  const programSelect = document.getElementById("program");

  const headerTitle = document.getElementById("headerTitle");
  const officerNameSpan = document.getElementById("officerName");
  const profilePic = document.getElementById("profilePic");

  // Home button
  const homeBtn = document.getElementById("homeBtn");

  // Event Form Elements
  const addEventForm = document.getElementById("addEventForm");
  const step1 = document.getElementById("step1");
  const step2 = document.getElementById("step2");

  const eventsCard = document.getElementById("eventsCard") || document.querySelector(".card");
  const eventTableBody = document.querySelector("#eventTable tbody");
  const addEventBtn = document.getElementById("addEventBtn");
  const nextStepBtn = document.getElementById("nextStepBtn");
  const addEventConfirmBtn = document.getElementById("addEventConfirmBtn");
  const cancelAddEvent = document.getElementById("cancelAddEvent");
  const backToStep1Btn = document.getElementById("backToStep1Btn");

  const eventNameInput = document.getElementById("eventName");
  const eventDeadlineInput = document.getElementById("eventDeadline");
  const eventFeeInput = document.getElementById("eventFee");
  const receiverNumberInput = document.getElementById("receiverNumber");
  const receiverNameInput = document.getElementById("receiverName");
  const receiverQRInput = document.getElementById("receiverQR");

  const confirmEventName = document.getElementById("confirmEventName");
  const confirmDeadline = document.getElementById("confirmDeadline");
  const confirmAmount = document.getElementById("confirmAmount");
  const confirmNumber = document.getElementById("confirmNumber");
  const confirmName = document.getElementById("confirmName");
  const confirmQR = document.getElementById("confirmQR");

  // Payments view
  const verifyPaymentsSection = document.getElementById("verifyPayments");
  const verifyTableBody = document.querySelector("#verifyTable tbody");
  const proofModal = document.getElementById("proofModal");
  const backToEventsBtn = document.getElementById("backToEventsBtn");
  const eventPaymentsHeading = document.getElementById("eventPaymentsHeading");
  const paymentStatsContainer = document.getElementById("paymentStats");
  const filterBtn = document.getElementById("filterBtn");

  // Stat elements
  let paidCountEl = null;
  let approvedCountEl = null;
  let receivedTotalEl = null;

  // Server base (adjust if your server runs on a different host/port)
  // Use localhost only for local development; on deployed site use same-origin (empty string -> '/api/...')
  const SERVER_BASE = window.SERVER_BASE || ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:3001' : '');

  // ----------------------
  // Signed URL caching & helper
  // ----------------------
  function getIdToken() {
    try { return localStorage.getItem("idToken") || null; } catch (e) { return null; }
  }

  // Helper: unified fetch that attaches stored idToken when available
  async function fetchWithAuth(url, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    try {
      const idToken = getIdToken();
      if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    } catch (e) { /* ignore */ }
    return fetch(url, Object.assign({}, options, { headers }));
  }

  const signedUrlCache = new Map(); // key: paymentId -> { url, expiresAt, local }
  async function requestSignedUrl(paymentId) {
    if (!paymentId) throw new Error('paymentId required');
    const now = Date.now();
    const cached = signedUrlCache.get(paymentId);
    if (cached && cached.url && cached.expiresAt && cached.expiresAt > now + 2000) {
      return cached;
    }
    const endpoint = `${SERVER_BASE}/api/payments/${encodeURIComponent(paymentId)}/proof-url`;
    const res = await fetchWithAuth(endpoint, { method: 'GET' });
    if (!res.ok) {
      const txt = await res.text().catch(()=> '');
      throw new Error(`Failed to get signed url: ${res.status} ${txt}`);
    }
    const payload = await res.json();
    const ttl = payload.expiresIn || payload.ttl || 0;
    const expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : 0;
    const entry = { url: payload.url, expiresAt, local: !!payload.local };
    signedUrlCache.set(paymentId, entry);
    return entry;
  }

  // ----------------------
  // Fetch payments
  // ----------------------
  async function fetchAllPaymentsFromServer() {
    try {
      const res = await fetchWithAuth(`${SERVER_BASE}/api/payments`, { method: 'GET' });
      if (!res.ok) {
        console.debug('fetchAllPaymentsFromServer failed status:', res.status);
        return [];
      }
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data;
    } catch (err) {
      console.debug('fetchAllPaymentsFromServer error:', err);
      return [];
    }
  }

  // ----------------------
  // Utilities
  // ----------------------
  function hide(el) { if (!el) return; el.classList.add("hidden"); el.style.display = "none"; }
  function show(el, display = "") { if (!el) return; el.classList.remove("hidden"); el.style.display = display; }
  function escapeHtml(str) { if (str === undefined || str === null) return ""; return String(str).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/'/g,"&#39;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  // ----------------------
  // Profile (per-org) helpers
  // ----------------------
  function getCurrentOrg() {
    // Prefer explicit officerOrg
    let org = localStorage.getItem("officerOrg") || "";
    if (org) return org;

    // Try to infer from lastOfficerUsername mapping; this preserves per-org isolation
    const lastUser = localStorage.getItem("lastOfficerUsername") || "";
    const profilesMap = JSON.parse(localStorage.getItem("officerProfiles") || "{}");
    if (lastUser) {
      for (const [k, v] of Object.entries(profilesMap)) {
        if (v && v.username && v.username === lastUser) {
          try { localStorage.setItem("officerOrg", k); } catch (e) {}
          return k;
        }
      }
    }

    // If there is exactly one saved org, use it (convenience)
    const keys = Object.keys(profilesMap || {});
    if (keys.length === 1) {
      try { localStorage.setItem("officerOrg", keys[0]); } catch (e) {}
      return keys[0];
    }

    return "";
  }

  function getCurrentOrgId() {
    // Prefer explicit officerOrgId if present
    const storedId = localStorage.getItem("officerOrgId") || "";
    if (storedId) return storedId;

    // Otherwise try to read from profiles map
    const org = getCurrentOrg();
    if (!org) return "";
    const profilesMap = JSON.parse(localStorage.getItem("officerProfiles") || "{}");
    if (profilesMap && profilesMap[org] && profilesMap[org].orgId) return profilesMap[org].orgId;
    return "";
  }

  // New helpers: server-backed officer profile get/upsert
  async function fetchOfficerProfileFromServer(orgName, orgId) {
    try {
      let url = `${SERVER_BASE}/api/officer-profiles`;
      if (orgId) url += `?orgId=${encodeURIComponent(orgId)}`;
      else if (orgName) url += `?org=${encodeURIComponent(orgName)}`;
      const res = await fetchWithAuth(url, { method: 'GET' });
      if (!res.ok) {
        // treat as no server profile
        return null;
      }
      const arr = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return arr[0];
    } catch (e) {
      console.warn('fetchOfficerProfileFromServer error:', e);
      return null;
    }
  }

  async function upsertOfficerProfileToServer(orgName, orgId, profileObj) {
    try {
      const payload = { org: orgName, orgId: orgId, profile: profileObj };
      const res = await fetchWithAuth(`${SERVER_BASE}/api/officer-profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const txt = await res.text().catch(()=>'');
        throw new Error(`Server responded ${res.status}: ${txt}`);
      }
      const json = await res.json();
      return json;
    } catch (e) {
      console.warn('upsertOfficerProfileToServer error:', e);
      return null;
    }
  }

  function loadProfileFromLocalStorageMap(key) {
    const profilesMap = JSON.parse(localStorage.getItem("officerProfiles") || "{}");
    return profilesMap[key] || null;
  }

  async function loadProfile() {
    // Attempt server-first load (if available) to sync across devices, fallback to localStorage as before
    const currentOrg = getCurrentOrg();
    const currentOrgId = getCurrentOrgId();

    // Try server first
    let serverProfile = null;
    if (SERVER_BASE) {
      try {
        serverProfile = await fetchOfficerProfileFromServer(currentOrg, currentOrgId);
      } catch (e) {
        console.debug('Server profile fetch failed, falling back to local storage', e);
        serverProfile = null;
      }
    }

    if (serverProfile) {
      // Normalize and persist to local mirror for offline use
      try {
        const key = serverProfile.orgId || (serverProfile.org ? serverProfile.org : (serverProfile.orgKey || ''));
        const profilesMap = JSON.parse(localStorage.getItem("officerProfiles") || "{}");
        // choose canonical key: prefer orgId if present else canonical org name (string)
        const storeKey = key || (serverProfile.org ? serverProfile.org : (serverProfile.orgKey || ''));
        profilesMap[storeKey] = Object.assign({}, profilesMap[storeKey] || {}, serverProfile);
        localStorage.setItem("officerProfiles", JSON.stringify(profilesMap));
        if (serverProfile.orgId) {
          try { localStorage.setItem('officerOrgId', serverProfile.orgId); } catch (e) {}
        }
      } catch (e) {
        console.warn('Failed to mirror server profile to localStorage:', e);
      }

      // Use server profile for UI
      const profile = serverProfile;
      if (profileOrg) { profileOrg.value = profile.org || currentOrg || ""; profileOrg.readOnly = true; }
      if (surnameInput) surnameInput.value = profile.name?.surname || "";
      if (givenNameInput) givenNameInput.value = profile.name?.given || "";
      if (middleInitialInput) middleInitialInput.value = profile.name?.middle || "";
      if (designationInput) designationInput.value = profile.designation || "";
      if (yearSelect) yearSelect.value = profile.year || "";
      if (collegeSelect) collegeSelect.value = profile.college || "";

      if (departmentSelect) {
        departmentSelect.innerHTML = '<option value="">-- Select Department --</option>';
        if (profile.college && collegeData[profile.college]) {
          Object.keys(collegeData[profile.college]).forEach(dep => {
            const opt = document.createElement("option");
            opt.value = dep; opt.textContent = dep;
            departmentSelect.appendChild(opt);
          });
        }
        departmentSelect.value = profile.department || "";
      }
      if (programSelect) {
        programSelect.innerHTML = '<option value="">-- Select Program --</option>';
        if (profile.college && profile.department && collegeData[profile.college] && collegeData[profile.college][profile.department]) {
          collegeData[profile.college][profile.department].forEach(prog => {
            const opt = document.createElement("option");
            opt.value = prog; opt.textContent = prog;
            programSelect.appendChild(opt);
          });
        }
        programSelect.value = profile.program || "";
      }

      setProfileReadOnly(true);
      if (editSaveProfileBtn) editSaveProfileBtn.textContent = "Edit";

      const orgName = profile.org || currentOrg || "";
      if (orgName) {
        if (headerTitle) headerTitle.textContent = `Hello, ${orgName}`;
        if (officerNameSpan) officerNameSpan.textContent = orgName;
      } else {
        if (headerTitle) headerTitle.textContent = `Hello`;
        if (officerNameSpan) officerNameSpan.textContent = "";
      }

      if (profile.photoURL && profile.org && profile.org === orgName && profilePic) {
        profilePic.src = profile.photoURL;
      }

      return;
    }

    // else fall back to previous local storage logic
    const profilesMap = JSON.parse(localStorage.getItem("officerProfiles") || "{}");
    let profile = {};

    const current = currentOrg;
    if (current && profilesMap[current]) {
      profile = profilesMap[current];
    } else {
      const single = JSON.parse(localStorage.getItem("officerProfile") || "{}");
      if (single && Object.keys(single).length > 0) {
        const singleOrg = single.org || "";
        if ((!current && singleOrg) || (current && singleOrg && singleOrg === current)) {
          profile = single;
        } else {
          profile = {};
        }
      } else {
        profile = {};
      }
    }

    if (profileOrg) { profileOrg.value = currentOrg || profile.org || ""; profileOrg.readOnly = true; }
    if (surnameInput) surnameInput.value = profile.name?.surname || "";
    if (givenNameInput) givenNameInput.value = profile.name?.given || "";
    if (middleInitialInput) middleInitialInput.value = profile.name?.middle || "";
    if (designationInput) designationInput.value = profile.designation || "";
    if (yearSelect) yearSelect.value = profile.year || "";
    if (collegeSelect) collegeSelect.value = profile.college || "";

    if (departmentSelect) {
      departmentSelect.innerHTML = '<option value="">-- Select Department --</option>';
      if (profile.college && collegeData[profile.college]) {
        Object.keys(collegeData[profile.college]).forEach(dep => {
          const opt = document.createElement("option");
          opt.value = dep; opt.textContent = dep;
          departmentSelect.appendChild(opt);
        });
      }
      departmentSelect.value = profile.department || "";
    }
    if (programSelect) {
      programSelect.innerHTML = '<option value="">-- Select Program --</option>';
      if (profile.college && profile.department && collegeData[profile.college] && collegeData[profile.college][profile.department]) {
        collegeData[profile.college][profile.department].forEach(prog => {
          const opt = document.createElement("option");
          opt.value = prog; opt.textContent = prog;
          programSelect.appendChild(opt);
        });
      }
      programSelect.value = profile.program || "";
    }

    setProfileReadOnly(true);
    if (editSaveProfileBtn) editSaveProfileBtn.textContent = "Edit";

    const orgName = currentOrg || (profile.org || "");
    if (orgName) {
      if (headerTitle) headerTitle.textContent = `Hello, ${orgName}`;
      if (officerNameSpan) officerNameSpan.textContent = orgName;
    } else {
      if (headerTitle) headerTitle.textContent = `Hello`;
      if (officerNameSpan) officerNameSpan.textContent = "";
    }

    if (profile.photoURL && profile.org && profile.org === orgName && profilePic) {
      profilePic.src = profile.photoURL;
    }
  }

  async function upsertOrgOnServer(orgName) {
    try {
      if (!orgName) return null;
      const res = await fetch(`${SERVER_BASE}/api/orgs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: orgName, displayName: orgName })
      });
      if (!res.ok) {
        const txt = await res.text().catch(()=>'');
        console.warn('Failed to upsert org on server:', res.status, txt);
        return null;
      }
      const json = await res.json();
      return json;
    } catch (err) {
      console.warn('upsertOrgOnServer error:', err);
      return null;
    }
  }

  async function saveProfile() {
    const newOrg = getCurrentOrg();
    if (!newOrg) {
      alert("Unable to determine organization to save profile for. Please login first.");
      return;
    }

    const profileObj = {
      org: newOrg,
      name: {
        surname: surnameInput ? surnameInput.value : "",
        given: givenNameInput ? givenNameInput.value : "",
        middle: middleInitialInput ? middleInitialInput.value : ""
      },
      designation: designationInput ? designationInput.value : "",
      year: yearSelect ? yearSelect.value : "",
      college: collegeSelect ? collegeSelect.value : "",
      department: departmentSelect ? departmentSelect.value : "",
      program: programSelect ? programSelect.value : "",
      photoURL: profilePic ? profilePic.src : ""
    };

    const profilesMap = JSON.parse(localStorage.getItem("officerProfiles") || "{}");

    // Try preserve username if present
    if (profilesMap[newOrg] && profilesMap[newOrg].username) {
      profileObj.username = profilesMap[newOrg].username;
    } else {
      // Keep lastOfficerUsername if present
      const lastUser = localStorage.getItem("lastOfficerUsername") || "";
      if (lastUser) profileObj.username = lastUser;
    }

    // Save per-org map and also write single-key fallback (only for convenience)
    profilesMap[newOrg] = Object.assign({}, profilesMap[newOrg] || {}, profileObj);
    localStorage.setItem("officerProfiles", JSON.stringify(profilesMap));
    try { localStorage.setItem("officerOrg", newOrg); } catch (e) {}
    localStorage.setItem("officerProfile", JSON.stringify(profileObj)); // single-key fallback

    // Persist lastOfficerUsername if username present
    if (profileObj.username) localStorage.setItem("lastOfficerUsername", profileObj.username);

    if (headerTitle) headerTitle.textContent = `Hello ${profileObj.org}`;
    if (officerNameSpan) officerNameSpan.textContent = profileObj.org;

    // Non-blocking attempt to ensure organization exists on server.
    (async () => {
      try {
        const org = await upsertOrgOnServer(newOrg);
        if (org && org.id) {
          // store org id in profiles map for convenience
          const pm = JSON.parse(localStorage.getItem("officerProfiles") || "{}");
          pm[newOrg] = pm[newOrg] || {};
          pm[newOrg].orgId = org.id;
          localStorage.setItem("officerProfiles", JSON.stringify(pm));
          try { localStorage.setItem('officerOrgId', org.id); } catch(e) {}
        }

        // Now upsert the full profile to the server so other devices can read it
        const orgIdToSend = (org && org.id) ? org.id : (profileObj.orgId || getCurrentOrgId() || null);
        const serverResult = await upsertOfficerProfileToServer(newOrg, orgIdToSend, profileObj);
        if (serverResult) {
          // Mirror the authoritative server profile into localStorage map
          try {
            const key = serverResult.orgId || serverResult.org || serverResult.orgKey || newOrg;
            const pm2 = JSON.parse(localStorage.getItem("officerProfiles") || "{}");
            pm2[key] = Object.assign({}, pm2[key] || {}, serverResult);
            localStorage.setItem("officerProfiles", JSON.stringify(pm2));
            if (serverResult.orgId) {
              try { localStorage.setItem('officerOrgId', serverResult.orgId); } catch(e) {}
            }
          } catch (e) {
            console.warn('Failed to mirror server profile after upsert:', e);
          }
        }

        // signal other tabs (same browser) to refresh org lists
        try {
          localStorage.setItem('orgsLastUpdated', String(Date.now()));
        } catch (e) { /* ignore */ }
      } catch (e) {
        console.warn('Failed to upsert org or profile after saving profile:', e);
      }
    })();
  }

  function setProfileReadOnly(isReadOnly) {
    const fields = [surnameInput, givenNameInput, middleInitialInput, designationInput];
    fields.forEach(f => { if (f) { f.readOnly = isReadOnly; f.style.backgroundColor = isReadOnly ? "#f0f0f0" : "#fff"; }});
    if (yearSelect) yearSelect.disabled = isReadOnly;
    if (collegeSelect) collegeSelect.disabled = isReadOnly;
    if (departmentSelect) departmentSelect.disabled = isReadOnly;
    if (programSelect) programSelect.disabled = isReadOnly;
    const selectFields = [yearSelect, collegeSelect, departmentSelect, programSelect];
    selectFields.forEach(f => { if (f) f.style.backgroundColor = isReadOnly ? "#e0e0e0" : "#fff"; });
    if (cancelEditProfileBtn) {
      if (isReadOnly) cancelEditProfileBtn.classList.add("hidden");
      else cancelEditProfileBtn.classList.remove("hidden");
    }
  }

  // Wire Edit/Save profile button
  if (editSaveProfileBtn) {
    editSaveProfileBtn.addEventListener("click", () => {
      if (editSaveProfileBtn.textContent === "Edit") {
        setProfileReadOnly(false);
        editSaveProfileBtn.textContent = "Save";
        if (cancelEditProfileBtn) cancelEditProfileBtn.classList.remove("hidden");
      } else {
        // Save profile to per-org storage and upsert org on server
        saveProfile();
        setProfileReadOnly(true);
        editSaveProfileBtn.textContent = "Edit";
        alert("Profile saved successfully!");
      }
    });
  }

  if (cancelEditProfileBtn) {
    cancelEditProfileBtn.addEventListener("click", () => {
      loadProfile();
      setProfileReadOnly(true);
      editSaveProfileBtn.textContent = "Edit";
    });
  }

  // ----------------------
  // College → Department → Program (static data)
  // ----------------------
  const collegeData = {
    COE: {
      "Chemical Engineering": ["BS ChE","BS FE","BS CerE","BS MetE"],
      "Civil Engineering": ["BS CE","BS SE","BS GE","BS GeoE","BS TE"],
      "Electrical Engineering": ["BS EE","BS CpE"],
      "Electronics Engineering": ["BS ECE","BS ICE","BS MexE","BS AeE","BS BioE"],
      "Industrial Engineering": ["BS IE"],
      "Mechanical Engineering": ["BS ME","BS PetE","BS AE","BS NAME"]
    },
    CAFAD: { "N/A": ["Bachelor of Fine Arts and Design Major in Visual Communication","Bachelor of Science in Architecture","Bachelor of Science in Interior Design"] },
    CICS: { "N/A": ["Bachelor of Science in Computer Science","Bachelor of Science in Information Technology"] },
    CET: { "N/A": ["Bachelor of Automotive Engineering Technology","Bachelor of Civil Engineering Technology","Bachelor of Computer Engineering Technology","Bachelor of Drafting Engineering Technology","Bachelor of Electrical Engineering Technology","Bachelor of Electronics Engineering Technology","Bachelor of Food Engineering Technology","Bachelor of Instrumentation and Control Engineering Technology","Bachelor of Mechanical Engineering Technology","Bachelor of Mechatronics Engineering Technology","Bachelor of Welding and Fabrication Engineering Technology"] }
  };

  function updateDepartments() {
    if (!departmentSelect || !collegeSelect) return;
    departmentSelect.innerHTML = '<option value="">-- Select Department --</option>';
    const col = collegeSelect.value;
    if (col && collegeData[col]) Object.keys(collegeData[col]).forEach(dep => {
      const opt = document.createElement("option"); opt.value = dep; opt.textContent = dep; departmentSelect.appendChild(opt);
    });
  }
  function updatePrograms() {
    if (!programSelect || !collegeSelect || !departmentSelect) return;
    programSelect.innerHTML = '<option value="">-- Select Program --</option>';
    const col = collegeSelect.value; const dep = departmentSelect.value;
    if (col && dep && collegeData[col] && collegeData[col][dep]) collegeData[col][dep].forEach(prog => {
      const opt = document.createElement('option'); opt.value = prog; opt.textContent = prog; programSelect.appendChild(opt);
    });
  }
  if (collegeSelect) collegeSelect.addEventListener("change", () => { updateDepartments(); updatePrograms(); });
  if (departmentSelect) departmentSelect.addEventListener("change", () => updatePrograms());

  // ----------------------
  // Stats element creation
  // ----------------------
  function ensureStatsElements() {
    if (!paymentStatsContainer) return;
    paidCountEl = document.getElementById("countPaid");
    approvedCountEl = document.getElementById("countApproved");
    receivedTotalEl = document.getElementById("countReceived");
    if (paidCountEl && approvedCountEl && receivedTotalEl) return;

    paymentStatsContainer.innerHTML = `
      <div class="stat-card stat-card--left">
        <div class="stat-label">Total students who paid</div>
        <div id="countPaid" class="stat-number paid">0</div>
      </div>
      <div class="stat-card	stat-card--center">
        <div class="stat-label">Total approved transactions</div>
        <div id="countApproved" class="stat-number approved">0</div>
      </div>
      <div class="stat-card stat-card--right">
        <div class="stat-label">Total funds received</div>
        <div id="countReceived" class="stat-number received">₱0.00</div>
      </div>
    `;
    paidCountEl = document.getElementById("countPaid");
    approvedCountEl = document.getElementById("countApproved");
    receivedTotalEl = document.getElementById("countReceived");
  }

  // ----------------------
  // Server: fetch orgs/events helpers (with local fallback)
  // ----------------------
  async function fetchOrgsFromServer() {
    try {
      const res = await fetch(`${SERVER_BASE}/api/orgs`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const orgs = await res.json();
      if (!Array.isArray(orgs)) return [];
      // normalize to {id, name, displayName}
      const normalized = orgs.map(o => {
        if (typeof o === 'string') return { id: o, name: o, displayName: o };
        return { id: o.id || o.name || o.displayName || String(o), name: o.name || o.displayName || o.id || String(o), displayName: o.displayName || o.name || o.id || String(o) };
      });
      // client-side dedupe by canonical name (safe-guard)
      const map = new Map();
      normalized.forEach(o => {
        const canon = String(o.name || '').trim().toLowerCase();
        if (!canon) return;
        if (!map.has(canon)) map.set(canon, o);
        else {
          const existing = map.get(canon);
          if ((!existing.id || existing.id === existing.name) && o.id) map.set(canon, o);
        }
      });
      return Array.from(map.values());
    } catch (err) {
      try {
        const localEvents = JSON.parse(localStorage.getItem("events") || "[]");
        const names = Array.from(new Set(localEvents.map(e => e.org).filter(Boolean)));
        return names.map(n => ({ id: n, name: n, displayName: n }));
      } catch (e) {
        return [];
      }
    }
  }

  // Prefer fetching events by orgId when available (server supports ?orgId=)
  async function fetchEventsForOrg(orgName, orgId = null) {
    if (!orgName && !orgId) return [];
    try {
      const url = orgId ? `${SERVER_BASE}/api/events?orgId=${encodeURIComponent(orgId)}` : `${SERVER_BASE}/api/events?org=${encodeURIComponent(orgName)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const events = await res.json();
      if (!Array.isArray(events)) return [];
      return events;
    } catch (err) {
      try {
        const local = JSON.parse(localStorage.getItem("events") || "[]");
        if (orgId) return local.filter(e => e.orgId === orgId || e.org === orgName);
        return local.filter(e => e.org === orgName);
      } catch (e) {
        return [];
      }
    }
  }

  // ----------------------
  // Helper: PUT FormData helper for updating server events (supports receiverQR)
  // ----------------------
  async function putEventToServer(id, formData) {
    try {
      const res = await fetch(`${SERVER_BASE}/api/events/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: formData
      });
      if (!res.ok) {
        const txt = await res.text().catch(()=>'');
        throw new Error(`Server responded ${res.status}: ${txt}`);
      }
      return await res.json();
    } catch (err) {
      throw err;
    }
  }

  // ----------------------
  // Event Management: list, add, edit, delete
  // Prefers server events when available; falls back to localStorage.
  // Shows server events with same UI as local events (View/Edit/Delete).
  // ----------------------
  async function loadEvents() {
    if (!eventTableBody) return;
    eventTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:18px">Loading events...</td></tr>`;
    const officerOrg = getCurrentOrg();
    const officerOrgId = getCurrentOrgId();

    // Ensure org selection exists if missing: try to auto-set using server orgs
    if (!officerOrg) {
      try {
        const orgs = await fetchOrgsFromServer();
        if (orgs && orgs.length === 1) {
          const o = orgs[0];
          try { localStorage.setItem('officerOrg', o.name || o.displayName || o.id); } catch(e){}
          if (o.id) try { localStorage.setItem('officerOrgId', o.id); } catch(e){}
        }
      } catch (e) { /* ignore */ }
    }

    // Attempt to fetch server events for this org (prefer orgId)
    let serverEvents = null;
    if (officerOrg || officerOrgId) {
      try {
        serverEvents = await fetchEventsForOrg(officerOrg, officerOrgId);
      } catch (e) {
        console.debug('fetchEventsForOrg failed (orgId or name):', e);
        serverEvents = null;
      }
    }

    // Always dedupe and prefer server events when available
    let localEvents = JSON.parse(localStorage.getItem("events") || "[]");
    localEvents = Array.isArray(localEvents) ? localEvents : [];

    let useEvents = [];
    let source = 'local';

    if (Array.isArray(serverEvents) && serverEvents.length > 0) {
      // Use server events exclusively for display; but ensure local mirror is updated (no duplicates)
      useEvents = serverEvents;
      source = 'server';

      // Update localStorage mirror: remove any local items that match server ids or name+org duplicates,
      // then insert server events so localStorage reflects server state (helps offline fallback later)
      try {
        const serverById = new Set(serverEvents.map(e => e.id).filter(Boolean));
        const serverByKey = new Set(serverEvents.map(e => `${(e.org||'').trim()}:::${(e.name||'').trim()}`));
        const filteredLocal = localEvents.filter(le => {
          if (le.id && serverById.has(le.id)) return false;
          const key = `${(le.org||'').trim()}:::${(le.name||'').trim()}`;
          if (serverByKey.has(key)) return false;
          return true;
        });
        const mirrored = serverEvents.concat(filteredLocal);
        localStorage.setItem("events", JSON.stringify(mirrored));
      } catch (e) {
        console.warn('Failed to mirror server events to localStorage:', e);
      }
    } else {
      // fallback to local events filtered by org or orgId
      useEvents = localEvents.filter(ev => {
        if (officerOrgId && ev.orgId) return ev.orgId === officerOrgId;
        if (officerOrg) return ev.org === officerOrg;
        return false;
      });
      source = 'local';
    }

    if (!useEvents || useEvents.length === 0) {
      eventTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:18px">No events yet</td></tr>`;
      return;
    }

    eventTableBody.innerHTML = "";
    useEvents.forEach((ev, idx) => {
      const tr = document.createElement("tr");
      // Render same UI for both server and local events (no cloud badge)
      // Buttons will carry either data-global-index (local) or data-ev-id (server)
      const isServer = (source === 'server');
      tr.innerHTML = `
        <td>${escapeHtml(ev.name)}</td>
        <td>₱${escapeHtml(String(ev.fee || ""))}</td>
        <td>${escapeHtml(ev.deadline || "")}</td>
        <td>${escapeHtml(ev.status || "")}</td>
        <td>
          ${isServer
            ? `<button class="viewBtn" data-ev-id="${ev.id}" data-ev-source="server" data-ev-idx="${idx}">View</button>
               <button class="editBtn" data-ev-id="${ev.id}" data-ev-source="server" data-ev-idx="${idx}">Edit</button>
               <button class="deleteBtn" data-ev-id="${ev.id}" data-ev-source="server">Delete</button>`
            : `<button class="viewBtn" data-global-index="${idx}" data-ev-source="local">View</button>
               <button class="editBtn" data-global-index="${idx}" data-ev-source="local">Edit</button>
               <button class="deleteBtn" data-global-index="${idx}" data-ev-source="local">Delete</button>`}
        </td>
      `;
      eventTableBody.appendChild(tr);
    });

    // attach listeners for unified button classes
    // View handlers
    eventTableBody.querySelectorAll(".viewBtn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const evSource = e.target.getAttribute('data-ev-source');
        if (evSource === 'server') {
          const evId = e.target.getAttribute('data-ev-id');
          if (!evId) return;
          try {
            const res = await fetchWithAuth(`${SERVER_BASE}/api/events/${encodeURIComponent(evId)}`, { method: 'GET' });
            if (!res.ok) {
              alert('Failed to fetch event details from server');
              return;
            }
            const ev = await res.json();
            openEventPaymentsView(ev);
          } catch (err) {
            console.error('Failed to fetch event details:', err);
            alert('Failed to fetch event details');
          }
        } else {
          const idx = Number(e.target.getAttribute('data-global-index'));
          const events = JSON.parse(localStorage.getItem("events") || "[]");
          const event = events[idx];
          if (event) openEventPaymentsView(event);
        }
      });
    });

    // Edit handlers
    eventTableBody.querySelectorAll(".editBtn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const evSource = e.target.getAttribute('data-ev-source');
        if (evSource === 'server') {
          const evId = e.target.getAttribute('data-ev-id');
          if (!evId) return;
          try {
            const res = await fetchWithAuth(`${SERVER_BASE}/api/events/${encodeURIComponent(evId)}`, { method: 'GET' });
            if (!res.ok) { alert('Failed to fetch event for editing'); return; }
            const ev = await res.json();
            // populate form with server event
            if (eventNameInput) eventNameInput.value = ev.name || "";
            if (eventDeadlineInput) eventDeadlineInput.value = ev.deadline || "";
            if (eventFeeInput) eventFeeInput.value = ev.fee || "";
            if (receiverNumberInput) receiverNumberInput.value = ev.receiver?.number || "";
            if (receiverNameInput) receiverNameInput.value = ev.receiver?.name || "";
            if (confirmQR) {
              // show signed URL if present (ev.receiver.qr) else leave blank
              confirmQR.src = ev.receiver?.qr || "";
            }
            if (receiverQRInput) receiverQRInput.value = "";
            editingEventIndex = null;
            editingServerEventId = evId;
            showAddEventForm(true);
          } catch (err) {
            console.error('Failed to fetch server event for edit:', err);
            alert('Failed to fetch server event for edit');
          }
        } else {
          const globalIndex = Number(e.target.getAttribute('data-global-index'));
          const events = JSON.parse(localStorage.getItem("events") || "[]");
          const event = events[globalIndex];
          if (!event) return;
          // populate form with event
          if (eventNameInput) eventNameInput.value = event.name;
          if (eventDeadlineInput) eventDeadlineInput.value = event.deadline;
          if (eventFeeInput) eventFeeInput.value = event.fee;
          if (receiverNumberInput) receiverNumberInput.value = event.receiver?.number || "";
          if (receiverNameInput) receiverNameInput.value = event.receiver?.name || "";
          if (confirmQR) confirmQR.src = event.receiver?.qr || "";
          if (receiverQRInput) receiverQRInput.value = "";
          editingEventIndex = globalIndex;
          editingServerEventId = null;
          showAddEventForm(true);
        }
      });
    });

    // Delete handlers
    eventTableBody.querySelectorAll(".deleteBtn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const evSource = e.target.getAttribute('data-ev-source');
        if (evSource === 'server') {
          const id = e.target.getAttribute('data-ev-id');
          if (!id) return;
          if (!confirm('Delete this server event? This will remove it for everyone.')) return;
          try {
            const res = await fetchWithAuth(`${SERVER_BASE}/api/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!res.ok) {
              const txt = await res.text().catch(()=> '');
              throw new Error(txt || `Status ${res.status}`);
            }
            // remove any matching local mirror entries (by id)
            try {
              const locals = JSON.parse(localStorage.getItem("events") || "[]");
              const filtered = (locals || []).filter(l => !(l.id && l.id === id));
              localStorage.setItem("events", JSON.stringify(filtered));
            } catch (e) { console.warn('Failed to clean local mirror after server delete:', e); }

            alert('Deleted event from server.');
            loadEvents();
          } catch (err) {
            console.error('Failed to delete server event:', err);
            alert('Failed to delete server event. Check console.');
          }
        } else {
          const globalIndex = Number(e.target.getAttribute('data-global-index'));
          let events = JSON.parse(localStorage.getItem("events") || "[]");
          if (!events[globalIndex]) { loadEvents(); return; }
          if (!confirm("Are you sure you want to delete this event?")) return;
          events.splice(globalIndex, 1);
          localStorage.setItem("events", JSON.stringify(events));
          loadEvents();
          alert("Event deleted successfully!");
        }
      });
    });
  }

  function showEvents() {
    show(eventsCard, "");
    hide(addEventForm);
    hide(profileForm);
    hide(verifyPaymentsSection);
    if (step1) show(step1, "");
    if (step2) hide(step2);
    editingEventIndex = null;
    editingServerEventId = null;
    loadEvents();
  }

  function showAddEventForm(isEditing = false) {
    hide(eventsCard); hide(profileForm); hide(verifyPaymentsSection);
    show(addEventForm, "");
    if (step1) show(step1, "");
    if (step2) hide(step2);
    try { addEventForm.scrollIntoView({ behavior: "smooth", block: "start" }); } catch(e) {}
  }

  function showProfileForm() {
    hide(eventsCard); hide(addEventForm); hide(verifyPaymentsSection);
    show(profileForm, "");
    try { profileForm.scrollIntoView({ behavior: "smooth", block: "start" }); } catch(e) {}
  }

  // ----------------------
  // Payments view: render table and stats
  // ----------------------
  function renderVerifyPaymentsForEvent(eventName) {
    const paymentHistory = JSON.parse(localStorage.getItem("paymentHistory") || "[]");
    if (!verifyTableBody) return;
    const officerOrg = getCurrentOrg();

    (async () => {
      const all = await fetchAllPaymentsFromServer();

      // Filter logic: server items may include purpose/name fields
      const serverFiltered = (all || []).filter(p => {
        const matchesOrg = p.org === officerOrg || (p.purpose && p.purpose.startsWith(officerOrg)) || false;
        const matchesEvent = p.event === eventName || (p.purpose && p.purpose.includes(eventName)) || (p.name && p.name === eventName);
        return matchesOrg && matchesEvent;
      });

      let toShow = serverFiltered;
      // fallback to localStorage if server returned nothing
      if ((!toShow || toShow.length === 0) && paymentHistory.length > 0) {
        toShow = paymentHistory.filter(p => p.org === officerOrg && p.event === eventName);
      }

      // compute stats
      try {
        ensureStatsElements();
        const paidStudents = new Set();
        let approvedCount = 0;
        let sumApproved = 0;
        (toShow || []).forEach(p => {
          const key = p.submittedByUid || p.submitted_by_uid || p.submittedByEmail || p.submitted_by_email || p.studentName || p.student || p.student_name || `${p.reference || ''}:${p.amount || ''}`;
          if (key) paidStudents.add(key);
          if (String(p.status || '').toLowerCase() === 'approved') {
            approvedCount++;
            const amt = parseFloat(p.amount || 0) || 0;
            sumApproved += amt;
          }
        });

        if (paidCountEl) paidCountEl.textContent = String(paidStudents.size);
        if (approvedCountEl) approvedCountEl.textContent = String(approvedCount);
        if (receivedTotalEl) receivedTotalEl.textContent = `₱${sumApproved.toFixed(2)}`;
      } catch (e) {
        console.warn('Failed to compute payment stats:', e);
      }

      // render table
      verifyTableBody.innerHTML = "";
      if (!toShow || toShow.length === 0) {
        verifyTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:18px">No payments submitted for this event</td></tr>`;
        return;
      }

      toShow.forEach(rec => {
        const tr = createVerifyRow(rec);
        verifyTableBody.appendChild(tr);
      });
    })();
  }

  // Create table row for a payment record
  function createVerifyRow(rec) {
    const tr = document.createElement("tr");

    const dateCell = document.createElement("td");
    dateCell.textContent = rec.date ? new Date(rec.date).toLocaleString() : (rec.createdAt ? new Date(rec.createdAt).toLocaleString() : "");

    const studentCell = document.createElement("td");
    const studentName = rec.studentName || rec.student || rec.student_name || rec.payerName || rec.name || "Unknown";
    studentCell.innerHTML = `<div style="font-weight:700">${escapeHtml(studentName)}</div>`;

    const amountCell = document.createElement("td");
    amountCell.textContent = `₱${rec.amount || ""}`;

    const refCell = document.createElement("td");
    refCell.textContent = rec.reference || rec.referenceNumber || rec.ref || "";

    const proofCell = document.createElement("td");
    const proofBtn = document.createElement("button");
    proofBtn.type = "button";
    proofBtn.className = "proof-btn";
    proofBtn.textContent = "View Proof";
    proofBtn.addEventListener("click", () => viewProof(rec));
    proofCell.appendChild(proofBtn);

    const statusCell = document.createElement("td");
    const statusSelect = document.createElement("select");
    statusSelect.className = "status-select";
    ["Pending","Approved"].forEach(s => {
      const op = document.createElement("option");
      op.value = s;
      op.textContent = s;
      if (String(rec.status || "pending").toLowerCase() === s.toLowerCase()) op.selected = true;
      statusSelect.appendChild(op);
    });
    statusSelect.addEventListener("change", (e) => {
      const newStatus = e.target.value;
      if (!confirm(`Mark payment from "${studentName}" as "${newStatus}"?`)) {
        statusSelect.value = (rec.status && String(rec.status).charAt(0).toUpperCase() + String(rec.status).slice(1)) || "Pending";
        return;
      }
      const normalized = newStatus.toLowerCase();
      rec.status = normalized;
      statusSelect.value = newStatus;
      updatePaymentStatus(rec, newStatus);
    });
    statusCell.appendChild(statusSelect);

    tr.appendChild(dateCell);
    tr.appendChild(studentCell);
    tr.appendChild(amountCell);
    tr.appendChild(refCell);
    tr.appendChild(proofCell);
    tr.appendChild(statusCell);

    return tr;
  }

  // Show proof modal
  async function viewProof(record) {
    if (!proofModal) return;
    if (!record) { alert("No record provided"); return; }

    const directProofUrl = record.proof || record.proofFile || record.proofFileUrl || record.proofFileURL || null;
    let finalUrl = null;
    let expiresIn = 0;
    let isLocal = false;

    const paymentId = record.id || record.paymentId || null;
    if (paymentId) {
      try {
        const entry = await requestSignedUrl(paymentId);
        if (entry && entry.url) {
          finalUrl = entry.url;
          isLocal = !!entry.local;
          expiresIn = entry.expiresAt ? Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)) : 0;
        }
      } catch (err) {
        console.warn('Signed URL request failed:', err);
      }
    }

    if (!finalUrl && directProofUrl) {
      finalUrl = directProofUrl;
      if (String(directProofUrl).startsWith(location.origin + '/uploads/') || String(directProofUrl).startsWith('/uploads/')) isLocal = true;
    }

    if (!finalUrl && record.proofObjectPath) {
      finalUrl = `${location.origin}/uploads/${record.proofObjectPath}`;
      isLocal = true;
    }

    if (!finalUrl) {
      alert("No proof available for this payment.");
      return;
    }

    proofModal.innerHTML = "";
    const overlay = document.createElement("div"); overlay.className = "modal-overlay"; overlay.tabIndex = -1;
    const card = document.createElement("div"); card.className = "modal-card";

    const title = document.createElement("h3"); title.id = "proofModalTitle"; title.textContent = `Proof — ${record.event || ""} (${record.reference || ""})`; card.appendChild(title);

    const img = document.createElement("img");
    img.alt = "Proof of Payment";
    img.src = finalUrl;
    img.style.maxWidth = "640px";
    img.style.maxHeight = "60vh";
    img.style.display = "block";
    img.style.margin = "8px auto";
    card.appendChild(img);

    img.onerror = () => {
      const errP = document.createElement("p");
      errP.className = "small-muted";
      errP.textContent = "Could not load image. You can open the raw URL in a new tab to inspect.";
      card.appendChild(errP);

      const rawBtn = document.createElement("button");
      rawBtn.type = "button";
      rawBtn.className = "btn small";
      rawBtn.textContent = "Open raw URL";
      rawBtn.addEventListener("click", () => { window.open(finalUrl, "_blank"); });
      card.appendChild(rawBtn);
    };

    const meta = document.createElement("p"); meta.style.marginTop = "8px"; meta.className = "small-muted";
    meta.textContent = `Submitted: ${record.date ? new Date(record.date).toLocaleString() : (record.createdAt ? new Date(record.createdAt).toLocaleString() : "")}`;
    card.appendChild(meta);

    if (!isLocal && expiresIn && expiresIn > 0) {
      const expNote = document.createElement("p");
      expNote.className = "small-muted";
      expNote.textContent = `This link expires in ${Math.round(expiresIn / 60)} minute(s).`;
      card.appendChild(expNote);
    }

    const actions = document.createElement("div"); actions.className = "modal-actions";
    const closeBtn = document.createElement("button"); closeBtn.className = "btn secondary"; closeBtn.type = "button"; closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => { hide(proofModal); proofModal.innerHTML = ""; });
    actions.appendChild(closeBtn);

    const openBtn = document.createElement("button"); openBtn.className = "btn"; openBtn.type = "button"; openBtn.textContent = "Open in new tab";
    openBtn.addEventListener("click", () => { window.open(finalUrl, "_blank"); });
    actions.appendChild(openBtn);

    card.appendChild(actions);
    overlay.appendChild(card);
    proofModal.appendChild(overlay);
    show(proofModal, "block");
  }

  // Update payment status (server or local fallback)
  async function updatePaymentStatus(record, newStatus) {
    const id = record.id || record.paymentId || null;
    const normalized = String(newStatus || '').toLowerCase();

    if (!id) {
      // local update
      const paymentHistory = JSON.parse(localStorage.getItem("paymentHistory") || "[]");
      let idx = paymentHistory.findIndex(r => (r.createdAt && record.createdAt && r.createdAt === record.createdAt) || (r.reference === record.reference && r.event === record.event && String(r.amount) === String(record.amount) && (r.date === record.date)));
      if (idx === -1) { idx = paymentHistory.findIndex(r => r.org === record.org && r.event === record.event && r.reference === record.reference); }
      if (idx === -1) { alert("Could not find payment to update."); return; }
      paymentHistory[idx].status = normalized;
      paymentHistory[idx].verifiedBy = localStorage.getItem("officerOrg") || profileOrg?.value || "Officer";
      paymentHistory[idx].verifiedAt = new Date().toISOString();
      localStorage.setItem("paymentHistory", JSON.stringify(paymentHistory));
      if (currentEventView) renderVerifyPaymentsForEvent(currentEventView.name);
      loadEvents();
      alert(`Payment status updated to "${newStatus}" (local)`);
      return;
    }

    try {
      if (normalized === 'approved') {
        const endpoint = `${SERVER_BASE}/api/payments/${encodeURIComponent(id)}/approve`;
        const res = await fetchWithAuth(endpoint, { method: 'POST' });
        if (!res.ok) {
          const txt = await res.text().catch(()=> '');
          throw new Error(txt || 'Server error');
        }
        const updated = await res.json();
        const paymentHistory = JSON.parse(localStorage.getItem("paymentHistory") || "[]");
        const idx = paymentHistory.findIndex(p => p.id === id || (p.reference === record.reference && p.event === record.event));
        if (idx !== -1) {
          paymentHistory[idx] = Object.assign({}, paymentHistory[idx], updated);
          localStorage.setItem("paymentHistory", JSON.stringify(paymentHistory));
        }
        if (currentEventView) renderVerifyPaymentsForEvent(currentEventView.name);
        loadEvents();
        alert(`Payment marked ${newStatus}`);
        return;
      }

      // normalized === 'pending' attempt server unapprove
      try {
        const endpoint = `${SERVER_BASE}/api/payments/${encodeURIComponent(id)}/unapprove`;
        const res = await fetchWithAuth(endpoint, { method: 'POST' });
        if (res.ok) {
          const updated = await res.json();
          const paymentHistory = JSON.parse(localStorage.getItem("paymentHistory") || "[]");
          const idx = paymentHistory.findIndex(p => p.id === id || (p.reference === record.reference && p.event === record.event));
          if (idx !== -1) {
            paymentHistory[idx] = Object.assign({}, paymentHistory[idx], updated);
            localStorage.setItem("paymentHistory", JSON.stringify(paymentHistory));
          }
          if (currentEventView) renderVerifyPaymentsForEvent(currentEventView.name);
          loadEvents();
          alert('Marked as Pending (server persisted)');
          return;
        }
      } catch (e) {
        console.debug('unapprove endpoint missing or failed:', e);
      }

      // fallback local update
      record.status = 'pending';
      const paymentHistory = JSON.parse(localStorage.getItem("paymentHistory") || "[]");
      const idxLocal = paymentHistory.findIndex(p => p.id === id || (p.reference === record.reference && p.event === record.event));
      if (idxLocal !== -1) {
        paymentHistory[idxLocal].status = 'pending';
        localStorage.setItem("paymentHistory", JSON.stringify(paymentHistory));
      }
      if (currentEventView) renderVerifyPaymentsForEvent(currentEventView.name);
      loadEvents();
      alert('Marked as Pending (local update). To persist this change server-side, add a /api/payments/:id/unapprove endpoint on the server.');
    } catch (err) {
      console.error('Failed to update status via server:', err);
      alert('Failed to update status on server. Check console.');
      if (currentEventView) renderVerifyPaymentsForEvent(currentEventView.name);
    }
  }

  // Open payments view for a specific event
  function openEventPaymentsView(eventObj) {
    currentEventView = eventObj;
    if (eventPaymentsHeading) eventPaymentsHeading.textContent = `Payments — ${eventObj.name}`;
    hide(eventsCard); hide(addEventForm); hide(profileForm); show(verifyPaymentsSection, "");
    ensureStatsElements();
    renderVerifyPaymentsForEvent(eventObj.name);
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch {}
  }

  // Back to events
  if (backToEventsBtn) {
    backToEventsBtn.addEventListener("click", () => {
      currentEventView = null;
      hide(verifyPaymentsSection);
      show(eventsCard, "");
      loadEvents();
    });
  }

  // Filter placeholder
  if (filterBtn) {
    filterBtn.addEventListener("click", () => {
      alert("Filter UI coming soon — I'll add the filter panel/drawer next.");
    });
  }

  // ----------------------
  // Profile dropdown wiring & logout
  // ----------------------
  function ensureProfileButtonWorks() {
    try {
      if (profileBtnWrapper) {
        profileBtnWrapper.style.pointerEvents = 'auto';
        profileBtnWrapper.style.zIndex = profileBtnWrapper.style.zIndex || '1250';
        profileBtnWrapper.setAttribute('tabindex', profileBtnWrapper.getAttribute('tabindex') || '0');
        profileBtnWrapper.setAttribute('role', profileBtnWrapper.getAttribute('role') || 'button');
      }
      if (profileDropdown) {
        profileDropdown.style.pointerEvents = 'auto';
        profileDropdown.style.zIndex = profileDropdown.style.zIndex || '1300';
      }

      if (profileBtnWrapper && !profileBtnWrapper._listenerAttached) {
        profileBtnWrapper.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!profileDropdown) return;
          const nowExpanded = profileBtnWrapper.getAttribute('aria-expanded') === 'true';
          profileDropdown.classList.toggle("hidden");
          profileBtnWrapper.setAttribute('aria-expanded', String(!nowExpanded));
        });
        profileBtnWrapper._listenerAttached = true;
      }

      if (!document._profileFallbackInstalled) {
        document.addEventListener("click", (e) => {
          const wrapper = document.getElementById("profileBtnWrapper");
          const dropdown = document.getElementById("profileDropdown");
          if (!wrapper || !dropdown) return;

          if (wrapper.contains(e.target)) {
            e.stopPropagation();
            const wasHidden = dropdown.classList.contains("hidden");
            document.querySelectorAll(".dropdown-menu").forEach(dm => { if (dm !== dropdown) dm.classList.add("hidden"); });
            if (wasHidden) {
              dropdown.classList.remove("hidden");
              wrapper.setAttribute('aria-expanded', 'true');
            } else {
              dropdown.classList.add("hidden");
              wrapper.setAttribute('aria-expanded', 'false');
            }
            return;
          }

          if (dropdown.contains(e.target)) return;

          if (!dropdown.classList.contains("hidden")) {
            dropdown.classList.add("hidden");
            wrapper.setAttribute('aria-expanded', 'false');
          }
        }, false);
        document._profileFallbackInstalled = true;
      }
    } catch (err) {
      console.warn("ensureProfileButtonWorks error:", err);
    }
  }

  if (profileBtn) {
    profileBtn.addEventListener("click", () => {
      if (profileDropdown) profileDropdown.classList.add("hidden");
      if (profileBtnWrapper) profileBtnWrapper.setAttribute('aria-expanded', 'false');
      showProfileForm();
      loadProfile();
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      // Keep profile data per-org; just navigate away
      window.location.href = "index.html";
    });
  }

  // Home button -> show events
  if (homeBtn) {
    homeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      showEvents();
    });
  }

  // initialize
  ensureProfileButtonWorks();
  loadProfile();
  loadEvents();
  showEvents();

  // ----------------------
  // Client-side helpers for uploading events with QR as File (FormData)
  // ----------------------
  // Convert dataURL to File/Blob
  function dataURLtoFile(dataurl, filename = 'qr.png') {
    if (!dataurl) return null;
    const arr = dataurl.split(',');
    if (arr.length < 2) return null;
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    try {
      return new File([u8arr], filename, { type: mime });
    } catch (e) {
      const file = new Blob([u8arr], { type: mime });
      file.name = filename;
      return file;
    }
  }

  // POST FormData helper
  async function postEventToServer(formData) {
    try {
      const res = await fetch(`${SERVER_BASE}/api/events`, {
        method: 'POST',
        body: formData // browser sets the multipart Content-Type boundary
      });
      if (!res.ok) {
        const txt = await res.text().catch(()=> '');
        throw new Error(`Server responded ${res.status}: ${txt}`);
      }
      return await res.json();
    } catch (err) {
      throw err;
    }
  }

  // Add Event wiring
  if (addEventBtn) {
    addEventBtn.addEventListener("click", () => {
      editingEventIndex = null;
      editingServerEventId = null;
      if (eventNameInput) eventNameInput.value = "";
      if (eventDeadlineInput) eventDeadlineInput.value = "";
      if (eventFeeInput) eventFeeInput.value = "";
      if (receiverNumberInput) receiverNumberInput.value = "";
      if (receiverNameInput) receiverNameInput.value = "";
      if (receiverQRInput) receiverQRInput.value = "";
      if (confirmQR) confirmQR.src = "";
      showAddEventForm(false);
    });
  }

  if (cancelAddEvent) {
    cancelAddEvent.addEventListener("click", () => {
      if (step1) show(step1, "");
      if (step2) hide(step2);
      editingEventIndex = null;
      editingServerEventId = null;
      showEvents();
    });
  }

  if (backToStep1Btn) {
    backToStep1Btn.addEventListener("click", () => {
      if (step2) hide(step2);
      if (step1) show(step1, "");
    });
  }

  if (nextStepBtn) {
    nextStepBtn.addEventListener("click", () => {
      if (!eventNameInput || !eventDeadlineInput || !eventFeeInput || !receiverNumberInput || !receiverNameInput) {
        alert("Please fill all required fields");
        return;
      }
      if (!eventNameInput.value || !eventDeadlineInput.value || !eventFeeInput.value ||
          !receiverNumberInput.value || !receiverNameInput.value) {
        alert("Please fill all required fields");
        return;
      }
      if (receiverQRInput && receiverQRInput.files && receiverQRInput.files[0]) {
        const file = receiverQRInput.files[0];
        const reader = new FileReader();
        if (addEventConfirmBtn) addEventConfirmBtn.disabled = true;
        reader.onload = () => {
          if (confirmQR) confirmQR.src = reader.result;
          fillConfirmStep();
          if (addEventConfirmBtn) addEventConfirmBtn.disabled = false;
        };
        reader.readAsDataURL(file);
      } else {
        fillConfirmStep();
      }
    });
  }

  function fillConfirmStep() {
    if (confirmEventName) confirmEventName.textContent = eventNameInput.value;
    if (confirmDeadline) confirmDeadline.textContent = eventDeadlineInput.value;
    if (confirmAmount) confirmAmount.textContent = eventFeeInput.value;
    if (confirmNumber) confirmNumber.textContent = receiverNumberInput.value;
    if (confirmName) confirmName.textContent = receiverNameInput.value;
    if (step1) hide(step1);
    if (step2) show(step2, "");
  }

  // ----------------------
  // UPDATED addEventConfirmBtn handler: attempt FormData POST (with QR file) then fallback to localStorage
  // Also handles PUT when editing a server event (editingServerEventId)
  // ----------------------
  if (addEventConfirmBtn) {
    addEventConfirmBtn.addEventListener("click", async () => {
      const events = JSON.parse(localStorage.getItem("events") || "[]");
      const newEventData = {
        name: eventNameInput ? eventNameInput.value : "",
        fee: eventFeeInput ? Number(eventFeeInput.value) : 0,
        deadline: eventDeadlineInput ? eventDeadlineInput.value : "",
        status: "Open",
        org: getCurrentOrg(),
        orgId: getCurrentOrgId(),
        receiver: {
          number: receiverNumberInput ? receiverNumberInput.value : "",
          name: receiverNameInput ? receiverNameInput.value : "",
          qr: (confirmQR && confirmQR.src) ? confirmQR.src : ""
        }
      };

      // if editing a server event, perform PUT multipart to /api/events/:id
      if (editingServerEventId) {
        try {
          const form = new FormData();
          if (newEventData.name) form.append('name', newEventData.name);
          form.append('fee', String(newEventData.fee || 0));
          if (newEventData.deadline) form.append('deadline', newEventData.deadline);
          if (newEventData.orgId) form.append('orgId', newEventData.orgId);
          else if (newEventData.org) form.append('org', newEventData.org);
          // Include receiver metadata (without qr)
          const receiverMeta = Object.assign({}, newEventData.receiver);
          delete receiverMeta.qr;
          form.append('receiver', JSON.stringify(receiverMeta));

          // If new QR file provided, append it
          let qrFile = null;
          if (receiverQRInput && receiverQRInput.files && receiverQRInput.files[0]) {
            qrFile = receiverQRInput.files[0];
          } else if (confirmQR && confirmQR.src && String(confirmQR.src).startsWith('data:')) {
            const filenameSafe = (newEventData.name || 'event').replace(/\s+/g, '_').slice(0,40) + '_qr.png';
            qrFile = dataURLtoFile(confirmQR.src, filenameSafe);
          }
          if (qrFile) form.append('receiverQR', qrFile, qrFile.name || 'qr.png');

          const updated = await putEventToServer(editingServerEventId, form);

          // Update localStorage mirror: remove any local entries with same id or same name+org, then add updated
          try {
            const local = JSON.parse(localStorage.getItem("events") || "[]");
            const filtered = (local || []).filter(l => {
              if (l.id && l.id === updated.id) return false;
              const keyLocal = `${(l.org||'').trim()}:::${(l.name||'').trim()}`;
              const keyUpdated = `${(updated.org||'').trim()}:::${(updated.name||'').trim()}`;
              if (keyLocal === keyUpdated) return false;
              return true;
            });
            filtered.unshift(updated);
            localStorage.setItem("events", JSON.stringify(filtered));
          } catch (e) {
            console.warn('Failed to update local mirror after PUT:', e);
          }

          alert("Event updated on server successfully!");
          editingServerEventId = null;
        } catch (err) {
          console.warn('Event PUT failed:', err);
          alert('Failed to update event on server. See console.');
        } finally {
          // Reset form UI
          if (step1) show(step1, "");
          if (step2) hide(step2);
          if (eventNameInput) eventNameInput.value = "";
          if (eventDeadlineInput) eventDeadlineInput.value = "";
          if (eventFeeInput) eventFeeInput.value = "";
          if (receiverNumberInput) receiverNumberInput.value = "";
          if (receiverNameInput) receiverNameInput.value = "";
          if (receiverQRInput) receiverQRInput.value = "";
          if (confirmQR) confirmQR.src = "";
          loadEvents();
        }
        return;
      }

      // Not editing server event -> create new or edit local
      let postedToServer = false;
      try {
        const form = new FormData();
        form.append('name', newEventData.name || '');
        form.append('fee', String(newEventData.fee || 0));
        if (newEventData.deadline) form.append('deadline', newEventData.deadline);
        if (newEventData.orgId) form.append('orgId', newEventData.orgId);
        else if (newEventData.org) form.append('org', newEventData.org);

        // Prepare receiver metadata and remove qr (we send qr as file)
        const receiverMeta = Object.assign({}, newEventData.receiver);
        const qrDataUrl = receiverMeta.qr;
        delete receiverMeta.qr;
        form.append('receiver', JSON.stringify(receiverMeta));

        // Determine QR file: prefer file input, otherwise convert data URL
        let qrFile = null;
        if (receiverQRInput && receiverQRInput.files && receiverQRInput.files[0]) {
          qrFile = receiverQRInput.files[0];
        } else if (confirmQR && confirmQR.src && String(confirmQR.src).startsWith('data:')) {
          const filenameSafe = (newEventData.name || 'event').replace(/\s+/g, '_').slice(0,40) + '_qr.png';
          qrFile = dataURLtoFile(confirmQR.src, filenameSafe);
        }

        if (qrFile) {
          form.append('receiverQR', qrFile, qrFile.name || 'qr.png');
        }

        // Attempt to post to server
        const serverResp = await postEventToServer(form);
        if (serverResp && (serverResp.id || serverResp.name)) {
          const createdEvent = serverResp;
          // Ensure no duplicate local entries: remove local entries with same id or same name+org
          try {
            const localEvents = JSON.parse(localStorage.getItem("events") || "[]");
            const filtered = (localEvents || []).filter(l => {
              if (l.id && createdEvent.id && l.id === createdEvent.id) return false;
              const keyLocal = `${(l.org||'').trim()}:::${(l.name||'').trim()}`;
              const keyCreated = `${(createdEvent.org||'').trim()}:::${(createdEvent.name||'').trim()}`;
              if (keyLocal === keyCreated) return false;
              return true;
            });
            filtered.unshift(createdEvent);
            localStorage.setItem("events", JSON.stringify(filtered));
          } catch (e) {
            // fallback: just set created event as the only local event
            try {
              const local = JSON.parse(localStorage.getItem("events") || "[]");
              local.unshift(createdEvent);
              localStorage.setItem("events", JSON.stringify(local));
            } catch (e2) {
              console.warn('Failed to mirror created event locally:', e2);
            }
          }

          alert("Event saved on server successfully!");
          postedToServer = true;
        } else {
          console.warn('Server did not return created event; falling back to local save');
        }
      } catch (err) {
        console.warn('Event POST failed, falling back to localStorage:', err);
      }

      if (!postedToServer) {
        // Fallback: preserve existing behavior (localStorage)
        if (editingEventIndex !== null && editingEventIndex !== undefined && editingEventIndex !== -1) {
          const allEvents = JSON.parse(localStorage.getItem("events") || "[]");
          // if editing local, preserve orgId if present
          if (allEvents[editingEventIndex] && newEventData.orgId) allEvents[editingEventIndex].orgId = newEventData.orgId;
          allEvents[editingEventIndex] = newEventData;
          localStorage.setItem("events", JSON.stringify(allEvents));
          editingEventIndex = null;
        } else {
          // attach orgId to local event for future canonical mapping
          if (newEventData.orgId) newEventData.orgId = newEventData.orgId;
          events.push(newEventData);
          localStorage.setItem("events", JSON.stringify(events));
        }
        alert(postedToServer ? "Event saved on server successfully!" : "Event saved locally (offline fallback).");
      }

      // Reset form UI (same as original)
      if (step1) show(step1, "");
      if (step2) hide(step2);
      if (eventNameInput) eventNameInput.value = "";
      if (eventDeadlineInput) eventDeadlineInput.value = "";
      if (eventFeeInput) eventFeeInput.value = "";
      if (receiverNumberInput) receiverNumberInput.value = "";
      if (receiverNameInput) receiverNameInput.value = "";
      if (receiverQRInput) receiverQRInput.value = "";
      if (confirmQR) confirmQR.src = "";

      showEvents();
    });
  }

  // storage events to sync across tabs
  window.addEventListener("storage", (ev) => {
    if (!ev.key) return;
    if (["paymentHistory","officerOrg","officerProfile","officerProfiles","events","orgsLastUpdated","officerOrgId"].includes(ev.key)) {
      loadProfile();
      loadEvents();
      if (currentEventView) renderVerifyPaymentsForEvent(currentEventView.name);
    }
  });

  // End DOMContentLoaded
});
