import { buildApp } from "./src/app.js";
import { config } from "./src/config/index.js";
import { logger } from "./src/lib/logger.js";
import { closeDb } from "./src/lib/db.js";

const app = buildApp();
const server = app.listen(config.port, "127.0.0.1", () => {
  logger.info({ port: config.port, env: config.env }, "trekonindia-api listening (bound to 127.0.0.1)");
});

// Some preview shells can detach stdio in a way that lets Node exit after startup.
// The HTTP server should keep the event loop alive, but this explicit ref keeps
// local previews stable without changing request behavior.
const previewKeepAlive = setInterval(() => {}, 60 * 60 * 1000);

// Slow-loris / connection exhaustion protection (Security doc §3)
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

async function shutdown(signal) {
  logger.info({ signal }, "shutting down");
  clearInterval(previewKeepAlive);
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
