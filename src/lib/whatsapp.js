import { getDb } from "./db.js";
import { logger } from "./logger.js";
import { getSettings } from "./settings.js";

function normalizePhone(phone = "") {
  return String(phone).replace(/^\+/, "");
}

async function writeLog({ recipient, template, status, inquiryId = null, payload = null, error = null, providerMessageId = null }) {
  const db = await getDb();
  await db.collection("notification_logs").insertOne({
    channel: "whatsapp",
    direction: "outbound",
    recipient,
    template,
    status,
    provider_message_id: providerMessageId,
    inquiry_id: inquiryId,
    payload_json: payload ? JSON.stringify(payload) : null,
    error: error ? String(error).slice(0, 2000) : null,
    created_at: new Date(),
  });
}

export async function sendWhatsAppText({ to, body, template = "freeform", inquiryId = null }) {
  const settings = await getSettings();
  const enabled = settings.whatsapp_enabled === "1";
  if (!enabled) {
    await writeLog({ recipient: to, template, status: "skipped", inquiryId, payload: { body } });
    return { status: "skipped" };
  }

  const phoneNumberId = settings.whatsapp_phone_number_id;
  const accessToken = settings.whatsapp_access_token;
  if (!phoneNumberId || !accessToken) {
    logger.info({ whatsapp: { to: "[dev]", template, inquiryId } }, "whatsapp (dev log, not sent)");
    await writeLog({ recipient: to, template, status: "dev_logged", inquiryId, payload: { body } });
    return { status: "dev_logged" };
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhone(to),
    type: "text",
    text: { preview_url: false, body },
  };

  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `WhatsApp API failed (${res.status})`);
    const providerMessageId = data.messages?.[0]?.id || null;
    await writeLog({ recipient: to, template, status: "sent", inquiryId, payload, providerMessageId });
    return { status: "sent", providerMessageId };
  } catch (err) {
    await writeLog({ recipient: to, template, status: "failed", inquiryId, payload, error: err.message });
    throw err;
  }
}

export function inquiryCreatedOpsMessage({ reference, tourTitle, name, phone, travellers }) {
  return `New Trek On India inquiry ${reference}\nTour: ${tourTitle}\nTraveller: ${name}\nPhone: ${phone}\nPax: ${travellers}\nOpen admin dashboard to follow up.`;
}

export function inquiryCreatedCustomerMessage({ reference, tourTitle, brandName }) {
  return `Namaste from ${brandName}. We received your inquiry ${reference} for ${tourTitle}. Our team will contact you shortly on WhatsApp or phone.`;
}

export function inquiryStatusMessage({ reference, status, brandName }) {
  return `${brandName} update for ${reference}: your inquiry status is now ${status.replace("_", " ")}.`;
}
