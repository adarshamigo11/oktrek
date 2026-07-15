import { getDb } from "../lib/db.js";
import { uuid, hashIp } from "../lib/crypto.js";
import { config } from "../config/index.js";

const STAFF_ROLES = new Set(["ops", "content", "superadmin", "analyst"]);

export async function createSession(res, user, req) {
  const db = await getDb();
  const isStaff = STAFF_ROLES.has(user.role);
  const ttl = isStaff ? config.session.adminTtlMs : config.session.travellerTtlMs;
  const id = uuid();
  await db.collection("sessions").insertOne({
    _id: id,
    user_id: user.id,
    expires_at: new Date(Date.now() + ttl),
    ip_hash: hashIp(req.ip),
    ua_fingerprint: (req.get("user-agent") || "").slice(0, 64),
  });
  res.cookie(config.session.cookieName, id, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: ttl,
  });
  return id;
}

export async function destroySession(req, res) {
  const db = await getDb();
  const sid = req.cookies?.[config.session.cookieName];
  if (sid) await db.collection("sessions").updateOne({ _id: sid }, { $set: { revoked_at: new Date() } });
  res.clearCookie(config.session.cookieName, { path: "/" });
}

/** Rotate on privilege change (login, MFA verify). */
export async function rotateSession(req, res, user) {
  await destroySession(req, res);
  return createSession(res, user, req);
}

/** Load session -> req.user (or null). Never trusts role from cookie/header. */
export async function loadUser(req, _res, next) {
  try {
    req.user = null;
    const sid = req.cookies?.[config.session.cookieName];
    if (!sid) return next();
    const db = await getDb();
    const s = await db.collection("sessions").findOne({ _id: sid, revoked_at: null });
    if (!s || new Date(s.expires_at) < new Date()) return next();
    const u = await db.collection("users").findOne({ id: s.user_id, deleted_at: null });
    if (!u) return next();
    // Admin sessions: re-auth on IP change
    if (STAFF_ROLES.has(u.role) && s.ip_hash && s.ip_hash !== hashIp(req.ip)) {
      await db.collection("sessions").updateOne({ _id: sid }, { $set: { revoked_at: new Date() } });
      return next();
    }
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role };
    req.sessionId = sid;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ type: "about:blank", title: "Authentication required", status: 401 });
    }
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ type: "about:blank", title: "Forbidden for this role", status: 403 });
    }
    next();
  };
}

export const requireStaff = requireRole("ops", "content", "superadmin", "analyst");
import { db } from "../lib/db.js";
import { uuid, hashIp } from "../lib/crypto.js";
import { config } from "../config/index.js";

const STAFF_ROLES = new Set(["ops", "content", "superadmin", "analyst"]);

export async function createSession(res, user, req) {
  const isStaff = STAFF_ROLES.has(user.role);
  const ttl = isStaff ? config.session.adminTtlMs : config.session.travellerTtlMs;
  const id = uuid();
  await db("session").insert({
    id,
    user_id: user.id,
    expires_at: new Date(Date.now() + ttl),
    ip_hash: hashIp(req.ip),
    ua_fingerprint: (req.get("user-agent") || "").slice(0, 64),
  });
  res.cookie(config.session.cookieName, id, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: ttl,
  });
  return id;
}

export async function destroySession(req, res) {
  const sid = req.cookies?.[config.session.cookieName];
  if (sid) await db("session").where({ id: sid }).update({ revoked_at: new Date() });
  res.clearCookie(config.session.cookieName, { path: "/" });
}

/** Rotate on privilege change (login, MFA verify) — Security doc §4.3. */
export async function rotateSession(req, res, user) {
  await destroySession(req, res);
  return createSession(res, user, req);
}

/** Load session -> req.user (or null). Never trusts role from cookie/header. */
export async function loadUser(req, _res, next) {
  try {
    req.user = null;
    const sid = req.cookies?.[config.session.cookieName];
    if (!sid) return next();
    const s = await db("session").where({ id: sid }).whereNull("revoked_at").first();
    if (!s || new Date(s.expires_at) < new Date()) return next();
    const u = await db("user").where({ id: s.user_id }).whereNull("deleted_at").first();
    if (!u) return next();
    // Admin sessions: re-auth on IP change (Security doc §3 spoofing control)
    if (STAFF_ROLES.has(u.role) && s.ip_hash && s.ip_hash !== hashIp(req.ip)) {
      await db("session").where({ id: sid }).update({ revoked_at: new Date() });
      return next();
    }
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role };
    req.sessionId = sid;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ type: "about:blank", title: "Authentication required", status: 401 });
    }
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ type: "about:blank", title: "Forbidden for this role", status: 403 });
    }
    next();
  };
}

export const requireStaff = requireRole("ops", "content", "superadmin", "analyst");
