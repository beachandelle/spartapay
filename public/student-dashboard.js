// student-dashboard.js
// Full updated student dashboard script (expanded, integrated).
// - Preserves original functionality (profile, events, payment flow, history).
// - Adds robust profile picture assignment and onerror fallback.
// - Renders the confirmation text inside the dashboard (Done section) after payment and wires an "Okay" button to return to main page.
// - Uses server endpoints where available and falls back to localStorage when needed.
// - NEW: fetches organizations from /api/orgs and events from /api/events?orgId=... (server-preferred).
// - NEW: reacts to a small localStorage signal ('orgsLastUpdated') so open tabs refresh org list quicker.

document.addEventListener("DOMContentLoaded", () => {
  // Use localhost only for local development; on deployed site use same-origin (empty string -> '/api/...')
  const SERVER_BASE = window.SERVER_BASE || ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:3001' : '');

  // ----------------------
  // Element refs
  // ----------------------
  const els = {
    profilePic: document.getElementById("profilePic"),
    profileDropdown: document.getElementById("profileDropdown"),
    profileBtn: document.getElementById("profileBtn"),
    logoutBtn: document.getElementById("logoutBtn"),
    profileForm: document.getElementById("profileForm"),
    editSaveProfileBtn: document.getElementById("editSaveProfileBtn"),
    cancelProfileBtn: document.getElementById("cancelProfileBtn"),
    studentFullName: document.getElementById("studentFullName"),
    studentEmail: document.getElementById("studentEmail"),
    profilePicForm: document.getElementById("profilePicForm"),
    headerTitle: document.getElementById("studentName"),
    profileBtnWrapper: document.getElementById("profileBtnWrapper"),

    studentYear: document.getElementById("studentYear"),
    studentCollege: document.getElementById("studentCollege"),
    studentDepartment: document.getElementById("studentDepartment"),
    studentProgram: document.getElementById("studentProgram"),

    homeBtn: document.getElementById("homeBtn"),
    payNowBtn: document.getElementById("payNowBtn"),
    paymentFlow: document.getElementById("paymentFlow"),
    selectEventSection: document.getElementById("selectEventSection"),
    confirmDetailsSection: document.getElementById("confirmDetailsSection"),
    paymentPanelSection: document.getElementById("paymentPanelSection"),
    doneSection: document.getElementById("doneSection"),
    paymentHistorySection: document.getElementById("paymentHistory"),

    orgSelect: document.getElementById("orgSelect"),
    eventSelect: document.getElementById("eventSelect"),

    confirmDetailsBtn: document.getElementById("confirmDetailsBtn"),
    proceedPaymentBtn: document.getElementById("proceedPaymentBtn"),
    paymentForm: document.getElementById("paymentForm"),

    paymentText: document.getElementById("paymentText"),
    qrContainer: document.getElementById("qrContainer"),
    receiverInfo: document.getElementById("receiverInfo"),
    amountInfo: document.getElementById("amountInfo"),

    historyTableBody: document.getElementById("historyTableBody"),
    cancelPaymentBtn: document.getElementById("cancelPaymentBtn"),

    // dynamic/optional
    confirmOkBtn: null,
    backToSelectBtn: document.getElementById("backToSelectBtn"),
    cancelSelectBtn: document.getElementById("cancelSelectBtn"),
  };

  // ----------------------
  // Data: collegeData (kept comprehensive)
  // ----------------------
  const collegeData = {
    COE: {
      "Chemical Engineering": ["BS ChE", "BS FE", "BS CerE", "BS MetE"],
      "Civil Engineering": ["BS CE", "BS SE", "BS GE", "BS GeoE", "BS TE"],
      "Electrical Engineering": ["BS EE", "BS CpE"],
      "Electronics Engineering": ["BS ECE", "BS ICE", "BS MexE", "BS AeE", "BS BioE"],
      "Industrial Engineering": ["BS IE"],
      "Mechanical Engineering": ["BS ME", "BS PetE", "BS AE", "BS NAME"]
    },
    CAFAD: {
      "N/A": ["Bachelor of Fine Arts and Design Major in Visual Communication","Bachelor of Science in Architecture","Bachelor of Science in Interior Design"]
    },
    CICS: {
      "N/A": ["Bachelor of Science in Computer Science","Bachelor of Science in Information Technology"]
    },
    CET: {
      "N/A": [
        "Bachelor of Automotive Engineering Technology","Bachelor of Civil Engineering Technology","Bachelor of Computer Engineering Technology",
        "Bachelor of Drafting Engineering Technology","Bachelor of Electrical Engineering Technology","Bachelor of Electronics Engineering Technology",
        "Bachelor of Food Engineering Technology","Bachelor of Instrumentation and Control Engineering Technology","Bachelor of Mechanical Engineering Technology",
        "Bachelor of Mechatronics Engineering Technology","Bachelor of Welding and Fabrication Engineering Technology"
      ]
    }
  };

  // ----------------------
  // Utilities
  // ----------------------
  function escapeHtml(str) {
    if (str === undefined || str === null) return "";
    return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function formatDateIso(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleDateString();
    } catch { return iso; }
  }

  function canonicalOrgNameClient(name) {
    try {
      return String(name || '').trim().toLowerCase();
    } catch (e) {
      return String(name || '').trim();
    }
  }

  let _isSubmittingPayment = false; // submission guard

  // ----------------------
  // Small auth helper for client requests
  // ----------------------
  function getIdToken() {
    try { return localStorage.getItem('idToken') || null; } catch (e) { return null; }
  }

  async function fetchWithAuth(url, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    try {
      const idToken = getIdToken();
      if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
    } catch (e) { /* ignore */ }
    return fetch(url, Object.assign({}, options, { headers }));
  }

  // ----------------------
  // Server helpers
  // ----------------------
  async function submitPaymentToServer({ org, orgId, event, eventId, amount, date, reference, file, studentMeta }) {
    const form = new FormData();
    form.append('name', event || 'payment');
    form.append('amount', amount || '0');
    form.append('purpose', `${org || ''} | ${event || ''}`);
    if (reference) form.append('reference', reference);
    // include orgId if provided (preferred)
    if (orgId) form.append('orgId', orgId);
    else if (org) form.append('org', org);
    // include eventId when available and event name for readability
    if (eventId) form.append('eventId', eventId);
    if (event) form.append('event', event);
    if (file) form.append('proof', file, file.name);
    if (studentMeta) {
      Object.keys(studentMeta).forEach(k => {
        if (studentMeta[k] !== undefined && studentMeta[k] !== null) form.append(k, studentMeta[k]);
      });
    }

    // Use fetchWithAuth to attach idToken if available
    const res = await fetchWithAuth(`${SERVER_BASE}/api/payments`, {
      method: 'POST',
      // DO NOT set Content-Type for FormData; browser will set boundary
      body: form
    });
    if (!res.ok) {
      const txt = await res.text().catch(()=> '');
      throw new Error(txt || `Server error ${res.status}`);
    }
    return res.json();
  }

  // ----------------------
  // New: fetch orgs/events from server (with local fallbacks)
  // ----------------------
  async function fetchOrgsFromServer() {
    try {
      const res = await fetch(`${SERVER_BASE}/api/orgs`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const orgs = await res.json();
      if (!Array.isArray(orgs)) return [];
      // normalize: ensure { id, name, displayName }
      return orgs.map(o => {
        if (typeof o === 'string') return { id: o, name: o, displayName: o };
        return { id: o.id || o.name || o.displayName || String(o), name: o.name || o.displayName || o.id || String(o), displayName: o.displayName || o.name || o.id || String(o) };
      });
    } catch (err) {
      // fallback: derive orgs from localStorage events
      try {
        const localEvents = JSON.parse(localStorage.getItem("events") || "[]");
        const set = Array.from(new Set(localEvents.map(e => e.org).filter(Boolean)));
        return set.map(name => ({ id: name, name, displayName: name }));
      } catch (e) {
        return [];
      }
    }
  }

  // fetch events for an org by orgId (preferred) with fallback to localStorage
  async function fetchEventsForOrgId(orgId, orgNameFallback = '') {
    if (!orgId && !orgNameFallback) return [];
    try {
      // Prefer orgId query if available
      const query = orgId ? `orgId=${encodeURIComponent(orgId)}` : `org=${encodeURIComponent(orgNameFallback)}`;
      const res = await fetch(`${SERVER_BASE}/api/events?${query}`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const events = await res.json();
      if (!Array.isArray(events)) return [];

      // Mirror server events into localStorage to avoid later duplicates and to provide offline fallback.
      try {
        const local = JSON.parse(localStorage.getItem("events") || "[]");
        const serverById = new Set(events.map(e => e.id).filter(Boolean));
        const serverByKey = new Set(events.map(e => `${(e.org||'').trim()}:::${(e.name||'').trim()}`));
        const filteredLocal = (Array.isArray(local) ? local : []).filter(l => {
          if (l.id && serverById.has(l.id)) return false;
          const key = `${(l.org||'').trim()}:::${(l.name||'').trim()}`;
          if (serverByKey.has(key)) return false;
          return true;
        });
        const mirrored = events.concat(filteredLocal);
        localStorage.setItem("events", JSON.stringify(mirrored));
      } catch (e) {
        console.warn('Failed to mirror server events to localStorage (student):', e);
      }

      return events;
    } catch (err) {
      // fallback: localStorage by orgId or org name
      try {
        const localEvents = JSON.parse(localStorage.getItem("events") || "[]");
        if (orgId) {
          return localEvents.filter(e => e.orgId === orgId || (e.org && e.org === orgNameFallback));
        }
        return localEvents.filter(e => e.org === orgNameFallback);
      } catch (e) {
        return [];
      }
    }
  }

  // ----------------------
  // New: fetch authenticated user's profile from server and mirror to localStorage
  // - Calls GET /api/my-profile (requires idToken). If returned profile exists, persist to localStorage.studentProfile and update UI.
  // ----------------------
  async function fetchAndMirrorMyProfile() {
    try {
      const idToken = getIdToken();
      if (!idToken) return null; // not authenticated; nothing to fetch

      const res = await fetchWithAuth(`${SERVER_BASE}/api/my-profile`, { method: 'GET' });
      if (!res.ok) {
        // Not found or no profile; ignore
        return null;
      }
      const payload = await res.json();
      if (payload && payload.profile && typeof payload.profile === 'object') {
        try {
          localStorage.setItem('studentProfile', JSON.stringify(payload.profile));
          if (payload.profile.displayName) localStorage.setItem('studentName', payload.profile.displayName);
          if (payload.profile.email) localStorage.setItem('studentEmail', payload.profile.email);
          if (payload.profile.photoURL) localStorage.setItem('profilePic', payload.profile.photoURL);
          loadProfile();
          return payload.profile;
        } catch (e) {
          console.warn('Failed to mirror profile to localStorage:', e);
          return payload.profile;
        }
      }
      return null;
    } catch (err) {
      console.warn('fetchAndMirrorMyProfile failed:', err);
      return null;
    }
  }

  // ----------------------
  // Render payment history
  // ----------------------
  function renderPaymentHistoryFromArray(arr) {
    const tbody = els.historyTableBody;
    if (!tbody) return;
    tbody.innerHTML = "";
    arr.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
    arr.forEach(record => {
      const tr = document.createElement("tr");
      const tdDate = document.createElement("td"); tdDate.textContent = formatDateIso(record.date || record.createdAt);
      const tdEvent = document.createElement("td"); tdEvent.textContent = record.event || record.purpose || record.name || "";
      const tdAmount = document.createElement("td"); tdAmount.textContent = `₱${record.amount || ""}`;
      const tdRef = document.createElement("td"); tdRef.textContent = record.reference || "";
      const tdStatus = document.createElement("td"); tdStatus.textContent = (record.status || "").charAt(0).toUpperCase() + (record.status || "").slice(1) || "";
      tr.appendChild(tdDate); tr.appendChild(tdEvent); tr.appendChild(tdAmount); tr.appendChild(tdRef); tr.appendChild(tdStatus);
      if (record.studentName) tr.title = `Submitted by: ${record.studentName}`;
      tbody.appendChild(tr);
    });
  }

  // ----------------------
  // Load payment history (server preference then local fallback)
  // ----------------------
  async function loadPaymentHistory() {
    try {
      // Prefer authenticated per-user endpoint when token present
      const idToken = getIdToken();
      if (idToken) {
        const res = await fetchWithAuth(`${SERVER_BASE}/api/my-payments`);
        if (res.ok) {
          const list = await res.json();
          renderPaymentHistoryFromArray(list);
          return;
        }
      }

      // Fallback to all payments then filter by email/uid
      const resAll = await fetchWithAuth(`${SERVER_BASE}/api/payments`);
      if (resAll.ok) {
        const all = await resAll.json();
        const uid = localStorage.getItem("spartapay_uid");
        const email = localStorage.getItem("studentEmail") || "";
        const filtered = uid ? all.filter(p => p.submittedByUid === uid || p.submittedByEmail === email) : all.filter(p => p.submittedByEmail === email);
        renderPaymentHistoryFromArray(filtered);
        return;
      }
    } catch (err) {
      console.warn("Failed to fetch payments from server, falling back to localStorage:", err);
    }
    const local = JSON.parse(localStorage.getItem("paymentHistory") || "[]");
    renderPaymentHistoryFromArray(local);
  }

  // ----------------------
  // UI show/hide helpers & confirmation rendering
  // ----------------------
  function showHome() {
    ["paymentFlow","selectEventSection","confirmDetailsSection","paymentPanelSection","profileForm","doneSection"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    });
    if (els.paymentHistorySection) els.paymentHistorySection.classList.remove("hidden");
    if (els.payNowBtn) els.payNowBtn.style.display = "inline-block";
    if (els.profileDropdown) els.profileDropdown.classList.add("hidden");
    loadPaymentHistory();
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch(err) {}
  }

  function showPaymentFlow() {
    if (els.paymentHistorySection) els.paymentHistorySection.classList.add("hidden");
    if (els.paymentFlow) els.paymentFlow.classList.remove("hidden");
    if (els.payNowBtn) els.payNowBtn.style.display = "none";
    // ensure flow steps initial visibility
    const selectSection = document.getElementById("selectEventSection"); if (selectSection) selectSection.classList.remove("hidden");
    const confirmSection = document.getElementById("confirmDetailsSection"); if (confirmSection) confirmSection.classList.add("hidden");
    const panel = document.getElementById("paymentPanelSection"); if (panel) panel.classList.add("hidden");
    const done = document.getElementById("doneSection"); if (done) done.classList.add("hidden");
    const paymentDateInput = document.getElementById("paymentDate");
    if (paymentDateInput) paymentDateInput.value = (new Date()).toISOString().split("T")[0];
    // ensure orgs/events are up-to-date
    loadEvents();
  }

  function renderConfirmationSection() {
    const doneEl = document.getElementById("doneSection");
    if (!doneEl) {
      console.error("doneSection not found in DOM");
      return;
    }
    // explicit content (ensures visible even if static HTML missing)
    doneEl.innerHTML = `
      <h3>Thank you for your payment!</h3>
      <p>Your transaction is now under review.</p>
      <p>Once verified, the status will be updated on your dashboard.</p>
      <div style="margin-top:16px;">
        <button id="confirmOkBtnInner" class="btn primary">Okay</button>
      </div>
    `;
    const ok = document.getElementById("confirmOkBtnInner");
    if (ok) ok.addEventListener("click", () => { showHome(); });
  }

  function showConfirmationView() {
    renderConfirmationSection();
    if (els.paymentHistorySection) els.paymentHistorySection.classList.add("hidden");
    if (els.paymentFlow) els.paymentFlow.classList.add("hidden");
    const doneEl = document.getElementById("doneSection"); if (doneEl) doneEl.classList.remove("hidden");
    if (els.payNowBtn) els.payNowBtn.style.display = "none";
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch(e) {}
  }

  // ----------------------
  // Populate college/department/program dropdowns
  // ----------------------
  function populateCollegeDropdown() {
    const sel = els.studentCollege;
    if (!sel) return;
    sel.innerHTML = "";
    const def = document.createElement("option"); def.value = ""; def.textContent = "Select College"; sel.appendChild(def);
    Object.keys(collegeData).forEach(col => {
      const opt = document.createElement("option"); opt.value = col; opt.textContent = col; sel.appendChild(opt);
    });
  }
  function populateDepartmentDropdown() {
    const sel = els.studentDepartment;
    if (!sel || !els.studentCollege) return;
    const col = els.studentCollege.value;
    sel.innerHTML = "";
    const def = document.createElement("option"); def.value = ""; def.textContent = "Select Department"; sel.appendChild(def);
    if (col && collegeData[col]) Object.keys(collegeData[col]).forEach(dep => { const o = document.createElement("option"); o.value = dep; o.textContent = dep; sel.appendChild(o); });
  }
  function populateProgramDropdown() {
    const sel = els.studentProgram;
    if (!sel || !els.studentCollege || !els.studentDepartment) return;
    sel.innerHTML = ""; const def = document.createElement("option"); def.value = ""; def.textContent = "Select Program"; sel.appendChild(def);
    const col = els.studentCollege.value, dep = els.studentDepartment.value;
    if (col && dep && collegeData[col] && collegeData[col][dep]) collegeData[col][dep].forEach(p => { const o=document.createElement('option'); o.value=p; o.textContent=p; sel.appendChild(o); });
  }
  if (els.studentCollege) els.studentCollege.addEventListener("change", () => { populateDepartmentDropdown(); if (els.studentProgram) els.studentProgram.innerHTML = '<option value="">Select Program</option>'; });
  if (els.studentDepartment) els.studentDepartment.addEventListener("change", populateProgramDropdown);

  // ----------------------
  // Load profile and photo robustly
  // ----------------------
  function loadProfile() {
    const profile = JSON.parse(localStorage.getItem("studentProfile") || "{}");
    let googleProfile = null;
    try { googleProfile = JSON.parse(localStorage.getItem("googleUser") || localStorage.getItem("googleProfile") || "null"); } catch(e) { googleProfile = null; }
    const name = profile.displayName || localStorage.getItem("studentName") || (googleProfile && (googleProfile.displayName || googleProfile.name)) || "Student";
    const email = profile.email || localStorage.getItem("studentEmail") || (googleProfile && (googleProfile.email || googleProfile.emailAddress)) || "";
    const storedPhoto = profile.photoURL || localStorage.getItem("profilePic") || "";

    populateCollegeDropdown();
    if (els.headerTitle) els.headerTitle.textContent = name;
    if (els.studentFullName) els.studentFullName.value = name;
    if (els.studentEmail) els.studentEmail.value = email;

    // robust photo selection
    let photoToUse = "default-profile.png";
    try {
      if (storedPhoto) {
        photoToUse = storedPhoto;
      } else if (profile && profile.photoURL) {
        photoToUse = profile.photoURL;
      } else if (googleProfile) {
        photoToUse = googleProfile.photoURL || googleProfile.picture || googleProfile.photo || googleProfile.imageUrl || googleProfile.image || null;
        if (!photoToUse) photoToUse = "default-profile.png";
      } else if (localStorage.getItem("profilePic")) {
        photoToUse = localStorage.getItem("profilePic");
      }
    } catch (e) {
      console.warn("Error resolving profile photo:", e);
      photoToUse = "default-profile.png";
    }

    if (els.profilePic) {
      els.profilePic.onerror = function() { this.onerror = null; this.src = "default-profile.png"; };
      // cache bust only for debugging if needed: els.profilePic.src = photoToUse + '?v=' + Date.now();
      els.profilePic.src = photoToUse;
    }
    if (els.profilePicForm) {
      els.profilePicForm.onerror = function() { this.onerror = null; this.src = "default-profile.png"; };
      els.profilePicForm.src = photoToUse;
    }

    if (els.studentYear) els.studentYear.value = profile.year || "";
    if (els.studentCollege && profile.college) els.studentCollege.value = profile.college;
    populateDepartmentDropdown();
    if (els.studentDepartment && profile.department) els.studentDepartment.value = profile.department;
    populateProgramDropdown();
    if (els.studentProgram && profile.program) els.studentProgram.value = profile.program;
  }

  // ----------------------
  // Load events into selects (server-preferred, fallback to localStorage)
  // ----------------------
  async function loadEvents() {
    const orgSel = els.orgSelect;
    const eventSel = els.eventSelect;
    if (!orgSel || !eventSel) return;

    // Clear current options and show loading placeholder
    orgSel.innerHTML = '';
    const orgLoading = document.createElement('option'); orgLoading.value=''; orgLoading.disabled=true; orgLoading.selected=true; orgLoading.textContent='Loading organizations...'; orgSel.appendChild(orgLoading);
    eventSel.innerHTML = ''; const evLoading = document.createElement('option'); evLoading.value=''; evLoading.disabled=true; evLoading.selected=true; evLoading.textContent='Select event'; eventSel.appendChild(evLoading);

    // Fetch orgs from server (fallback to localStorage derived orgs)
    const orgs = await fetchOrgsFromServer(); // returns array of {id,name,displayName,...}

    // Deduplicate orgs by canonical name on client as an extra safety net (server should already return deduped)
    const map = new Map(); // canon -> org
    (orgs || []).forEach(o => {
      const canon = canonicalOrgNameClient(o && (o.name || o.displayName || o.id || ''));
      if (!canon) return;
      if (!map.has(canon)) map.set(canon, o);
      else {
        // prefer the entry that has an id
        const existing = map.get(canon);
        if ((!existing.id || existing.id === existing.name) && o.id) map.set(canon, o);
      }
    });
    let normalizedOrgs = Array.from(map.values());

    // If no orgs found, fallback to deriving orgs from localStorage events
    let finalOrgs = normalizedOrgs;
    if (!finalOrgs || finalOrgs.length === 0) {
      try {
        const localEvents = JSON.parse(localStorage.getItem("events") || "[]");
        const set = Array.from(new Set(localEvents.map(e => e.org).filter(Boolean)));
        finalOrgs = set.map(name => ({ id: name, name, displayName: name }));
      } catch (e) {
        finalOrgs = [];
      }
    }

    // Populate org select - use org.id as option.value (canonical)
    orgSel.innerHTML = '';
    const defaultOpt = document.createElement('option'); defaultOpt.value=''; defaultOpt.disabled=true; defaultOpt.selected=true; defaultOpt.textContent='-- Select Organization --'; orgSel.appendChild(defaultOpt);
    finalOrgs.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.id || o.name; // canonical id when available, otherwise name
      opt.textContent = o.displayName || o.name;
      opt.dataset.orgName = o.name || o.displayName || '';
      opt.dataset.orgDisplay = o.displayName || o.name || '';
      orgSel.appendChild(opt);
    });

    // If there is a saved officerOrgId in localStorage, try to select it; else fall back to saved officerOrg (legacy)
    const savedOrgId = localStorage.getItem('officerOrgId') || '';
    const savedOrgNameLegacy = localStorage.getItem('officerOrg') || '';
    if (savedOrgId) {
      const match = Array.from(orgSel.options).find(opt => opt.value === savedOrgId);
      if (match) {
        orgSel.value = savedOrgId;
      }
    } else if (savedOrgNameLegacy) {
      const match2 = Array.from(orgSel.options).find(opt => opt.dataset.orgName === savedOrgNameLegacy || opt.text === savedOrgNameLegacy);
      if (match2) {
        orgSel.value = match2.value;
        // save canonical id for future
        try { localStorage.setItem('officerOrgId', match2.value); } catch (e) { /* ignore */ }
      }
    }

    // Attach change listener (only once)
    if (!orgSel._listenerAttached) {
      orgSel.addEventListener('change', async () => {
        const selectedOrgId = orgSel.value;
        const selectedOrgName = orgSel.selectedOptions && orgSel.selectedOptions[0] ? (orgSel.selectedOptions[0].dataset.orgName || orgSel.selectedOptions[0].text) : '';
        if (selectedOrgId) {
          try { localStorage.setItem('officerOrgId', selectedOrgId); } catch (e) {}
          try { localStorage.setItem('officerOrg', selectedOrgName); } catch (e) {}
        } else {
          localStorage.removeItem('officerOrgId');
          localStorage.removeItem('officerOrg');
        }

        // Populate events for selected org (use orgId)
        const events = await fetchEventsForOrgId(selectedOrgId, selectedOrgName);
        eventSel.innerHTML = '';
        const d = document.createElement('option'); d.value=''; d.disabled=true; d.selected=true; d.textContent='-- Select Event --'; eventSel.appendChild(d);
        events.forEach(ev => {
          const opt = document.createElement('option');
          // Store event id in value (canonical). Use dataset.eventName for human-readable name.
          opt.value = ev.id || (ev.name || ''); // prefer id for canonical mapping
          opt.textContent = ev.name || 'Unnamed Event';
          opt.dataset.eventName = ev.name || opt.textContent;
          opt.dataset.fee = String(ev.fee !== undefined ? ev.fee : '');
          // store orgId for the event (if server provided)
          if (ev.orgId) opt.dataset.orgId = ev.orgId;
          else opt.dataset.orgId = selectedOrgId || '';
          // receiver QR: server events may store receiver.qrObjectPath or receiver.qr
          let qr = '';
          if (ev.receiver) {
            if (ev.receiver.q) qr = ev.receiver.q;
            else if (ev.receiver.qr) qr = ev.receiver.qr;
            else if (ev.receiver.qrObjectPath) {
              // If Supabase private path exists, we may not include signed URL here.
              qr = ''; // leave empty; image may be requested via a dedicated endpoint later
            }
          }
          opt.dataset.qr = qr || '';
          opt.dataset.receiver = (ev.receiver && ev.receiver.name) ? ev.receiver.name : '';
          eventSel.appendChild(opt);
        });
      });
      orgSel._listenerAttached = true;
    }

    // If there is a selected org now, trigger its change handler to populate events
    if (orgSel.value) {
      orgSel.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // If only one org exists, auto-select it
      if (finalOrgs.length === 1) {
        orgSel.value = finalOrgs[0].id;
        try { localStorage.setItem('officerOrgId', finalOrgs[0].id); localStorage.setItem('officerOrg', finalOrgs[0].name); } catch (e) {}
        orgSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  // ----------------------
  // Initial load
  // ----------------------
  // First, try to fetch server-stored profile (if authenticated). Mirror it into localStorage then continue.
  (async () => {
    try {
      await fetchAndMirrorMyProfile();
    } catch (e) {
      // ignore
    } finally {
      // existing initializers
      loadEvents();
      loadProfile();
      loadPaymentHistory();
    }
  })();

  // ----------------------
  // Profile dropdown toggle
  // ----------------------
  if (els.profileBtnWrapper) {
    els.profileBtnWrapper.addEventListener("click", (e) => {
      e.stopPropagation();
      if (els.profileDropdown) els.profileDropdown.classList.toggle("hidden");
    });
  }
  document.addEventListener("click", (e) => {
    if (els.profileDropdown && els.profileBtnWrapper && !els.profileBtnWrapper.contains(e.target) && !els.profileDropdown.contains(e.target)) {
      els.profileDropdown.classList.add("hidden");
    }
  });

  if (els.profileBtn) {
    els.profileBtn.addEventListener("click", () => {
      if (els.profileDropdown) els.profileDropdown.classList.add("hidden");
      if (els.profileForm) els.profileForm.classList.remove("hidden");
      ["paymentFlow","paymentHistory"].forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
      if (els.payNowBtn) els.payNowBtn.style.display = "none";
      if (els.editSaveProfileBtn) els.editSaveProfileBtn.textContent = "Edit";
      if (els.cancelProfileBtn) els.cancelProfileBtn.classList.add("hidden");
    });
  }

  // ----------------------
  // Home and logout
  // ----------------------
  if (els.homeBtn) els.homeBtn.addEventListener('click', () => { showHome(); });
  if (els.logoutBtn) els.logoutBtn.addEventListener('click', () => { window.location.href = 'index.html'; });

  // ----------------------
  // Edit/save profile (existing behavior) + server persist
  // ----------------------
  if (els.editSaveProfileBtn) {
    els.editSaveProfileBtn.addEventListener('click', () => {
      const editableFields = [els.studentYear, els.studentCollege, els.studentDepartment, els.studentProgram];
      if (els.editSaveProfileBtn.textContent === 'Edit') {
        editableFields.forEach(el => { if (el) { el.disabled=false; el.style.backgroundColor='#fff'; el.style.cursor='text'; }});
        els.editSaveProfileBtn.textContent = 'Save';
        if (els.profileForm) els.profileForm.classList.remove('hidden');
        if (els.paymentHistorySection) els.paymentHistorySection.classList.add('hidden');
        if (els.payNowBtn) els.payNowBtn.style.display='none';
        if (els.cancelProfileBtn) els.cancelProfileBtn.classList.remove('hidden');
      } else {
        const prevProfile = JSON.parse(localStorage.getItem('studentProfile')||'{}');
        let photoToSave = '';
        if (els.profilePicForm && els.profilePicForm.src && !els.profilePicForm.src.includes('default-profile.png')) photoToSave = els.profilePicForm.src;
        else if (els.profilePic && els.profilePic.src) photoToSave = els.profilePic.src;
        else if (prevProfile && prevProfile.photoURL) photoToSave = prevProfile.photoURL;
        else photoToSave = localStorage.getItem('profilePic') || 'default-profile.png';
        const updatedProfile = {
          displayName: (els.studentFullName && els.studentFullName.value) ? els.studentFullName.value : (prevProfile.displayName||''),
          email: (els.studentEmail && els.studentEmail.value) ? els.studentEmail.value : (prevProfile.email||''),
          photoURL: photoToSave,
          year: (els.studentYear?els.studentYear.value:'') || prevProfile.year || '',
          college: (els.studentCollege?els.studentCollege.value:'') || prevProfile.college || '',
          department: (els.studentDepartment?els.studentDepartment.value:'') || prevProfile.department || '',
          program: (els.studentProgram?els.studentProgram.value:'') || prevProfile.program || ''
        };

        // Persist locally as before
        localStorage.setItem('studentProfile', JSON.stringify(updatedProfile));
        localStorage.setItem('studentName', updatedProfile.displayName || '');
        localStorage.setItem('studentEmail', updatedProfile.email || '');
        localStorage.setItem('profilePic', updatedProfile.photoURL || '');
        if (els.headerTitle) els.headerTitle.textContent = updatedProfile.displayName || 'Student';
        if (els.profilePic) els.profilePic.src = updatedProfile.photoURL || 'default-profile.png';
        if (els.profilePicForm) els.profilePicForm.src = updatedProfile.photoURL || 'default-profile.png';
        const editableFields2 = [els.studentYear, els.studentCollege, els.studentDepartment, els.studentProgram];
        editableFields2.forEach(el => { if (el) { el.disabled=true; el.style.backgroundColor='#e0e0e0'; el.style.cursor='not-allowed'; }});
        els.editSaveProfileBtn.textContent='Edit';

        // Non-blocking server persist: POST to /session with profile payload so server.session.js will persist users/{uid}.profile
        (async () => {
          try {
            const resp = await fetchWithAuth(`${SERVER_BASE}/session`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ profile: updatedProfile })
            });
            if (!resp.ok) {
              const txt = await resp.text().catch(()=>'');
              console.warn('/session profile persist failed:', resp.status, txt);
            } else {
              // optionally fetch back authoritative profile
              try {
                await fetchAndMirrorMyProfile();
              } catch (e) { /* ignore */ }
            }
          } catch (e) {
            console.warn('Failed to persist student profile to server:', e);
          }
        })();

        alert('Profile updated successfully!');
        showHome();
        if (els.cancelProfileBtn) els.cancelProfileBtn.classList.add('hidden');
      }
    });
  }
  if (els.cancelProfileBtn) els.cancelProfileBtn.addEventListener('click', () => { loadProfile(); showHome(); els.cancelProfileBtn.classList.add('hidden'); if (els.editSaveProfileBtn) els.editSaveProfileBtn.textContent='Edit'; });

  // ----------------------
  // Pay Now flow wiring
  // ----------------------
  if (els.payNowBtn) els.payNowBtn.addEventListener('click', () => { showPaymentFlow(); });

  if (els.confirmDetailsBtn) {
    els.confirmDetailsBtn.addEventListener('click', () => {
      const orgId = els.orgSelect ? els.orgSelect.value : '';
      const eventOption = (els.eventSelect && els.eventSelect.selectedOptions && els.eventSelect.selectedOptions[0]) || null;
      if (!orgId || !eventOption || !eventOption.value) { alert('Please select both organization and event.'); return; }
      const eventName = eventOption.dataset.eventName || eventOption.textContent || eventOption.value;
      const amount = eventOption.dataset.fee || '';
      const orgDisplay = els.orgSelect.selectedOptions && els.orgSelect.selectedOptions[0] ? (els.orgSelect.selectedOptions[0].dataset.orgDisplay || els.orgSelect.selectedOptions[0].text) : '';
      if (els.paymentText) els.paymentText.textContent = `For ${orgDisplay} payment event "${eventName}", you are required to pay ₱${amount}.`;
      if (els.confirmDetailsSection) els.confirmDetailsSection.classList.remove('hidden');
      if (els.selectEventSection) els.selectEventSection.classList.add('hidden');
    });
  }

  if (els.proceedPaymentBtn) {
    els.proceedPaymentBtn.addEventListener('click', () => {
      const eventOption = (els.eventSelect && els.eventSelect.selectedOptions && els.eventSelect.selectedOptions[0]) || null;
      if (!eventOption || !eventOption.value) { alert('Please select an event before proceeding.'); return; }
      const qrCode = eventOption.dataset.qr || '';
      const receiver = eventOption.dataset.receiver || '';
      const amount = eventOption.dataset.fee || '';
      if (els.qrContainer) els.qrContainer.innerHTML = qrCode ? `<img src="${escapeHtml(qrCode)}" alt="QR Code" style="width:150px;">` : "<p>No QR available</p>";
      if (els.receiverInfo) els.receiverInfo.textContent = `Receiver Name: ${receiver || "N/A"}`;
      if (els.amountInfo) els.amountInfo.textContent = `Amount: ₱${amount}`;
      if (els.confirmDetailsSection) els.confirmDetailsSection.classList.add('hidden');
      if (els.paymentPanelSection) els.paymentPanelSection.classList.remove('hidden');
      const amountPaidEl = document.getElementById("amountPaid");
      if (amountPaidEl && (!amountPaidEl.value || Number(amountPaidEl.value) === 0)) amountPaidEl.value = amount || "";
    });
  }

  // Cancel/back handlers
  if (els.cancelSelectBtn) els.cancelSelectBtn.addEventListener('click', showHome);
  if (els.backToSelectBtn) els.backToSelectBtn.addEventListener('click', () => { if (els.selectEventSection) els.selectEventSection.classList.remove('hidden'); if (els.confirmDetailsSection) els.confirmDetailsSection.classList.add('hidden'); });
  if (els.cancelPaymentBtn) els.cancelPaymentBtn.addEventListener('click', () => { if (els.paymentForm) els.paymentForm.reset(); if (els.qrContainer) els.qrContainer.innerHTML=''; if (els.receiverInfo) els.receiverInfo.textContent='Receiver: '; if (els.amountInfo) els.amountInfo.textContent='Amount: '; showHome(); });

  // ----------------------
  // Finalize Payment (submit) -> show confirmation view
  // ----------------------
  if (els.paymentForm) {
    els.paymentForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (_isSubmittingPayment) return;
      _isSubmittingPayment = true;
      const submitBtn = els.paymentForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      const selectedOrgId = els.orgSelect ? els.orgSelect.value : '';
      const selectedOrgName = els.orgSelect ? (els.orgSelect.selectedOptions && els.orgSelect.selectedOptions[0] ? (els.orgSelect.selectedOptions[0].dataset.orgName || els.orgSelect.selectedOptions[0].text) : '') : '';
      const selectedOption = els.eventSelect ? (els.eventSelect.selectedOptions && els.eventSelect.selectedOptions[0] ? els.eventSelect.selectedOptions[0] : null) : null;
      const selectedEventId = selectedOption ? selectedOption.value : '';
      const selectedEventName = selectedOption ? (selectedOption.dataset.eventName || selectedOption.textContent || selectedEventId) : '';

      const amountPaidEl = document.getElementById('amountPaid');
      const paymentDateEl = document.getElementById('paymentDate');
      const referenceNumberEl = document.getElementById('referenceNumber');
      const proofFileEl = document.getElementById('proofFile');

      const amountPaid = amountPaidEl ? amountPaidEl.value.trim() : '';
      const paymentDate = paymentDateEl ? paymentDateEl.value : '';
      const referenceNumber = referenceNumberEl ? referenceNumberEl.value.trim() : '';
      const proofFile = proofFileEl && proofFileEl.files && proofFileEl.files[0];

      if (!selectedOrgId || !selectedEventId || !amountPaid || Number(amountPaid) <= 0 || !referenceNumber) {
        alert('Please fill required fields (org, event, amount, reference).');
        if (submitBtn) submitBtn.disabled = false;
        _isSubmittingPayment = false;
        return;
      }

      const studentProfile = JSON.parse(localStorage.getItem('studentProfile') || '{}');
      const studentNameVal = (els.studentFullName && els.studentFullName.value) ? els.studentFullName.value : (studentProfile.displayName || localStorage.getItem('studentName') || '');
      const studentMeta = {
        studentName: studentNameVal,
        studentYear: (els.studentYear && els.studentYear.value) ? els.studentYear.value : (studentProfile.year || ''),
        studentCollege: (els.studentCollege && els.studentCollege.value) ? els.studentCollege.value : (studentProfile.college || ''),
        studentDepartment: (els.studentDepartment && els.studentDepartment.value) ? els.studentDepartment.value : (studentProfile.department || ''),
        studentProgram: (els.studentProgram && els.studentProgram.value) ? els.studentProgram.value : (studentProfile.program || '')
      };

      (async () => {
        try {
          const resp = await submitPaymentToServer({
            org: selectedOrgName,
            orgId: selectedOrgId,
            event: selectedEventName,
            eventId: selectedEventId,
            amount: amountPaid,
            date: paymentDate,
            reference: referenceNumber,
            file: proofFile,
            studentMeta
          });
          console.log("Payment saved on server:", resp);
          await loadPaymentHistory();
          showConfirmationView();
        } catch (err) {
          console.error("Payment upload failed, saving locally:", err);
          const history = JSON.parse(localStorage.getItem('paymentHistory') || "[]");
          history.push({
            org: selectedOrgName,
            orgId: selectedOrgId,
            event: selectedEventName,
            eventId: selectedEventId,
            amount: amountPaid,
            date: paymentDate || new Date().toISOString(),
            reference: referenceNumber || "",
            proof: proofFile ? "(local-file)" : null,
            status: "pending",
            createdAt: new Date().toISOString(),
            studentName: studentNameVal
          });
          localStorage.setItem('paymentHistory', JSON.stringify(history));
          await loadPaymentHistory();
          showConfirmationView();
        } finally {
          if (submitBtn) submitBtn.disabled = false;
          _isSubmittingPayment = false;
          if (els.paymentForm) els.paymentForm.reset();
          if (els.qrContainer) els.qrContainer.innerHTML = '';
          if (els.receiverInfo) els.receiverInfo.textContent = 'Receiver: ';
          if (els.amountInfo) els.amountInfo.textContent = 'Amount: ';
          if (els.orgSelect) els.orgSelect.value = '';
          if (els.eventSelect) els.eventSelect.innerHTML = '<option value="" disabled selected>Select event</option>';
        }
      })();
    });
  }

  // ----------------------
  // Storage events sync
  // ----------------------
  window.addEventListener("storage", (ev) => {
    const watched = ["studentProfile","profilePic","studentName","studentEmail","googleUser","googleProfile","paymentHistory","orgsLastUpdated","officerOrgId","officerOrg"];
    if (!ev.key) return;
    if (watched.includes(ev.key)) { loadProfile(); loadEvents(); loadPaymentHistory(); }
  });

  // ----------------------
  // Optional helper: clear local fallback paymentHistory
  // ----------------------
  async function clearLocalHistory() { localStorage.removeItem("paymentHistory"); await loadPaymentHistory(); }

  // ----------------------
  // Ensure initial UI state
  // ----------------------
  showHome();
});
