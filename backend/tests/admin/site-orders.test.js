// Studio user Details → "On the AceIIIT site": the portal reads a student's orders, payments,
// entitlements and payment screenshot from the site's read-only internal API (shared secret),
// admin-only, and streams screenshots itself. The site is faked by stubbing global fetch.
const { createApp } = require("../../app");
const { clearSiteCustomerCache } = require("../../services/siteCustomerService");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
const realFetch = global.fetch;
const savedSecret = process.env.INTERNAL_API_SECRET;

beforeAll(async () => {
  await startDb();
  app = createApp();
});

beforeEach(() => {
  process.env.INTERNAL_API_SECRET = "test-internal-secret-0123456789-abcdefghij";
  process.env.ACEIIIT_SITE_URL = "https://site.test.invalid/";
  clearSiteCustomerCache();
});

afterEach(async () => {
  global.fetch = realFetch;
  delete process.env.ACEIIIT_SITE_URL;
  if (savedSecret === undefined) delete process.env.INTERNAL_API_SECRET;
  else process.env.INTERNAL_API_SECRET = savedSecret;
  await clearDb();
});

afterAll(async () => {
  await stopDb();
});

const SITE_CUSTOMER = {
  found: true,
  customer: { name: "Riya Sharma", phone: "9", college: "", year: "", createdAt: "2026-10-01T00:00:00.000Z", deleted: false },
  orders: [{
    orderNumber: "ACE-1", status: "PAID", total: 1180, currency: "INR", createdAt: "2026-10-02T00:00:00.000Z",
    items: [{ productName: "Paid Mock Series", quantity: 1, unitPrice: 1000, lineTotal: 1180 }],
    payments: [{ id: "11111111-2222-3333-4444-555555555555", method: "MANUAL_UPI", status: "VERIFIED", utr: "123456789012", amount: 1180, hasReceipt: true, receiptType: "png" }],
  }],
  entitlements: [{ resourceCode: "CLASS_NOTES", status: "ACTIVE" }],
};

function fakeSite() {
  const calls = [];
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url: String(url), headers: (init && init.headers) || {} });
    if (String(url).includes("/receipt")) {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(JSON.stringify(SITE_CUSTOMER), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

async function setup() {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  const student = await createUser({ email: "riya@test.local", name: "Riya" });
  await createUser({ email: "other@test.local", name: "Other" });
  return { student, admin: await loginClient(app, "admin@test.local"), other: await loginClient(app, "other@test.local") };
}

test("admins get the student's site orders through the shared secret; students can't", async () => {
  const { student, admin, other } = await setup();
  const calls = fakeSite();
  const res = await admin.get(`/api/admin/users/${student._id}/site-orders`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ configured: true, found: true, entitlements: [{ resourceCode: "CLASS_NOTES", status: "ACTIVE" }] });
  expect(res.body.orders[0].payments[0]).toMatchObject({ status: "VERIFIED", utr: "123456789012", hasReceipt: true });
  expect(calls[0].url).toBe("https://site.test.invalid/api/internal/portal/customer?email=riya%40test.local");
  expect(calls[0].headers["x-internal-api-secret"]).toBe(process.env.INTERNAL_API_SECRET);
  expect((await other.get(`/api/admin/users/${student._id}/site-orders`)).status).toBe(403);
});

test("the payment screenshot is streamed by the portal with a safe content type", async () => {
  const { student, admin } = await setup();
  fakeSite();
  const res = await admin.get(`/api/admin/users/${student._id}/site-receipts/11111111-2222-3333-4444-555555555555`);
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe("image/png");
  expect(res.headers["cache-control"]).toBe("private, no-store");
  expect((await admin.get(`/api/admin/users/${student._id}/site-receipts/not..valid`)).status).toBe(400);
});

test("not connected and site errors are reported, not crashed", async () => {
  const { student, admin } = await setup();
  delete process.env.ACEIIIT_SITE_URL;
  const notConnected = await admin.get(`/api/admin/users/${student._id}/site-orders`);
  expect(notConnected.body).toEqual({ configured: false });
  process.env.ACEIIIT_SITE_URL = "https://site.test.invalid";
  global.fetch = jest.fn(async () => { throw new Error("getaddrinfo ENOTFOUND"); });
  const down = await admin.get(`/api/admin/users/${student._id}/site-orders`);
  expect(down.status).toBe(502);
  expect(down.body.error).toMatch(/didn't respond/);
  expect(JSON.stringify(down.body)).not.toMatch(/ENOTFOUND|site\.test\.invalid/);
});
