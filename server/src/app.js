import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
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

function addApiInfoRoute(app) {
  app.get("/api", (_request, response) => {
    response.json({
      name: "Corolla Fix Helper API",
      version: "0.1.0",
    });
  });
}

function addFrontendRoutes(app, clientDistDir) {
  const indexFile = path.join(clientDistDir, "index.html");

  if (!fs.existsSync(indexFile)) {
    app.get("/", (_request, response) => {
      response.json({
        name: "Corolla Fix Helper API",
        version: "0.1.0",
        frontend: "Run npm run build before npm start to serve the built app.",
      });
    });
    return;
  }

  app.use(express.static(clientDistDir));

  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api")) {
      return next();
    }

    return response.sendFile(indexFile);
  });
}

export function createApp(options = {}) {
  initializeDatabase();

  const app = express();
  const clientDistDir = options.clientDistDir || config.clientDistDir;

  app.use(
    cors({
      origin: `http://localhost:${config.clientPort}`,
    })
  );
  app.use(express.json());

  addApiInfoRoute(app);
  app.use("/api/health", healthRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/symptoms", symptomsRouter);
  app.use("/api/procedures", proceduresRouter);
  app.use("/api/notes", notesRouter);
  app.use("/api/settings", settingsRouter);

  addFrontendRoutes(app, clientDistDir);

  return app;
}
