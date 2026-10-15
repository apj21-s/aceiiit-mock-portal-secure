// Studio → User Payments lists every registered user (paginated and searched on the server,
// not the 500 the admin snapshot carries) with true totals, and never sends internal fields.
const { createApp } = require("../../app");
const User = require("../../models/User");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;

beforeAll(async () => {
  await startDb();
  app = createApp();
});

afterEach(async () => {
  await clearDb();
});

afterAll(async () => {
  await stopDb();
});

async function seedUsers(count, paidEvery) {
  const docs = Array.from({ length: count }, (_v, i) => ({
    name: `Student ${i + 1}`,
    email: `s${i + 1}@test.local`,
    normalizedEmail: `s${i + 1}@test.local`,
    role: "student",
    status: "active",
    isActivated: true,
    isPaid: paidEvery ? (i + 1) % paidEvery === 0 : false,
    tokenVersion: 3,
    googleSubject: i % 2 ? `google-${i}` : null,
    createdAt: new Date(Date.now() - i * 1000),
  }));
  await User.insertMany(docs);
}

test("lists all users past 500 with true totals and pages; Paid counts every paid user", async () => {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  await seedUsers(520, 10);
  const admin = await loginClient(app, "admin@test.local");

  const first = await admin.get("/api/admin/users-list?page=1&limit=50");
  expect(first.status).toBe(200);
  expect(first.body.counts).toEqual({ all: 521, paid: 52 });
  expect(first.body.pagination).toMatchObject({ page: 1, limit: 50, total: 521, pages: 11 });
  expect(first.body.users).toHaveLength(50);

  const last = await admin.get("/api/admin/users-list?page=11&limit=50");
  expect(last.body.users).toHaveLength(21);

  const paid = await admin.get("/api/admin/users-list?page=2&limit=50&isEnrolledOnly=true");
  expect(paid.body.pagination.total).toBe(52);
  expect(paid.body.users).toHaveLength(2);
  expect(paid.body.users.every((u) => u.isPaid)).toBe(true);

  const search = await admin.get("/api/admin/users-list?search=Student%20519");
  expect(search.body.users.map((u) => u.email)).toEqual(["s519@test.local"]);
});

test("list and details send only what the Studio shows", async () => {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  await seedUsers(2, 0);
  const admin = await loginClient(app, "admin@test.local");
  const list = await admin.get("/api/admin/users-list?search=s2%40test.local");
  const row = list.body.users[0];
  expect(row).toMatchObject({ email: "s2@test.local", signInMethods: ["google"] });
  ["tokenVersion", "googleSubject", "passwordHash", "failedLoginCount", "_id"].forEach((field) => expect(row).not.toHaveProperty(field));

  const details = await admin.get(`/api/admin/users/${row.id}/details`);
  expect(details.status).toBe(200);
  expect(details.body.user).toMatchObject({ id: row.id, email: "s2@test.local" });
  ["tokenVersion", "googleSubject", "passwordHash"].forEach((field) => expect(details.body.user).not.toHaveProperty(field));
  expect(Array.isArray(details.body.payments)).toBe(true);
});
