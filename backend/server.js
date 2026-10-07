const path = require("path");
const dotenv = require("dotenv");

// Load env before any module reads process.env at require time. Test harnesses (E2E, load
// test) set ACEIIIT_SKIP_DOTENV=1 so a local backend/.env, which may hold production
// credentials, is never loaded into a throwaway server.
if (process.env.ACEIIIT_SKIP_DOTENV !== "1") {
  dotenv.config({ path: path.join(__dirname, ".env") });
}

const mongoose = require("mongoose");

const { validateEnv } = require("./config/env");
const { initSentry, captureException, flushSentry } = require("./utils/sentry");
const { logger } = require("./utils/logger");
const { createApp } = require("./app");
const { connectDb } = require("./config/db");
const { reminderService } = require("./services/reminderService");
const { attemptSweeper } = require("./services/attemptSweeper");
const { interpretationWorker } = require("./services/aiInterpretationService");

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000);
let server = null;
let shuttingDown = false;
let dbRetryTimer = null;

function stopJobs() {
  reminderService.stop();
  attemptSweeper.stop();
  interpretationWorker.stop();
  if (dbRetryTimer) clearTimeout(dbRetryTimer);
}

/** Graceful shutdown: stop accepting connections, stop jobs, drain, close Mongo, exit. */
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  const hardExit = setTimeout(() => {
    logger.error("graceful shutdown timed out; forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  hardExit.unref();
  try {
    stopJobs();
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    await mongoose.disconnect().catch(() => {});
    await flushSentry();
  } finally {
    clearTimeout(hardExit);
    process.exit(exitCode);
  }
}

async function main() {
  const envInfo = validateEnv(process.env);
  initSentry();
  if (envInfo.insecureDevAuth) {
    logger.warn("ALLOW_INSECURE_DEV_AUTH is enabled. Mock OAuth logins are accepted (development only).");
  }

  const app = createApp();
  const port = Number(process.env.PORT || 4000);
  server = app.listen(port, () => {
    logger.info({ port }, "UGEE portal backend listening");
  });
  server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
  server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 66000);
  server.requestTimeout = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 15000);

  function bootDb() {
    connectDb(process.env.MONGODB_URI)
      .then(async () => {
        if (shuttingDown) return;
        logger.info("MongoDB connected");
        reminderService.start();
        attemptSweeper.start();
        interpretationWorker.start();
        // Production runs with autoIndex off: warn loudly if required indexes are missing.
        require("./services/indexCheck").warnOnMissingIndexes().catch((err) => logger.warn({ err: err.message }, "index check failed"));
        try {
          const { getActiveSeason } = require("./services/seasonService");
          await getActiveSeason();
        } catch (seasonErr) {
          logger.warn({ err: seasonErr }, "season bootstrap note");
        }
      })
      .catch((err) => {
        logger.error({ err: err.message }, "MongoDB connection failed, retrying soon");
        if (!shuttingDown) dbRetryTimer = setTimeout(bootDb, Number(process.env.DB_RETRY_DELAY_MS || 5000));
      });
  }

  bootDb();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "unhandled promise rejection");
  captureException(err);
});

// An uncaught exception leaves the process in an unknown state: log, report, exit.
// The platform (Render/systemd/PM2) restarts a fresh process.
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception; exiting");
  captureException(err);
  shutdown("uncaughtException", 1);
});

main().catch((err) => {
  logger.fatal({ err }, "failed to start server");
  process.exit(1);
});
