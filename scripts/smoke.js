/* Smoke test — runs against a live server on 127.0.0.1:4000.
 * Verifies Sprint-1 exit criteria + inquiry flow end-to-end.
 */
import { authenticator } from "otplib";
import knex from "knex";
import knexConfig from "../knexfile.js";
import crypto from "node:crypto";
import "dotenv/config";

const BASE = "http://127.0.0.1:4000/api/v1";
const db = knex(knexConfig);

let pass = 0, failCount = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { failCount++; console.log("  ✗ FAIL " + name); }
}

/** Minimal cookie jar */
const jar = new Map();
function setCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const [pair] = c.split(";");
    const [k, v] = pair.split("=");
    jar.set(k.trim(), v);
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function req(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader(),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  setCookies(res);
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function decryptSecret(buf) {
  const key = Buffer.from(process.env.AES_KEY_MFA, "base64");
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), ct = b.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

async function main() {
  console.log("\n— health & public catalog —");
  let r = await req("/health");
  ok(r.status === 200 && r.data.ok, "GET /health 200");

  r = await req("/tours");
  ok(r.status === 200 && r.data.items.length === 6, `GET /tours lists 6 tours (${r.data.items?.length})`);

  r = await req("/tours?category=char-dham-yatra");
  ok(r.status === 200 && r.data.items.every(t => t.region === "Uttarakhand"), "category filter works");

  r = await req("/tours/kedarnath-do-dham-5n6d");
  ok(r.status === 200 && r.data.departures.length === 8 && r.data.itinerary.length === 6,
    "tour detail: 8 departures + itinerary parsed");
  const departureId = r.data.departures[0].id;

  r = await req("/tours/does-not-exist");
  ok(r.status === 404, "unknown tour -> 404");

  console.log("\n— CSRF enforcement —");
  r = await req("/inquiries", { method: "POST", body: {} });
  ok(r.status === 403, "POST without CSRF token -> 403");

  r = await req("/csrf");
  const csrf = r.data.token;
  ok(!!csrf, "CSRF token issued");
  const CSRF = { "x-csrf-token": csrf };

  console.log("\n— inquiry flow —");
  const inquiryBody = {
    tour_slug: "kedarnath-do-dham-5n6d",
    departure_id: departureId,
    name: "Ramesh Sharma",
    email: "ramesh@example.com",
    phone_e164: "+919812345678",
    travellers: 4,
    pickup_city: "Delhi",
    message: "One senior citizen (age 68).",
    consent: { version: "2026-07-01", accepted: true },
  };
  r = await req("/inquiries", { method: "POST", headers: CSRF, body: inquiryBody });
  ok(r.status === 201 && /^TOI-2026-\d{6}$/.test(r.data.reference), `inquiry created ${r.data.reference}`);
  const reference = r.data.reference;

  r = await req("/inquiries", { method: "POST", headers: CSRF, body: { ...inquiryBody, phone_e164: "9812345678" } });
  ok(r.status === 422, "bad phone format -> 422 validation");

  r = await req("/inquiries", { method: "POST", headers: CSRF, body: { ...inquiryBody, website: "spam.example" } });
  ok(r.status === 201 && r.data.reference === "TOI-0000-000000", "honeypot silently dropped");

  console.log("\n— rate limiting (5/hour on inquiries) —");
  let got429 = false;
  for (let i = 0; i < 5; i++) {
    r = await req("/inquiries", { method: "POST", headers: CSRF, body: inquiryBody });
    if (r.status === 429) { got429 = true; break; }
  }
  ok(got429, "inquiry rate limit returns 429 with Retry-After");

  console.log("\n— admin auth: password + TOTP —");
  r = await req("/admin/inquiries");
  ok(r.status === 401, "admin API without session -> 401");

  r = await req("/admin/auth/login", {
    method: "POST", headers: CSRF,
    body: { email: "admin@trekonindia.com", password: "wrong-password" },
  });
  ok(r.status === 401, "wrong password -> 401");

  r = await req("/admin/auth/login", {
    method: "POST", headers: CSRF,
    body: { email: "admin@trekonindia.com", password: "TrekOnIndia@2026!" },
  });
  ok(r.status === 200 && r.data.mfa_required, "correct password -> MFA required (no session yet)");

  const admin = await db("user").where({ email: "admin@trekonindia.com" }).first();
  const totpSecret = decryptSecret(admin.mfa_secret_enc);
  const code = authenticator.generate(totpSecret);

  r = await req("/admin/auth/mfa", {
    method: "POST", headers: CSRF,
    body: { pending_token: r.data.pending_token, code: "000000" },
  });
  ok(r.status === 401, "wrong TOTP -> 401");

  // redo password step (pending token consumed conceptually; get fresh)
  r = await req("/admin/auth/login", {
    method: "POST", headers: CSRF,
    body: { email: "admin@trekonindia.com", password: "TrekOnIndia@2026!" },
  });
  r = await req("/admin/auth/mfa", {
    method: "POST", headers: CSRF,
    body: { pending_token: r.data.pending_token, code: authenticator.generate(totpSecret) },
  });
  ok(r.status === 200 && r.data.ok, "correct TOTP -> session established");

  r = await req("/admin/me");
  ok(r.status === 200 && r.data.user.role === "superadmin", "GET /admin/me returns superadmin");

  console.log("\n— ops workflow + audit —");
  r = await req("/admin/inquiries?status=new");
  ok(r.status === 200 && r.data.items.length >= 1, "inquiry queue lists new inquiries");
  const inq = r.data.items.find(i => i.reference === reference);
  ok(!!inq, "created inquiry appears in queue");

  r = await req(`/admin/inquiries/${inq.id}`, {
    method: "PATCH", headers: CSRF, body: { status: "confirmed" },
  });
  ok(r.status === 200 && r.data.status === "confirmed", "status new -> confirmed");

  const dep = await db("departure").where({ id: departureId }).first();
  ok(dep.confirmed_count === 4, `departure confirmed_count incremented to ${dep.confirmed_count}`);

  const auditRows = await db("audit_entry").where({ entity_type: "inquiry", entity_id: inq.id });
  ok(auditRows.some(a => a.action === "update.inquiry"), "audit entry recorded for status change");

  r = await req(`/admin/inquiries/${inq.id}/messages`, {
    method: "POST", headers: CSRF,
    body: { visibility: "internal", body_md: "Called traveller; senior citizen noted." },
  });
  ok(r.status === 201, "internal message posted");

  console.log("\n— reviews moderation —");
  r = await req("/admin/reviews?status=pending");
  const review = r.data.items[0];
  ok(!!review, "pending review in queue");
  r = await req(`/admin/reviews/${review.id}/approve`, { method: "POST", headers: CSRF, body: {} });
  ok(r.status === 200, "review approved");
  const tour = await db("tour").where({ id: review.tour_id }).first();
  ok(Number(tour.rating_avg) === 5 && tour.rating_count === 1, "tour rating aggregates updated");

  console.log("\n— RBAC: ops cannot create users —");
  // login as ops (must enrol MFA first — exercise enrol flow)
  jar.delete("toi_sess");
  r = await req("/admin/auth/login", {
    method: "POST", headers: CSRF,
    body: { email: "ops@trekonindia.com", password: "OpsTrek@2026!" },
  });
  ok(r.status === 200 && r.data.enrol_required, "staff without MFA forced to enrol");
  r = await req("/admin/auth/enrol/begin", { method: "POST", headers: CSRF, body: { pending_token: r.data.pending_token } });
  const opsSecret = r.data.secret;
  r = await req("/admin/auth/enrol/confirm", {
    method: "POST", headers: CSRF,
    body: { confirm_token: r.data.confirm_token, code: authenticator.generate(opsSecret) },
  });
  ok(r.status === 200 && r.data.role === "ops", "ops MFA enrolment complete, session issued");

  r = await req("/admin/users", {
    method: "POST", headers: CSRF,
    body: { email: "x@x.com", name: "X User", role: "ops", password: "SomePass123!" },
  });
  ok(r.status === 403, "ops role blocked from creating users (403)");

  r = await req("/admin/audit");
  ok(r.status === 403, "ops role blocked from audit log (403)");

  console.log(`\n${"─".repeat(46)}\nRESULT: ${pass} passed, ${failCount} failed\n`);
  await db.destroy();
  process.exit(failCount ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await db.destroy(); process.exit(1); });
