// Shared settings for the browser E2E suites (run with `npm run test:e2e`).
const path = require("path");

const BACKEND = path.join(__dirname, "..", "..");
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const SHOTS_DIR = process.env.E2E_SHOTS_DIR || path.join(BACKEND, "node_modules", ".cache", "e2e-shots");

/**
 * A clean environment for the throwaway server: an in-memory DB and no backend/.env
 * (which may hold production credentials), so no real email/Sentry/AI calls happen.
 */
function serverEnv(extra) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ACEIIIT_SKIP_DOTENV: "1",
    NODE_ENV: "development",
    LOG_LEVEL: "warn",
    JWT_SECRET: "e2e-jwt-secret-0123456789abcdef-0123456789",
    AI_INTERPRETATION_ENABLED: "false",
    ...extra,
  };
}

module.exports = { BACKEND, CHROME_PATH, SHOTS_DIR, serverEnv };
