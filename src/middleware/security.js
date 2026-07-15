import helmet from "helmet";
import crypto from "node:crypto";

/** Per-request nonce for the admin page CSP. */
export function nonceMiddleware(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
}

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        "style-src": ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        "img-src": ["'self'", "data:"],
        "font-src": ["'self'"],
        "connect-src": ["'self'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],
        "upgrade-insecure-requests": process.env.NODE_ENV === "production" ? [] : null,
      },
    },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "same-site" },
    xFrameOptions: { action: "deny" },
  });
}

export function extraHeaders(req, res, next) {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (req.path.startsWith("/admin")) res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
}
