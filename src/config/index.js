import "dotenv/config";

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT || 4000),
  appUrl: process.env.APP_URL || "http://localhost:4000",
  mongoUrl: process.env.MONGODB_URL || "mongodb://127.0.0.1:27017/oktrek",

  sessionSecret: req("SESSION_SECRET"),
  csrfSecret: req("CSRF_SECRET"),
  signedLinkSecret: req("SIGNED_LINK_SECRET"),
  ipHashSecret: req("IP_HASH_SECRET"),
  aesKeyMfa: process.env.AES_KEY_MFA ? Buffer.from(process.env.AES_KEY_MFA, "base64") : Buffer.alloc(32),

  // Master admin credentials from env — bypass MFA when these are used
  adminEmail: process.env.ADMIN_EMAIL || "admin@trekonindia.com",
  adminPassword: process.env.ADMIN_PASSWORD || "changeme",

  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.MAIL_FROM || "Trek On India <bookings@trekonindia.com>",
    ops: process.env.MAIL_OPS || "ops@trekonindia.com",
  },

  captchaSecret: process.env.CAPTCHA_SECRET || "",
  trustProxy: process.env.TRUST_PROXY === "1",
  logLevel: process.env.LOG_LEVEL || "info",

  session: {
    cookieName: "toi_sess",
    travellerTtlMs: 30 * 24 * 3600 * 1000, // 30 days sliding
    adminTtlMs: 12 * 3600 * 1000,          // 12 hours absolute
  },
  lockout: { maxFailures: 5, lockMinutes: 15 },
};


