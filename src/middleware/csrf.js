import crypto from "node:crypto";
import { config } from "../config/index.js";

const COOKIE = "toi_csrf";

/** Issue a CSRF token: random value + HMAC, delivered as cookie AND response body. */
export function issueCsrf(req, res) {
  const raw = crypto.randomBytes(16).toString("base64url");
  const sig = crypto.createHmac("sha256", config.csrfSecret).update(raw).digest("base64url");
  const token = `${raw}.${sig}`;
  res.cookie(COOKIE, token, {
    httpOnly: false, // double-submit: client JS must read it to echo in header
    secure: config.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 2 * 3600 * 1000,
  });
  return token;
}

function valid(token) {
  const [raw, sig] = String(token || "").split(".");
  if (!raw || !sig) return false;
  const expect = crypto.createHmac("sha256", config.csrfSecret).update(raw).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Enforce on state-changing methods: header token must match cookie token and verify. */
export function csrfProtect(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const header = req.get("X-CSRF-Token");
  const cookie = req.cookies?.[COOKIE];
  if (!header || !cookie || header !== cookie || !valid(header)) {
    return res.status(403).json({
      type: "about:blank", title: "CSRF token missing or invalid", status: 403,
    });
  }
  next();
}
