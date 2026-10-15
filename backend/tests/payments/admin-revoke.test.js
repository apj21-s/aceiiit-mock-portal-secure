// Studio "Revoke Paid Access" must remove real access (entitlements), not just the isPaid flag.
const { createApp } = require("../../app");
const Entitlement = require("../../models/Entitlement");
const PaymentRecord = require("../../models/PaymentRecord");
const User = require("../../models/User");
const { getActiveSeason } = require("../../services/seasonService");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, createTest } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
beforeAll(async () => { await startDb(); app = createApp(); });
afterEach(clearDb);
afterAll(stopDb);

test("revoking in Studio closes every paid test, and logging in again doesn't re-grant", async () => {
  const season = await getActiveSeason();
  const student = await createUser({ email: "pro@test.local" });
  await Entitlement.create({ email: "pro@test.local", normalizedEmail: "pro@test.local", seasonId: season._id, tier: "paid", status: "active", source: "admin" });
  await PaymentRecord.create({ seasonId: season._id, email: "pro@test.local", normalizedEmail: "pro@test.local", status: "verified", source: "commerce" });
  const paid = await createTest({ isFree: false });
  let s = await loginClient(app, "pro@test.local");
  expect((await s.get(`/api/tests/${paid._id}`)).status).toBe(200);

  await createUser({ email: "admin@test.local", role: "admin" });
  const a = await loginClient(app, "admin@test.local");
  expect((await a.post(`/api/admin/users/${student._id}/revoke-payment`, {})).status).toBe(200);

  expect((await s.get(`/api/tests/${paid._id}`)).status).not.toBe(200);
  s = await loginClient(app, "pro@test.local");
  expect((await s.get(`/api/tests/${paid._id}`)).status).not.toBe(200);
  expect(await Entitlement.countDocuments({ status: "active" })).toBe(0);
  expect((await User.findById(student._id).lean()).isPaid).toBe(false);
});
