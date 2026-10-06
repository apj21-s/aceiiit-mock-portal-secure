const path = require("path");

const compression = require("compression");
const cors = require("cors");
const express = require("express");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const morgan = require("morgan");

const { requireDbReady } = require("./middleware/dbReady");
const { errorHandler, notFound } = require("./middleware/error");
const { requestTimeout } = require("./middleware/timeout");

// Builds the Express application without listening or starting background jobs.
// server.js owns process lifecycle; tests import this module directly.
function createApp() {
  const app = express();

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
  if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test") {
    app.use(morgan("tiny"));
  }
  app.use(requestTimeout(process.env.REQUEST_TIMEOUT_MS || 15000));

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

  function healthHandler(_req, res) {
    res.set("Cache-Control", "no-store");
    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  }

  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);
  app.use("/api/upload-image", require("./routes/uploadRoutes"));

  app.use("/api", requireDbReady);
  app.use("/api/auth", require("./routes/authRoutes"));
  app.use("/api/tests", require("./routes/testRoutes"));
  app.use("/api", require("./routes/attemptRoutes"));
  app.use("/api/reminders", require("./routes/reminderRoutes"));
  app.use("/api/admin", require("./routes/adminRoutes"));
  app.use("/api/calendar", require("./routes/calendarRoutes"));
  app.use("/api/internal", require("./routes/internalRoutes"));

  // Serve the existing static frontend from the repo root (keeps theme/layout intact).
  const staticRoot = path.resolve(__dirname, "..");
  app.use(express.static(staticRoot, {
    etag: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    },
  }));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticRoot, "index.html"));
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
