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

// POST /inquiries — csrf + tight limits (5/hr + 30/day per IP)
publicRouter.post(
  "/inquiries",
  csrfProtect,
  rateLimit({ name: "inq-h", limit: 5, windowSec: 3600 }),
  rateLimit({ name: "inq-d", limit: 30, windowSec: 86400 }),
  async (req, res, next) => {
    try {
      const result = await createInquiry(req, req.body ?? {});
      res.status(201).json(result);
    } catch (err) { next(err); }
  }
);
import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
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
    const items = await db("inquiry")
      .join("tour", "tour.id", "inquiry.tour_id")
      .where("inquiry.user_id", req.user.id)
      .orderBy("inquiry.created_at", "desc")
      .select("inquiry.*", "tour.title as tour_title", "tour.slug as tour_slug");
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

    let query = db("tour").where({ is_published: true }).whereNull("deleted_at");
    if (q.region) query = query.where("region", q.region);
    if (q.difficulty) query = query.where("difficulty", q.difficulty);
    if (q.category) {
      query = query.whereIn("id", db("tour_category")
        .select("tour_id")
        .join("category", "category.id", "tour_category.category_id")
        .where("category.slug", q.category));
    }
    const sortMap = {
      relevance: ["is_featured", "desc"],
      price_asc: ["from_price_inr", "asc"],
      price_desc: ["from_price_inr", "desc"],
      duration: ["duration_days", "asc"],
      rating: ["rating_avg", "desc"],
    };
    const [col, dir] = sortMap[q.sort];
    const rows = await query.clone()
      .orderBy(col, dir).orderBy("id", "asc")
      .limit(q.per).offset((q.page - 1) * q.per)
      .select("slug", "title", "region", "difficulty", "duration_days",
        "from_price_inr", "rating_avg", "rating_count", "hero_image_path", "is_featured");
    const [{ c }] = await query.clone().count({ c: "*" });
    res.json({ items: rows, page: q.page, per: q.per, total: Number(c) });
  } catch (err) { next(err); }
});

publicRouter.get("/tours/:slug", async (req, res, next) => {
  try {
    const tour = await db("tour")
      .where({ slug: req.params.slug, is_published: true })
      .whereNull("deleted_at").first();
    if (!tour) return res.status(404).json({ type: "about:blank", title: "Tour not found", status: 404 });

    const [departures, images, reviews] = await Promise.all([
      db("departure").where({ tour_id: tour.id }).whereNot({ status: "cancelled" })
        .where("start_date", ">=", new Date().toISOString().slice(0, 10))
        .orderBy("start_date", "asc")
        .select("id", "start_date", "end_date", "capacity", "confirmed_count", "price_inr", "status"),
      db("tour_image").where({ tour_id: tour.id }).orderBy("sort_order").select("path", "alt"),
      db("review").where({ tour_id: tour.id, status: "approved" })
        .orderBy("created_at", "desc").limit(10)
        .select("author_name", "rating", "title", "body_md", "reply_body_md", "created_at"),
    ]);

    res.json({
      ...tour,
      itinerary: JSON.parse(tour.itinerary_json || "[]"),
      inclusions: JSON.parse(tour.inclusions_json || "[]"),
      exclusions: JSON.parse(tour.exclusions_json || "[]"),
      faq: JSON.parse(tour.faq_json || "null"),
      itinerary_json: undefined, inclusions_json: undefined,
      exclusions_json: undefined, faq_json: undefined,
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
    res.json({ items: await db("category").orderBy("kind").orderBy("name") });
  } catch (err) { next(err); }
});

publicRouter.get("/deals", async (_req, res, next) => {
  try {
    const now = new Date();
    const items = await db("deal")
      .where("active_from", "<=", now).andWhere("active_to", ">=", now)
      .orderBy("sort_order");
    res.json({ items });
  } catch (err) { next(err); }
});

// POST /inquiries — csrf + tight limits (Security doc §11: 5/hr + 30/day per IP)
publicRouter.post(
  "/inquiries",
  csrfProtect,
  rateLimit({ name: "inq-h", limit: 5, windowSec: 3600 }),
  rateLimit({ name: "inq-d", limit: 30, windowSec: 86400 }),
  async (req, res, next) => {
    try {
      const result = await createInquiry(req, req.body ?? {});
      res.status(201).json(result);
    } catch (err) { next(err); }
  }
);
