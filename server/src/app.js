import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { initializeDatabase } from "./initDatabase.js";
import { documentsRouter } from "./routes/documents.js";
import { healthRouter } from "./routes/health.js";
import { notesRouter } from "./routes/notes.js";
import { proceduresRouter } from "./routes/procedures.js";
import { searchRouter } from "./routes/search.js";
import { settingsRouter } from "./routes/settings.js";
import { symptomsRouter } from "./routes/symptoms.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
const clientDistDir = path.join(projectRoot, "client", "dist");

export function createApp() {
  initializeDatabase();

  const app = express();

  app.use(
    cors({
      origin: config.corsOrigin,
    })
  );
  app.use(express.json());

  const isProduction = process.env.NODE_ENV === "production";

  if (!isProduction) {
    app.get("/", (_request, response) => {
      response.json({
        name: "Corolla Fix Helper API",
        version: "0.1.0",
      });
    });
  }

  app.use("/api/health", healthRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/symptoms", symptomsRouter);
  app.use("/api/procedures", proceduresRouter);
  app.use("/api/notes", notesRouter);
  app.use("/api/settings", settingsRouter);

  if (isProduction) {
    app.use(express.static(clientDistDir));

    app.get(/^\/(?!api\/).*/, (_request, response) => {
      response.sendFile(path.join(clientDistDir, "index.html"));
    });
  }

  return app;
}
