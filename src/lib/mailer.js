import nodemailer from "nodemailer";
import { config } from "../config/index.js";
import { logger } from "./logger.js";
import { getSmtpSettings } from "./settings.js";

let cachedTransport = null;
let cachedConfigHash = "";

function hashCfg(cfg) {
  return `${cfg.host}|${cfg.port}|${cfg.user}|${cfg.pass ? "[set]" : ""}|${cfg.secure}`;
}

async function getTransport() {
  const dbSmtp = await getSmtpSettings();
  // Env overrides DB for host (allows quick disaster recovery)
  const effective = {
    host: config.smtp.host || dbSmtp.host,
    port: config.smtp.port || dbSmtp.port,
    user: config.smtp.user || dbSmtp.user,
    pass: config.smtp.pass || dbSmtp.pass,
    from: config.smtp.from || dbSmtp.from,
    ops: config.smtp.ops || dbSmtp.ops,
    secure: config.smtp.port === 465 || dbSmtp.secure,
  };

  const h = hashCfg(effective);
  if (cachedTransport && cachedConfigHash === h) return cachedTransport;

  if (effective.host) {
    cachedTransport = nodemailer.createTransport({
      host: effective.host,
      port: effective.port,
      secure: effective.secure,
      auth: effective.user ? { user: effective.user, pass: effective.pass } : undefined,
    });
  } else {
    cachedTransport = nodemailer.createTransport({ jsonTransport: true });
  }
  cachedConfigHash = h;
  return cachedTransport;
}

export async function sendMail({ to, subject, text, html }) {
  const transport = await getTransport();
  const from = (await getSmtpSettings()).from;
  const info = await transport.sendMail({ from, to, subject, text, html });
  if (!config.smtp.host && !(await getSmtpSettings()).host) {
    logger.info({ mail: { to: "[dev]", subject } }, "email (dev jsonTransport, not sent)");
  }
  return info;
}

export function inquiryConfirmationEmail({ name, reference, tourTitle }) {
  return {
    subject: `Inquiry received — ${reference}`,
    text:
`Namaste ${name},

Thank you for your inquiry about "${tourTitle}".
Your booking reference is ${reference}.

Our team will contact you within 4 business hours on phone or WhatsApp
with availability and a quote. No payment is required at this stage.

oktrek
`,
  };
}

export function opsNotificationEmail({ reference, tourTitle, travellers }) {
  return {
    subject: `New inquiry ${reference} — ${tourTitle}`,
    text: `New inquiry ${reference} for "${tourTitle}" (${travellers} traveller(s)). Open the admin queue to respond.`,
  };
}
