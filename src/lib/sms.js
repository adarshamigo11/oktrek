import { db } from "./db.js";
import { logger } from "./logger.js";
import { getSettings } from "./settings.js";

async function writeLog({ recipient, template, status, inquiryId = null, payload = null, error = null, providerMessageId = null }) {
  await db("notification_log").insert({
    channel: "sms",
    direction: "outbound",
    recipient,
    template,
    status,
    provider_message_id: providerMessageId,
    inquiry_id: inquiryId,
    payload_json: payload ? JSON.stringify(payload) : null,
    error: error ? String(error).slice(0, 2000) : null,
  });
}

export async function sendSmsText({ to, body, template = "freeform", inquiryId = null }) {
  const settings = await getSettings();
  const enabled = settings.sms_enabled === "1";
  const payload = {
    provider: settings.sms_provider || "dev",
    sender: settings.sms_sender_id || "TrekIndia",
    to,
    body,
  };

  if (!enabled) {
    await writeLog({ recipient: to, template, status: "skipped", inquiryId, payload });
    return { status: "skipped" };
  }

  const apiUrl = settings.sms_api_url;
  const apiKey = settings.sms_api_key;
  if (!apiUrl || !apiKey) {
    logger.info({ sms: { to: "[dev]", template, inquiryId } }, "sms (dev log, not sent)");
    await writeLog({ recipient: to, template, status: "dev_logged", inquiryId, payload });
    return { status: "dev_logged" };
  }

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || data.message || `SMS API failed (${res.status})`);
    const providerMessageId = data.id || data.message_id || data.sid || null;
    await writeLog({ recipient: to, template, status: "sent", inquiryId, payload, providerMessageId });
    return { status: "sent", providerMessageId };
  } catch (err) {
    await writeLog({ recipient: to, template, status: "failed", inquiryId, payload, error: err.message });
    throw err;
  }
}
