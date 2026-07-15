import { db } from "./db.js";

export const DEFAULT_SETTINGS = {
  brand_name: "Trek On India",
  brand_logo_url: "",
  whatsapp_enabled: "0",
  whatsapp_phone_number_id: "",
  whatsapp_access_token: "",
  whatsapp_ops_number: "+919812345678",
  whatsapp_notify_customer: "1",
  smtp_host: "",
  smtp_port: "587",
  smtp_user: "",
  smtp_pass: "",
  smtp_from: "Trek On India <bookings@trekonindia.com>",
  smtp_ops: "ops@trekonindia.com",
  smtp_secure: "0",
  sms_enabled: "0",
  sms_provider: "dev",
  sms_api_url: "",
  sms_api_key: "",
  sms_sender_id: "TrekIndia",
};

export async function getSettings(keys = Object.keys(DEFAULT_SETTINGS)) {
  const rows = await db("app_setting").whereIn("key", keys);
  const values = { ...DEFAULT_SETTINGS };
  for (const row of rows) values[row.key] = row.value ?? "";
  return values;
}

export async function publicSettings() {
  const settings = await getSettings(["brand_name", "brand_logo_url", "whatsapp_enabled", "whatsapp_ops_number"]);
  return {
    brand_name: settings.brand_name,
    brand_logo_url: settings.brand_logo_url,
    whatsapp_enabled: settings.whatsapp_enabled === "1",
    whatsapp_ops_number: settings.whatsapp_ops_number,
  };
}

export async function getSmtpSettings() {
  const s = await getSettings(["smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from", "smtp_ops", "smtp_secure"]);
  return {
    host: s.smtp_host || null,
    port: Number(s.smtp_port) || 587,
    user: s.smtp_user || null,
    pass: s.smtp_pass || null,
    from: s.smtp_from || "Trek On India <bookings@trekonindia.com>",
    ops: s.smtp_ops || "ops@trekonindia.com",
    secure: s.smtp_secure === "1",
  };
}

export async function updateSettings(patch, userId = null) {
  const now = new Date();
  for (const [key, value] of Object.entries(patch)) {
    await db("app_setting")
      .insert({ key, value: value == null ? "" : String(value), updated_at: now, updated_by: userId })
      .onConflict("key")
      .merge({ value: value == null ? "" : String(value), updated_at: now, updated_by: userId });
  }
  return getSettings();
}
