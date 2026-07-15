import crypto from "node:crypto";
import { config } from "../config/index.js";

/** AES-256-GCM encrypt (used for TOTP secrets at rest — Security doc §6.2). */
export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config.aesKeyMfa, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]); // 12 + 16 + n
}

export function decryptSecret(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const iv = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const ct = b.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", config.aesKeyMfa, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** HMAC-SHA256 hash of an IP (raw IP never stored — Security doc §6.4). */
export function hashIp(ip) {
  return crypto.createHmac("sha256", config.ipHashSecret).update(ip || "").digest("hex");
}

export function hashKey(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function uuid() {
  return crypto.randomUUID();
}

/** Compact signed token: base64url(json).base64url(hmac). For MFA-pending + magic links. */
export function signToken(payload, secret, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token, secret) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expect = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
