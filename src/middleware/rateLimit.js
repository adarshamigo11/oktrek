import { db } from "../lib/db.js";
import { hashIp, hashKey } from "../lib/crypto.js";
import { config } from "../config/index.js";

/**
 * Fixed-window rate limit backed by rate_limit_bucket (shared across processes).
 * key: function(req) -> string identity part (default IP hash).
 */
export function rateLimit({ name, limit, windowSec, key }) {
  return async (req, res, next) => {
    try {
      const identity = key ? key(req) : hashIp(req.ip);
      const bucketKey = hashKey(config.ipHashSecret, `${name}:${identity}:${windowSec}`);
      const now = new Date();
      const windowStartCutoff = new Date(now.getTime() - windowSec * 1000);

      const row = await db("rate_limit_bucket").where({ key_hash: bucketKey }).first();
      if (!row || new Date(row.window_start) < windowStartCutoff) {
        await db("rate_limit_bucket")
          .insert({ key_hash: bucketKey, counter: 1, window_start: now })
          .onConflict("key_hash")
          .merge({ counter: 1, window_start: now });
        return next();
      }
      if (row.counter >= limit) {
        const retryAfter = Math.ceil(
          (new Date(row.window_start).getTime() + windowSec * 1000 - now.getTime()) / 1000
        );
        res.setHeader("Retry-After", String(Math.max(retryAfter, 1)));
        return res.status(429).json({
          type: "about:blank", title: "Too many requests", status: 429,
          detail: `Rate limit for this action exceeded. Retry after ${Math.max(retryAfter, 1)}s.`,
        });
      }
      await db("rate_limit_bucket").where({ key_hash: bucketKey }).increment("counter", 1);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Default API limiter: 120/min/IP (Security doc §11). */
export const defaultApiLimit = rateLimit({ name: "api", limit: 120, windowSec: 60 });
