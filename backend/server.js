const path = require("path");

const compression = require("compression");
const cors = require("cors");
const dotenv = require("dotenv");
const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");

const { connectDb } = require("./config/db");
const { requireDbReady } = require("./middleware/dbReady");
const { errorHandler, notFound } = require("./middleware/error");
const { requestTimeout } = require("./middleware/timeout");
const { paidSheetService } = require("./services/paidSheetService");
const { reminderService } = require("./services/reminderService");

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    // Required because we use inline style attributes in markup + allow KaTeX CDN + data: images.
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'", "https://cdn.jsdelivr.net"],
        "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "data:"],
        "img-src": ["'self'", "data:", "https:", "blob:"],
        "connect-src": ["'self'"],
      },
    },
    // Avoid blocking KaTeX/font/images in some browsers.
    crossOriginEmbedderPolicy: false,
  })
);
app.use(compression());
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false }));
if (process.env.NODE_ENV !== "production") {
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

// Serve the existing static frontend from the repo root (keeps theme/layout intact).
const staticRoot = path.resolve(__dirname, "..");
app.use(express.static(staticRoot));
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticRoot, "index.html"));
});

app.use(notFound);
app.use(errorHandler);

async function main() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required (set it in backend/.env)");
  }

  const port = Number(process.env.PORT || 4000);
  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`UGEE portal backend listening on :${port}`);
  });
  server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
  server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 66000);
  server.requestTimeout = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 15000);

  const paidSheetStartupDelayMs = Number(process.env.PAID_SHEETS_STARTUP_DELAY_MS || 10000);
  setTimeout(() => {
    paidSheetService.start();
  }, Math.max(0, paidSheetStartupDelayMs));

  function bootDb() {
    connectDb(process.env.MONGODB_URI)
      .then(() => {
        // eslint-disable-next-line no-console
        console.log("MongoDB connected");
        reminderService.start();
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("MongoDB connection failed, retrying soon:", err.message);
        setTimeout(bootDb, Number(process.env.DB_RETRY_DELAY_MS || 5000));
      });
  }

  bootDb();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server:", err);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  // eslint-disable-next-line no-console
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("Uncaught exception:", err);
});
