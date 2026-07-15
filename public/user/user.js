const state = {
  tours: [],
  tourDetails: new Map(),
  csrf: "",
};

const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const tourGrid = document.querySelector("#tourGrid");
const dealList = document.querySelector("#dealList");
const regionFilter = document.querySelector("#regionFilter");
const difficultyFilter = document.querySelector("#difficultyFilter");
const sortFilter = document.querySelector("#sortFilter");
const tourSelect = document.querySelector("#tourSelect");
const departureSelect = document.querySelector("#departureSelect");
const inquiryForm = document.querySelector("#inquiryForm");
const formStatus = document.querySelector("#formStatus");
const dialog = document.querySelector("#tourDialog");
const detail = document.querySelector("#tourDetail");
const brandLogo = document.querySelector("#brandLogo");

document.querySelectorAll('a[href^="/admin"]').forEach((link) => link.remove());

const btnAuth = document.querySelector("#btn-auth");
const btnLogout = document.querySelector("#btn-logout");
const userName = document.querySelector("#user-name");
const navMyInquiries = document.querySelector("#nav-my-inquiries");
const authDialog = document.querySelector("#authDialog");
const authContent = document.querySelector("#authContent");
const loginForm = document.querySelector("#loginForm");
const registerForm = document.querySelector("#registerForm");
const myInquiriesSection = document.querySelector("#my-inquiries");
const inquiryList = document.querySelector("#inquiryList");

let lastFocusTarget = null;
let currentUser = null;

function initUiEffects() {
  const header = document.querySelector(".site-header");
  const canvas = document.querySelector("#particle-canvas");
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  window.addEventListener("scroll", () => {
    header?.classList.toggle("scrolled", window.scrollY > 50);
  }, { passive: true });

  if (!prefersReducedMotion) {
    document.addEventListener("mousemove", (event) => {
      const x = (event.clientX / window.innerWidth - 0.5) * 2;
      const y = (event.clientY / window.innerHeight - 0.5) * 2;
      const layers = [
        [".layer-sky", 15, 10, "translateZ(-400px) scale(1.4)"],
        [".layer-mountains-far", 35, 20, "translateZ(-250px) scale(1.25)"],
        [".layer-mountains-mid", 65, 35, "translateZ(-120px) scale(1.1)"],
        [".layer-mountains-near", 100, 50, "translateZ(-30px) scale(1.02)"],
      ];
      for (const [selector, mx, my, base] of layers) {
        const layer = document.querySelector(selector);
        if (layer) layer.style.transform = `translateX(${x * mx}px) translateY(${y * my}px) ${base}`;
      }
      const heroContent = document.querySelector(".hero-content");
      if (heroContent) heroContent.style.transform = `rotateY(${x * 3}deg) rotateX(${-y * 3}deg)`;
    }, { passive: true });
  }

  if (canvas && !prefersReducedMotion) {
    const ctx = canvas.getContext("2d");
    let particles = [];
    let pointerX = 0.5;
    let pointerY = 0.5;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const resetParticle = (particle = {}) => ({
      ...particle,
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      z: Math.random() * 800,
      size: Math.random() * 1.4 + 0.3,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
      vz: -Math.random() * 1.2 - 0.25,
    });

    resize();
    particles = Array.from({ length: 90 }, () => resetParticle());
    window.addEventListener("resize", resize, { passive: true });
    document.addEventListener("mousemove", (event) => {
      pointerX = event.clientX / window.innerWidth;
      pointerY = event.clientY / window.innerHeight;
    }, { passive: true });

    const animateParticles = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < particles.length; i += 1) {
        const particle = particles[i];
        particle.x += particle.vx + (pointerX - 0.5) * 0.35;
        particle.y += particle.vy + (pointerY - 0.5) * 0.35;
        particle.z += particle.vz;
        if (particle.z < 0) particles[i] = resetParticle({ z: 800 });
        if (particle.x < 0) particle.x = canvas.width;
        if (particle.x > canvas.width) particle.x = 0;
        if (particle.y < 0) particle.y = canvas.height;
        if (particle.y > canvas.height) particle.y = 0;
        const scale = 800 / (800 + particle.z);
        const alpha = particle.z < 100 ? particle.z / 100 : Math.min(1, particle.z / 800);
        ctx.beginPath();
        ctx.arc(
          particle.x + (pointerX - 0.5) * particle.z * 0.08,
          particle.y + (pointerY - 0.5) * particle.z * 0.08,
          particle.size * scale,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = `rgba(212, 165, 116, ${alpha * 0.5})`;
        ctx.fill();
      }
      requestAnimationFrame(animateParticles);
    };
    animateParticles();
  }

  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) entry.target.classList.add("active");
    });
  }, { threshold: 0.1 });

  window.observeReveal = (root = document) => {
    root.querySelectorAll(".reveal").forEach((element) => revealObserver.observe(element));
  };
  document.querySelectorAll(".section-heading, .inquiry-form").forEach((element) => {
    element.classList.add("reveal");
  });
  window.observeReveal();

  const statObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const valueElement = entry.target.querySelector(".stat-number");
      const target = Number(valueElement?.dataset.value || 0);
      const suffix = target >= 90 ? (target === 98 ? "%" : "+") : "+";
      const steps = 60;
      let current = 0;
      const increment = target / steps;
      const timer = setInterval(() => {
        current += increment;
        if (current >= target) {
          current = target;
          clearInterval(timer);
        }
        valueElement.textContent = `${Math.floor(current)}${suffix}`;
      }, 2000 / steps);
      statObserver.unobserve(entry.target);
    });
  }, { threshold: 0.5 });
  document.querySelectorAll(".stat-item").forEach((element) => statObserver.observe(element));

  const galleryBg = document.querySelector("#galleryParallax");
  if (galleryBg && !prefersReducedMotion) {
    window.addEventListener("scroll", () => {
      const rect = galleryBg.parentElement.getBoundingClientRect();
      const progress = -rect.top / (window.innerHeight + rect.height);
      if (progress > -0.5 && progress < 1.5) {
        const image = galleryBg.querySelector("img");
        if (image) image.style.transform = `translateY(${progress * 80}px)`;
      }
    }, { passive: true });
  }

  let currentTestimonial = 0;
  const testimonialTrack = document.querySelector("#testimonialTrack");
  const testimonialDots = [...document.querySelectorAll(".testimonial-dot")];
  const testimonialCards = testimonialTrack ? [...testimonialTrack.querySelectorAll(".testimonial-card")] : [];
  const showTestimonial = (index) => {
    if (!testimonialTrack || !testimonialCards.length) return;
    currentTestimonial = index;
    testimonialTrack.style.transform = `translateX(-${index * 100}%)`;
    testimonialDots.forEach((dot, dotIndex) => dot.classList.toggle("active", dotIndex === index));
    testimonialCards.forEach((card, cardIndex) => card.classList.toggle("active", cardIndex === index));
  };
  testimonialDots.forEach((dot) => {
    dot.addEventListener("click", () => showTestimonial(Number(dot.dataset.testimonial || 0)));
  });
  if (testimonialCards.length > 1 && !prefersReducedMotion) {
    setInterval(() => showTestimonial((currentTestimonial + 1) % testimonialCards.length), 6000);
  }
}

function escapeHtml(value) {
  const str = value == null ? "" : String(value);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(message, kind = "") {
  formStatus.textContent = message;
  formStatus.className = `form-status ${kind}`.trim();
}

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

async function loadTours() {
  const params = new URLSearchParams({
    sort: sortFilter.value,
    per: "50",
  });
  if (regionFilter.value) params.set("region", regionFilter.value);
  if (difficultyFilter.value) params.set("difficulty", difficultyFilter.value);

  const data = await getJson(`/api/v1/tours?${params.toString()}`);
  state.tours = data.items;
  renderTours();
  renderTourSelect();
}

async function loadDeals() {
  const data = await getJson("/api/v1/deals");
  dealList.innerHTML = data.items.length
    ? data.items.map((deal) => `
      <article class="deal reveal">
        <h3>${escapeHtml(deal.headline)}</h3>
        <p>${escapeHtml(deal.body)}</p>
      </article>
    `).join("")
    : `<article class="deal reveal"><h3>No active deal today</h3><p>Fresh mountain departures are still open for inquiry.</p></article>`;
  window.observeReveal?.(dealList);
}

async function loadSettings() {
  const settings = await getJson("/api/v1/settings");
  document.querySelectorAll("[data-brand-name]").forEach((el) => {
    el.textContent = settings.brand_name || "oktrek";
  });
  if (settings.brand_logo_url) {
    brandLogo.src = settings.brand_logo_url;
    brandLogo.classList.remove("hidden");
    document.querySelector(".brand-mark").classList.add("hidden");
  }
}

async function loadCategories() {
  const tours = await getJson("/api/v1/tours?per=50");
  const regions = [...new Set(tours.items.map((tour) => tour.region).filter(Boolean))].sort();
  regionFilter.insertAdjacentHTML("beforeend", regions.map((region) => (
    `<option value="${escapeHtml(region)}">${escapeHtml(region)}</option>`
  )).join(""));
}

function renderTours() {
  tourGrid.innerHTML = state.tours.map((tour) => `
    <article class="tour-card reveal">
      <div class="trek-card-image tour-visual" aria-hidden="true">
        <img src="/user/assets/himalayan-hero.png" alt="">
      </div>
      <button class="trek-card-btn" type="button" data-slug="${escapeHtml(tour.slug)}" aria-label="View ${escapeHtml(tour.title)} details">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="5" y1="12" x2="19" y2="12"></line>
          <polyline points="12 5 19 12 12 19"></polyline>
        </svg>
      </button>
      <div class="trek-card-content tour-body">
        <div class="trek-card-meta chip-row">
          <span class="chip">${escapeHtml(tour.region)}</span>
          <span class="chip">${escapeHtml(tour.difficulty)}</span>
          <span class="chip">${tour.duration_days} days</span>
        </div>
        <h3>${escapeHtml(tour.title)}</h3>
        <p>${tour.rating_count ? `${tour.rating_avg} from ${tour.rating_count} reviews` : "New fixed departure"}</p>
        <div class="price-row">
          <span class="price">${money.format(tour.from_price_inr)}</span>
          <span>per person onwards</span>
        </div>
        <button class="link-button" type="button" data-slug="${escapeHtml(tour.slug)}">View details</button>
      </div>
    </article>
  `).join("");
  window.observeReveal?.(tourGrid);
}

function renderTourSelect() {
  const current = tourSelect.value || state.tours[0]?.slug || "";
  tourSelect.innerHTML = state.tours.map((tour) => (
    `<option value="${escapeHtml(tour.slug)}">${escapeHtml(tour.title)}</option>`
  )).join("");
  tourSelect.value = state.tours.some((tour) => tour.slug === current) ? current : state.tours[0]?.slug || "";
  loadDeparturesForSelectedTour();
}

async function fetchTour(slug) {
  if (!state.tourDetails.has(slug)) {
    state.tourDetails.set(slug, await getJson(`/api/v1/tours/${encodeURIComponent(slug)}`));
  }
  return state.tourDetails.get(slug);
}

async function loadDeparturesForSelectedTour() {
  if (!tourSelect.value) return;
  const tour = await fetchTour(tourSelect.value);
  departureSelect.innerHTML = tour.departures.map((dep) => `
    <option value="${escapeHtml(dep.id)}">
      ${escapeHtml(dep.start_date)} to ${escapeHtml(dep.end_date)} - ${money.format(dep.price_inr)} - ${escapeHtml(dep.availability.replace("_", " "))}
    </option>
  `).join("");
}

function listItems(items) {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

async function openTour(slug) {
  const tour = await fetchTour(slug);
  detail.innerHTML = `
    <section class="detail-hero">
      <div>
        <p class="eyebrow">${escapeHtml(tour.region)} / ${escapeHtml(tour.difficulty)}</p>
        <h2>${escapeHtml(tour.title)}</h2>
      </div>
    </section>
    <section class="detail-body">
      <p>${escapeHtml(tour.description_md)}</p>
      <div class="detail-grid">
        <div class="mini-panel">
          <h4>Trip facts</h4>
          <ul>
            <li>${tour.duration_days} days</li>
            <li>${money.format(tour.from_price_inr)} onwards</li>
            <li>${tour.min_age ? `Minimum age ${tour.min_age}` : "Family friendly"}</li>
          </ul>
        </div>
        <div class="mini-panel">
          <h4>Next departures</h4>
          <ul>${tour.departures.slice(0, 4).map((dep) => `<li>${escapeHtml(dep.start_date)} - ${escapeHtml(dep.availability.replace("_", " "))}</li>`).join("")}</ul>
        </div>
      </div>
      <div class="detail-grid">
        <div class="mini-panel">
          <h4>Itinerary</h4>
          <ul>${tour.itinerary.map((day) => `<li>Day ${day.day}: ${escapeHtml(day.title)}</li>`).join("")}</ul>
        </div>
        <div class="mini-panel">
          <h4>Included</h4>
          ${listItems(tour.inclusions)}
        </div>
      </div>
      <button class="button primary" type="button" data-inquire="${escapeHtml(tour.slug)}">Inquire for this tour</button>
    </section>
  `;
  lastFocusTarget = document.activeElement;
  dialog.showModal();
}

async function submitInquiry(event) {
  event.preventDefault();
  setStatus("Sending...");

  const form = new FormData(inquiryForm);
  const payload = {
    tour_slug: form.get("tour_slug"),
    departure_id: Number(form.get("departure_id")) || undefined,
    name: form.get("name"),
    email: form.get("email"),
    phone_e164: form.get("phone_e164"),
    travellers: Number(form.get("travellers")),
    pickup_city: form.get("pickup_city"),
    message: form.get("message"),
    website: form.get("website"),
    consent: { version: "preview-2026-07-09", accepted: form.get("consent") === "on" },
  };

  const captchaResponse = window.hcaptcha?.getResponse?.();
  if (captchaResponse) payload.captcha_token = captchaResponse;

  try {
    if (!state.csrf) {
      state.csrf = (await getJson("/api/v1/csrf")).token;
    }
    const res = await fetch("/api/v1/inquiries", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": state.csrf,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.title || body.message || "Inquiry failed");
    setStatus(`Inquiry created: ${body.reference}`, "ok");
    window.hcaptcha?.reset?.();
  } catch (err) {
    setStatus(err.message, "error");
  }
}

/* ---------- auth ---------- */

const STAFF_ROLES = new Set(["ops", "content", "superadmin", "analyst"]);

function setAuthState(user) {
  // Public user page should never reflect an admin/staff session.
  if (user && STAFF_ROLES.has(user.role)) {
    user = null;
  }
  currentUser = user || null;
  if (user) {
    btnAuth.classList.add("hidden");
    userName.textContent = user.name;
    userName.classList.remove("hidden");
    btnLogout.classList.remove("hidden");
    navMyInquiries.classList.remove("hidden");
    myInquiriesSection.classList.remove("hidden");
    inquiryForm.querySelector('[name="name"]').value = user.name;
    inquiryForm.querySelector('[name="email"]').value = user.email;
    loadMyInquiries();
  } else {
    btnAuth.classList.remove("hidden");
    userName.classList.add("hidden");
    btnLogout.classList.add("hidden");
    navMyInquiries.classList.add("hidden");
    myInquiriesSection.classList.add("hidden");
    inquiryList.innerHTML = "";
  }
}

async function checkAuth() {
  try {
    const data = await getJson("/api/v1/me");
    setAuthState(data.user);
  } catch {
    setAuthState(null);
  }
}

async function submitLogin(event) {
  event.preventDefault();
  const status = loginForm.querySelector(".form-status");
  status.textContent = "";
  try {
    if (!state.csrf) state.csrf = (await getJson("/api/v1/csrf")).token;
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": state.csrf },
      body: JSON.stringify({
        email: loginForm.querySelector('[name="email"]').value.trim(),
        password: loginForm.querySelector('[name="password"]').value,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.title || body.message || "Login failed");
    authDialog.close();
    setAuthState(body.user);
  } catch (err) {
    status.textContent = err.message;
  }
}

async function submitRegister(event) {
  event.preventDefault();
  const status = registerForm.querySelector(".form-status");
  status.textContent = "";
  try {
    if (!state.csrf) state.csrf = (await getJson("/api/v1/csrf")).token;
    const res = await fetch("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": state.csrf },
      body: JSON.stringify({
        name: registerForm.querySelector('[name="name"]').value.trim(),
        email: registerForm.querySelector('[name="email"]').value.trim(),
        password: registerForm.querySelector('[name="password"]').value,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.title || body.message || "Registration failed");
    authDialog.close();
    setAuthState(body.user);
  } catch (err) {
    status.textContent = err.message;
  }
}

async function logout() {
  try {
    if (!state.csrf) state.csrf = (await getJson("/api/v1/csrf")).token;
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": state.csrf },
    });
  } catch {}
  setAuthState(null);
}

async function loadMyInquiries() {
  if (!currentUser) return;
  try {
    const data = await getJson("/api/v1/my-inquiries");
    renderMyInquiries(data.items);
  } catch (err) {
    inquiryList.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
  }
}

function renderMyInquiries(items) {
  if (!items.length) {
    inquiryList.innerHTML = `<p class="muted">No inquiries yet. Browse tours and send your first inquiry.</p>`;
    return;
  }
  inquiryList.innerHTML = items.map((inq) => `
    <article class="inquiry-card">
      <h4>${escapeHtml(inq.reference)} — ${escapeHtml(inq.tour_title)}</h4>
      <p>${escapeHtml(inq.status.replace("_", " "))} · ${escapeHtml(inq.travellers)} traveller(s) · ${escapeHtml(inq.created_at ? inq.created_at.slice(0, 10) : "")}</p>
      <div class="meta">
        <span>${escapeHtml(inq.phone_e164)}</span>
        <span>${escapeHtml(inq.email)}</span>
      </div>
    </article>
  `).join("");
}

function switchAuthTab(tab) {
  for (const t of authContent.querySelectorAll(".auth-tab")) {
    t.classList.toggle("active", t.dataset.tab === tab);
  }
  loginForm.classList.toggle("hidden", tab !== "login");
  registerForm.classList.toggle("hidden", tab !== "register");
}

tourGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-slug]");
  if (button) openTour(button.dataset.slug);
});

detail.addEventListener("click", (event) => {
  const button = event.target.closest("[data-inquire]");
  if (!button) return;
  tourSelect.value = button.dataset.inquire;
  loadDeparturesForSelectedTour();
  dialog.close();
  document.querySelector("#inquiry").scrollIntoView({ behavior: "smooth" });
});

dialog.querySelector(".icon-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  if (lastFocusTarget && lastFocusTarget.focus) {
    lastFocusTarget.focus();
    lastFocusTarget = null;
  }
});
regionFilter.addEventListener("change", loadTours);
difficultyFilter.addEventListener("change", loadTours);
sortFilter.addEventListener("change", loadTours);
tourSelect.addEventListener("change", loadDeparturesForSelectedTour);
inquiryForm.addEventListener("submit", submitInquiry);

btnAuth.addEventListener("click", () => authDialog.showModal());
btnLogout.addEventListener("click", logout);
authDialog.querySelector(".icon-close").addEventListener("click", () => authDialog.close());
authContent.querySelectorAll(".auth-tab").forEach((t) => {
  t.addEventListener("click", () => switchAuthTab(t.dataset.tab));
});
loginForm.addEventListener("submit", submitLogin);
registerForm.addEventListener("submit", submitRegister);
initUiEffects();

Promise.all([loadSettings(), loadCategories(), loadDeals()])
  .then(loadTours)
  .then(checkAuth)
  .catch((err) => {
    tourGrid.innerHTML = `<p>${escapeHtml(err.message)}</p>`;
  });

/* Demo values only when ?demo=1 is present */
if (new URLSearchParams(location.search).has("demo")) {
  inquiryForm.querySelector('[name="name"]').value = "Preview Traveller";
  inquiryForm.querySelector('[name="email"]').value = "traveller@example.com";
  inquiryForm.querySelector('[name="phone_e164"]').value = "+919812345678";
  inquiryForm.querySelector('[name="travellers"]').value = "2";
  inquiryForm.querySelector('[name="pickup_city"]').value = "Haridwar";
  inquiryForm.querySelector('[name="message"]').value = "Need hotel and transport details for this departure.";
}
