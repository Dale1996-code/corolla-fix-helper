import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createAskRouter } from "./routes/ask.js";
import { createRepairPlanRouter } from "./routes/repairPlan.js";
import { createRateLimiter } from "./middleware/rateLimit.js";
import {
  apiNotFound,
  createHostAllowList,
  createHostGuard,
  createJsonErrorHandler,
  defaultEmptyBody,
  JSON_BODY_LIMIT,
  requireJsonBody,
  requireSameOriginRequest,
  requireSameOriginWrite,
} from "./middleware/requestGuard.js";
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

// The GET routes that do work rather than only read: backup export stages
// every upload into a temp directory (routes/settings.js), and procedure
// suggestions make model calls (routes/symptoms.js). A cross-site <img src>
// could start either, so they get the same-origin rule that writes get.
const BACKUP_EXPORT_PATH = "/api/settings/backup-export";
const SUGGESTED_PROCEDURES_PATH = "/api/symptoms/:id/suggested-procedures";

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

    // Relative to `root`, so `send` looks for dot segments only inside the build.
    // Given the absolute path, it refused any install under a dot-folder
    // (`~/.local/...`, `.claude/worktrees/...`) and every deep link was a 404.
    return response.sendFile("index.html", { root: clientDistDir });
  });
}

export function createApp(options = {}) {
  initializeDatabase();

  const app = express();
  // Nothing gains from knowing the server framework (2A-12).
  app.disable("x-powered-by");
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
  // substitute for the request gate below.
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

  // Repair data must never be served stale — not by the service worker (which
  // already skips /api) and not by any HTTP cache in between. Set before the
  // request gate so its refusals are not cached either.
  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  // The request gate (middleware/requestGuard.js). The app has no login, so
  // these checks are what keep other web pages from driving it. The Host
  // allow-list runs ahead of every route and the built frontend, so a
  // DNS-rebound page gets nothing. Injectable for network-mode tests.
  const hostAllowList =
    options.hostAllowList ||
    createHostAllowList({
      networkMode: config.networkMode,
      allowedHosts: config.allowedHosts,
    });
  app.use(createHostGuard(hostAllowList));
  app.use("/api", requireSameOriginWrite);
  app.get([BACKUP_EXPORT_PATH, SUGGESTED_PROCEDURES_PATH], requireSameOriginRequest);

  // No CORS middleware, on purpose (2A-04). The client calls relative /api
  // URLs, and in dev the Vite proxy makes those same-origin too, so the app
  // never needs to grant another origin access. Granting one (it used to be
  // http://localhost:5173, even under npm start) handed every page on that
  // port read access to everything, the backup included.

  // The body contract: a write's body is JSON (or multipart for uploads), up
  // to a deliberate limit, and a missing body reads as {}.
  app.use("/api", requireJsonBody);
  app.use("/api", express.json({ limit: JSON_BODY_LIMIT }));
  app.use("/api", defaultEmptyBody);

  addApiInfoRoute(app);
  app.use("/api/health", healthRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/search", searchRouter);
  // Suggestions call the model from a GET, so they share the one AI window
  // with /api/ask and /api/repair-plan (2A-07). The cross-site check above
  // runs first, so a refused request never uses up the owner's window.
  app.get(SUGGESTED_PROCEDURES_PATH, aiLimiter);
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
  app.use("/api", apiNotFound);

  addFrontendRoutes(app, clientDistDir);

  // Last: anything no route answered itself becomes { error } JSON, never
  // Express's HTML page with a stack trace (1B-06).
  app.use(createJsonErrorHandler());

  return app;
}
