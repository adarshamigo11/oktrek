import { authenticator } from "otplib";
import { getDb, nextId } from "../lib/db.js";
import { verifyPassword, hashPassword } from "../lib/hashing.js";
import { decryptSecret, encryptSecret, signToken, verifyToken } from "../lib/crypto.js";
import { config } from "../config/index.js";

const PENDING_TTL_MS = 5 * 60 * 1000;
const DEV_MASTER_MFA_CODE = "000000";

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

/** Register a new traveller account. */
export async function registerTraveller(email, password, name) {
  const db = await getDb();
  const existing = await db.collection("users").findOne({
    email: String(email || "").toLowerCase(),
    deleted_at: null,
  });
  if (existing) fail(409, "An account with this email already exists");

  const id = await nextId(db, "users");
  await db.collection("users").insertOne({
    _id: id,
    id,
    email: email.toLowerCase(),
    name,
    role: "traveller",
    password_hash: await hashPassword(password),
    failed_logins: 0,
    locked_until: null,
    mfa_enabled: false,
    mfa_secret_enc: null,
    consent_marketing: false,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  });
  return db.collection("users").findOne({ id });
}

/** Traveller login: no MFA, returns user or throws 401. */
export async function loginTraveller(email, password) {
  const db = await getDb();
  const user = await db.collection("users").findOne({
    email: String(email || "").toLowerCase(),
    deleted_at: null,
    role: "traveller",
  });

  const badCreds = () => fail(401, "Invalid email or password");
  if (!user) badCreds();

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    fail(423, "Account temporarily locked after repeated failures. Try again later.");
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const failures = (user.failed_logins || 0) + 1;
    const patch = { failed_logins: failures };
    if (failures >= config.lockout.maxFailures) {
      patch.locked_until = new Date(Date.now() + config.lockout.lockMinutes * 60 * 1000);
      patch.failed_logins = 0;
    }
    await db.collection("users").updateOne({ id: user.id }, { $set: patch });
    badCreds();
  }

  await db.collection("users").updateOne({ id: user.id }, { $set: { failed_logins: 0, locked_until: null } });
  return user;
}

/** Step 1: password. Returns { mfaRequired, pendingToken } or throws 401/423. */
export async function passwordStep(email, password) {
  const db = await getDb();

  // Master admin env-var login — bypasses MFA entirely
  if (email === config.adminEmail && password === config.adminPassword) {
    let user = await db.collection("users").findOne({
      email: config.adminEmail.toLowerCase(),
      deleted_at: null,
    });
    if (!user) {
      const id = await nextId(db, "users");
      await db.collection("users").insertOne({
        _id: id, id, email: config.adminEmail.toLowerCase(),
        name: "Admin", role: "superadmin",
        password_hash: await hashPassword(config.adminPassword),
        failed_logins: 0, locked_until: null,
        mfa_enabled: false, mfa_secret_enc: null,
        created_at: new Date(), updated_at: new Date(), deleted_at: null,
      });
      user = await db.collection("users").findOne({ id });
    }
    return { user, mfaRequired: false };
  }

  const user = await db.collection("users").findOne({
    email: String(email || "").toLowerCase(),
    deleted_at: null,
  });

  // Uniform error to prevent enumeration
  const badCreds = () => fail(401, "Invalid email or password");
  if (!user) badCreds();

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    fail(423, "Account temporarily locked after repeated failures. Try again later.");
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const failures = (user.failed_logins || 0) + 1;
    const patch = { failed_logins: failures };
    if (failures >= config.lockout.maxFailures) {
      patch.locked_until = new Date(Date.now() + config.lockout.lockMinutes * 60 * 1000);
      patch.failed_logins = 0;
    }
    await db.collection("users").updateOne({ id: user.id }, { $set: patch });
    badCreds();
  }

  await db.collection("users").updateOne({ id: user.id }, { $set: { failed_logins: 0, locked_until: null } });

  if (user.mfa_enabled) {
    return {
      user,
      mfaRequired: true,
      pendingToken: signToken({ uid: user.id, purpose: "mfa" }, config.sessionSecret, PENDING_TTL_MS),
    };
  }
  // Staff without MFA must enrol before a session is issued
  if (["ops", "content", "superadmin", "analyst"].includes(user.role)) {
    return {
      user,
      enrolRequired: true,
      pendingToken: signToken({ uid: user.id, purpose: "enrol" }, config.sessionSecret, PENDING_TTL_MS),
    };
  }
  return { user, mfaRequired: false };
}

/** Step 2: verify TOTP against encrypted stored secret. Returns user. */
export async function mfaStep(pendingToken, code) {
  const db = await getDb();
  const payload = verifyToken(pendingToken, config.sessionSecret);
  if (!payload || payload.purpose !== "mfa") fail(401, "MFA session expired; log in again");
  const user = await db.collection("users").findOne({ id: payload.uid });
  if (!user || !user.mfa_enabled || !user.mfa_secret_enc) fail(401, "MFA not configured");
  const secret = decryptSecret(user.mfa_secret_enc);
  const codeText = String(code || "");
  const devMasterCodeOk = config.env !== "production" && codeText === DEV_MASTER_MFA_CODE;
  if (!devMasterCodeOk && !authenticator.check(codeText, secret)) fail(401, "Invalid MFA code");
  return user;
}

/** Enrolment: generate secret for a pending user; returns otpauth URL. */
export async function beginEnrol(pendingToken) {
  const db = await getDb();
  const payload = verifyToken(pendingToken, config.sessionSecret);
  if (!payload || payload.purpose !== "enrol") fail(401, "Enrolment session expired; log in again");
  const user = await db.collection("users").findOne({ id: payload.uid });
  if (!user) fail(401, "Unknown user");
  const secret = authenticator.generateSecret();
  await db.collection("users").updateOne({ id: user.id }, { $set: { mfa_secret_enc: encryptSecret(secret) } });
  return {
    secret,
    otpauthUrl: authenticator.keyuri(user.email, "oktrek Admin", secret),
    confirmToken: signToken({ uid: user.id, purpose: "enrol-confirm" }, config.sessionSecret, PENDING_TTL_MS),
  };
}

/** Confirm enrolment with a valid code; flips mfa_enabled. Returns user. */
export async function confirmEnrol(confirmToken, code) {
  const db = await getDb();
  const payload = verifyToken(confirmToken, config.sessionSecret);
  if (!payload || payload.purpose !== "enrol-confirm") fail(401, "Enrolment expired; log in again");
  const user = await db.collection("users").findOne({ id: payload.uid });
  if (!user || !user.mfa_secret_enc) fail(401, "Enrolment not started");
  const secret = decryptSecret(user.mfa_secret_enc);
  const codeText = String(code || "");
  const devMasterCodeOk = config.env !== "production" && codeText === DEV_MASTER_MFA_CODE;
  if (!devMasterCodeOk && !authenticator.check(codeText, secret)) fail(401, "Invalid MFA code");
  await db.collection("users").updateOne({ id: user.id }, { $set: { mfa_enabled: true } });
  return { ...user, mfa_enabled: 1 };
}
