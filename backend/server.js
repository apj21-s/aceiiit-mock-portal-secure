const path = require("path");
const dotenv = require("dotenv");

// Load env before any module reads process.env at require time.
dotenv.config({ path: path.join(__dirname, ".env") });

const { createApp } = require("./app");
const { connectDb } = require("./config/db");
const { paidSheetService } = require("./services/paidSheetService");
const { reminderService } = require("./services/reminderService");

async function main() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required (set it in backend/.env)");
  }

  const app = createApp();
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
      .then(async () => {
        // eslint-disable-next-line no-console
        console.log("MongoDB connected");
        reminderService.start();
        try {
          const { getActiveSeason } = require("./services/seasonService");
          await getActiveSeason();
        } catch (seasonErr) {
          console.warn("Season bootstrap note:", seasonErr.message);
        }
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
