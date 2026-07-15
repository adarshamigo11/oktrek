"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  (function initScene() {
    const canHover = matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!canHover || reduced) return;
    const root = document.documentElement;
    let raf = null, lastX = 0, lastY = 0;
    function apply() { raf = null; root.style.setProperty("--px", lastX.toFixed(3)); root.style.setProperty("--py", lastY.toFixed(3)); }
    window.addEventListener("pointermove", (e) => {
      lastX = (e.clientX / window.innerWidth - 0.5) * 2;
      lastY = (e.clientY / window.innerHeight - 0.5) * 2;
      if (!raf) raf = requestAnimationFrame(apply);
    }, { passive: true });
  })();

  let csrf = null;
  let pendingToken = null;
  let confirmToken = null;
  let inquiryPage = 1;
  let toursCache = [];
  let usersCache = [];
  const INQUIRY_PER_PAGE = 25;
  const STATUSES = ["new", "contacted", "quote_sent", "confirmed", "completed", "cancelled", "lost"];

  const uniqueIds = [
    "app", "auth-overlay", "view-login", "view-mfa", "view-enrol", "form-login", "form-mfa", "form-enrol",
    "login-email", "login-password", "login-error", "mfa-code", "mfa-error", "enrol-code", "enrol-error",
    "sidebar", "menuToggle", "pageTitle", "messenger", "messenger-form"
  ];
  for (const id of uniqueIds) {
    const nodes = $$(`#${id}`);
    nodes.slice(1).forEach((node) => node.remove());
  }
  $("view-login")?.classList.remove("hidden");

  async function api(path, opts = {}) {
    if (!csrf) {
      const r = await fetch("/api/v1/csrf");
      csrf = (await r.json()).token;
    }
    const method = opts.method || "GET";
    const res = await fetch("/api/v1" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.title || "Request failed"), { status: res.status, data });
    return data;
  }

  function setText(id, value) { const el = $(id); if (el) el.textContent = value ?? ""; }
  function lines(value) { return String(value || "").split("\n").map(x => x.trim()).filter(Boolean); }
  function fmtDate(value) { return value ? String(value).slice(0, 10) : "—"; }
  function money(value) { return `₹${Number(value || 0).toLocaleString("en-IN")}`; }
  function badge(status) {
    const span = document.createElement("span");
    span.className = "badge " + status;
    span.textContent = String(status || "").replaceAll("_", " ");
    return span;
  }
  function cell(text) {
    const td = document.createElement("td");
    td.textContent = text ?? "";
    td.style.whiteSpace = "pre-line";
    return td;
  }
  function uploadFile(file, folder) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve(null);
      if (file.size > 2 * 1024 * 1024) return reject(new Error("File too large (max 2MB)"));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read file"));
      reader.onload = async () => {
        try { resolve((await api("/admin/upload", { method: "POST", body: { file: reader.result, folder } })).url); }
        catch (err) { reject(err); }
      };
      reader.readAsDataURL(file);
    });
  }

  function setSidebarOpen(open) {
    const sidebar = $("sidebar");
    if (!sidebar) return;
    sidebar.classList.toggle("open", open);
    document.body.classList.toggle("sidebar-open", open);
    $("menuToggle")?.setAttribute("aria-expanded", String(open));
  }
  function closeSidebar() { setSidebarOpen(false); }

  const views = ["dashboard", "bookings", "tours", "gallery", "users", "communications", "reviews", "settings", "profile"];
  function showView(name) {
    for (const v of views) $("view-" + v)?.classList.toggle("hidden", v !== name);
    for (const link of $$(".nav-item")) link.classList.toggle("active", link.dataset.view === name);
    setText("pageTitle", name[0].toUpperCase() + name.slice(1));
    closeSidebar();
    if (name === "dashboard") loadDashboard();
    if (name === "bookings") loadInquiries();
    if (name === "tours") loadTours();
    if (name === "gallery") loadGalleryView();
    if (name === "users") loadUsers();
    if (name === "communications") loadContacts();
    if (name === "reviews") loadReviews();
    if (name === "settings") loadSettings();
    if (name === "profile") loadProfile();
  }
  for (const link of $$(".nav-item")) link.addEventListener("click", (e) => { e.preventDefault(); showView(link.dataset.view); });
  $("menuToggle")?.setAttribute("aria-expanded", "false");
  $("menuToggle")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const sidebar = $("sidebar");
    setSidebarOpen(!sidebar?.classList.contains("open"));
  });
  document.addEventListener("click", (e) => {
    if (!document.body.classList.contains("sidebar-open")) return;
    if ($("sidebar")?.contains(e.target) || $("menuToggle")?.contains(e.target)) return;
    closeSidebar();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSidebar(); });

  (async () => {
    try {
      const publicSettings = await api("/settings");
      applyBrand(publicSettings);
      const me = await api("/admin/me");
      $("auth-overlay").classList.add("hidden");
      enterApp(me.user);
    } catch {
      $("auth-overlay").classList.remove("hidden");
      showAuth("view-login");
    }
  })();

  function showAuth(id) { for (const v of ["view-login", "view-mfa", "view-enrol"]) $(v)?.classList.toggle("hidden", v !== id); }
  function enterApp(user) { setText("sidebarWho", `${user.name} · ${user.role}`); setText("topbarWho", user.name); showView("dashboard"); }
  function applyBrand(settings) { document.querySelectorAll("[data-brand-name]").forEach(el => { el.textContent = settings.brand_name || "oktrek"; }); }

  $("form-login")?.addEventListener("submit", async (e) => {
    e.preventDefault(); setText("login-error", "");
    try {
      const r = await api("/admin/auth/login", { method: "POST", body: { email: $("login-email").value.trim(), password: $("login-password").value } });
      if (r.enrol_required) {
        pendingToken = r.pending_token;
        const en = await api("/admin/auth/enrol/begin", { method: "POST", body: { pending_token: pendingToken } });
        confirmToken = en.confirm_token; setText("enrol-secret", en.secret); setText("enrol-uri", en.otpauth_url); showAuth("view-enrol");
      } else if (r.mfa_required) {
        pendingToken = r.pending_token; showAuth("view-mfa"); $("mfa-code")?.focus();
      } else { $("auth-overlay").classList.add("hidden"); enterApp({ name: r.name, role: r.role }); }
    } catch (err) { setText("login-error", err.message); }
  });
  $("form-mfa")?.addEventListener("submit", async (e) => {
    e.preventDefault(); setText("mfa-error", "");
    try { const r = await api("/admin/auth/mfa", { method: "POST", body: { pending_token: pendingToken, code: $("mfa-code").value.trim() } }); $("auth-overlay").classList.add("hidden"); enterApp({ name: r.name, role: r.role }); }
    catch (err) { setText("mfa-error", err.message); }
  });
  $("form-enrol")?.addEventListener("submit", async (e) => {
    e.preventDefault(); setText("enrol-error", "");
    try { const r = await api("/admin/auth/enrol/confirm", { method: "POST", body: { confirm_token: confirmToken, code: $("enrol-code").value.trim() } }); $("auth-overlay").classList.add("hidden"); enterApp({ name: r.name, role: r.role }); }
    catch (err) { setText("enrol-error", err.message); }
  });
  $("btn-logout")?.addEventListener("click", async () => { try { await api("/admin/auth/logout", { method: "POST", body: {} }); } catch {} location.reload(); });

  async function loadDashboard() {
    setText("dashboard-msg", "Loading…");
    try {
      const [newData, confirmedData, recentData, notifications] = await Promise.all([
        api("/admin/inquiries?status=new&page=1&per=1"),
        api("/admin/inquiries?booked=1&page=1&per=1"),
        api("/admin/inquiries?page=1&per=8"),
        api("/admin/notifications"),
      ]);
      setText("metric-new", newData.total);
      setText("metric-confirmed", confirmedData.total);
      setText("metric-notifications", notifications.items.length);
      renderCompactBookings(recentData.items);
      renderNotifications(notifications.items);
      setText("dashboard-msg", recentData.items.length ? "" : "No recent booking leads.");
    } catch (err) { setText("dashboard-msg", err.message); }
  }

  function renderCompactBookings(items) {
    const tb = $("dashboard-booking-rows");
    if (!tb) return;
    tb.textContent = "";
    for (const it of items) {
      const tr = document.createElement("tr");
      tr.append(cell(it.reference), cell(it.tour_title), cell(`${it.name}\n${it.email}\n${it.phone_e164}`));
      const statusTd = document.createElement("td"); statusTd.append(badge(it.status)); tr.append(statusTd);
      const actionTd = document.createElement("td");
      const btn = document.createElement("button"); btn.className = "ghost small"; btn.textContent = "Open"; btn.addEventListener("click", () => { showView("bookings"); openMessenger(it.id); });
      actionTd.append(btn); tr.append(actionTd); tb.append(tr);
    }
  }
  $("btn-dashboard-refresh")?.addEventListener("click", loadDashboard);

  async function loadInquiries() {
    setText("dash-msg", "Loading…");
    const params = new URLSearchParams({ page: String(inquiryPage), per: String(INQUIRY_PER_PAGE) });
    if ($("filter-status")?.value) params.set("status", $("filter-status").value);
    if ($("filter-booked")?.checked) params.set("booked", "1");
    try {
      const data = await api("/admin/inquiries?" + params.toString());
      renderRows(data.items, data.page, data.per, data.total);
      setText("dash-msg", data.items.length ? "" : "No bookings match this filter.");
    } catch (err) { setText("dash-msg", err.message); if (err.status === 401) location.reload(); }
  }

  function renderRows(items, page, per, total) {
    const tb = $("rows"); tb.textContent = "";
    for (const it of items) {
      const tr = document.createElement("tr");
      tr.append(cell(it.reference), cell(`${it.tour_title}\n${fmtDate(it.departure_start)} to ${fmtDate(it.departure_end)}`), cell(`${it.name}\n${it.email}\n${it.phone_e164}${it.account_name ? `\nAccount: ${it.account_name}` : ""}`), cell(String(it.travellers)));
      const statusTd = document.createElement("td"); statusTd.append(badge(it.status)); tr.append(statusTd);
      tr.append(cell(it.assigned_name || "—"));
      const actionTd = document.createElement("td"); actionTd.className = "row-actions";
      const msgBtn = document.createElement("button"); msgBtn.type = "button"; msgBtn.className = "ghost small"; msgBtn.textContent = "Trail notes"; msgBtn.addEventListener("click", () => openMessenger(it.id));
      const sendBtn = document.createElement("button"); sendBtn.type = "button"; sendBtn.className = "ghost small"; sendBtn.textContent = "Send"; sendBtn.addEventListener("click", () => prefillCommunication(it));
      const sel = document.createElement("select");
      for (const s of STATUSES) { const o = document.createElement("option"); o.value = s; o.textContent = s.replaceAll("_", " "); if (s === it.status) o.selected = true; sel.append(o); }
      sel.addEventListener("change", async () => {
        if (["confirmed", "cancelled"].includes(sel.value) && sel.value !== it.status && !confirm(`Change status to ${sel.value.replaceAll("_", " ")}?`)) { sel.value = it.status; return; }
        try { await api(`/admin/inquiries/${it.id}`, { method: "PATCH", body: { status: sel.value } }); loadInquiries(); loadNotifications(); }
        catch (err) { alert(err.message); sel.value = it.status; }
      });
      actionTd.append(msgBtn, sendBtn, sel); tr.append(actionTd); tb.append(tr);
    }
    const pager = $("dash-pager"); pager.textContent = "";
    if (page > 1) { const prev = document.createElement("button"); prev.className = "ghost"; prev.textContent = "← Prev"; prev.addEventListener("click", () => { inquiryPage = page - 1; loadInquiries(); }); pager.append(prev); }
    const info = document.createElement("span"); info.className = "muted"; info.textContent = `Page ${page}${total ? ` of ${Math.ceil(total / per)}` : ""}`; pager.append(info);
    if (page * per < total) { const next = document.createElement("button"); next.className = "ghost"; next.textContent = "Next →"; next.addEventListener("click", () => { inquiryPage = page + 1; loadInquiries(); }); pager.append(next); }
  }
  $("filter-status")?.addEventListener("change", () => { inquiryPage = 1; loadInquiries(); });
  $("filter-booked")?.addEventListener("change", () => { inquiryPage = 1; loadInquiries(); });
  $("btn-refresh")?.addEventListener("click", () => { inquiryPage = 1; loadInquiries(); });

  let messengerInquiryId = null;
  let messengerVisibility = "internal";
  function renderMessengerThread(inq) {
    const thread = $("messenger-thread"); thread.textContent = "";
    if (!inq.messages.length) { const empty = document.createElement("div"); empty.className = "messenger-empty"; empty.textContent = "No notes yet."; thread.append(empty); return; }
    for (const m of inq.messages) {
      const row = document.createElement("div"); row.className = "msg " + (m.visibility === "customer" ? "msg-river" : "msg-basecamp");
      const meta = document.createElement("div"); meta.className = "msg-meta";
      const who = document.createElement("span"); who.className = "msg-who"; who.textContent = m.author_name || "Team";
      const tag = document.createElement("span"); tag.className = "msg-tag"; tag.textContent = m.visibility === "customer" ? "sent to traveller" : "basecamp note";
      const time = document.createElement("span"); time.className = "msg-time"; time.textContent = new Date(m.created_at).toLocaleString();
      const body = document.createElement("p"); body.className = "msg-body"; body.textContent = m.body_md;
      meta.append(who, tag, time); row.append(meta, body); thread.append(row);
    }
    thread.scrollTop = thread.scrollHeight;
  }
  function setMessengerVisibility(vis) {
    messengerVisibility = vis;
    $("toggle-internal")?.classList.toggle("active", vis === "internal");
    $("toggle-customer")?.classList.toggle("active", vis === "customer");
    $("messenger-form")?.classList.toggle("mode-internal", vis === "internal");
    $("messenger-form")?.classList.toggle("mode-customer", vis === "customer");
    setText("composer-hint", vis === "customer" ? "Sent to the traveller by WhatsApp." : "Only your team can see basecamp notes.");
    setText("messenger-send", vis === "customer" ? "Send to traveller" : "Save note");
  }
  async function openMessenger(id) {
    messengerInquiryId = id; setText("messenger-error", ""); $("messenger-input").value = ""; setMessengerVisibility("internal");
    $("messenger").classList.remove("hidden"); $("messenger").setAttribute("aria-hidden", "false"); setText("messenger-thread", "Loading…");
    try {
      const inq = await api(`/admin/inquiries/${id}`);
      setText("messenger-ref", inq.reference); setText("messenger-title", inq.name); setText("messenger-sub", `${inq.tour_title} · ${inq.travellers} traveller(s) · ${inq.phone_e164}`);
      renderMessengerThread(inq);
    } catch (err) { setText("messenger-error", err.message); }
  }
  function closeMessenger() { $("messenger").classList.add("hidden"); $("messenger").setAttribute("aria-hidden", "true"); messengerInquiryId = null; }
  $("messenger-close")?.addEventListener("click", closeMessenger);
  $("messenger-backdrop")?.addEventListener("click", closeMessenger);
  $("toggle-internal")?.addEventListener("click", () => setMessengerVisibility("internal"));
  $("toggle-customer")?.addEventListener("click", () => setMessengerVisibility("customer"));
  $("messenger-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body_md = $("messenger-input").value.trim();
    if (!body_md || !messengerInquiryId) return;
    try { await api(`/admin/inquiries/${messengerInquiryId}/messages`, { method: "POST", body: { visibility: messengerVisibility, body_md } }); renderMessengerThread(await api(`/admin/inquiries/${messengerInquiryId}`)); $("messenger-input").value = ""; loadNotifications(); }
    catch (err) { setText("messenger-error", err.message); }
  });

  async function loadTours() {
    setText("tours-msg", "Loading…");
    try {
      const data = await api("/admin/tours");
      toursCache = data.items || [];
      renderTourRows(); populateTourSelects(); setText("tours-msg", toursCache.length ? "" : "No tours found.");
    } catch (err) { setText("tours-msg", err.message); }
  }
  function renderTourRows() {
    const tb = $("tour-rows"); tb.textContent = "";
    for (const t of toursCache) {
      const tr = document.createElement("tr");
      tr.append(cell(`${t.title}\n${t.region}`), cell(money(t.from_price_inr)), cell(t.is_published ? "Yes" : "No"));
      const act = document.createElement("td"); act.className = "row-actions";
      const edit = document.createElement("button"); edit.className = "ghost small"; edit.textContent = "Edit"; edit.addEventListener("click", () => loadTourIntoForm(t.id));
      const toggle = document.createElement("button"); toggle.className = "ghost small"; toggle.textContent = t.is_published ? "Unpublish" : "Publish"; toggle.addEventListener("click", async () => { await api(`/admin/tours/${t.id}`, { method: "PATCH", body: { is_published: !t.is_published } }); loadTours(); });
      act.append(edit, toggle); tr.append(act); tb.append(tr);
    }
  }
  function populateTourSelects() {
    const sel = $("gallery-tour"); if (!sel) return;
    const current = sel.value; sel.textContent = "";
    for (const t of toursCache) { const o = document.createElement("option"); o.value = t.id; o.textContent = t.title; sel.append(o); }
    if (current) sel.value = current;
  }
  function clearTourForm() {
    $("form-tour")?.reset(); $("tour-id").value = ""; setText("tour-form-title", "Create / edit tour"); setText("tour-form-msg", "");
    $("tour-itinerary").value = "[]";
  }
  async function loadTourIntoForm(id) {
    setText("tour-form-msg", "Loading tour…");
    try {
      const t = await api(`/admin/tours/${id}`);
      $("tour-id").value = t.id; $("tour-slug").value = t.slug || ""; $("tour-title").value = t.title || ""; $("tour-region").value = t.region || "";
      $("tour-difficulty").value = t.difficulty || ""; $("tour-duration").value = t.duration_days || ""; $("tour-price").value = t.from_price_inr || ""; $("tour-age").value = t.min_age || "";
      $("tour-hero").value = t.hero_image_path || ""; $("tour-description").value = t.description_md || ""; $("tour-itinerary").value = JSON.stringify(t.itinerary || [], null, 2);
      $("tour-inclusions").value = (t.inclusions || []).join("\n"); $("tour-exclusions").value = (t.exclusions || []).join("\n"); $("tour-meta-title").value = t.meta_title || ""; $("tour-meta-description").value = t.meta_description || "";
      $("tour-published").checked = !!t.is_published; $("tour-featured").checked = !!t.is_featured; setText("tour-form-title", `Editing: ${t.title}`); setText("tour-form-msg", "");
    } catch (err) { setText("tour-form-msg", err.message); }
  }
  $("btn-new-tour")?.addEventListener("click", clearTourForm);
  $("btn-clear-tour")?.addEventListener("click", clearTourForm);
  $("tour-hero-file")?.addEventListener("change", async (e) => { try { const url = await uploadFile(e.target.files[0], "tours"); if (url) $("tour-hero").value = url; setText("tour-form-msg", "Hero uploaded. Save tour to apply."); } catch (err) { setText("tour-form-msg", err.message); } });
  $("form-tour")?.addEventListener("submit", async (e) => {
    e.preventDefault(); setText("tour-form-msg", "Saving…");
    try {
      let itinerary = [];
      try { itinerary = JSON.parse($("tour-itinerary").value || "[]"); } catch { throw new Error("Itinerary must be valid JSON"); }
      const body = { slug: $("tour-slug").value.trim(), title: $("tour-title").value.trim(), region: $("tour-region").value.trim(), difficulty: $("tour-difficulty").value || null, duration_days: Number($("tour-duration").value), from_price_inr: Number($("tour-price").value), min_age: $("tour-age").value ? Number($("tour-age").value) : null, hero_image_path: $("tour-hero").value.trim(), description_md: $("tour-description").value.trim(), itinerary, inclusions: lines($("tour-inclusions").value), exclusions: lines($("tour-exclusions").value), meta_title: $("tour-meta-title").value.trim(), meta_description: $("tour-meta-description").value.trim(), is_published: $("tour-published").checked, is_featured: $("tour-featured").checked };
      const id = $("tour-id").value;
      const saved = await api(id ? `/admin/tours/${id}` : "/admin/tours", { method: id ? "PATCH" : "POST", body });
      $("tour-id").value = saved.id; setText("tour-form-msg", "Saved."); await loadTours();
    } catch (err) { setText("tour-form-msg", err.message); }
  });
  $("btn-delete-tour")?.addEventListener("click", async () => {
    const id = $("tour-id").value; if (!id || !confirm("Delete this tour? It will be unpublished and hidden.")) return;
    try { await api(`/admin/tours/${id}`, { method: "DELETE", body: {} }); clearTourForm(); loadTours(); }
    catch (err) { setText("tour-form-msg", err.message); }
  });

  async function loadGalleryView() { if (!toursCache.length) await loadTours(); await loadGalleryImages(); }
  async function loadGalleryImages() {
    const tourId = $("gallery-tour")?.value;
    if (!tourId) { setText("gallery-msg", "Create a tour first."); return; }
    setText("gallery-msg", "Loading…");
    try {
      const data = await api(`/admin/tours/${tourId}/images`);
      renderGallery(data.items || []); setText("gallery-msg", data.items?.length ? "" : "No gallery images for this tour.");
    } catch (err) { setText("gallery-msg", err.message); }
  }
  function renderGallery(items) {
    const list = $("gallery-list"); list.textContent = "";
    for (const img of items) {
      const card = document.createElement("div"); card.className = "gallery-admin-card";
      const preview = document.createElement("img"); preview.src = img.path; preview.alt = img.alt || "Tour image";
      const pathInput = document.createElement("input"); pathInput.value = img.path;
      const altInput = document.createElement("input"); altInput.value = img.alt || "";
      const sortInput = document.createElement("input"); sortInput.type = "number"; sortInput.min = "0"; sortInput.value = img.sort_order || 0;
      const save = document.createElement("button"); save.className = "ghost small"; save.textContent = "Save"; save.addEventListener("click", async () => { await api(`/admin/tour-images/${img.id}`, { method: "PATCH", body: { path: pathInput.value.trim(), alt: altInput.value.trim(), sort_order: Number(sortInput.value) || 0 } }); loadGalleryImages(); });
      const del = document.createElement("button"); del.className = "ghost small"; del.textContent = "Delete"; del.addEventListener("click", async () => { if (confirm("Delete this gallery image?")) { await api(`/admin/tour-images/${img.id}`, { method: "DELETE", body: {} }); loadGalleryImages(); } });
      card.append(preview, pathInput, altInput, sortInput, save, del); list.append(card);
    }
  }
  $("gallery-tour")?.addEventListener("change", loadGalleryImages);
  $("btn-gallery-refresh")?.addEventListener("click", loadGalleryView);
  $("gallery-file")?.addEventListener("change", async (e) => { try { const url = await uploadFile(e.target.files[0], "tours"); if (url) $("gallery-path").value = url; setText("gallery-msg", "Image uploaded. Add it to the selected tour."); } catch (err) { setText("gallery-msg", err.message); } });
  $("form-gallery")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api(`/admin/tours/${$("gallery-tour").value}/images`, { method: "POST", body: { path: $("gallery-path").value.trim(), alt: $("gallery-alt").value.trim(), sort_order: Number($("gallery-sort").value) || 0 } }); $("form-gallery").reset(); $("gallery-sort").value = "0"; loadGalleryImages(); }
    catch (err) { setText("gallery-msg", err.message); }
  });

  async function loadUsers() {
    setText("users-msg", "Loading…");
    try {
      const data = await api(`/admin/users?role=${$("filter-users-role").value}`);
      usersCache = data.items || []; renderUsers(); setText("users-msg", usersCache.length ? "" : "No users found.");
    } catch (err) { setText("users-msg", err.status === 403 ? "Superadmin only." : err.message); }
  }
  function renderUsers() {
    const tb = $("user-rows"); tb.textContent = "";
    for (const u of usersCache) {
      const tr = document.createElement("tr"); tr.append(cell(u.name), cell(u.email), cell(u.phone_e164 || "—"), cell(u.role));
      const act = document.createElement("td"); act.className = "row-actions";
      const edit = document.createElement("button"); edit.className = "ghost small"; edit.textContent = "Edit"; edit.addEventListener("click", () => editUser(u));
      const disable = document.createElement("button"); disable.className = "ghost small"; disable.textContent = "Disable"; disable.addEventListener("click", async () => { if (confirm(`Disable ${u.email}?`)) { await api(`/admin/users/${u.id}`, { method: "DELETE", body: {} }); loadUsers(); } });
      act.append(edit, disable); tr.append(act); tb.append(tr);
    }
  }
  async function editUser(u) {
    const name = prompt("Name", u.name); if (name === null) return;
    const phone = prompt("Phone E.164 (blank allowed)", u.phone_e164 || ""); if (phone === null) return;
    try { await api(`/admin/users/${u.id}`, { method: "PATCH", body: { name: name.trim(), phone_e164: phone.trim() || null } }); loadUsers(); }
    catch (err) { setText("users-msg", err.message); }
  }
  $("filter-users-role")?.addEventListener("change", loadUsers);
  $("btn-refresh-users")?.addEventListener("click", loadUsers);
  $("form-user")?.addEventListener("submit", async (e) => {
    e.preventDefault(); setText("user-form-msg", "Creating…");
    try { await api("/admin/users", { method: "POST", body: { name: $("new-user-name").value.trim(), email: $("new-user-email").value.trim(), role: $("new-user-role").value, password: $("new-user-password").value } }); $("form-user").reset(); setText("user-form-msg", "Created."); loadUsers(); }
    catch (err) { setText("user-form-msg", err.message); }
  });

  function prefillCommunication(inq) {
    showView("communications");
    $("comm-inquiry-id").value = inq.id; $("comm-recipient").value = inq.email || inq.phone_e164 || ""; $("comm-subject").value = `Update for ${inq.reference}`; $("comm-body").focus();
  }
  async function loadContacts() {
    setText("contacts-msg", "Loading…");
    try {
      const data = await api("/admin/booking-contacts");
      const tb = $("contact-rows"); tb.textContent = "";
      for (const c of data.items) {
        const tr = document.createElement("tr"); tr.append(cell(c.reference), cell(`${c.name}\n${c.email}\n${c.phone_e164}`), cell(c.tour_title), cell(c.status));
        const act = document.createElement("td"); const btn = document.createElement("button"); btn.className = "ghost small"; btn.textContent = "Use"; btn.addEventListener("click", () => prefillCommunication({ id: c.id, email: c.email, phone_e164: c.phone_e164, reference: c.reference })); act.append(btn); tr.append(act); tb.append(tr);
      }
      setText("contacts-msg", data.items.length ? "" : "No contacts yet.");
    } catch (err) { setText("contacts-msg", err.message); }
  }
  $("btn-contacts-refresh")?.addEventListener("click", loadContacts);
  $("comm-channel")?.addEventListener("change", () => {
    const ch = $("comm-channel").value;
    const rec = $("comm-recipient").value;
    if (["whatsapp", "sms"].includes(ch) && rec.includes("@")) $("comm-recipient").value = "";
  });
  $("form-communication")?.addEventListener("submit", async (e) => {
    e.preventDefault(); setText("comm-msg", "Sending…");
    const body = { channel: $("comm-channel").value, body: $("comm-body").value.trim() };
    if ($("comm-inquiry-id").value) body.inquiry_id = Number($("comm-inquiry-id").value);
    if ($("comm-user-id").value) body.user_id = Number($("comm-user-id").value);
    if ($("comm-recipient").value.trim()) body.recipient = $("comm-recipient").value.trim();
    if ($("comm-subject").value.trim()) body.subject = $("comm-subject").value.trim();
    if ($("comm-reminder").value.trim()) body.reminder_label = $("comm-reminder").value.trim();
    try { const r = await api("/admin/communications/send", { method: "POST", body }); setText("comm-msg", `Sent/logged: ${r.status}`); $("comm-body").value = ""; loadNotifications(); }
    catch (err) { setText("comm-msg", err.message); }
  });

  async function loadReviews() {
    setText("reviews-msg", "Loading…");
    try {
      const data = await api("/admin/reviews?status=" + $("filter-review-status").value);
      const list = $("review-list"); list.textContent = "";
      for (const r of data.items) {
        const card = document.createElement("div"); card.className = "review-card";
        const h = document.createElement("h4"); h.textContent = `${r.author_name} — ${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}`;
        const title = document.createElement("p"); title.textContent = r.title || "No title";
        const body = document.createElement("p"); body.textContent = r.body_md;
        card.append(h, title, body);
        if ($("filter-review-status").value === "pending") {
          const actions = document.createElement("div"); actions.className = "review-actions";
          const approve = document.createElement("button"); approve.className = "ghost"; approve.textContent = "Approve"; approve.addEventListener("click", async () => { await api(`/admin/reviews/${r.id}/approve`, { method: "POST", body: {} }); loadReviews(); });
          const reject = document.createElement("button"); reject.className = "ghost"; reject.textContent = "Reject"; reject.addEventListener("click", async () => { await api(`/admin/reviews/${r.id}/reject`, { method: "POST", body: {} }); loadReviews(); });
          actions.append(approve, reject); card.append(actions);
        }
        list.append(card);
      }
      setText("reviews-msg", data.items.length ? "" : "No reviews.");
    } catch (err) { setText("reviews-msg", err.message); }
  }
  $("filter-review-status")?.addEventListener("change", loadReviews);
  $("btn-refresh-reviews")?.addEventListener("click", loadReviews);

  async function loadSettings() {
    for (const id of ["branding-msg", "smtp-msg", "whatsapp-msg", "sms-msg"]) setText(id, "");
    try {
      const s = await api("/admin/settings");
      $("sb-brand-name").value = s.brand_name || ""; $("sb-logo-url").value = s.brand_logo_url || "";
      if (s.brand_logo_url) { $("logo-preview").src = s.brand_logo_url; $("logo-preview").classList.remove("hidden"); } else $("logo-preview").classList.add("hidden");
      $("sb-smtp-host").value = s.smtp_host || ""; $("sb-smtp-port").value = s.smtp_port || ""; $("sb-smtp-user").value = s.smtp_user || ""; $("sb-smtp-pass").value = s.smtp_pass || ""; $("sb-smtp-from").value = s.smtp_from || ""; $("sb-smtp-ops").value = s.smtp_ops || ""; $("sb-smtp-secure").checked = s.smtp_secure === "1";
      $("sb-wa-ops").value = s.whatsapp_ops_number || ""; $("sb-wa-phone-id").value = s.whatsapp_phone_number_id || ""; $("sb-wa-token").value = s.whatsapp_access_token || ""; $("sb-wa-enabled").checked = s.whatsapp_enabled === "1"; $("sb-wa-customer").checked = s.whatsapp_notify_customer === "1";
      $("sb-sms-enabled").checked = s.sms_enabled === "1"; $("sb-sms-provider").value = s.sms_provider || "dev"; $("sb-sms-api-url").value = s.sms_api_url || ""; $("sb-sms-api-key").value = s.sms_api_key || ""; $("sb-sms-sender").value = s.sms_sender_id || "TrekIndia";
      applyBrand(s);
    } catch (err) { setText("branding-msg", err.status === 403 ? "Only Superadmin can edit settings." : err.message); }
  }
  for (const tab of $$(".tab")) tab.addEventListener("click", () => { for (const t of $$(".tab")) t.classList.toggle("active", t === tab); for (const p of $$(".tab-panel")) { p.classList.toggle("hidden", p.dataset.panel !== tab.dataset.tab); p.classList.toggle("active", p.dataset.panel === tab.dataset.tab); } });
  $("sb-logo-file")?.addEventListener("change", async (e) => { try { const url = await uploadFile(e.target.files[0], "logos"); if (url) { $("sb-logo-url").value = url; $("logo-preview").src = url; $("logo-preview").classList.remove("hidden"); } setText("branding-msg", "Logo uploaded. Click Save to apply."); } catch (err) { setText("branding-msg", err.message); } });
  $("form-branding")?.addEventListener("submit", async (e) => { e.preventDefault(); try { const s = await api("/admin/settings", { method: "PATCH", body: { brand_name: $("sb-brand-name").value.trim(), brand_logo_url: $("sb-logo-url").value.trim() } }); applyBrand(s); setText("branding-msg", "Saved."); } catch (err) { setText("branding-msg", err.message); } });
  $("form-smtp")?.addEventListener("submit", async (e) => { e.preventDefault(); try { await api("/admin/settings", { method: "PATCH", body: { smtp_host: $("sb-smtp-host").value.trim(), smtp_port: Number($("sb-smtp-port").value) || 587, smtp_user: $("sb-smtp-user").value.trim(), smtp_pass: $("sb-smtp-pass").value, smtp_from: $("sb-smtp-from").value.trim(), smtp_ops: $("sb-smtp-ops").value.trim(), smtp_secure: $("sb-smtp-secure").checked } }); setText("smtp-msg", "Saved."); } catch (err) { setText("smtp-msg", err.message); } });
  $("form-whatsapp")?.addEventListener("submit", async (e) => { e.preventDefault(); try { await api("/admin/settings", { method: "PATCH", body: { whatsapp_ops_number: $("sb-wa-ops").value.trim(), whatsapp_phone_number_id: $("sb-wa-phone-id").value.trim(), whatsapp_access_token: $("sb-wa-token").value, whatsapp_enabled: $("sb-wa-enabled").checked, whatsapp_notify_customer: $("sb-wa-customer").checked } }); setText("whatsapp-msg", "Saved."); } catch (err) { setText("whatsapp-msg", err.message); } });
  $("form-sms")?.addEventListener("submit", async (e) => { e.preventDefault(); try { await api("/admin/settings", { method: "PATCH", body: { sms_enabled: $("sb-sms-enabled").checked, sms_provider: $("sb-sms-provider").value.trim(), sms_api_url: $("sb-sms-api-url").value.trim(), sms_api_key: $("sb-sms-api-key").value, sms_sender_id: $("sb-sms-sender").value.trim() } }); setText("sms-msg", "Saved."); } catch (err) { setText("sms-msg", err.message); } });

  async function loadProfile() {
    setText("profile-msg", ""); setText("password-msg", "");
    try { const p = await api("/admin/profile"); setText("pf-name", p.name); setText("pf-email", p.email); setText("pf-role", p.role); setText("pf-mfa", p.mfa_enabled ? "Enabled" : "Not enabled"); $("pf-edit-name").value = p.name; $("pf-edit-phone").value = p.phone_e164 || ""; }
    catch (err) { setText("profile-msg", err.message); }
  }
  $("form-profile")?.addEventListener("submit", async (e) => { e.preventDefault(); try { await api("/admin/profile", { method: "PATCH", body: { name: $("pf-edit-name").value.trim(), phone_e164: $("pf-edit-phone").value.trim() || null } }); setText("profile-msg", "Profile updated."); loadProfile(); } catch (err) { setText("profile-msg", err.message); } });
  $("form-password")?.addEventListener("submit", async (e) => { e.preventDefault(); try { await api("/admin/profile/password", { method: "PATCH", body: { current_password: $("pf-cur-pw").value, new_password: $("pf-new-pw").value } }); setText("password-msg", "Password changed."); $("pf-cur-pw").value = ""; $("pf-new-pw").value = ""; } catch (err) { setText("password-msg", err.message); } });

  async function loadNotifications() {
    setText("notification-msg", "Loading…");
    try { const data = await api("/admin/notifications"); renderNotifications(data.items); setText("notification-msg", data.items.length ? "" : "No notifications logged yet."); }
    catch (err) { setText("notification-msg", err.message); }
  }
  function renderNotifications(items) {
    const tb = $("notification-rows"); if (!tb) return; tb.textContent = "";
    for (const n of items || []) { const tr = document.createElement("tr"); tr.append(cell(new Date(n.created_at).toLocaleString()), cell(n.channel), cell(n.recipient), cell(n.template), cell(n.status)); tb.append(tr); }
  }
  $("btn-notifications")?.addEventListener("click", loadNotifications);
})();
"use strict";
false && (() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);

  /* ---------- Basecamp Ridge: global parallax driver ---------- */
  (function initScene() {
    const canHover = matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!canHover || reduced) return;
    const root = document.documentElement;
    let raf = null, lastX = 0, lastY = 0;
    function apply() {
      raf = null;
      root.style.setProperty("--px", lastX.toFixed(3));
      root.style.setProperty("--py", lastY.toFixed(3));
    }
    window.addEventListener("pointermove", (e) => {
      lastX = (e.clientX / window.innerWidth - 0.5) * 2;
      lastY = (e.clientY / window.innerHeight - 0.5) * 2;
      if (!raf) raf = requestAnimationFrame(apply);
    }, { passive: true });
  })();

  let csrf = null;
  let pendingToken = null;
  let confirmToken = null;
  let inquiryPage = 1;
  const INQUIRY_PER_PAGE = 25;

  async function api(path, opts = {}) {
    if (!csrf) {
      const r = await fetch("/api/v1/csrf");
      csrf = (await r.json()).token;
    }
    const res = await fetch("/api/v1" + path, {
      method: opts.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(opts.method && opts.method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.title || "Request failed"), { status: res.status, data });
    return data;
  }

  /* ---------- views ---------- */
  const views = ["dashboard", "tours", "reviews", "users", "settings", "profile"];
  function showView(name) {
    for (const v of views) $("view-" + v).classList.toggle("hidden", v !== name);
    for (const link of $$(".nav-item")) link.classList.toggle("active", link.dataset.view === name);
    $("pageTitle").textContent = name[0].toUpperCase() + name.slice(1);
    $("sidebar")?.classList.remove("open");
    if (name === "dashboard") loadInquiries();
    if (name === "tours") loadTours();
    if (name === "reviews") loadReviews();
    if (name === "users") loadUsers();
    if (name === "settings") loadSettings();
    if (name === "profile") loadProfile();
  }

  for (const link of $$(".nav-item")) {
    link.addEventListener("click", (e) => { e.preventDefault(); showView(link.dataset.view); });
  }
  $("menuToggle")?.addEventListener("click", () => $("sidebar").classList.toggle("open"));

  /* ---------- boot ---------- */
  (async () => {
    try {
      const publicSettings = await api("/settings");
      applyBrand(publicSettings);
      const me = await api("/admin/me");
      $("auth-overlay").classList.add("hidden");
      enterApp(me.user);
    } catch {
      $("auth-overlay").classList.remove("hidden");
      showAuth("view-login");
    }
  })();

  function showAuth(id) {
    for (const v of ["view-login", "view-mfa", "view-enrol"]) $(v).classList.toggle("hidden", v !== id);
  }

  function enterApp(user) {
    $("sidebarWho").textContent = `${user.name} · ${user.role}`;
    $("topbarWho").textContent = `${user.name}`;
    showView("dashboard");
    loadNotifications();
  }

  function applyBrand(settings) {
    document.querySelectorAll("[data-brand-name]").forEach((el) => { el.textContent = settings.brand_name || "oktrek"; });
  }

  /* ---------- login ---------- */
  $("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").textContent = "";
    try {
      const r = await api("/admin/auth/login", {
        method: "POST",
        body: { email: $("login-email").value.trim(), password: $("login-password").value },
      });
      if (r.enrol_required) {
        pendingToken = r.pending_token;
        const en = await api("/admin/auth/enrol/begin", { method: "POST", body: { pending_token: pendingToken } });
        confirmToken = en.confirm_token;
        $("enrol-secret").textContent = en.secret;
        $("enrol-uri").textContent = en.otpauth_url;
        showAuth("view-enrol");
      } else if (r.mfa_required) {
        pendingToken = r.pending_token;
        showAuth("view-mfa");
        $("mfa-code").focus();
      } else {
        $("auth-overlay").classList.add("hidden");
        enterApp({ name: r.name, role: r.role });
      }
    } catch (err) {
      $("login-error").textContent = err.message;
    }
  });

  $("form-mfa").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("mfa-error").textContent = "";
    try {
      const r = await api("/admin/auth/mfa", {
        method: "POST",
        body: { pending_token: pendingToken, code: $("mfa-code").value.trim() },
      });
      $("auth-overlay").classList.add("hidden");
      enterApp({ name: r.name, role: r.role });
    } catch (err) {
      $("mfa-error").textContent = err.message;
    }
  });

  $("form-enrol").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("enrol-error").textContent = "";
    try {
      const r = await api("/admin/auth/enrol/confirm", {
        method: "POST",
        body: { confirm_token: confirmToken, code: $("enrol-code").value.trim() },
      });
      $("auth-overlay").classList.add("hidden");
      enterApp({ name: r.name, role: r.role });
    } catch (err) {
      $("enrol-error").textContent = err.message;
    }
  });

  $("btn-logout").addEventListener("click", async () => {
    try { await api("/admin/auth/logout", { method: "POST", body: {} }); } catch {}
    location.reload();
  });

  /* ---------- inquiries ---------- */
  const STATUSES = ["new", "contacted", "quote_sent", "confirmed", "completed", "cancelled", "lost"];

  async function loadInquiries() {
    $("dash-msg").textContent = "Loading…";
    const status = $("filter-status").value;
    const params = new URLSearchParams({ page: String(inquiryPage), per: String(INQUIRY_PER_PAGE) });
    if (status) params.set("status", status);
    try {
      const data = await api("/admin/inquiries?" + params.toString());
      renderRows(data.items, data.page, data.per, data.total);
      $("dash-msg").textContent = data.items.length ? "" : "No inquiries match this filter.";
    } catch (err) {
      $("dash-msg").textContent = err.message;
      if (err.status === 401) location.reload();
    }
  }

  function renderRows(items, page, per, total) {
    const tb = $("rows");
    tb.textContent = "";
    for (const it of items) {
      const tr = document.createElement("tr");
      const cells = [
        it.reference,
        it.tour_title,
        `${it.name}\n${it.email}\n${it.phone_e164}`,
        String(it.travellers),
        it.preferred_date || (it.departure_id ? `dep #${it.departure_id}` : "—"),
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = c;
        td.style.whiteSpace = "pre-line";
        tr.appendChild(td);
      }
      const tdBadge = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "badge " + it.status;
      badge.textContent = it.status.replace("_", " ");
      tdBadge.appendChild(badge);
      tr.appendChild(tdBadge);
      const tdAct = document.createElement("td");
      tdAct.style.display = "flex";
      tdAct.style.gap = "6px";
      tdAct.style.alignItems = "center";
      const msgBtn = document.createElement("button");
      msgBtn.type = "button";
      msgBtn.className = "ghost small";
      msgBtn.style.width = "auto";
      msgBtn.style.marginTop = "0";
      msgBtn.textContent = "💬 Trail notes";
      msgBtn.addEventListener("click", () => openMessenger(it.id));
      tdAct.appendChild(msgBtn);
      const sel = document.createElement("select");
      for (const s of STATUSES) {
        const o = document.createElement("option");
        o.value = s; o.textContent = s.replace("_", " ");
        if (s === it.status) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", async () => {
        if ((sel.value === "confirmed" || sel.value === "cancelled") && sel.value !== it.status) {
          if (!confirm(`Change status to "${sel.value.replace("_", " ")}"? This triggers notifications and seat updates.`)) {
            sel.value = it.status; return;
          }
        }
        try {
          await api(`/admin/inquiries/${it.id}`, { method: "PATCH", body: { status: sel.value } });
          loadInquiries();
        } catch (err) {
          alert(err.message); sel.value = it.status;
        }
      });
      tdAct.appendChild(sel);
      tr.appendChild(tdAct);
      tb.appendChild(tr);
    }
    let pager = $("dash-pager");
    if (!pager) {
      pager = document.createElement("div");
      pager.id = "dash-pager"; pager.className = "toolbar"; pager.style.marginTop = "14px";
      $("tbl").insertAdjacentElement("afterend", pager);
    }
    pager.textContent = "";
    if (page > 1) {
      const prev = document.createElement("button"); prev.className = "ghost"; prev.textContent = "← Prev";
      prev.addEventListener("click", () => { inquiryPage = page - 1; loadInquiries(); });
      pager.appendChild(prev);
    }
    const info = document.createElement("span"); info.className = "muted"; info.textContent = `Page ${page}${total ? ` of ${Math.ceil(total / per)}` : ""}`;
    pager.appendChild(info);
    if (items.length === per) {
      const next = document.createElement("button"); next.className = "ghost"; next.textContent = "Next →";
      next.addEventListener("click", () => { inquiryPage = page + 1; loadInquiries(); });
      pager.appendChild(next);
    }
  }

  $("filter-status").addEventListener("change", () => { inquiryPage = 1; loadInquiries(); });
  $("btn-refresh").addEventListener("click", () => { inquiryPage = 1; loadInquiries(); });

  /* ---------- messenger (trail notes) ---------- */
  let messengerInquiryId = null;
  let messengerVisibility = "internal";

  function fmtTime(iso) {
    try { return new Date(iso.includes("Z") || iso.includes("+") ? iso : iso.replace(" ", "T") + "Z").toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch { return iso; }
  }

  function renderMessengerThread(inq) {
    const thread = $("messenger-thread");
    thread.textContent = "";
    if (!inq.messages.length) {
      const empty = document.createElement("div");
      empty.className = "messenger-empty";
      empty.innerHTML = "<span>⛺</span><p>No notes on this trail yet. Say hello, or leave a note for the team.</p>";
      thread.appendChild(empty);
      return;
    }
    for (const m of inq.messages) {
      const row = document.createElement("div");
      row.className = "msg " + (m.visibility === "customer" ? "msg-river" : "msg-basecamp");
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      const who = document.createElement("span");
      who.className = "msg-who";
      who.textContent = m.author_name || "Team";
      const tag = document.createElement("span");
      tag.className = "msg-tag";
      tag.textContent = m.visibility === "customer" ? "sent to traveller" : "basecamp note";
      const time = document.createElement("span");
      time.className = "msg-time";
      time.textContent = fmtTime(m.created_at);
      meta.append(who, tag, time);
      const body = document.createElement("p");
      body.className = "msg-body";
      body.textContent = m.body_md;
      row.append(meta, body);
      thread.appendChild(row);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function setMessengerVisibility(vis) {
    messengerVisibility = vis;
    $("toggle-internal").classList.toggle("active", vis === "internal");
    $("toggle-customer").classList.toggle("active", vis === "customer");
    $("messenger-form").classList.toggle("mode-internal", vis === "internal");
    $("messenger-form").classList.toggle("mode-customer", vis === "customer");
    $("messenger-input").placeholder = vis === "customer"
      ? "Write a message to send to the traveller…"
      : "Write a note for the team…";
    $("composer-hint").textContent = vis === "customer"
      ? "Sent to the traveller by WhatsApp."
      : "Only your team can see basecamp notes.";
    $("messenger-send").textContent = vis === "customer" ? "Send to traveller" : "Save note";
  }

  async function openMessenger(id) {
    messengerInquiryId = id;
    $("messenger-error").textContent = "";
    $("messenger-input").value = "";
    setMessengerVisibility("internal");
    $("messenger").classList.remove("hidden");
    $("messenger").setAttribute("aria-hidden", "false");
    $("messenger-thread").innerHTML = "<div class=\"messenger-empty\"><span>🏔️</span><p>Loading the trail…</p></div>";
    try {
      const inq = await api(`/admin/inquiries/${id}`);
      $("messenger-ref").textContent = inq.reference;
      $("messenger-title").textContent = inq.name;
      $("messenger-sub").textContent = `${inq.tour_title || "Tour"} · ${inq.travellers} traveller${inq.travellers === 1 ? "" : "s"} · ${inq.phone_e164}`;
      renderMessengerThread(inq);
    } catch (err) {
      $("messenger-thread").innerHTML = "";
      $("messenger-error").textContent = err.message;
    }
    $("messenger-input").focus();
  }

  function closeMessenger() {
    $("messenger").classList.add("hidden");
    $("messenger").setAttribute("aria-hidden", "true");
    messengerInquiryId = null;
  }

  $("messenger-close").addEventListener("click", closeMessenger);
  $("messenger-backdrop").addEventListener("click", closeMessenger);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("messenger").classList.contains("hidden")) closeMessenger();
  });
  $("toggle-internal").addEventListener("click", () => setMessengerVisibility("internal"));
  $("toggle-customer").addEventListener("click", () => setMessengerVisibility("customer"));

  $("messenger-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body_md = $("messenger-input").value.trim();
    if (!body_md || !messengerInquiryId) return;
    $("messenger-error").textContent = "";
    const btn = $("messenger-send");
    btn.disabled = true;
    try {
      await api(`/admin/inquiries/${messengerInquiryId}/messages`, {
        method: "POST",
        body: { visibility: messengerVisibility, body_md },
      });
      const inq = await api(`/admin/inquiries/${messengerInquiryId}`);
      renderMessengerThread(inq);
      $("messenger-input").value = "";
    } catch (err) {
      $("messenger-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- tours ---------- */
  async function loadTours() {
    $("tours-msg").textContent = "Loading…";
    try {
      const data = await api("/admin/tours");
      const tb = $("tour-rows");
      tb.textContent = "";
      for (const t of data.items) {
        const tr = document.createElement("tr");
        for (const c of [t.title, t.region, `₹${t.from_price_inr}`, t.is_published ? "Yes" : "No", t.is_featured ? "Yes" : "No"]) {
          const td = document.createElement("td"); td.textContent = c; tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      $("tours-msg").textContent = data.items.length ? "" : "No tours found.";
    } catch (err) {
      $("tours-msg").textContent = err.message;
    }
  }

  /* ---------- reviews ---------- */
  async function loadReviews() {
    $("reviews-msg").textContent = "Loading…";
    const status = $("filter-review-status").value;
    try {
      const data = await api("/admin/reviews?status=" + status);
      const list = $("review-list");
      list.textContent = "";
      for (const r of data.items) {
        const card = document.createElement("div");
        card.className = "review-card";
        card.innerHTML = `
          <h4>${r.author_name} — ${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</h4>
          <p><strong>${r.title || "No title"}</strong></p>
          <p>${r.body_md}</p>
        `;
        if (status === "pending") {
          const actions = document.createElement("div"); actions.className = "review-actions";
          const approve = document.createElement("button"); approve.className = "ghost"; approve.textContent = "Approve";
          approve.addEventListener("click", async () => {
            await api(`/admin/reviews/${r.id}/approve`, { method: "POST", body: {} }); loadReviews();
          });
          const reject = document.createElement("button"); reject.className = "ghost"; reject.textContent = "Reject";
          reject.addEventListener("click", async () => {
            await api(`/admin/reviews/${r.id}/reject`, { method: "POST", body: {} }); loadReviews();
          });
          actions.appendChild(approve); actions.appendChild(reject); card.appendChild(actions);
        }
        list.appendChild(card);
      }
      $("reviews-msg").textContent = data.items.length ? "" : "No reviews.";
    } catch (err) {
      $("reviews-msg").textContent = err.message;
    }
  }
  $("filter-review-status").addEventListener("change", loadReviews);
  $("btn-refresh-reviews").addEventListener("click", loadReviews);

  /* ---------- users ---------- */
  async function loadUsers() {
    $("users-msg").textContent = "Loading…";
    try {
      const data = await api("/admin/users");
      const tb = $("user-rows");
      tb.textContent = "";
      for (const u of data.items) {
        const tr = document.createElement("tr");
        for (const c of [u.name, u.email, u.role, u.mfa_enabled ? "Enabled" : "—"]) {
          const td = document.createElement("td"); td.textContent = c; tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      $("users-msg").textContent = data.items.length ? "" : "No staff users.";
    } catch (err) {
      $("users-msg").textContent = err.status === 403 ? "Superadmin only." : err.message;
    }
  }

  /* ---------- settings ---------- */
  const settingsTabs = $$('.tab');
  const settingsPanels = $$('.tab-panel');
  for (const t of settingsTabs) {
    t.addEventListener('click', () => {
      for (const x of settingsTabs) x.classList.toggle('active', x === t);
      for (const p of settingsPanels) {
        p.classList.toggle('hidden', p.dataset.panel !== t.dataset.tab);
        p.classList.toggle('active', p.dataset.panel === t.dataset.tab);
      }
    });
  }

  async function loadSettings() {
    $("branding-msg").textContent = ""; $("smtp-msg").textContent = ""; $("whatsapp-msg").textContent = "";
    try {
      const s = await api("/admin/settings");
      // Branding
      $("sb-brand-name").value = s.brand_name || "";
      $("sb-logo-url").value = s.brand_logo_url || "";
      const preview = $("logo-preview");
      if (s.brand_logo_url) { preview.src = s.brand_logo_url; preview.classList.remove("hidden"); }
      else preview.classList.add("hidden");
      // SMTP
      $("sb-smtp-host").value = s.smtp_host || "";
      $("sb-smtp-port").value = s.smtp_port || "";
      $("sb-smtp-user").value = s.smtp_user || "";
      $("sb-smtp-pass").value = s.smtp_pass || "";
      $("sb-smtp-from").value = s.smtp_from || "";
      $("sb-smtp-ops").value = s.smtp_ops || "";
      $("sb-smtp-secure").checked = s.smtp_secure === "1";
      // WhatsApp
      $("sb-wa-ops").value = s.whatsapp_ops_number || "";
      $("sb-wa-phone-id").value = s.whatsapp_phone_number_id || "";
      $("sb-wa-token").value = s.whatsapp_access_token || "";
      $("sb-wa-enabled").checked = s.whatsapp_enabled === "1";
      $("sb-wa-customer").checked = s.whatsapp_notify_customer === "1";
      applyBrand(s);
    } catch (err) {
      $("branding-msg").textContent = err.status === 403 ? "Only Superadmin can edit settings." : err.message;
    }
  }

  /* Logo upload via FileReader */
  $("sb-logo-file")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { $("branding-msg").textContent = "File too large (max 2MB)"; return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = await api("/admin/upload", { method: "POST", body: { file: reader.result, folder: "logos" } });
        $("sb-logo-url").value = data.url;
        const preview = $("logo-preview");
        preview.src = data.url; preview.classList.remove("hidden");
        $("branding-msg").textContent = "Logo uploaded. Click Save to apply.";
      } catch (err) {
        $("branding-msg").textContent = err.message;
      }
    };
    reader.readAsDataURL(file);
  });

  $("form-branding").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("branding-msg").textContent = "Saving…";
    try {
      const s = await api("/admin/settings", {
        method: "PATCH",
        body: {
          brand_name: $("sb-brand-name").value.trim(),
          brand_logo_url: $("sb-logo-url").value.trim(),
        },
      });
      applyBrand(s);
      $("branding-msg").textContent = "Saved.";
    } catch (err) { $("branding-msg").textContent = err.message; }
  });

  $("form-smtp").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("smtp-msg").textContent = "Saving…";
    try {
      await api("/admin/settings", {
        method: "PATCH",
        body: {
          smtp_host: $("sb-smtp-host").value.trim(),
          smtp_port: Number($("sb-smtp-port").value) || 587,
          smtp_user: $("sb-smtp-user").value.trim(),
          smtp_pass: $("sb-smtp-pass").value,
          smtp_from: $("sb-smtp-from").value.trim(),
          smtp_ops: $("sb-smtp-ops").value.trim(),
          smtp_secure: $("sb-smtp-secure").checked,
        },
      });
      $("smtp-msg").textContent = "Saved.";
    } catch (err) { $("smtp-msg").textContent = err.message; }
  });

  $("form-whatsapp").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("whatsapp-msg").textContent = "Saving…";
    try {
      await api("/admin/settings", {
        method: "PATCH",
        body: {
          whatsapp_ops_number: $("sb-wa-ops").value.trim(),
          whatsapp_phone_number_id: $("sb-wa-phone-id").value.trim(),
          whatsapp_access_token: $("sb-wa-token").value,
          whatsapp_enabled: $("sb-wa-enabled").checked,
          whatsapp_notify_customer: $("sb-wa-customer").checked,
        },
      });
      $("whatsapp-msg").textContent = "Saved.";
    } catch (err) { $("whatsapp-msg").textContent = err.message; }
  });

  /* ---------- profile ---------- */
  async function loadProfile() {
    $("profile-msg").textContent = ""; $("password-msg").textContent = "";
    try {
      const p = await api("/admin/profile");
      $("pf-name").textContent = p.name;
      $("pf-email").textContent = p.email;
      $("pf-role").textContent = p.role;
      $("pf-mfa").textContent = p.mfa_enabled ? "Enabled" : "Not enabled";
      $("pf-edit-name").value = p.name;
      $("pf-edit-phone").value = p.phone_e164 || "";
    } catch (err) {
      $("profile-msg").textContent = err.message;
    }
  }

  $("form-profile").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("profile-msg").textContent = "Saving…";
    try {
      await api("/admin/profile", {
        method: "PATCH",
        body: {
          name: $("pf-edit-name").value.trim(),
          phone_e164: $("pf-edit-phone").value.trim() || null,
        },
      });
      $("profile-msg").textContent = "Profile updated.";
      loadProfile();
    } catch (err) { $("profile-msg").textContent = err.message; }
  });

  $("form-password").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("password-msg").textContent = "Changing…";
    try {
      await api("/admin/profile/password", {
        method: "PATCH",
        body: {
          current_password: $("pf-cur-pw").value,
          new_password: $("pf-new-pw").value,
        },
      });
      $("password-msg").textContent = "Password changed.";
      $("pf-cur-pw").value = ""; $("pf-new-pw").value = "";
    } catch (err) { $("password-msg").textContent = err.message; }
  });

  /* ---------- notifications ---------- */
  async function loadNotifications() {
    $("notification-msg").textContent = "Loading…";
    try {
      const data = await api("/admin/notifications");
      const tb = $("notification-rows");
      tb.textContent = "";
      for (const n of data.items) {
        const tr = document.createElement("tr");
        for (const value of [
          new Date(n.created_at).toLocaleString(),
          n.channel, n.recipient, n.template, n.status,
        ]) {
          const td = document.createElement("td"); td.textContent = value || ""; tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
      $("notification-msg").textContent = data.items.length ? "" : "No notifications logged yet.";
    } catch (err) {
      $("notification-msg").textContent = err.message;
    }
  }
  $("btn-notifications").addEventListener("click", loadNotifications);
})();
