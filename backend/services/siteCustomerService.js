const { MemoryCache } = require("../utils/memoryCache");
const { logger, errorSummary } = require("../utils/logger");

// The AceIIIT site's read-only lookups (its /api/internal/portal routes): a student's orders,
// payments, payment screenshots and verified entitlements. Used by the Studio's user details
// and by the mentor's enrolled tier. Authenticated by the shared INTERNAL_API_SECRET (the
// same secret the site sends when it provisions access here). No site URL → not connected.

const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RECEIPT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
const cache = new MemoryCache(1000);

function siteBase() {
  return String(process.env.ACEIIIT_SITE_URL || "").trim().replace(/\/+$/, "");
}

function isConfigured() {
  return Boolean(siteBase() && process.env.INTERNAL_API_SECRET);
}

function siteError(message) {
  return Object.assign(new Error(message), { status: 502, expose: true, code: "SITE_UNAVAILABLE" });
}

async function callSite(pathAndQuery) {
  try {
    return await fetch(`${siteBase()}/api${pathAndQuery}`, {
      headers: { "x-internal-api-secret": String(process.env.INTERNAL_API_SECRET || ""), accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err: errorSummary(err) }, "AceIIIT site lookup failed");
    throw siteError("The AceIIIT site didn't respond. Try again in a moment.");
  }
}

/** Orders, payments and verified entitlements for an email (cached for 5 minutes). */
async function getSiteCustomer(email, { fresh = false } = {}) {
  if (!isConfigured()) return { configured: false };
  const key = String(email || "").trim().toLowerCase();
  if (!key) return { configured: true, found: false, orders: [], entitlements: [] };
  if (!fresh) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const res = await callSite(`/internal/portal/customer?email=${encodeURIComponent(key)}`);
  if (!res.ok) {
    logger.warn({ status: res.status }, "AceIIIT site customer lookup refused");
    throw siteError("The AceIIIT site couldn't look this student up.");
  }
  const data = await res.json().catch(() => ({}));
  const value = {
    configured: true,
    found: Boolean(data.found),
    customer: data.customer || null,
    orders: Array.isArray(data.orders) ? data.orders : [],
    entitlements: Array.isArray(data.entitlements) ? data.entitlements : [],
  };
  return cache.set(key, value, CACHE_TTL_MS);
}

/** A payment screenshot from the site, only for that student's own payment. */
async function fetchSiteReceipt(email, paymentId) {
  if (!isConfigured()) throw Object.assign(new Error("The AceIIIT site isn't connected."), { status: 503, expose: true });
  if (!/^[0-9a-f-]{8,64}$/i.test(String(paymentId || ""))) throw Object.assign(new Error("Invalid payment id."), { status: 400, expose: true });
  const res = await callSite(`/internal/portal/payments/${encodeURIComponent(paymentId)}/receipt?email=${encodeURIComponent(String(email || "").toLowerCase())}`);
  if (res.status === 404) throw Object.assign(new Error("Receipt not found."), { status: 404, expose: true });
  if (!res.ok) throw siteError("The AceIIIT site couldn't send this receipt.");
  const contentType = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!RECEIPT_TYPES.has(contentType)) throw siteError("The receipt has an unexpected file type.");
  return { contentType, body: Buffer.from(await res.arrayBuffer()) };
}

function clearSiteCustomerCache() {
  cache.deleteByPrefix("");
}

module.exports = { isConfigured, getSiteCustomer, fetchSiteReceipt, clearSiteCustomerCache };
