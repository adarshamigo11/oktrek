# Trek On India — Inquiry Booking Platform (Backend + Admin)

Sprint 1 deliverable per the approved Roadmap: foundations, schema, auth with mandatory
TOTP MFA, security middleware, plus the end-to-end inquiry flow (Sprint 3 core, pulled
forward so the increment is demonstrable) and an operations admin UI.

## Quick start

```bash
cp .env.example .env        # then replace every CHANGE_ME with random secrets:
# node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npm install
npm run migrate
npm run seed                # prints admin credentials + TOTP secret
npm start                   # http://127.0.0.1:4000
```

Open **http://127.0.0.1:4000/admin/** — log in with the seeded Super Admin, enter the
TOTP code from your authenticator app (add the secret printed by the seed).

Seeded accounts:

| Account | Password | MFA |
|---|---|---|
| admin@trekonindia.com | TrekOnIndia@2026! | Enabled — secret printed by seed |
| ops@trekonindia.com | OpsTrek@2026! | Forced enrolment on first login |
| content@trekonindia.com | ContentTrek@2026! | Forced enrolment on first login |

**Rotate all seeded passwords before any shared environment.**

## Verify

```bash
npm start &        # in one terminal
npm run smoke      # in another — 30 assertions, all must pass
```

The smoke suite covers: catalog endpoints, CSRF enforcement, inquiry creation +
validation + honeypot + rate limiting (429), admin password step, TOTP verify,
forced MFA enrolment, RBAC denials (ops blocked from user creation and audit log),
inquiry status workflow with departure seat counting, review moderation with rating
aggregation, and audit-entry writes.

## API surface (implemented)

Public (`/api/v1`): `GET /health`, `GET /csrf`, `GET /tours` (filters + sort),
`GET /tours/:slug` (departures, images, approved reviews), `GET /categories`,
`GET /deals`, `POST /inquiries` (CSRF + captcha + honeypot + 5/hr + 30/day per IP).

Admin (`/api/v1/admin`): `POST auth/login`, `POST auth/mfa`,
`POST auth/enrol/begin|confirm`, `POST auth/logout`, `GET me`,
`GET|PATCH inquiries`, `POST inquiries/:id/messages`, `GET|POST tours`,
`POST tours/:id/publish|unpublish`, `POST departures` (bulk),
`GET reviews`, `POST reviews/:id/approve|reject`, `POST users` (superadmin),
`GET audit` (superadmin).

## Security controls in this increment

- bcrypt cost 12; breached-password check at set time; account lockout 5 failures / 15 min
- TOTP MFA mandatory for every staff role; secret stored AES-256-GCM encrypted
- Server-side session store; HttpOnly/SameSite=Lax cookies; 12 h absolute admin TTL;
  session rotation on login and MFA; admin session revoked on IP change
- CSRF double-submit with HMAC-verified tokens on every state-changing route
- DB-backed rate-limit buckets (shared across processes) per Security doc §11
- Strict CSP with per-request nonces, HSTS preload, full header set (verified in tests)
- Zod validation at every boundary; parameterised queries only (Knex)
- Raw IPs never stored — HMAC-SHA256 hashes only
- Append-only audit log with actor, action, before/after snapshots
- Analyst role receives masked email/phone (field-level RBAC)
- API bound to 127.0.0.1; reverse proxy is the only public entry

## Architecture Decision Records (deviations from the Architecture doc)

**ADR-001 — Knex replaces Prisma.** Prisma requires engine binaries fetched from
binaries.prisma.sh at install time, which is unreachable in the build environment and
adds a native-binary dependency to cPanel deploys. Knex is pure JS, supports the same
SQLite-dev → MySQL-prod path via `DATABASE_URL`, and keeps `migrations/` in source
control as the doc requires. Query parameterisation guarantees are equivalent.

**ADR-002 — Plain ESM JavaScript instead of TypeScript for the API.** Zero build step
means the release artifact is the source tree itself — simpler on GoDaddy cPanel's
Node.js Selector (Passenger points at `server.js` directly). Zod provides runtime type
safety at all trust boundaries, which is where it matters most for this service.
TypeScript remains the plan for the Next.js frontend (Sprint 2).

## Deploying to GoDaddy (summary — full detail in Architecture doc §7)

1. Confirm plan tier supports Node.js (cPanel Business+ with Node.js Selector, or VPS).
2. Upload the tree to `~/apps/api/`; run `npm ci --omit=dev`.
3. Create the MySQL database; set `DATABASE_URL=mysql://...` in `.env` (chmod 600).
4. `npm run migrate` from a cPanel terminal. Do NOT run the demo seed in production —
   create the first Super Admin with a one-off script instead.
5. Node.js Selector: application root `~/apps/api`, startup file `server.js`.
6. Put Cloudflare in front; enable the WAF; origin binds to localhost and is reached
   through the Apache/Passenger proxy only.

## Next sprint (S2 — Public Site)

Next.js 14 public frontend consuming this API: home, catalogue, tour detail,
inquiry form with hCaptcha, legal pages, SEO (JSON-LD TouristTrip, sitemap).
