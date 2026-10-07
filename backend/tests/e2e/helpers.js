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

const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

/**
 * A page that only talks to the local test server (plus data:/blob:). Third-party requests
 * (Google sign-in script, fonts, CDNs) are blocked so runs don't hang on the network or DNS.
 * Pass { allowFonts: true } for screenshot harnesses that should render the real typefaces.
 */
async function newHermeticPage(browserOrContext, { allowFonts = false } = {}) {
  const page = await browserOrContext.newPage();
  page.setDefaultNavigationTimeout(60000);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (/^(data|blob|about):/.test(url)) return request.continue();
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch (_err) {
      return request.abort();
    }
    if (host === "127.0.0.1" || host === "localhost" || (allowFonts && FONT_HOSTS.has(host))) {
      return request.continue();
    }
    return request.abort();
  });
  return page;
}

module.exports = { BACKEND, CHROME_PATH, SHOTS_DIR, serverEnv, newHermeticPage };
