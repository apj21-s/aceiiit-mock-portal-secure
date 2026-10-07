const path = require("path");

const compression = require("compression");
const cors = require("cors");
const express = require("express");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const crypto = require("crypto");
const pinoHttp = require("pino-http");

const { ensureCsrfCookie, requireCsrf } = require("./middleware/csrf");
const { requireDbReady } = require("./middleware/dbReady");
const { errorHandler, notFound } = require("./middleware/error");
const { requestTimeout } = require("./middleware/timeout");
const { logger } = require("./utils/logger");
const { getDbStatus } = require("./config/db");

// Builds the Express application without listening or starting background jobs.
// server.js owns process lifecycle; tests import this module directly.
function createApp() {
  const app = express();

  // Post-exam interpretation reacts to "attempt finalized" events (decoupled from exam code).
  require("./services/aiInterpretationService").registerEventHandlers();

  app.set("trust proxy", 1);

  app.use(
    helmet({
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://accounts.google.com", "https://appleid.cdn-apple.com"],
          "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://accounts.google.com"],
          "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "data:"],
          "img-src": ["'self'", "data:", "https:", "blob:"],
          "connect-src": ["'self'", "https://accounts.google.com", "https://oauth2.googleapis.com", "https://appleid.apple.com"],
          "frame-src": ["'self'", "https://accounts.google.com", "https://appleid.apple.com"],
        },
      },
      // Avoid blocking KaTeX/font/images in some browsers.
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false }));
  // Request IDs: honour a well-formed incoming X-Request-Id (from a proxy), else generate one.
  app.use(pinoHttp({
    logger,
    genReqId(req, res) {
      const incoming = String(req.headers["x-request-id"] || "");
      const id = /^[A-Za-z0-9._-]{8,128}$/.test(incoming) ? incoming : crypto.randomUUID();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    autoLogging: { ignore: (req) => req.url === "/health" || req.url.startsWith("/vendor/") || /\.(js|css|svg|png|jpe?g|woff2?|ico)(\?|$)/.test(req.url) },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }));
  app.use(requestTimeout(process.env.REQUEST_TIMEOUT_MS || 15000));
  app.use(ensureCsrfCookie);

  // Serve KaTeX locally (no CDN dependency; works even with restricted networks).
  app.use("/vendor/katex", express.static(path.join(__dirname, "node_modules", "katex", "dist")));

  const corsOrigin = String(process.env.CORS_ORIGIN || "").trim();
  if (corsOrigin) {
    app.use(
      cors({
        origin: corsOrigin.split(",").map((s) => s.trim()).filter(Boolean),
        credentials: true,
      })
    );
  }

  // Liveness: the process is up. No dependencies, no secrets.
  function healthHandler(_req, res) {
    res.set("Cache-Control", "no-store");
    res.json({ status: "ok", uptime: Math.round(process.uptime()), timestamp: Date.now() });
  }

  // Readiness: can this instance serve traffic? DB, background jobs, queue and AI breaker.
  function readyHandler(_req, res) {
    const db = getDbStatus();
    const jobs = {};
    const jobAge = (worker) => (worker && worker.lastRunAt ? Math.round((Date.now() - new Date(worker.lastRunAt).getTime()) / 1000) : null);
    try {
      jobs.reminders = { lastRunSecondsAgo: jobAge(require("./services/reminderService").reminderService) };
      jobs.attemptSweeper = { lastRunSecondsAgo: jobAge(require("./services/attemptSweeper").attemptSweeper) };
      const ai = require("./services/aiInterpretationService");
      jobs.aiInterpretation = { lastRunSecondsAgo: jobAge(ai.interpretationWorker), breaker: ai.breakerState() };
    } catch (_err) {
      // Job modules unavailable: report what we have.
    }
    const attemptRoutes = require("./routes/attemptRoutes");
    const queue = attemptRoutes.attemptQueue ? attemptRoutes.attemptQueue.getStats() : null;
    const ready = db.ready;
    res.set("Cache-Control", "no-store");
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      db: { ready: db.ready, readyState: db.readyState },
      jobs,
      attemptQueue: queue ? { active: queue.activeCount, queued: queue.queued, max: queue.maxQueueSize } : null,
    });
  }

  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);
  app.get("/ready", readyHandler);
  // Every state-changing /api request must carry a valid CSRF header (see middleware/csrf.js).
  app.use("/api", requireCsrf);
  app.use("/api/upload-image", require("./routes/uploadRoutes"));

  app.use("/api", requireDbReady);
  app.use("/api/auth", require("./routes/authRoutes"));
  app.use("/api/account", require("./routes/accountRoutes"));
  app.use("/api/tests", require("./routes/testRoutes"));
  app.use("/api", require("./routes/attemptRoutes"));
  app.use("/api/reminders", require("./routes/reminderRoutes"));
  app.use("/api/admin", require("./routes/adminRoutes"));
  app.use("/api/calendar", require("./routes/calendarRoutes"));
  app.use("/api/internal", require("./routes/internalRoutes"));

  // Only backend/public is web-served. The repo root and backend source are never exposed.
  const publicRoot = path.join(__dirname, "public");
  app.use(express.static(publicRoot, {
    etag: false,
    maxAge: 0,
    index: "index.html",
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    },
  }));
  // SPA fallback: only extension-less GET routes outside /api get index.html; anything
  // else (missing files, unknown API paths) falls through to a 404.
  app.get(/^\/(?!api(?:\/|$))[^.]*$/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(publicRoot, "index.html"));
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
