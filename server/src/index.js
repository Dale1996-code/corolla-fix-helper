import pino from "pino";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { db } from "./database.js";

const logger = pino({ name: "corolla-fix-helper" });

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "Server running");
});

function shutdown(signal) {
  logger.info({ signal }, "Graceful shutdown initiated");

  server.close(() => {
    logger.info("HTTP server closed");
    try {
      db.close();
    } catch {
      // already closed
    }
    logger.info("Database closed — exiting");
    process.exit(0);
  });

  // Force exit if in-flight requests haven't drained within 25 s
  setTimeout(() => {
    logger.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 25_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
