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

export function createApp() {
  initializeDatabase();

  const app = express();

  app.use(
    cors({
      origin: `http://localhost:${config.clientPort}`,
    })
  );
  app.use(express.json());

  app.get("/", (_request, response) => {
    response.json({
      name: "Corolla Fix Helper API",
      version: "0.1.0",
    });
  });

  app.use("/api/health", healthRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/symptoms", symptomsRouter);
  app.use("/api/procedures", proceduresRouter);
  app.use("/api/notes", notesRouter);
  app.use("/api/settings", settingsRouter);

  return app;
}
