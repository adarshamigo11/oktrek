import { getDb } from "../lib/db.js";
import { hashIp } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

/** Append-only audit write. */
export async function audit(req, { action, entityType, entityId = null, before = null, after = null }) {
  const db = await getDb();
  await db.collection("audit_entries").insertOne({
    actor_id: req.user?.id ?? null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
    ip_hash: hashIp(req.ip),
    ua: (req.get("user-agent") || "").slice(0, 255),
    created_at: new Date(),
  });
}

export function notFound(_req, res) {
  res.status(404).json({ type: "about:blank", title: "Not found", status: 404 });
}

/** RFC 7807 Problem Details error handler — Architecture doc §6.1. */
export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) logger.error({ err, path: req.path }, "unhandled error");
  const body = {
    type: "about:blank",
    title: status >= 500 ? "Internal server error" : err.message || "Request failed",
    status,
    instance: req.originalUrl,
  };
  if (err.errors) body.errors = err.errors; // zod details
  res.status(status).json(body);
}

export function zodError(zerr) {
  const e = new Error("Validation failed");
  e.status = 422;
  e.errors = zerr.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  return e;
}
