import { Router } from "express";
import { z } from "zod";
import { getDb, nextId } from "../lib/db.js";
import { csrfProtect } from "../middleware/csrf.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireStaff, requireRole, createSession, destroySession, rotateSession } from "../middleware/auth.js";
import { audit, zodError } from "../middleware/common.js";
import { passwordStep, mfaStep, beginEnrol, confirmEnrol } from "../services/authService.js";
import { hashPassword } from "../lib/hashing.js";
import { config } from "../config/index.js";
import { getSettings, updateSettings, getSmtpSettings } from "../lib/settings.js";
import { sendMail } from "../lib/mailer.js";
import { sendSmsText } from "../lib/sms.js";
import { sendWhatsAppText, inquiryStatusMessage } from "../lib/whatsapp.js";
import { logger } from "../lib/logger.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const adminRouter = Router();

const INQUIRY_STATUSES = ["new", "contacted", "quote_sent", "confirmed", "completed", "cancelled", "lost"];
const STAFF_ROLES = ["ops", "content", "analyst", "superadmin"];
const USER_ROLES = ["traveller", ...STAFF_ROLES];
const DIFFICULTIES = ["easy", "moderate", "challenging", "strenuous", "extreme"];
const loginLimit = rateLimit({ name: "adm-login", limit: config.env === "production" ? 10 : 1000, windowSec: 15 * 60 });

function mask(email = "") { const [u, d] = email.split("@"); return `${(u || "").slice(0, 2)}***@${d || ""}`; }
function maskPhone(p = "") { return p.slice(0, 4) + "*".repeat(Math.max(p.length - 6, 0)) + p.slice(-2); }

function tourPatch(data) {
  const patch = { updated_at: new Date() };
  for (const key of ["slug", "title", "region", "difficulty", "duration_days", "from_price_inr", "min_age", "description_md", "hero_image_path", "meta_title", "meta_description", "is_published", "is_featured"]) {
    if (Object.prototype.hasOwnProperty.call(data, key)) patch[key] = data[key] ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(data, "itinerary")) patch.itinerary = data.itinerary ?? [];
  if (Object.prototype.hasOwnProperty.call(data, "inclusions")) patch.inclusions = data.inclusions ?? [];
  if (Object.prototype.hasOwnProperty.call(data, "exclusions")) patch.exclusions = data.exclusions ?? [];
  return patch;
}

async function writeEmailLog({ recipient, template, status, inquiryId = null, payload = null, error = null, providerMessageId = null }) {
  const db = await getDb();
  await db.collection("notification_logs").insertOne({
    channel: "email", direction: "outbound", recipient, template, status,
    provider_message_id: providerMessageId, inquiry_id: inquiryId,
    payload_json: payload ? JSON.stringify(payload) : null,
    error: error ? String(error).slice(0, 2000) : null, created_at: new Date(),
  });
}
async function writeNotificationLog({ channel = "notification", recipient, template, status, inquiryId = null, payload = null, error = null }) {
  const db = await getDb();
  await db.collection("notification_logs").insertOne({
    channel, direction: "outbound", recipient, template, status,
    inquiry_id: inquiryId, payload_json: payload ? JSON.stringify(payload) : null,
    error: error ? String(error).slice(0, 2000) : null, created_at: new Date(),
  });
}

adminRouter.post("/auth/login", csrfProtect, loginLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};
    const result = await passwordStep(email, password);
    await audit(req, { action: "login.attempt", entityType: "user", entityId: result.user.id });
    if (result.enrolRequired) return res.json({ enrol_required: true, pending_token: result.pendingToken });
    if (result.mfaRequired) return res.json({ mfa_required: true, pending_token: result.pendingToken });
    await createSession(res, result.user, req);
    res.json({ ok: true, role: result.user.role, name: result.user.name });
  } catch (err) { next(err); }
});
adminRouter.post("/auth/mfa", csrfProtect, loginLimit, async (req, res, next) => {
  try { const user = await mfaStep(req.body?.pending_token, req.body?.code); await rotateSession(req, res, user); await audit(req, { action: "login.success", entityType: "user", entityId: user.id }); res.json({ ok: true, role: user.role, name: user.name }); } catch (err) { next(err); }
});
adminRouter.post("/auth/enrol/begin", csrfProtect, loginLimit, async (req, res, next) => {
  try { const { otpauthUrl, secret, confirmToken } = await beginEnrol(req.body?.pending_token); res.json({ otpauth_url: otpauthUrl, secret, confirm_token: confirmToken }); } catch (err) { next(err); }
});
adminRouter.post("/auth/enrol/confirm", csrfProtect, loginLimit, async (req, res, next) => {
  try { const user = await confirmEnrol(req.body?.confirm_token, req.body?.code); await rotateSession(req, res, user); await audit(req, { action: "mfa.enrolled", entityType: "user", entityId: user.id }); res.json({ ok: true, role: user.role, name: user.name }); } catch (err) { next(err); }
});
adminRouter.post("/auth/logout", csrfProtect, async (req, res, next) => { try { await destroySession(req, res); res.json({ ok: true }); } catch (err) { next(err); } });
adminRouter.get("/me", requireStaff, (req, res) => res.json({ user: req.user }));

adminRouter.get("/profile", requireStaff, async (req, res, next) => {
  try { const db = await getDb(); const user = await db.collection("users").findOne({ id: req.user.id }); if (!user) return res.status(404).json({ type: "about:blank", title: "Not found", status: 404 }); res.json({ id: user.id, email: user.email, name: user.name, role: user.role, phone_e164: user.phone_e164, mfa_enabled: user.mfa_enabled, created_at: user.created_at }); } catch (err) { next(err); }
});
adminRouter.patch("/profile", requireStaff, csrfProtect, async (req, res, next) => {
  try { const body = z.object({ name: z.string().min(2).max(120).optional(), phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable().optional() }).strict().safeParse(req.body ?? {}); if (!body.success) throw zodError(body.error); const db = await getDb(); await db.collection("users").updateOne({ id: req.user.id }, { $set: { ...body.data, updated_at: new Date() } }); await audit(req, { action: "update.profile", entityType: "user", entityId: req.user.id }); res.json({ ok: true }); } catch (err) { next(err); }
});
adminRouter.patch("/profile/password", requireStaff, csrfProtect, async (req, res, next) => {
  try {
    const body = z.object({ current_password: z.string().min(1), new_password: z.string().min(10).max(200) }).strict().safeParse(req.body ?? {});
    if (!body.success) throw zodError(body.error);
    const db = await getDb();
    const user = await db.collection("users").findOne({ id: req.user.id });
    const { verifyPassword } = await import("../lib/hashing.js");
    if (!(await verifyPassword(body.data.current_password, user.password_hash))) throw Object.assign(new Error("Current password is incorrect"), { status: 401 });
    await db.collection("users").updateOne({ id: req.user.id }, { $set: { password_hash: await hashPassword(body.data.new_password), updated_at: new Date() } });
    await audit(req, { action: "update.password", entityType: "user", entityId: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

adminRouter.post("/upload", requireStaff, csrfProtect, async (req, res, next) => {
  try {
    const body = z.object({ file: z.string().min(1), folder: z.enum(["logos", "tours", "deals"]).default("logos") }).strict().safeParse(req.body ?? {});
    if (!body.success) throw zodError(body.error);
    const match = body.data.file.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
    if (!match) throw Object.assign(new Error("Invalid image format. Use PNG, JPG, or WEBP."), { status: 422 });
    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 2 * 1024 * 1024) throw Object.assign(new Error("File too large. Max 2MB."), { status: 413 });
    const uploadDir = path.join(process.cwd(), "public", "uploads", body.data.folder);
    fs.mkdirSync(uploadDir, { recursive: true });
    const filename = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, filename), buffer);
    res.json({ url: `/uploads/${body.data.folder}/${filename}` });
  } catch (err) { next(err); }
});

adminRouter.get("/settings", requireRole("superadmin"), async (_req, res, next) => {
  try {
    const settings = await getSettings();
    res.json({ ...settings, whatsapp_access_token: settings.whatsapp_access_token ? "********" : "", whatsapp_access_token_configured: !!settings.whatsapp_access_token, smtp_pass: settings.smtp_pass ? "********" : "", smtp_pass_configured: !!settings.smtp_pass, sms_api_key: settings.sms_api_key ? "********" : "", sms_api_key_configured: !!settings.sms_api_key });
  } catch (err) { next(err); }
});
adminRouter.patch("/settings", requireRole("superadmin"), csrfProtect, async (req, res, next) => {
  try {
    const body = z.object({ brand_name: z.string().min(2).max(120).optional(), brand_logo_url: z.string().max(1000).optional(), whatsapp_enabled: z.boolean().optional(), whatsapp_phone_number_id: z.string().max(120).optional(), whatsapp_access_token: z.string().max(1000).optional(), whatsapp_ops_number: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(), whatsapp_notify_customer: z.boolean().optional(), smtp_host: z.string().max(255).optional(), smtp_port: z.coerce.number().int().min(1).max(65535).optional(), smtp_user: z.string().max(255).optional(), smtp_pass: z.string().max(500).optional(), smtp_from: z.string().max(255).optional(), smtp_ops: z.string().max(255).optional(), smtp_secure: z.boolean().optional(), sms_enabled: z.boolean().optional(), sms_provider: z.string().max(80).optional(), sms_api_url: z.string().max(1000).optional(), sms_api_key: z.string().max(1000).optional(), sms_sender_id: z.string().max(40).optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) throw zodError(body.error);
    const before = await getSettings();
    const patch = {};
    for (const [key, value] of Object.entries(body.data)) {
      if (["whatsapp_access_token", "smtp_pass", "sms_api_key"].includes(key) && value === "********") continue;
      patch[key] = typeof value === "boolean" ? (value ? "1" : "0") : value;
    }
    const after = await updateSettings(patch, req.user.id);
    await audit(req, { action: "update.settings", entityType: "app_setting", before: { ...before, whatsapp_access_token: before.whatsapp_access_token ? "[set]" : "", smtp_pass: before.smtp_pass ? "[set]" : "", sms_api_key: before.sms_api_key ? "[set]" : "" }, after: { ...after, whatsapp_access_token: after.whatsapp_access_token ? "[set]" : "", smtp_pass: after.smtp_pass ? "[set]" : "", sms_api_key: after.sms_api_key ? "[set]" : "" } });
    res.json({ ...after, whatsapp_access_token: after.whatsapp_access_token ? "********" : "", whatsapp_access_token_configured: !!after.whatsapp_access_token, smtp_pass: after.smtp_pass ? "********" : "", smtp_pass_configured: !!after.smtp_pass, sms_api_key: after.sms_api_key ? "********" : "", sms_api_key_configured: !!after.sms_api_key });
  } catch (err) { next(err); }
});
adminRouter.get("/notifications", requireStaff, async (_req, res, next) => { try { const db = await getDb(); res.json({ items: await db.collection("notification_logs").find().sort({ created_at: -1 }).limit(100).toArray() }); } catch (err) { next(err); } });

adminRouter.get("/inquiries", requireStaff, async (req, res, next) => {
  try {
    const q = z.object({ status: z.enum(INQUIRY_STATUSES).optional(), tour_id: z.coerce.number().int().optional(), assigned: z.coerce.number().int().optional(), booked: z.enum(["1", "true"]).optional(), page: z.coerce.number().int().min(1).default(1), per: z.coerce.number().int().min(1).max(100).default(25) }).safeParse(req.query);
    if (!q.success) throw zodError(q.error);
    const p = q.data;
    const db = await getDb();

    const match = {};
    if (p.status) match.status = p.status;
    if (p.booked) match.status = { $in: ["confirmed", "completed"] };
    if (p.tour_id) match.tour_id = p.tour_id;
    if (p.assigned) match.assigned_to = p.assigned;

    const pipeline = [
      { $match: match },
      { $lookup: { from: "tours", localField: "tour_id", foreignField: "id", as: "tour" } },
      { $unwind: { path: "$tour", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "departures", localField: "departure_id", foreignField: "id", as: "departure" } },
      { $unwind: { path: "$departure", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "users", localField: "user_id", foreignField: "id", as: "traveller" } },
      { $unwind: { path: "$traveller", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "users", localField: "assigned_to", foreignField: "id", as: "assignee" } },
      { $unwind: { path: "$assignee", preserveNullAndEmptyArrays: true } },
      { $sort: { created_at: -1 } },
      { $skip: (p.page - 1) * p.per },
      { $limit: p.per },
      { $project: {
        id: 1, reference: 1, tour_id: 1, departure_id: 1, user_id: 1, name: 1, email: 1,
        phone_e164: 1, travellers: 1, preferred_date: 1, pickup_city: 1, message: 1,
        source: 1, status: 1, assigned_to: 1, ip_hash: 1, ua: 1, consent_snapshot: 1,
        created_at: 1, updated_at: 1,
        tour_title: "$tour.title", tour_slug: "$tour.slug",
        departure_start: "$departure.start_date", departure_end: "$departure.end_date",
        departure_status: "$departure.status",
        account_name: "$traveller.name", account_email: "$traveller.email",
        assigned_name: "$assignee.name",
      }},
    ];

    const rows = await db.collection("inquiries").aggregate(pipeline).toArray();

    const countPipeline = [
      { $match: match },
      { $count: "total" },
    ];
    const countResult = await db.collection("inquiries").aggregate(countPipeline).toArray();
    const total = countResult.length > 0 ? countResult[0].total : 0;

    const items = req.user.role === "analyst" ? rows.map(r => ({ ...r, email: mask(r.email), phone_e164: maskPhone(r.phone_e164) })) : rows;
    res.json({ items, page: p.page, per: p.per, total });
  } catch (err) { next(err); }
});
adminRouter.get("/inquiries/:id", requireStaff, async (req, res, next) => {
  try {
    const db = await getDb();
    const inq = await db.collection("inquiries").aggregate([
      { $match: { id: Number(req.params.id) } },
      { $lookup: { from: "tours", localField: "tour_id", foreignField: "id", as: "tour" } },
      { $unwind: { path: "$tour", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "departures", localField: "departure_id", foreignField: "id", as: "departure" } },
      { $unwind: { path: "$departure", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "users", localField: "user_id", foreignField: "id", as: "traveller" } },
      { $unwind: { path: "$traveller", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "users", localField: "assigned_to", foreignField: "id", as: "assignee" } },
      { $unwind: { path: "$assignee", preserveNullAndEmptyArrays: true } },
      { $project: {
        id: 1, reference: 1, tour_id: 1, departure_id: 1, user_id: 1, name: 1, email: 1,
        phone_e164: 1, travellers: 1, preferred_date: 1, pickup_city: 1, message: 1,
        source: 1, status: 1, assigned_to: 1, ip_hash: 1, ua: 1, consent_snapshot: 1,
        created_at: 1, updated_at: 1, messages: 1,
        tour_title: "$tour.title", tour_slug: "$tour.slug",
        departure_start: "$departure.start_date", departure_end: "$departure.end_date",
        departure_status: "$departure.status",
        account_name: "$traveller.name", account_email: "$traveller.email",
        assigned_name: "$assignee.name",
      }},
    ]).toArray();
    if (!inq.length) return res.status(404).json({ type: "about:blank", title: "Not found", status: 404 });
    // Messages are embedded; enrich with author names
    const msgIds = (inq[0].messages || []).map(m => m.author_id).filter(Boolean);
    const authors = msgIds.length ? await db.collection("users").find({ id: { $in: msgIds } }).project({ id: 1, name: 1 }).toArray() : [];
    const authorMap = Object.fromEntries(authors.map(a => [a.id, a.name]));
    const messages = (inq[0].messages || []).map(m => ({ ...m, author_name: authorMap[m.author_id] || null }));
    res.json({ ...inq[0], messages });
  } catch (err) { next(err); }
});
adminRouter.patch("/inquiries/:id", requireRole("ops", "superadmin"), csrfProtect, async (req, res, next) => {
  try {
    const body = z.object({ status: z.enum(INQUIRY_STATUSES).optional(), assigned_to: z.coerce.number().int().nullable().optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) throw zodError(body.error);
    const db = await getDb();
    const before = await db.collection("inquiries").findOne({ id: Number(req.params.id) });
    if (!before) return res.status(404).json({ type: "about:blank", title: "Not found", status: 404 });
    await db.collection("inquiries").updateOne({ id: before.id }, { $set: { ...body.data, updated_at: new Date() } });
    if (body.data.status === "confirmed" && before.status !== "confirmed" && before.departure_id) {
      await db.collection("departures").updateOne({ id: before.departure_id }, { $inc: { confirmed_count: before.travellers } });
      const dep = await db.collection("departures").findOne({ id: before.departure_id });
      if (dep.confirmed_count >= dep.capacity) await db.collection("departures").updateOne({ id: dep.id }, { $set: { status: "sold_out" } });
    }
    const after = await db.collection("inquiries").findOne({ id: before.id });
    if (body.data.status && body.data.status !== before.status) {
      const settings = await getSettings();
      sendWhatsAppText({ to: after.phone_e164, template: "customer_status_update", inquiryId: after.id, body: inquiryStatusMessage({ reference: after.reference, status: after.status, brandName: settings.brand_name }) }).catch((err) => logger.error({ err }, "whatsapp status update failed"));
    }
    await audit(req, { action: "update.inquiry", entityType: "inquiry", entityId: before.id, before: { status: before.status, assigned_to: before.assigned_to }, after: { status: after.status, assigned_to: after.assigned_to } });
    res.json(after);
  } catch (err) { next(err); }
});
adminRouter.post("/inquiries/:id/messages", requireRole("ops", "superadmin"), csrfProtect, async (req, res, next) => {
  try {
    const body = z.object({ visibility: z.enum(["internal", "customer"]), body_md: z.string().min(1).max(8000) }).strict().safeParse(req.body ?? {});
    if (!body.success) throw zodError(body.error);
    const db = await getDb();
    const inq = await db.collection("inquiries").findOne({ id: Number(req.params.id) });
    if (!inq) return res.status(404).json({ type: "about:blank", title: "Not found", status: 404 });
    const msgId = await nextId(db, "inquiry_message_ids");
    const msg = {
      id: msgId,
      inquiry_id: inq.id,
      author_id: req.user.id,
      visibility: body.data.visibility,
      body_md: body.data.body_md,
      attachment_path: null,
      created_at: new Date(),
    };
    await db.collection("inquiries").updateOne({ id: inq.id }, { $push: { messages: msg } });
    if (body.data.visibility === "customer") {
      const settings = await getSettings();
      sendWhatsAppText({ to: inq.phone_e164, template: "customer_message", inquiryId: inq.id, body: `${settings.brand_name} message for ${inq.reference}:\n${body.data.body_md}` }).catch((err) => logger.error({ err }, "whatsapp customer message failed"));
    }
    await audit(req, { action: "create.inquiry_message", entityType: "inquiry", entityId: inq.id });
    res.status(201).json(msg);
  } catch (err) { next(err); }
});

const tourSchema = z.object({ slug: z.string().min(3).max(160).regex(/^[a-z0-9-]+$/), title: z.string().min(3).max(200), region: z.string().min(2).max(80), difficulty: z.enum(DIFFICULTIES).nullable().optional(), duration_days: z.coerce.number().int().min(1).max(60), from_price_inr: z.coerce.number().min(0), min_age: z.coerce.number().int().min(0).max(99).nullable().optional(), description_md: z.string().max(50000).optional(), itinerary: z.array(z.object({ day: z.coerce.number().int(), title: z.string(), detail: z.string() })).default([]), inclusions: z.array(z.string()).default([]), exclusions: z.array(z.string()).default([]), hero_image_path: z.string().max(255).default(""), meta_title: z.string().max(180).optional(), meta_description: z.string().max(300).optional(), is_published: z.boolean().optional(), is_featured: z.boolean().optional() });
const tourUpdateSchema = tourSchema.partial();
adminRouter.get("/tours", requireStaff, async (_req, res, next) => { try { const db = await getDb(); res.json({ items: await db.collection("tours").find({ deleted_at: null }).sort({ updated_at: -1 }).toArray() }); } catch (err) { next(err); } });
adminRouter.get("/tours/:id", requireStaff, async (req, res, next) => {
  try { const db = await getDb(); const tour = await db.collection("tours").findOne({ id: Number(req.params.id), deleted_at: null }); if (!tour) return res.status(404).json({ type: "about:blank", title: "Tour not found", status: 404 }); const departures = await db.collection("departures").find({ tour_id: tour.id }).sort({ start_date: -1 }).toArray(); res.json({ ...tour, images: tour.images || [], departures }); } catch (err) { next(err); }
});
adminRouter.post("/tours", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => {
  try { const p = tourSchema.safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const db = await getDb(); const d = p.data; const id = await nextId(db, "tours"); await db.collection("tours").insertOne({ _id: id, id, ...tourPatch(d), created_by: req.user.id, created_at: new Date(), updated_at: new Date(), is_published: !!d.is_published, is_featured: !!d.is_featured, rating_avg: 0, rating_count: 0, images: [], deleted_at: null }); await audit(req, { action: "create.tour", entityType: "tour", entityId: id, after: { slug: d.slug } }); res.status(201).json(await db.collection("tours").findOne({ id })); } catch (err) { next(err); }
});
adminRouter.patch("/tours/:id", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => {
  try { const p = tourUpdateSchema.safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const db = await getDb(); const before = await db.collection("tours").findOne({ id: Number(req.params.id), deleted_at: null }); if (!before) return res.status(404).json({ type: "about:blank", title: "Tour not found", status: 404 }); await db.collection("tours").updateOne({ id: before.id }, { $set: tourPatch(p.data) }); const after = await db.collection("tours").findOne({ id: before.id }); await audit(req, { action: "update.tour", entityType: "tour", entityId: before.id, before: { slug: before.slug, title: before.title }, after: { slug: after.slug, title: after.title } }); res.json(after); } catch (err) { next(err); }
});
adminRouter.delete("/tours/:id", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { const db = await getDb(); await db.collection("tours").updateOne({ id: Number(req.params.id) }, { $set: { deleted_at: new Date(), updated_at: new Date(), is_published: false } }); await audit(req, { action: "delete.tour", entityType: "tour", entityId: Number(req.params.id) }); res.json({ ok: true }); } catch (err) { next(err); } });
adminRouter.post("/tours/:id/publish", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { const db = await getDb(); await db.collection("tours").updateOne({ id: Number(req.params.id) }, { $set: { is_published: true, updated_at: new Date() } }); await audit(req, { action: "publish.tour", entityType: "tour", entityId: Number(req.params.id) }); res.json({ ok: true }); } catch (err) { next(err); } });
adminRouter.post("/tours/:id/unpublish", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { const db = await getDb(); await db.collection("tours").updateOne({ id: Number(req.params.id) }, { $set: { is_published: false, updated_at: new Date() } }); await audit(req, { action: "unpublish.tour", entityType: "tour", entityId: Number(req.params.id) }); res.json({ ok: true }); } catch (err) { next(err); } });
const imageSchema = z.object({ path: z.string().min(1).max(255), alt: z.string().max(200).nullable().optional(), sort_order: z.coerce.number().int().min(0).max(999).default(0) });
adminRouter.get("/tours/:id/images", requireStaff, async (req, res, next) => { try { const db = await getDb(); const tour = await db.collection("tours").findOne({ id: Number(req.params.id) }); res.json({ items: (tour?.images || []).sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id)) }); } catch (err) { next(err); } });
adminRouter.post("/tours/:id/images", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { const p = imageSchema.safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const db = await getDb(); const imgId = await nextId(db, "tour_image_ids"); const img = { id: imgId, ...p.data, tour_id: Number(req.params.id) }; await db.collection("tours").updateOne({ id: Number(req.params.id) }, { $push: { images: img } }); await audit(req, { action: "create.tour_image", entityType: "tour", entityId: Number(req.params.id), after: { image_id: imgId } }); res.status(201).json(img); } catch (err) { next(err); } });
adminRouter.patch("/tour-images/:id", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { const p = imageSchema.partial().safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const db = await getDb(); const tour = await db.collection("tours").findOne({ "images.id": Number(req.params.id) }); if (!tour) return res.status(404).json({ type: "about:blank", title: "Image not found", status: 404 }); await db.collection("tours").updateOne({ "images.id": Number(req.params.id) }, { $set: Object.fromEntries(Object.entries(p.data).map(([k, v]) => [`images.$.${k}`, v])) }); await audit(req, { action: "update.tour_image", entityType: "tour", entityId: tour.id }); const updated = await db.collection("tours").findOne({ id: tour.id }); const img = (updated.images || []).find(i => i.id === Number(req.params.id)); res.json(img); } catch (err) { next(err); } });
adminRouter.delete("/tour-images/:id", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { const db = await getDb(); const tour = await db.collection("tours").findOne({ "images.id": Number(req.params.id) }); if (!tour) return res.status(404).json({ type: "about:blank", title: "Image not found", status: 404 }); await db.collection("tours").updateOne({ id: tour.id }, { $pull: { images: { id: Number(req.params.id) } } }); await audit(req, { action: "delete.tour_image", entityType: "tour", entityId: tour.id }); res.json({ ok: true }); } catch (err) { next(err); } });

adminRouter.post("/departures", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => {
  try { const p = z.object({ tour_id: z.coerce.number().int(), items: z.array(z.object({ start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), capacity: z.coerce.number().int().min(1).max(500), price_inr: z.coerce.number().min(0) })).min(1).max(60) }).safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const db = await getDb(); const rows = []; for (const item of p.data.items) { const id = await nextId(db, "departures"); rows.push({ _id: id, id, tour_id: p.data.tour_id, ...item, confirmed_count: 0, status: "scheduled", notes_internal: null }); } if (rows.length) await db.collection("departures").insertMany(rows); await audit(req, { action: "create.departures", entityType: "tour", entityId: p.data.tour_id, after: { count: rows.length } }); res.status(201).json({ created: rows.length }); } catch (err) { next(err); }
});

adminRouter.post("/communications/send", requireRole("ops", "superadmin"), csrfProtect, async (req, res, next) => {
  try {
    const body = z.object({ channel: z.enum(["email", "whatsapp", "sms", "notification"]), inquiry_id: z.coerce.number().int().optional(), user_id: z.coerce.number().int().optional(), recipient: z.string().max(255).optional(), subject: z.string().max(180).optional(), body: z.string().min(1).max(4000), reminder_label: z.string().max(80).optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) throw zodError(body.error);
    const p = body.data;
    const db = await getDb();
    const inquiry = p.inquiry_id ? await db.collection("inquiries").findOne({ id: p.inquiry_id }) : null;
    const user = p.user_id ? await db.collection("users").findOne({ id: p.user_id }) : null;
    const recipient = p.recipient || (p.channel === "email" ? inquiry?.email || user?.email : inquiry?.phone_e164 || user?.phone_e164);
    if (!recipient) throw Object.assign(new Error("Recipient is required for this channel"), { status: 422 });
    const template = p.reminder_label ? `reminder:${p.reminder_label}` : "admin_message";
    let result;
    if (p.channel === "email") {
      try { const info = await sendMail({ to: recipient, subject: p.subject || "Trek On India update", text: p.body }); const smtp = await getSmtpSettings(); result = { status: smtp.host ? "sent" : "dev_logged", providerMessageId: info.messageId || null }; await writeEmailLog({ recipient, template, status: result.status, inquiryId: inquiry?.id ?? null, payload: { subject: p.subject || "Trek On India update", body: p.body }, providerMessageId: result.providerMessageId }); }
      catch (err) { await writeEmailLog({ recipient, template, status: "failed", inquiryId: inquiry?.id ?? null, payload: { subject: p.subject, body: p.body }, error: err.message }); throw err; }
    } else if (p.channel === "whatsapp") result = await sendWhatsAppText({ to: recipient, body: p.body, template, inquiryId: inquiry?.id ?? null });
    else if (p.channel === "sms") result = await sendSmsText({ to: recipient, body: p.body, template, inquiryId: inquiry?.id ?? null });
    else { await writeNotificationLog({ recipient, template, status: "dev_logged", inquiryId: inquiry?.id ?? null, payload: { body: p.body } }); result = { status: "dev_logged" }; }
    if (inquiry) {
      const msgId = await nextId(db, "inquiry_message_ids");
      await db.collection("inquiries").updateOne({ id: inquiry.id }, { $push: { messages: { id: msgId, inquiry_id: inquiry.id, author_id: req.user.id, visibility: "customer", body_md: `[${p.channel}] ${p.body}`, created_at: new Date() } } });
    }
    await audit(req, { action: "send.communication", entityType: inquiry ? "inquiry" : "user", entityId: inquiry?.id ?? user?.id ?? null, after: { channel: p.channel, recipient, status: result.status } });
    res.json({ ok: true, channel: p.channel, recipient, ...result });
  } catch (err) { next(err); }
});

adminRouter.get("/reviews", requireStaff, async (req, res, next) => { try { const db = await getDb(); const status = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : "pending"; res.json({ items: await db.collection("reviews").find({ status }).sort({ created_at: -1 }).limit(100).toArray() }); } catch (err) { next(err); } });
adminRouter.post("/reviews/:id/approve", requireRole("content", "ops", "superadmin"), csrfProtect, async (req, res, next) => {
  try { const db = await getDb(); const r = await db.collection("reviews").findOne({ id: Number(req.params.id) }); if (!r) return res.status(404).json({ type: "about:blank", title: "Not found", status: 404 }); await db.collection("reviews").updateOne({ id: r.id }, { $set: { status: "approved", moderator_id: req.user.id, updated_at: new Date() } }); const agg = await db.collection("reviews").aggregate([{ $match: { tour_id: r.tour_id, status: "approved" } }, { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } }]).toArray(); const a = agg[0] || { avg: 0, count: 0 }; await db.collection("tours").updateOne({ id: r.tour_id }, { $set: { rating_avg: Number(a.avg || 0).toFixed(2), rating_count: a.count } }); await audit(req, { action: "approve.review", entityType: "review", entityId: r.id }); res.json({ ok: true }); } catch (err) { next(err); }
});
adminRouter.post("/reviews/:id/reject", requireRole("content", "ops", "superadmin"), csrfProtect, async (req, res, next) => { try { const db = await getDb(); const note = String(req.body?.reason || "").slice(0, 500); await db.collection("reviews").updateOne({ id: Number(req.params.id) }, { $set: { status: "rejected", moderator_id: req.user.id, moderator_note: note, updated_at: new Date() } }); await audit(req, { action: "reject.review", entityType: "review", entityId: Number(req.params.id) }); res.json({ ok: true }); } catch (err) { next(err); } });

adminRouter.get("/users", requireRole("superadmin"), async (req, res, next) => {
  try { const db = await getDb(); const role = ["staff", "traveller", "all"].includes(req.query.role) ? req.query.role : "staff"; const filter = { deleted_at: null }; if (role === "staff") filter.role = { $in: STAFF_ROLES }; if (role === "traveller") filter.role = "traveller"; const items = await db.collection("users").find(filter).sort({ created_at: -1 }).project({ id: 1, email: 1, name: 1, phone_e164: 1, role: 1, mfa_enabled: 1, consent_marketing: 1, created_at: 1 }).toArray(); res.json({ items }); } catch (err) { next(err); }
});
adminRouter.post("/users", requireRole("superadmin"), csrfProtect, async (req, res, next) => {
  try { const p = z.object({ email: z.string().email(), name: z.string().min(2).max(120), role: z.enum(STAFF_ROLES), password: z.string().min(10).max(200) }).safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const db = await getDb(); const id = await nextId(db, "users"); await db.collection("users").insertOne({ _id: id, id, email: p.data.email.toLowerCase(), name: p.data.name, role: p.data.role, password_hash: await hashPassword(p.data.password), failed_logins: 0, locked_until: null, mfa_enabled: false, mfa_secret_enc: null, consent_marketing: false, created_at: new Date(), updated_at: new Date(), deleted_at: null }); await audit(req, { action: "create.user", entityType: "user", entityId: id, after: { role: p.data.role } }); res.status(201).json({ id, email: p.data.email, role: p.data.role }); } catch (err) { next(err); }
});
adminRouter.patch("/users/:id", requireRole("superadmin"), csrfProtect, async (req, res, next) => {
  try { const p = z.object({ name: z.string().min(2).max(120).optional(), email: z.string().email().optional(), phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable().optional(), role: z.enum(USER_ROLES).optional(), consent_marketing: z.boolean().optional(), password: z.string().min(10).max(200).optional() }).strict().safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const db = await getDb(); const before = await db.collection("users").findOne({ id: Number(req.params.id) }); if (!before) return res.status(404).json({ type: "about:blank", title: "User not found", status: 404 }); const patch = { ...p.data, updated_at: new Date() }; if (patch.email) patch.email = patch.email.toLowerCase(); if (patch.password) { patch.password_hash = await hashPassword(patch.password); delete patch.password; } await db.collection("users").updateOne({ id: before.id }, { $set: patch }); const after = await db.collection("users").findOne({ id: before.id }); await audit(req, { action: "update.user", entityType: "user", entityId: before.id, before: { email: before.email, role: before.role }, after: { email: after.email, role: after.role } }); res.json({ id: after.id, email: after.email, name: after.name, phone_e164: after.phone_e164, role: after.role, consent_marketing: after.consent_marketing }); } catch (err) { next(err); }
});
adminRouter.delete("/users/:id", requireRole("superadmin"), csrfProtect, async (req, res, next) => { try { if (Number(req.params.id) === Number(req.user.id)) throw Object.assign(new Error("You cannot disable your own account"), { status: 422 }); const db = await getDb(); await db.collection("users").updateOne({ id: Number(req.params.id) }, { $set: { deleted_at: new Date(), updated_at: new Date() } }); await db.collection("sessions").updateMany({ user_id: Number(req.params.id) }, { $set: { revoked_at: new Date() } }); await audit(req, { action: "delete.user", entityType: "user", entityId: Number(req.params.id) }); res.json({ ok: true }); } catch (err) { next(err); } });
adminRouter.get("/booking-contacts", requireStaff, async (_req, res, next) => { try { const db = await getDb(); const items = await db.collection("inquiries").aggregate([{ $lookup: { from: "tours", localField: "tour_id", foreignField: "id", as: "tour" } }, { $unwind: { path: "$tour", preserveNullAndEmptyArrays: true } }, { $lookup: { from: "departures", localField: "departure_id", foreignField: "id", as: "departure" } }, { $unwind: { path: "$departure", preserveNullAndEmptyArrays: true } }, { $sort: { created_at: -1 } }, { $limit: 200 }, { $project: { id: 1, reference: 1, name: 1, email: 1, phone_e164: 1, travellers: 1, status: 1, created_at: 1, tour_title: "$tour.title", departure_start: "$departure.start_date", departure_end: "$departure.end_date" } }]).toArray(); res.json({ items }); } catch (err) { next(err); } });
adminRouter.get("/audit", requireRole("superadmin"), async (_req, res, next) => { try { const db = await getDb(); res.json({ items: await db.collection("audit_entries").find().sort({ id: -1 }).limit(200).toArray() }); } catch (err) { next(err); } });
