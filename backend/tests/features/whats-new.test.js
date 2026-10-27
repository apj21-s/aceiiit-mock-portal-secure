// "What's new": admins write and publish notes in Studio; each student sees the newest note
// once (per account, not per device), only if it's for their audience (paid from the real
// entitlement) and only if it was published after their account existed.
const { createApp } = require("../../app");
const Season = require("../../models/Season");
const ReleaseNote = require("../../models/ReleaseNote");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser, grantEntitlementFor } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

let app;
beforeAll(async () => { await startDb(); app = createApp(); });
afterEach(clearDb);
afterAll(stopDb);

const note = (over = {}) => ({
  title: "Practice papers are here",
  summary: "Build a paper from any topic in seconds.",
  items: [{ icon: "🧪", title: "Custom practice", body: "Pick a subject and a size." }, { icon: "📊", title: "Topic analysis" }],
  ctaLabel: "Try it",
  ctaHref: "#exams/practice",
  ...over,
});

async function setup() {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  const free = await createUser({ email: "free@test.local", name: "Free" });
  const paid = await createUser({ email: "paid@test.local", name: "Paid" });
  const season = await Season.create({ name: "UGEE 2026", year: 2026, status: "active", isDefaultActive: true });
  await grantEntitlementFor(paid, season._id);
  return {
    admin: await loginClient(app, "admin@test.local"),
    free: await loginClient(app, "free@test.local"),
    paid: await loginClient(app, "paid@test.local"),
    freeUser: free,
  };
}

async function publish(admin, body) {
  const created = await admin.post("/api/admin/whats-new", body);
  expect(created.status).toBe(201);
  const id = created.body.note.id;
  expect((await admin.post(`/api/admin/whats-new/${id}/publish`)).status).toBe(200);
  return id;
}

test("a published note shows once per account; drafts never show", async () => {
  const { admin, free } = await setup();
  const draft = await admin.post("/api/admin/whats-new", note({ title: "Draft only" }));
  expect(draft.body.note.status).toBe("draft");
  expect((await free.get("/api/whats-new")).body.note).toBeNull();
  const id = await publish(admin, note());
  const shown = await free.get("/api/whats-new");
  expect(shown.body.note).toMatchObject({ id, title: "Practice papers are here", cta: { label: "Try it", href: "#exams/practice" }, items: [{ icon: "🧪", title: "Custom practice" }, { title: "Topic analysis", body: "" }] });
  expect(shown.body.note.audience).toBeUndefined(); // admin-only fields stay in Studio
  expect((await free.post("/api/whats-new/seen")).status).toBe(200);
  expect((await free.get("/api/whats-new")).body.note).toBeNull();
  // The "What's new" link can still reopen the latest one.
  expect((await free.get("/api/whats-new?latest=1")).body.note.id).toBe(id);
});

test("audience: paid notes reach only students with an active entitlement", async () => {
  const { admin, free, paid } = await setup();
  await publish(admin, note({ title: "For enrolled students", audience: "paid" }));
  expect((await free.get("/api/whats-new")).body.note).toBeNull();
  expect((await paid.get("/api/whats-new")).body.note.title).toBe("For enrolled students");
  await publish(admin, note({ title: "For free students", audience: "free" }));
  expect((await free.get("/api/whats-new")).body.note.title).toBe("For free students");
  expect((await paid.get("/api/whats-new")).body.note.title).toBe("For enrolled students");
});

test("new accounts don't get old news; a newer note shows after an older one was seen", async () => {
  const { admin, free } = await setup();
  await publish(admin, note({ title: "Old news" }));
  await createUser({ email: "late@test.local", name: "Late" });
  const late = await loginClient(app, "late@test.local");
  expect((await late.get("/api/whats-new")).body.note).toBeNull();
  await free.post("/api/whats-new/seen");
  await new Promise((r) => setTimeout(r, 15));
  await publish(admin, note({ title: "Newer news" }));
  expect((await free.get("/api/whats-new")).body.note.title).toBe("Newer news");
  expect((await late.get("/api/whats-new")).body.note.title).toBe("Newer news");
});

test("validation: https images, safe button links, 1–6 items, both label and link", async () => {
  const { admin } = await setup();
  const bad = async (body, field) => {
    const res = await admin.post("/api/admin/whats-new", note(body));
    expect(res.status).toBe(400);
    if (field) expect(res.body.field).toBe(field);
  };
  await bad({ imageUrl: "http://example.com/a.png" }, "imageUrl");
  await bad({ ctaHref: "javascript:alert(1)" }, "ctaHref");
  await bad({ ctaHref: "" }, "ctaHref");
  await bad({ items: [] }, "items");
  await bad({ items: Array.from({ length: 7 }, (_, i) => ({ title: `Item ${i}` })) }, "items");
  await bad({ title: "" }, "title");
  await bad({ extra: true });
  await bad({ items: [{ title: "Bad link", href: "javascript:alert(1)" }] }, "items.0.href");
  await bad({ items: [{ title: "Plain http", href: "http://example.com" }] }, "items.0.href");
  const linked = await admin.post("/api/admin/whats-new", note({ items: [{ icon: "🎯", title: "Practice", href: "#exams/practice" }, { title: "Site", href: "https://aceiiit.in" }] }));
  expect(linked.status).toBe(201);
  expect(linked.body.note.items.map((i) => i.href)).toEqual(["#exams/practice", "https://aceiiit.in"]);
  const ok = await admin.post("/api/admin/whats-new", note({ imageUrl: "https://example.com/a.png", ctaHref: "https://aceiiit.in/#packages" }));
  expect(ok.status).toBe(201);
  // Text is stored as typed (the client renders it as text, never HTML).
  const html = await admin.post("/api/admin/whats-new", note({ title: "<img src=x onerror=alert(1)>" }));
  expect(html.status).toBe(201);
  expect(html.body.note.title).toBe("<img src=x onerror=alert(1)>");
});

test("only admins manage notes; edit, unpublish and delete work", async () => {
  const { admin, free } = await setup();
  expect((await free.get("/api/admin/whats-new")).status).toBe(403);
  expect((await free.post("/api/admin/whats-new", note())).status).toBe(403);
  const id = await publish(admin, note());
  expect((await free.post(`/api/admin/whats-new/${id}/unpublish`)).status).toBe(403);
  const edited = await admin.put(`/api/admin/whats-new/${id}`, note({ title: "Fixed typo" }));
  expect(edited.body.note).toMatchObject({ title: "Fixed typo", status: "published" });
  expect((await admin.get("/api/admin/whats-new")).body.notes.map((n) => n.title)).toEqual(["Fixed typo"]);
  await admin.post(`/api/admin/whats-new/${id}/unpublish`);
  expect((await free.get("/api/whats-new")).body.note).toBeNull();
  expect((await admin.del(`/api/admin/whats-new/${id}`)).status).toBe(200);
  expect(await ReleaseNote.countDocuments({})).toBe(0);
  expect((await admin.del(`/api/admin/whats-new/${id}`)).status).toBe(404);
});

test("signed-out visitors get nothing", async () => {
  const request = require("supertest");
  expect((await request(app).get("/api/whats-new")).status).toBe(401);
});
