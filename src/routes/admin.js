import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
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
function jsonArray(value) { if (Array.isArray(value)) return value; try { return JSON.parse(value || "[]"); } catch { return []; } }
function tourResponse(tour) {
  if (!tour) return tour;
  return { ...tour, itinerary: jsonArray(tour.itinerary_json), inclusions: jsonArray(tour.inclusions_json), exclusions: jsonArray(tour.exclusions_json), itinerary_json: undefined, inclusions_json: undefined, exclusions_json: undefined };
}
function tourPatch(data) {
  const patch = { updated_at: new Date() };
  for (const key of ["slug", "title", "region", "difficulty", "duration_days", "from_price_inr", "min_age", "description_md", "hero_image_path", "meta_title", "meta_description", "is_published", "is_featured"]) {
    if (Object.prototype.hasOwnProperty.call(data, key)) patch[key] = data[key] ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(data, "itinerary")) patch.itinerary_json = JSON.stringify(data.itinerary ?? []);
  if (Object.prototype.hasOwnProperty.call(data, "inclusions")) patch.inclusions_json = JSON.stringify(data.inclusions ?? []);
  if (Object.prototype.hasOwnProperty.call(data, "exclusions")) patch.exclusions_json = JSON.stringify(data.exclusions ?? []);
  return patch;
}
async function writeEmailLog({ recipient, template, status, inquiryId = null, payload = null, error = null, providerMessageId = null }) {
  await db("notification_log").insert({ channel: "email", direction: "outbound", recipient, template, status, provider_message_id: providerMessageId, inquiry_id: inquiryId, payload_json: payload ? JSON.stringify(payload) : null, error: error ? String(error).slice(0, 2000) : null });
}
async function writeNotificationLog({ channel = "notification", recipient, template, status, inquiryId = null, payload = null, error = null }) {
  await db("notification_log").insert({ channel, direction: "outbound", recipient, template, status, inquiry_id: inquiryId, payload_json: payload ? JSON.stringify(payload) : null, error: error ? String(error).slice(0, 2000) : null });
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
  try { const user = await db("user").where({ id: req.user.id }).first(); if (!user) return res.status(404).json({ type: "about:blank", title: "Not found", status: 404 }); res.json({ id: user.id, email: user.email, name: user.name, role: user.role, phone_e164: user.phone_e164, mfa_enabled: user.mfa_enabled, created_at: user.created_at }); } catch (err) { next(err); }
});
adminRouter.patch("/profile", requireStaff, csrfProtect, async (req, res, next) => {
  try { const body = z.object({ name: z.string().min(2).max(120).optional(), phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable().optional() }).strict().safeParse(req.body ?? {}); if (!body.success) throw zodError(body.error); await db("user").where({ id: req.user.id }).update({ ...body.data, updated_at: new Date() }); await audit(req, { action: "update.profile", entityType: "user", entityId: req.user.id }); res.json({ ok: true }); } catch (err) { next(err); }
});
adminRouter.patch("/profile/password", requireStaff, csrfProtect, async (req, res, next) => {
  try {
    const body = z.object({ current_password: z.string().min(1), new_password: z.string().min(10).max(200) }).strict().safeParse(req.body ?? {});
    if (!body.success) throw zodError(body.error);
    const user = await db("user").where({ id: req.user.id }).first();
    const { verifyPassword } = await import("../lib/hashing.js");
    if (!(await verifyPassword(body.data.current_password, user.password_hash))) throw Object.assign(new Error("Current password is incorrect"), { status: 401 });
    await db("user").where({ id: req.user.id }).update({ password_hash: await hashPassword(body.data.new_password), updated_at: new Date() });
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
adminRouter.get("/notifications", requireStaff, async (_req, res, next) => { try { res.json({ items: await db("notification_log").orderBy("created_at", "desc").limit(100) }); } catch (err) { next(err); } });

adminRouter.get("/inquiries", requireStaff, async (req, res, next) => {
  try {
    const q = z.object({ status: z.enum(INQUIRY_STATUSES).optional(), tour_id: z.coerce.number().int().optional(), assigned: z.coerce.number().int().optional(), booked: z.enum(["1", "true"]).optional(), page: z.coerce.number().int().min(1).default(1), per: z.coerce.number().int().min(1).max(100).default(25) }).safeParse(req.query);
    if (!q.success) throw zodError(q.error);
    const p = q.data;
    let query = db("inquiry").join("tour", "tour.id", "inquiry.tour_id").leftJoin("departure", "departure.id", "inquiry.departure_id").leftJoin({ traveller: "user" }, "traveller.id", "inquiry.user_id").leftJoin({ assignee: "user" }, "assignee.id", "inquiry.assigned_to").select("inquiry.*", "tour.title as tour_title", "tour.slug as tour_slug", "departure.start_date as departure_start", "departure.end_date as departure_end", "departure.status as departure_status", "traveller.name as account_name", "traveller.email as account_email", "assignee.name as assigned_name");
    if (p.status) query = query.where("inquiry.status", p.status);
    if (p.booked) query = query.whereIn("inquiry.status", ["confirmed", "completed"]);
    if (p.tour_id) query = query.where("inquiry.tour_id", p.tour_id);
    if (p.assigned) query = query.where("inquiry.assigned_to", p.assigned);
    const rows = await query.clone().orderBy("inquiry.created_at", "desc").limit(p.per).offset((p.page - 1) * p.per);
    const { total } = await query.clone().clearSelect().count({ total: "inquiry.id" }).first();
    const items = req.user.role === "analyst" ? rows.map(r => ({ ...r, email: mask(r.email), phone_e164: maskPhone(r.phone_e164) })) : rows;
    res.json({ items, page: p.page, per: p.per, total: Number(total) });
  } catch (err) { next(err); }
});
adminRouter.get("/inquiries/:id", requireStaff, async (req, res, next) => {
  try {
    const inq = await db("inquiry").join("tour", "tour.id", "inquiry.tour_id").leftJoin("departure", "departure.id", "inquiry.departure_id").leftJoin({ traveller: "user" }, "traveller.id", "inquiry.user_id").leftJoin({ assignee: "user" }, "assignee.id", "inquiry.assigned_to").where("inquiry.id", req.params.id).select("inquiry.*", "tour.title as tour_title", "tour.slug as tour_slug", "departure.start_date as departure_start", "departure.end_date as departure_end", "departure.status as departure_status", "traveller.name as account_name", "traveller.email as account_email", "assignee.name as assigned_name").first();
    if (!inq) return res.status(404).json({ type: "about:blank", title: "Not found", status: 404 });
    const messages = await db("inquiry_message").leftJoin("user", "user.id", "inquiry_message.author_id").where({ inquiry_id: inq.id }).orderBy("created_at").select("inquiry_message.*", "user.name as author_name");
    res.json({ ...inq, messages });
  } catch (err) { next(err); }
});
adminRouter.patch("/inquiries/:id", requireRole("ops", "superadmin"), csrfProtect, async (req, res, next) => {
  try {
    const body = z.object({ status: z.enum(INQUIRY_STATUSES).optional(), assigned_to: z.coerce.number().int().nullable().optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) throw zodError(body.error);
    const before = await db("inquiry").where({ id: req.params.id }).first();
    if (!before) return res.status(404).json({ type: "about:blank", title: "Not found", status: 404 });
    await db("inquiry").where({ id: before.id }).update({ ...body.data, updated_at: new Date() });
    if (body.data.status === "confirmed" && before.status !== "confirmed" && before.departure_id) {
      await db("departure").where({ id: before.departure_id }).increment("confirmed_count", before.travellers);
      const dep = await db("departure").where({ id: before.departure_id }).first();
      if (dep.confirmed_count >= dep.capacity) await db("departure").where({ id: dep.id }).update({ status: "sold_out" });
    }
    const after = await db("inquiry").where({ id: before.id }).first();
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
    const inq = await db("inquiry").where({ id: req.params.id }).first();
    if (!inq) return res.status(404).json({ type: "about:blank", title: "Not found", status: 404 });
    const [id] = await db("inquiry_message").insert({ inquiry_id: inq.id, author_id: req.user.id, visibility: body.data.visibility, body_md: body.data.body_md });
    if (body.data.visibility === "customer") {
      const settings = await getSettings();
      sendWhatsAppText({ to: inq.phone_e164, template: "customer_message", inquiryId: inq.id, body: `${settings.brand_name} message for ${inq.reference}:\n${body.data.body_md}` }).catch((err) => logger.error({ err }, "whatsapp customer message failed"));
    }
    await audit(req, { action: "create.inquiry_message", entityType: "inquiry", entityId: inq.id });
    res.status(201).json(await db("inquiry_message").where({ id }).first());
  } catch (err) { next(err); }
});

const tourSchema = z.object({ slug: z.string().min(3).max(160).regex(/^[a-z0-9-]+$/), title: z.string().min(3).max(200), region: z.string().min(2).max(80), difficulty: z.enum(DIFFICULTIES).nullable().optional(), duration_days: z.coerce.number().int().min(1).max(60), from_price_inr: z.coerce.number().min(0), min_age: z.coerce.number().int().min(0).max(99).nullable().optional(), description_md: z.string().max(50000).optional(), itinerary: z.array(z.object({ day: z.coerce.number().int(), title: z.string(), detail: z.string() })).default([]), inclusions: z.array(z.string()).default([]), exclusions: z.array(z.string()).default([]), hero_image_path: z.string().max(255).default(""), meta_title: z.string().max(180).optional(), meta_description: z.string().max(300).optional(), is_published: z.boolean().optional(), is_featured: z.boolean().optional() });
const tourUpdateSchema = tourSchema.partial();
adminRouter.get("/tours", requireStaff, async (_req, res, next) => { try { res.json({ items: await db("tour").whereNull("deleted_at").orderBy("updated_at", "desc") }); } catch (err) { next(err); } });
adminRouter.get("/tours/:id", requireStaff, async (req, res, next) => {
  try { const tour = await db("tour").where({ id: req.params.id }).whereNull("deleted_at").first(); if (!tour) return res.status(404).json({ type: "about:blank", title: "Tour not found", status: 404 }); const [images, departures] = await Promise.all([db("tour_image").where({ tour_id: tour.id }).orderBy("sort_order").orderBy("id"), db("departure").where({ tour_id: tour.id }).orderBy("start_date", "desc")]); res.json({ ...tourResponse(tour), images, departures }); } catch (err) { next(err); }
});
adminRouter.post("/tours", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => {
  try { const p = tourSchema.safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const d = p.data; const [id] = await db("tour").insert({ ...tourPatch(d), created_by: req.user.id, created_at: new Date(), is_published: !!d.is_published, is_featured: !!d.is_featured }); await audit(req, { action: "create.tour", entityType: "tour", entityId: id, after: { slug: d.slug } }); res.status(201).json(tourResponse(await db("tour").where({ id }).first())); } catch (err) { next(err); }
});
adminRouter.patch("/tours/:id", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => {
  try { const p = tourUpdateSchema.safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const before = await db("tour").where({ id: req.params.id }).whereNull("deleted_at").first(); if (!before) return res.status(404).json({ type: "about:blank", title: "Tour not found", status: 404 }); await db("tour").where({ id: before.id }).update(tourPatch(p.data)); const after = await db("tour").where({ id: before.id }).first(); await audit(req, { action: "update.tour", entityType: "tour", entityId: before.id, before: { slug: before.slug, title: before.title }, after: { slug: after.slug, title: after.title } }); res.json(tourResponse(after)); } catch (err) { next(err); }
});
adminRouter.delete("/tours/:id", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { await db("tour").where({ id: req.params.id }).update({ deleted_at: new Date(), updated_at: new Date(), is_published: false }); await audit(req, { action: "delete.tour", entityType: "tour", entityId: Number(req.params.id) }); res.json({ ok: true }); } catch (err) { next(err); } });
adminRouter.post("/tours/:id/publish", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { await db("tour").where({ id: req.params.id }).update({ is_published: true, updated_at: new Date() }); await audit(req, { action: "publish.tour", entityType: "tour", entityId: Number(req.params.id) }); res.json({ ok: true }); } catch (err) { next(err); } });
adminRouter.post("/tours/:id/unpublish", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { await db("tour").where({ id: req.params.id }).update({ is_published: false, updated_at: new Date() }); await audit(req, { action: "unpublish.tour", entityType: "tour", entityId: Number(req.params.id) }); res.json({ ok: true }); } catch (err) { next(err); } });
const imageSchema = z.object({ path: z.string().min(1).max(255), alt: z.string().max(200).nullable().optional(), sort_order: z.coerce.number().int().min(0).max(999).default(0) });
adminRouter.get("/tours/:id/images", requireStaff, async (req, res, next) => { try { res.json({ items: await db("tour_image").where({ tour_id: req.params.id }).orderBy("sort_order").orderBy("id") }); } catch (err) { next(err); } });
adminRouter.post("/tours/:id/images", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { const p = imageSchema.safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const [id] = await db("tour_image").insert({ tour_id: req.params.id, ...p.data }); await audit(req, { action: "create.tour_image", entityType: "tour", entityId: Number(req.params.id), after: { image_id: id } }); res.status(201).json(await db("tour_image").where({ id }).first()); } catch (err) { next(err); } });
adminRouter.patch("/tour-images/:id", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { const p = imageSchema.partial().safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const before = await db("tour_image").where({ id: req.params.id }).first(); if (!before) return res.status(404).json({ type: "about:blank", title: "Image not found", status: 404 }); await db("tour_image").where({ id: before.id }).update(p.data); await audit(req, { action: "update.tour_image", entityType: "tour", entityId: before.tour_id, before, after: p.data }); res.json(await db("tour_image").where({ id: before.id }).first()); } catch (err) { next(err); } });
adminRouter.delete("/tour-images/:id", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => { try { const before = await db("tour_image").where({ id: req.params.id }).first(); if (!before) return res.status(404).json({ type: "about:blank", title: "Image not found", status: 404 }); await db("tour_image").where({ id: before.id }).delete(); await audit(req, { action: "delete.tour_image", entityType: "tour", entityId: before.tour_id, before }); res.json({ ok: true }); } catch (err) { next(err); } });

adminRouter.post("/departures", requireRole("content", "superadmin"), csrfProtect, async (req, res, next) => {
  try { const p = z.object({ tour_id: z.coerce.number().int(), items: z.array(z.object({ start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), capacity: z.coerce.number().int().min(1).max(500), price_inr: z.coerce.number().min(0) })).min(1).max(60) }).safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const rows = p.data.items.map(i => ({ ...i, tour_id: p.data.tour_id })); await db("departure").insert(rows); await audit(req, { action: "create.departures", entityType: "tour", entityId: p.data.tour_id, after: { count: rows.length } }); res.status(201).json({ created: rows.length }); } catch (err) { next(err); }
});

adminRouter.post("/communications/send", requireRole("ops", "superadmin"), csrfProtect, async (req, res, next) => {
  try {
    const body = z.object({ channel: z.enum(["email", "whatsapp", "sms", "notification"]), inquiry_id: z.coerce.number().int().optional(), user_id: z.coerce.number().int().optional(), recipient: z.string().max(255).optional(), subject: z.string().max(180).optional(), body: z.string().min(1).max(4000), reminder_label: z.string().max(80).optional() }).strict().safeParse(req.body ?? {});
    if (!body.success) throw zodError(body.error);
    const p = body.data;
    const inquiry = p.inquiry_id ? await db("inquiry").where({ id: p.inquiry_id }).first() : null;
    const user = p.user_id ? await db("user").where({ id: p.user_id }).first() : null;
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
    if (inquiry) await db("inquiry_message").insert({ inquiry_id: inquiry.id, author_id: req.user.id, visibility: "customer", body_md: `[${p.channel}] ${p.body}` });
    await audit(req, { action: "send.communication", entityType: inquiry ? "inquiry" : "user", entityId: inquiry?.id ?? user?.id ?? null, after: { channel: p.channel, recipient, status: result.status } });
    res.json({ ok: true, channel: p.channel, recipient, ...result });
  } catch (err) { next(err); }
});

adminRouter.get("/reviews", requireStaff, async (req, res, next) => { try { const status = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : "pending"; res.json({ items: await db("review").where({ status }).orderBy("created_at", "desc").limit(100) }); } catch (err) { next(err); } });
adminRouter.post("/reviews/:id/approve", requireRole("content", "ops", "superadmin"), csrfProtect, async (req, res, next) => {
  try { const r = await db("review").where({ id: req.params.id }).first(); if (!r) return res.status(404).json({ type: "about:blank", title: "Not found", status: 404 }); await db("review").where({ id: r.id }).update({ status: "approved", moderator_id: req.user.id, updated_at: new Date() }); const agg = await db("review").where({ tour_id: r.tour_id, status: "approved" }).avg({ a: "rating" }).count({ c: "*" }).first(); await db("tour").where({ id: r.tour_id }).update({ rating_avg: Number(agg.a || 0).toFixed(2), rating_count: agg.c }); await audit(req, { action: "approve.review", entityType: "review", entityId: r.id }); res.json({ ok: true }); } catch (err) { next(err); }
});
adminRouter.post("/reviews/:id/reject", requireRole("content", "ops", "superadmin"), csrfProtect, async (req, res, next) => { try { const note = String(req.body?.reason || "").slice(0, 500); await db("review").where({ id: req.params.id }).update({ status: "rejected", moderator_id: req.user.id, moderator_note: note, updated_at: new Date() }); await audit(req, { action: "reject.review", entityType: "review", entityId: Number(req.params.id) }); res.json({ ok: true }); } catch (err) { next(err); } });

adminRouter.get("/users", requireRole("superadmin"), async (req, res, next) => {
  try { const role = ["staff", "traveller", "all"].includes(req.query.role) ? req.query.role : "staff"; let query = db("user").whereNull("deleted_at"); if (role === "staff") query = query.whereIn("role", STAFF_ROLES); if (role === "traveller") query = query.where("role", "traveller"); const items = await query.orderBy("created_at", "desc").select("id", "email", "name", "phone_e164", "role", "mfa_enabled", "consent_marketing", "created_at"); res.json({ items }); } catch (err) { next(err); }
});
adminRouter.post("/users", requireRole("superadmin"), csrfProtect, async (req, res, next) => {
  try { const p = z.object({ email: z.string().email(), name: z.string().min(2).max(120), role: z.enum(STAFF_ROLES), password: z.string().min(10).max(200) }).safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const [id] = await db("user").insert({ email: p.data.email.toLowerCase(), name: p.data.name, role: p.data.role, password_hash: await hashPassword(p.data.password) }); await audit(req, { action: "create.user", entityType: "user", entityId: id, after: { role: p.data.role } }); res.status(201).json({ id, email: p.data.email, role: p.data.role }); } catch (err) { next(err); }
});
adminRouter.patch("/users/:id", requireRole("superadmin"), csrfProtect, async (req, res, next) => {
  try { const p = z.object({ name: z.string().min(2).max(120).optional(), email: z.string().email().optional(), phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable().optional(), role: z.enum(USER_ROLES).optional(), consent_marketing: z.boolean().optional(), password: z.string().min(10).max(200).optional() }).strict().safeParse(req.body ?? {}); if (!p.success) throw zodError(p.error); const before = await db("user").where({ id: req.params.id }).first(); if (!before) return res.status(404).json({ type: "about:blank", title: "User not found", status: 404 }); const patch = { ...p.data, updated_at: new Date() }; if (patch.email) patch.email = patch.email.toLowerCase(); if (patch.password) { patch.password_hash = await hashPassword(patch.password); delete patch.password; } await db("user").where({ id: before.id }).update(patch); const after = await db("user").where({ id: before.id }).first(); await audit(req, { action: "update.user", entityType: "user", entityId: before.id, before: { email: before.email, role: before.role }, after: { email: after.email, role: after.role } }); res.json({ id: after.id, email: after.email, name: after.name, phone_e164: after.phone_e164, role: after.role, consent_marketing: after.consent_marketing }); } catch (err) { next(err); }
});
adminRouter.delete("/users/:id", requireRole("superadmin"), csrfProtect, async (req, res, next) => { try { if (Number(req.params.id) === Number(req.user.id)) throw Object.assign(new Error("You cannot disable your own account"), { status: 422 }); await db("user").where({ id: req.params.id }).update({ deleted_at: new Date(), updated_at: new Date() }); await db("session").where({ user_id: req.params.id }).update({ revoked_at: new Date() }); await audit(req, { action: "delete.user", entityType: "user", entityId: Number(req.params.id) }); res.json({ ok: true }); } catch (err) { next(err); } });
adminRouter.get("/booking-contacts", requireStaff, async (_req, res, next) => { try { const items = await db("inquiry").join("tour", "tour.id", "inquiry.tour_id").leftJoin("departure", "departure.id", "inquiry.departure_id").orderBy("inquiry.created_at", "desc").limit(200).select("inquiry.id", "inquiry.reference", "inquiry.name", "inquiry.email", "inquiry.phone_e164", "inquiry.travellers", "inquiry.status", "inquiry.created_at", "tour.title as tour_title", "departure.start_date as departure_start", "departure.end_date as departure_end"); res.json({ items }); } catch (err) { next(err); } });
adminRouter.get("/audit", requireRole("superadmin"), async (_req, res, next) => { try { res.json({ items: await db("audit_entry").orderBy("id", "desc").limit(200) }); } catch (err) { next(err); } });
