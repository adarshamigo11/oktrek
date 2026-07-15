import { z } from "zod";
import { getDb, nextId } from "../lib/db.js";
import { hashIp } from "../lib/crypto.js";
import { sendMail, inquiryConfirmationEmail, opsNotificationEmail } from "../lib/mailer.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { zodError } from "../middleware/common.js";
import { getSettings } from "../lib/settings.js";
import {
  sendWhatsAppText,
  inquiryCreatedOpsMessage,
  inquiryCreatedCustomerMessage,
} from "../lib/whatsapp.js";

export const inquirySchema = z.object({
  tour_slug: z.string().min(1).max(160),
  departure_id: z.coerce.number().int().positive().optional(),
  preferred_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  name: z.string().min(2).max(120),
  email: z.string().email().max(255),
  phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone must be E.164, e.g. +919812345678"),
  travellers: z.coerce.number().int().min(1).max(40),
  pickup_city: z.string().max(80).optional(),
  message: z.string().max(4000).optional(),
  consent: z.object({ version: z.string().min(1), accepted: z.literal(true) }),
  captcha_token: z.string().optional(),
  website: z.string().max(0).optional(), // honeypot: must be empty
}).strict();

async function verifyCaptcha(token) {
  if (!config.captchaSecret) {
    logger.warn("captcha check skipped (no CAPTCHA_SECRET configured)");
    return true;
  }
  const res = await fetch("https://hcaptcha.com/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: config.captchaSecret, response: token || "" }),
  });
  const data = await res.json();
  return !!data.success;
}

export async function createInquiry(req, rawBody) {
  const db = await getDb();

  // Honeypot filled -> silently fake-accept and drop
  if (rawBody.website) {
    logger.warn({ ip_hash: hashIp(req.ip) }, "honeypot triggered; inquiry dropped");
    return { reference: "TOI-0000-000000", status: "new", dropped: true };
  }

  const parsed = inquirySchema.safeParse(rawBody);
  if (!parsed.success) throw zodError(parsed.error);
  const body = parsed.data;

  if (!(await verifyCaptcha(body.captcha_token))) {
    throw Object.assign(new Error("Captcha verification failed"), { status: 400 });
  }

  const tour = await db.collection("tours").findOne({
    slug: body.tour_slug,
    is_published: true,
    deleted_at: null,
  });
  if (!tour) throw Object.assign(new Error("Tour not found"), { status: 404 });

  let departureId = null;
  if (body.departure_id) {
    const dep = await db.collection("departures").findOne({
      id: body.departure_id,
      tour_id: tour.id,
      status: { $ne: "cancelled" },
    });
    if (!dep) throw Object.assign(new Error("Departure not found for this tour"), { status: 404 });
    departureId = dep.id;
  }
  if (!departureId && !body.preferred_date) {
    throw Object.assign(new Error("Provide a departure_id or a preferred_date"), { status: 422 });
  }

  const id = await nextId(db, "inquiries");
  await db.collection("inquiries").insertOne({
    _id: id,
    id,
    tour_id: tour.id,
    departure_id: departureId,
    user_id: req.user?.id ?? null,
    name: body.name,
    email: body.email,
    phone_e164: body.phone_e164,
    travellers: body.travellers,
    preferred_date: body.preferred_date ?? null,
    pickup_city: body.pickup_city ?? null,
    message: body.message ?? null,
    source: "web",
    status: "new",
    ip_hash: hashIp(req.ip),
    ua: (req.get("user-agent") || "").slice(0, 255),
    consent_snapshot: JSON.stringify({ ...body.consent, at: new Date().toISOString() }),
    created_at: new Date(),
    updated_at: new Date(),
    messages: [],
  });

  const reference = `TOI-${new Date().getFullYear()}-${String(id).padStart(6, "0")}`;
  await db.collection("inquiries").updateOne({ id }, { $set: { reference } });

  // Fire-and-forget emails; failures logged, never block the response
  const conf = inquiryConfirmationEmail({ name: body.name, reference, tourTitle: tour.title });
  const ops = opsNotificationEmail({ reference, tourTitle: tour.title, travellers: body.travellers });
  Promise.allSettled([
    sendMail({ to: body.email, ...conf }),
    sendMail({ to: config.smtp.ops, ...ops }),
  ]).then((rs) => {
    for (const r of rs) if (r.status === "rejected") logger.error({ err: r.reason }, "inquiry email failed");
  });

  getSettings().then((settings) => Promise.allSettled([
    sendWhatsAppText({
      to: settings.whatsapp_ops_number,
      template: "ops_new_inquiry",
      inquiryId: id,
      body: inquiryCreatedOpsMessage({
        reference,
        tourTitle: tour.title,
        name: body.name,
        phone: body.phone_e164,
        travellers: body.travellers,
      }),
    }),
    settings.whatsapp_notify_customer === "1"
      ? sendWhatsAppText({
          to: body.phone_e164,
          template: "customer_inquiry_received",
          inquiryId: id,
          body: inquiryCreatedCustomerMessage({
            reference,
            tourTitle: tour.title,
            brandName: settings.brand_name,
          }),
        })
      : Promise.resolve({ status: "skipped" }),
  ])).then((rs) => {
    for (const r of rs) if (r.status === "rejected") logger.error({ err: r.reason }, "whatsapp notification failed");
  });

  return { reference, status: "new", created_at: new Date().toISOString() };
}
import { z } from "zod";
import { db } from "../lib/db.js";
import { hashIp } from "../lib/crypto.js";
import { sendMail, inquiryConfirmationEmail, opsNotificationEmail } from "../lib/mailer.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { zodError } from "../middleware/common.js";
import { getSettings } from "../lib/settings.js";
import {
  sendWhatsAppText,
  inquiryCreatedOpsMessage,
  inquiryCreatedCustomerMessage,
} from "../lib/whatsapp.js";

export const inquirySchema = z.object({
  tour_slug: z.string().min(1).max(160),
  departure_id: z.coerce.number().int().positive().optional(),
  preferred_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  name: z.string().min(2).max(120),
  email: z.string().email().max(255),
  phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone must be E.164, e.g. +919812345678"),
  travellers: z.coerce.number().int().min(1).max(40),
  pickup_city: z.string().max(80).optional(),
  message: z.string().max(4000).optional(),
  consent: z.object({ version: z.string().min(1), accepted: z.literal(true) }),
  captcha_token: z.string().optional(),
  website: z.string().max(0).optional(), // honeypot: must be empty
}).strict();

async function verifyCaptcha(token) {
  if (!config.captchaSecret) {
    logger.warn("captcha check skipped (no CAPTCHA_SECRET configured)");
    return true;
  }
  const res = await fetch("https://hcaptcha.com/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: config.captchaSecret, response: token || "" }),
  });
  const data = await res.json();
  return !!data.success;
}

export async function createInquiry(req, rawBody) {
  // Honeypot filled -> silently fake-accept and drop, BEFORE validation, so bots
  // learn nothing from error responses (Security doc §11)
  if (rawBody.website) {
    logger.warn({ ip_hash: hashIp(req.ip) }, "honeypot triggered; inquiry dropped");
    return { reference: "TOI-0000-000000", status: "new", dropped: true };
  }

  const parsed = inquirySchema.safeParse(rawBody);
  if (!parsed.success) throw zodError(parsed.error);
  const body = parsed.data;

  if (!(await verifyCaptcha(body.captcha_token))) {
    throw Object.assign(new Error("Captcha verification failed"), { status: 400 });
  }

  const tour = await db("tour")
    .where({ slug: body.tour_slug, is_published: true })
    .whereNull("deleted_at")
    .first();
  if (!tour) throw Object.assign(new Error("Tour not found"), { status: 404 });

  let departureId = null;
  if (body.departure_id) {
    const dep = await db("departure")
      .where({ id: body.departure_id, tour_id: tour.id })
      .whereNot({ status: "cancelled" })
      .first();
    if (!dep) throw Object.assign(new Error("Departure not found for this tour"), { status: 404 });
    departureId = dep.id;
  }
  if (!departureId && !body.preferred_date) {
    throw Object.assign(new Error("Provide a departure_id or a preferred_date"), { status: 422 });
  }

  const [id] = await db("inquiry").insert({
    tour_id: tour.id,
    departure_id: departureId,
    user_id: req.user?.id ?? null,
    name: body.name,
    email: body.email,
    phone_e164: body.phone_e164,
    travellers: body.travellers,
    preferred_date: body.preferred_date ?? null,
    pickup_city: body.pickup_city ?? null,
    message: body.message ?? null,
    source: "web",
    status: "new",
    ip_hash: hashIp(req.ip),
    ua: (req.get("user-agent") || "").slice(0, 255),
    consent_snapshot: JSON.stringify({ ...body.consent, at: new Date().toISOString() }),
  });

  const reference = `TOI-${new Date().getFullYear()}-${String(id).padStart(6, "0")}`;
  await db("inquiry").where({ id }).update({ reference });

  // Fire-and-forget emails; failures logged, never block the response
  const conf = inquiryConfirmationEmail({ name: body.name, reference, tourTitle: tour.title });
  const ops = opsNotificationEmail({ reference, tourTitle: tour.title, travellers: body.travellers });
  Promise.allSettled([
    sendMail({ to: body.email, ...conf }),
    sendMail({ to: config.smtp.ops, ...ops }),
  ]).then((rs) => {
    for (const r of rs) if (r.status === "rejected") logger.error({ err: r.reason }, "inquiry email failed");
  });

  getSettings().then((settings) => Promise.allSettled([
    sendWhatsAppText({
      to: settings.whatsapp_ops_number,
      template: "ops_new_inquiry",
      inquiryId: id,
      body: inquiryCreatedOpsMessage({
        reference,
        tourTitle: tour.title,
        name: body.name,
        phone: body.phone_e164,
        travellers: body.travellers,
      }),
    }),
    settings.whatsapp_notify_customer === "1"
      ? sendWhatsAppText({
          to: body.phone_e164,
          template: "customer_inquiry_received",
          inquiryId: id,
          body: inquiryCreatedCustomerMessage({
            reference,
            tourTitle: tour.title,
            brandName: settings.brand_name,
          }),
        })
      : Promise.resolve({ status: "skipped" }),
  ])).then((rs) => {
    for (const r of rs) if (r.status === "rejected") logger.error({ err: r.reason }, "whatsapp notification failed");
  });

  return { reference, status: "new", created_at: new Date().toISOString() };
}
