import { Router } from "express";
import { z } from "zod";
import { getDb } from "../lib/db.js";
import { issueCsrf, csrfProtect } from "../middleware/csrf.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { createInquiry } from "../services/inquiryService.js";
import { zodError } from "../middleware/common.js";
import { publicSettings } from "../lib/settings.js";
import { registerTraveller, loginTraveller } from "../services/authService.js";
import { createSession, destroySession } from "../middleware/auth.js";
import { config } from "../config/index.js";

export const publicRouter = Router();

publicRouter.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

publicRouter.get("/settings", async (_req, res, next) => {
  try {
    res.json(await publicSettings());
  } catch (err) { next(err); }
});

publicRouter.get("/csrf", (req, res) => {
  res.json({ token: issueCsrf(req, res) });
});

/* ---------- traveller auth ---------- */

const loginLimit = rateLimit({
  name: "trav-login",
  limit: config.env === "production" ? 10 : 100,
  windowSec: 15 * 60,
});

publicRouter.post("/auth/register", csrfProtect, loginLimit, async (req, res, next) => {
  try {
    const body = z.object({
      email: z.string().email().max(255),
      name: z.string().min(2).max(120),
      password: z.string().min(10).max(200),
    }).strict().safeParse(req.body ?? {});
    if (!body.success) throw zodError(body.error);
    const user = await registerTraveller(body.data.email, body.data.password, body.data.name);
    await createSession(res, user, req);
    res.status(201).json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) { next(err); }
});

publicRouter.post("/auth/login", csrfProtect, loginLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    const user = await loginTraveller(email, password);
    await createSession(res, user, req);
    res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) { next(err); }
});

publicRouter.post("/auth/logout", csrfProtect, async (req, res, next) => {
  try {
    await destroySession(req, res);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

publicRouter.get("/me", async (req, res) => {
  if (!req.user) return res.status(401).json({ type: "about:blank", title: "Authentication required", status: 401 });
  res.json({ user: req.user });
});

publicRouter.get("/my-inquiries", async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ type: "about:blank", title: "Authentication required", status: 401 });
    const db = await getDb();
    const items = await db.collection("inquiries").aggregate([
      { $match: { user_id: req.user.id } },
      { $lookup: { from: "tours", localField: "tour_id", foreignField: "id", as: "tour" } },
      { $unwind: { path: "$tour", preserveNullAndEmptyArrays: true } },
      { $sort: { created_at: -1 } },
      { $project: { id: 1, reference: 1, tour_id: 1, departure_id: 1, name: 1, email: 1, phone_e164: 1, travellers: 1, preferred_date: 1, status: 1, created_at: 1, updated_at: 1, tour_title: "$tour.title", tour_slug: "$tour.slug" } },
    ]).toArray();
    res.json({ items });
  } catch (err) { next(err); }
});

/* ---------- tours & catalog ---------- */

const listQuery = z.object({
  category: z.string().max(80).optional(),
  region: z.string().max(80).optional(),
  difficulty: z.enum(["easy", "moderate", "challenging", "strenuous", "extreme"]).optional(),
  sort: z.enum(["relevance", "price_asc", "price_desc", "duration", "rating"]).default("relevance"),
  page: z.coerce.number().int().min(1).default(1),
  per: z.coerce.number().int().min(1).max(50).default(12),
});

publicRouter.get("/tours", async (req, res, next) => {
  try {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) throw zodError(parsed.error);
    const q = parsed.data;

    const db = await getDb();
    const filter = { is_published: true, deleted_at: null };
    if (q.region) filter.region = q.region;
    if (q.difficulty) filter.difficulty = q.difficulty;

    // If filtering by category, resolve category slug to id first
    let categoryId = null;
    if (q.category) {
      const cat = await db.collection("categories").findOne({ slug: q.category });
      if (!cat) return res.json({ items: [], page: q.page, per: q.per, total: 0 });
      categoryId = cat.id;
      filter.category_ids = categoryId;
    }

    const sortMap = {
      relevance: ["is_featured", -1],
      price_asc: ["from_price_inr", 1],
      price_desc: ["from_price_inr", -1],
      duration: ["duration_days", 1],
      rating: ["rating_avg", -1],
    };
    const [sortCol, sortDir] = sortMap[q.sort];
    const sortObj = { [sortCol]: sortDir, id: 1 };

    const total = await db.collection("tours").countDocuments(filter);
    const rows = await db.collection("tours")
      .find(filter)
      .project({ slug: 1, title: 1, region: 1, difficulty: 1, duration_days: 1, from_price_inr: 1, rating_avg: 1, rating_count: 1, hero_image_path: 1, is_featured: 1 })
      .sort(sortObj)
      .skip((q.page - 1) * q.per)
      .limit(q.per)
      .toArray();

    res.json({ items: rows, page: q.page, per: q.per, total });
  } catch (err) { next(err); }
});

publicRouter.get("/tours/:slug", async (req, res, next) => {
  try {
    const db = await getDb();
    const tour = await db.collection("tours").findOne({
      slug: req.params.slug,
      is_published: true,
      deleted_at: null,
    });
    if (!tour) return res.status(404).json({ type: "about:blank", title: "Tour not found", status: 404 });

    const [departures, reviews] = await Promise.all([
      db.collection("departures").find({
        tour_id: tour.id,
        status: { $ne: "cancelled" },
        start_date: { $gte: new Date().toISOString().slice(0, 10) },
      }).sort({ start_date: 1 })
        .project({ id: 1, start_date: 1, end_date: 1, capacity: 1, confirmed_count: 1, price_inr: 1, status: 1 })
        .toArray(),
      db.collection("reviews").find({
        tour_id: tour.id,
        status: "approved",
      }).sort({ created_at: -1 }).limit(10)
        .project({ author_name: 1, rating: 1, title: 1, body_md: 1, reply_body_md: 1, created_at: 1 })
        .toArray(),
    ]);

    // Images are embedded in the tour document
    const images = tour.images || [];

    res.json({
      ...tour,
      images: undefined,
      itinerary: tour.itinerary || [],
      inclusions: tour.inclusions || [],
      exclusions: tour.exclusions || [],
      faq: tour.faq || null,
      departures: departures.map(d => ({
        ...d,
        availability: d.status === "sold_out" || d.confirmed_count >= d.capacity
          ? "sold_out"
          : d.confirmed_count / d.capacity >= 0.7 ? "filling_fast" : "available",
      })),
      images, reviews,
    });
  } catch (err) { next(err); }
});

publicRouter.get("/categories", async (_req, res, next) => {
  try {
    const db = await getDb();
    res.json({ items: await db.collection("categories").find().sort({ kind: 1, name: 1 }).toArray() });
  } catch (err) { next(err); }
});

publicRouter.get("/deals", async (_req, res, next) => {
  try {
    const db = await getDb();
    const now = new Date();
    const items = await db.collection("deals").find({
      active_from: { $lte: now },
      active_to: { $gte: now },
    }).sort({ sort_order: 1 }).toArray();
    res.json({ items });
  } catch (err) { next(err); }
});

// POST /inquiries — csrf + moderate limits (10/hr + 50/day per IP)
publicRouter.post(
  "/inquiries",
  csrfProtect,
  rateLimit({ name: "inq-h", limit: 10, windowSec: 3600 }),
  rateLimit({ name: "inq-d", limit: 50, windowSec: 86400 }),
  async (req, res, next) => {
    try {
      const result = await createInquiry(req, req.body ?? {});
      res.status(201).json(result);
    } catch (err) { next(err); }
  }
);
