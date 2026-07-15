import pino from "pino";
import { config } from "../config/index.js";

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "req.headers.cookie", "req.headers.authorization",
      "*.password", "*.email", "*.phone", "*.phone_e164", "*.captcha_token",
    ],
    censor: "[REDACTED]",
  },
});
