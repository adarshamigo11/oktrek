import express from "express";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config/index.js";
import { logger } from "./lib/logger.js";
import { nonceMiddleware, securityHeaders, extraHeaders } from "./middleware/security.js";
import { loadUser } from "./middleware/auth.js";
import { defaultApiLimit } from "./middleware/rateLimit.js";
import { notFound, errorHandler } from "./middleware/common.js";
import { publicRouter } from "./routes/public.js";
import { adminRouter } from "./routes/admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use(nonceMiddleware);
  app.use(securityHeaders());
  app.use(extraHeaders);
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/v1/health" } }));
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());
  app.use(loadUser);

  app.use("/api/v1", defaultApiLimit, publicRouter);
  app.use("/api/v1/admin", defaultApiLimit, adminRouter);

  app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin"), {
    index: "index.html",
    setHeaders(res) { res.setHeader("Cache-Control", "no-store"); },
  }));

  app.use("/user", express.static(path.join(__dirname, "..", "public", "user"), {
    index: "index.html",
    setHeaders(res) { res.setHeader("Cache-Control", "no-store"); },
  }));

  app.use("/uploads", express.static(path.join(__dirname, "..", "public", "uploads"), {
    setHeaders(res) { res.setHeader("Cache-Control", "public, max-age=86400"); },
  }));

  app.use("/images", express.static(path.join(__dirname, "..", "public", "images"), {
    setHeaders(res) { res.setHeader("Cache-Control", "public, max-age=86400"); },
  }));

  app.get("/", (_req, res) => res.redirect("/user/"));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
