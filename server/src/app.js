import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import { createAskRouter } from "./routes/ask.js";
import { createRepairPlanRouter } from "./routes/repairPlan.js";
import { createRateLimiter } from "./middleware/rateLimit.js";
import { attachmentsRouter } from "./routes/attachments.js";
import { config } from "./config.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { initializeDatabase } from "./initDatabase.js";
import { documentsRouter } from "./routes/documents.js";
import { healthRouter } from "./routes/health.js";
import { notesRouter } from "./routes/notes.js";
import { proceduresRouter } from "./routes/procedures.js";
import { repairChecklistsRouter } from "./routes/repairChecklists.js";
import { repairHistoryRouter } from "./routes/repairHistory.js";
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

  app.use(
    express.static(clientDistDir, {
      setHeaders(response, filePath) {
        // The service worker script must revalidate on every check so a new
        // deploy's worker is picked up promptly instead of after the browser's
        // default script-cache window.
        if (path.basename(filePath) === "sw.js") {
          response.setHeader("Cache-Control", "no-cache");
        }
      },
    })
  );

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
  const { askQuestion, runRepairPlan } = options;
  const clientDistDir = options.clientDistDir || config.clientDistDir;

  // Cap how often the AI endpoints can be hit so a runaway client cannot burn the
  // OpenAI budget. One shared 20-requests-per-minute window covers /api/ask and
  // /api/repair-plan together (not one window each), so the combined AI request
  // rate is bounded. Injectable for tests.
  const aiLimiter = options.aiRateLimiter || createRateLimiter({ windowMs: 60_000, max: 20 });

  // Baseline security headers. This is a local-first app served same-origin, so
  // a self-only CSP is safe: scripts/styles come from the built bundle, images
  // (attachments) are same-origin plus data:/blob:, and PDFs open in new tabs
  // rather than being framed. These headers are defense-in-depth, not a
  // substitute for the access-control decision tracked separately.
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "font-src 'self' data:",
        "manifest-src 'self'",
        "worker-src 'self'",
      ].join("; ")
    );
    next();
  });

  app.use(
    cors({
      origin: config.corsOrigin,
    })
  );
  app.use(express.json());

  // Repair data must never be served stale — not by the service worker (which
  // already skips /api) and not by any HTTP cache in between.
  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  addApiInfoRoute(app);
  app.use("/api/health", healthRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/symptoms", symptomsRouter);
  app.use("/api/procedures", proceduresRouter);
  app.use("/api/notes", notesRouter);
  app.use("/api/repair-checklists", repairChecklistsRouter);
  app.use("/api/repair-history", repairHistoryRouter);
  app.use("/api/attachments", attachmentsRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/ask", aiLimiter, createAskRouter({ askQuestion }));
  app.use(
    "/api/repair-plan",
    // The limiter is handed to the router rather than mounted across the whole
    // prefix so it still shares one window with /api/ask on plan generation,
    // while the safety-acknowledgment subroute (no model call) stays outside it.
    createRepairPlanRouter({ runAgent: runRepairPlan, aiRateLimiter: aiLimiter })
  );

  addFrontendRoutes(app, clientDistDir);

  return app;
}
