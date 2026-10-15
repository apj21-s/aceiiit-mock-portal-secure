// Study materials live in the admin's Google Drive (one root folder). Students browse, search,
// open and download through the portal; admins connect Drive, make nested folders, upload,
// rename, move and delete. Nothing outside the root is ever reachable. Google is a fake here.
process.env.CALENDAR_TOKEN_KEY = process.env.CALENDAR_TOKEN_KEY || "test-calendar-token-key-0123456789abcdef";
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
const { Readable } = require("stream");
const { createApp } = require("../../app");
const DriveConnection = require("../../models/DriveConnection");
const drive = require("../../services/driveService");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser } = require("../helpers/fixtures");
const { newClient, loginClient } = require("../helpers/session");

const FOLDER = drive.FOLDER_MIME;
const REFRESH = "1//refresh-token-secret-never-shown";

function fakeDrive() {
  const items = new Map();
  let n = 0;
  const calls = { sessions: [], revoked: [] };
  const fake = { items, calls, failNext: null };
  const add = (props) => {
    n += 1;
    const item = { id: `item${String(n).padStart(6, "0")}xyz`, modifiedTime: "2026-10-15T10:00:00.000Z", trashed: false, parents: [], ...props };
    items.set(item.id, item);
    return item;
  };
  fake.add = add;
  add({ id: "myDriveRootId001", name: "My Drive", mimeType: FOLDER });
  fake.outside = add({ name: "private-taxes.pdf", mimeType: "application/pdf", parents: ["myDriveRootId001"], content: "SECRET" });
  const notFound = () => Object.assign(new Error("File not found"), { code: 404 });
  const matches = (q, item) => {
    if (item.trashed) return false;
    let m;
    if ((m = /^name = '(.+)' and mimeType = '(.+)' and 'root' in parents and trashed = false$/.exec(q))) {
      return item.name === m[1] && item.mimeType === m[2] && item.parents.includes("myDriveRootId001");
    }
    if ((m = /^name contains '(.+)' and trashed = false$/.exec(q))) return item.name.toLowerCase().includes(m[1].toLowerCase());
    const parents = [...q.matchAll(/'([A-Za-z0-9_-]+)' in parents/g)].map((x) => x[1]);
    return parents.some((p) => item.parents.includes(p));
  };
  const check = () => {
    if (fake.failNext) {
      const e = fake.failNext;
      fake.failNext = null;
      throw e;
    }
  };
  const files = {
    async list({ q }) {
      check();
      const out = [...items.values()].filter((it) => matches(q, it)).sort((a, b) => (a.mimeType === FOLDER) === (b.mimeType === FOLDER) ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.mimeType === FOLDER ? -1 : 1);
      return { data: { files: out.map(({ content, ...rest }) => ({ ...rest })) } };
    },
    async get({ fileId, alt, fields }, opts = {}) {
      check();
      const item = items.get(fileId);
      if (!item) throw notFound();
      if (alt === "media") {
        const body = Buffer.from(item.content || "");
        const range = opts.headers && opts.headers.Range;
        if (range) {
          const [, s, e] = /bytes=(\d*)-(\d*)/.exec(range);
          const start = Number(s || 0);
          const end = e ? Number(e) : body.length - 1;
          return { status: 206, headers: { "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${body.length}` }, data: Readable.from([body.subarray(start, end + 1)]) };
        }
        return { status: 200, headers: { "content-length": String(body.length) }, data: Readable.from([body]) };
      }
      if (fields === "thumbnailLink") return { data: { thumbnailLink: item.hasThumbnail ? `https://thumbs.test/${item.id}` : "" } };
      const { content, ...rest } = item;
      return { data: { ...rest, size: content ? String(Buffer.byteLength(content)) : undefined } };
    },
    async export({ fileId }) {
      if (!items.get(fileId)) throw notFound();
      return { status: 200, headers: {}, data: Readable.from([Buffer.from("%PDF-exported")]) };
    },
    async create({ requestBody }) {
      check();
      const item = add({ name: requestBody.name, mimeType: requestBody.mimeType, parents: requestBody.parents || ["myDriveRootId001"] });
      return { data: { ...item } };
    },
    async update({ fileId, addParents, removeParents, requestBody = {} }) {
      check();
      const item = items.get(fileId);
      if (!item) throw notFound();
      if (requestBody.name) item.name = requestBody.name;
      if (requestBody.trashed) item.trashed = true;
      if (requestBody.folderColorRgb !== undefined) item.folderColorRgb = requestBody.folderColorRgb;
      if (addParents) item.parents = item.parents.filter((p) => !String(removeParents || "").split(",").includes(p)).concat([addParents]);
      return { data: { ...item } };
    },
  };
  return Object.assign(fake, {
    impl: {
      authUrl: (state) => `https://accounts.google.test/o/oauth2/auth?state=${state}`,
      exchangeCode: async (code) => (code === "good-code" ? { refreshToken: REFRESH, email: "owner@gmail.test" } : { refreshToken: "", email: "" }),
      revoke: async (token) => calls.revoked.push(token),
      files: (token) => {
        if (token !== REFRESH) throw new Error("wrong token");
        return files;
      },
      createUploadSession: async (token, meta) => {
        calls.sessions.push(meta);
        return `https://www.googleapis.test/upload/session/${calls.sessions.length}`;
      },
      thumbnail: async () => new Response(Buffer.from("PNGDATA"), { status: 200, headers: { "content-type": "image/png" } }),
    },
  });
}

let app;
let fake;

beforeAll(async () => {
  await startDb();
  app = createApp();
});

beforeEach(() => {
  fake = fakeDrive();
  drive.setDriveImplementation(fake.impl);
});

afterEach(async () => {
  drive.setDriveImplementation(null);
  await clearDb();
});

afterAll(stopDb);

async function people() {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  await createUser({ email: "student@test.local", name: "Student" });
  return { admin: await loginClient(app, "admin@test.local"), student: await loginClient(app, "student@test.local") };
}

async function connect(admin) {
  const start = await admin.post("/api/materials/drive/connect", {});
  expect(start.status).toBe(200);
  const state = new URL(start.body.url).searchParams.get("state");
  const back = await admin.agent.get(`/api/materials/drive/callback?code=good-code&state=${state}`);
  expect(back.status).toBe(302);
  expect(back.headers.location).toBe("/?drive=connected#admin");
  return [...fake.items.values()].find((i) => i.name === drive.DEFAULT_ROOT_NAME);
}

describe("connecting Google Drive", () => {
  test("before connecting, students see that materials aren't available and nothing breaks", async () => {
    const { student, admin } = await people();
    expect((await student.get("/api/materials")).body).toEqual({ connected: false });
    expect((await admin.get("/api/materials/drive")).body.drive).toEqual({ connected: false });
    expect((await (await newClient(app)).get("/api/materials")).status).toBe(401);
  });

  test("the OAuth state must match; the token is encrypted at rest and never returned", async () => {
    const { admin, student } = await people();
    expect((await student.post("/api/materials/drive/connect", {})).status).toBe(403);
    await admin.post("/api/materials/drive/connect", {});
    const forged = await admin.agent.get("/api/materials/drive/callback?code=good-code&state=forged");
    expect(forged.status).toBe(400);
    const root = await connect(admin);
    expect(root).toBeTruthy();
    const doc = await DriveConnection.findOne({}).lean();
    expect(doc.refreshToken).not.toContain(REFRESH);
    expect(doc.rootFolderId).toBe(root.id);
    const status = await admin.get("/api/materials/drive");
    expect(status.body.drive).toMatchObject({ connected: true, accountEmail: "owner@gmail.test", root: { id: root.id, name: drive.DEFAULT_ROOT_NAME } });
    expect(JSON.stringify(status.body)).not.toContain(REFRESH);
  });

  test("an existing root folder is reused, and admins can point at another folder by link", async () => {
    const { admin } = await people();
    const existing = fake.add({ name: drive.DEFAULT_ROOT_NAME, mimeType: FOLDER, parents: ["myDriveRootId001"] });
    expect((await connect(admin)).id).toBe(existing.id);
    const other = fake.add({ name: "Notes 2027", mimeType: FOLDER, parents: ["myDriveRootId001"] });
    const set = await admin.post("/api/materials/drive/root", { folder: `https://drive.google.com/drive/folders/${other.id}?usp=sharing` });
    expect(set.body.root).toEqual({ id: other.id, name: "Notes 2027" });
    expect((await admin.post("/api/materials/drive/root", { folder: fake.outside.id })).status).toBe(400);
  });

  test("disconnecting revokes the token at Google and forgets it", async () => {
    const { admin } = await people();
    await connect(admin);
    expect((await admin.post("/api/materials/drive/disconnect", {})).status).toBe(200);
    expect(fake.calls.revoked).toEqual([REFRESH]);
    expect(await DriveConnection.countDocuments({})).toBe(0);
  });
});

describe("browsing", () => {
  async function library() {
    const p = await people();
    const root = await connect(p.admin);
    const physics = fake.add({ name: "Physics", mimeType: FOLDER, parents: [root.id], folderColorRgb: "#4285f4" });
    const mechanics = fake.add({ name: "Mechanics", mimeType: FOLDER, parents: [physics.id] });
    fake.add({ name: "Chemistry", mimeType: FOLDER, parents: [root.id] });
    for (let i = 1; i <= 60; i += 1) fake.add({ name: `Notes ${i}.pdf`, mimeType: "application/pdf", parents: [physics.id], content: `pdf-${i}` });
    const kinematics = fake.add({ name: "Kinematics.pdf", mimeType: "application/pdf", parents: [mechanics.id], content: "0123456789" });
    return { ...p, root, physics, mechanics, kinematics };
  }

  test("a folder lists its subfolders first, then its files in natural order, with counts", async () => {
    const { student, physics } = await library();
    const top = (await student.get("/api/materials")).body;
    expect(top).toMatchObject({ connected: true, folder: { name: "Study material", isRoot: true } });
    expect(top.folders.map((f) => f.name)).toEqual(["Chemistry", "Physics"]);
    expect(top.folders[1]).toMatchObject({ itemCount: 61, color: "#4285f4" });
    const inner = (await student.get(`/api/materials?folder=${physics.id}`)).body;
    expect(inner.breadcrumbs.map((b) => b.name)).toEqual(["Study material", "Physics"]);
    expect(inner.folders.map((f) => f.name)).toEqual(["Mechanics"]);
    expect(inner.files).toHaveLength(60);
    expect(inner.files.slice(0, 3).map((f) => f.name)).toEqual(["Notes 1.pdf", "Notes 2.pdf", "Notes 3.pdf"]);
  });

  test("files added directly in Google Drive appear (after the short cache, or a refresh)", async () => {
    const { student, admin, mechanics } = await library();
    await student.get(`/api/materials?folder=${mechanics.id}`);
    fake.add({ name: "Added in Drive.pdf", mimeType: "application/pdf", parents: [mechanics.id], content: "x" });
    expect((await admin.post("/api/materials/refresh", {})).status).toBe(200);
    const names = (await student.get(`/api/materials?folder=${mechanics.id}`)).body.files.map((f) => f.name);
    expect(names).toContain("Added in Drive.pdf");
  });

  test("anything outside the study-materials folder is unreachable", async () => {
    const { student } = await library();
    expect((await student.get(`/api/materials?folder=myDriveRootId001`)).status).toBe(404);
    expect((await student.get(`/api/materials/files/${fake.outside.id}/content`)).status).toBe(404);
    expect((await student.get(`/api/materials/files/${fake.outside.id}/thumbnail`)).status).toBe(404);
    expect((await student.get("/api/materials?folder=../../etc")).status).toBe(400);
    const found = (await student.get("/api/materials/search?q=taxes")).body.items;
    expect(found).toEqual([]);
  });

  test("search finds files under the root, with their folder path", async () => {
    const { student } = await library();
    const items = (await student.get("/api/materials/search?q=kinem")).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Kinematics.pdf", path: ["Study material", "Physics", "Mechanics"] });
  });

  test("files stream through the portal: PDFs inline with Range support, downloads as attachments", async () => {
    const { student, kinematics } = await library();
    const whole = await student.get(`/api/materials/files/${kinematics.id}/content`);
    expect(whole.status).toBe(200);
    expect(whole.headers["content-type"]).toMatch(/application\/pdf/);
    expect(whole.headers["content-disposition"]).toMatch(/^inline/);
    expect(whole.body.toString()).toBe("0123456789");
    const part = await student.agent.get(`/api/materials/files/${kinematics.id}/content`).set("Range", "bytes=2-5");
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 2-5/10");
    const dl = await student.get(`/api/materials/files/${kinematics.id}/content?download=1`);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; filename="Kinematics.pdf"/);
  });

  test("risky types never render on the portal's origin; Google Docs come as PDF", async () => {
    const { student, root } = await library();
    const html = fake.add({ name: "page.html", mimeType: "text/html", parents: [root.id], content: "<script>alert(1)</script>" });
    const res = await student.get(`/api/materials/files/${html.id}/content`);
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const doc = fake.add({ name: "Formula sheet", mimeType: "application/vnd.google-apps.document", parents: [root.id] });
    const pdf = await student.get(`/api/materials/files/${doc.id}/content`);
    expect(pdf.headers["content-type"]).toMatch(/application\/pdf/);
    expect(pdf.headers["content-disposition"]).toMatch(/Formula sheet\.pdf/);
  });

  test("a revoked Google grant asks the admin to reconnect", async () => {
    const { student, admin, physics } = await library();
    fake.failNext = Object.assign(new Error("invalid_grant: Token has been expired or revoked."), { code: 400 });
    const res = await student.get(`/api/materials?folder=${physics.id}`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("DRIVE_RECONNECT");
    expect((await admin.get("/api/materials/drive")).body.drive.needsReconnect).toBe(true);
  });
});

describe("managing (admins only)", () => {
  async function setup() {
    const p = await people();
    const root = await connect(p.admin);
    return { ...p, root };
  }

  test("students can't change anything", async () => {
    const { student, root } = await setup();
    expect((await student.post("/api/materials/folders", { name: "x" })).status).toBe(403);
    expect((await student.agent.patch(`/api/materials/items/${root.id}`).set("X-CSRF-Token", student.csrf).send({ name: "y" })).status).toBe(403);
    expect((await student.del(`/api/materials/items/${root.id}`)).status).toBe(403);
    expect((await student.post("/api/materials/uploads/session", { name: "a.pdf", size: 1 })).status).toBe(403);
  });

  test("folders nest to any depth; rename, recolour, move and delete (to Drive's trash)", async () => {
    const { admin, root } = await setup();
    const physics = (await admin.post("/api/materials/folders", { name: "Physics" })).body.folder;
    const mech = (await admin.post("/api/materials/folders", { parentId: physics.id, name: "Mechanics" })).body.folder;
    const deep = (await admin.post("/api/materials/folders", { parentId: mech.id, name: "Rotation" })).body.folder;
    expect(fake.items.get(deep.id).parents).toEqual([mech.id]);
    const patch = (id, body) => admin.agent.patch(`/api/materials/items/${id}`).set("X-CSRF-Token", admin.csrf).send(body);
    expect((await patch(mech.id, { name: "Mechanics (Class 11)", color: "#0f9d58" })).body.item).toMatchObject({ name: "Mechanics (Class 11)", color: "#0f9d58" });
    expect((await patch(physics.id, { parentId: deep.id })).status).toBe(400); // into its own subfolder
    expect((await patch(deep.id, { parentId: root.id })).status).toBe(200);
    expect(fake.items.get(deep.id).parents).toEqual([root.id]);
    expect((await patch(root.id, { name: "Renamed" })).status).toBe(400);
    expect((await admin.del(`/api/materials/items/${root.id}`)).status).toBe(400);
    expect((await admin.del(`/api/materials/items/${deep.id}`)).status).toBe(200);
    expect(fake.items.get(deep.id).trashed).toBe(true);
    const names = (await admin.get("/api/materials")).body.folders.map((f) => f.name);
    expect(names).toEqual(["Physics"]);
    expect((await patch(fake.outside.id, { name: "mine now" })).status).toBe(404);
  });

  test("uploads go straight to Drive through a resumable session, then show up", async () => {
    const { admin, root } = await setup();
    const physics = (await admin.post("/api/materials/folders", { name: "Physics" })).body.folder;
    const session = await admin.post("/api/materials/uploads/session", { parentId: physics.id, name: "Optics.pdf", mimeType: "application/pdf", size: 2048 });
    expect(session.status).toBe(200);
    expect(session.body.uploadUrl).toMatch(/^https:\/\/www\.googleapis\.test\/upload\/session\//);
    expect(fake.calls.sessions[0]).toMatchObject({ name: "Optics.pdf", parentId: physics.id, size: 2048 });
    // The browser's PUT to Drive creates the file there:
    const uploaded = fake.add({ name: "Optics.pdf", mimeType: "application/pdf", parents: [physics.id], content: "pdf" });
    const done = await admin.post("/api/materials/uploads/complete", { fileId: uploaded.id });
    expect(done.body.file).toMatchObject({ id: uploaded.id, name: "Optics.pdf" });
    expect((await admin.get(`/api/materials?folder=${physics.id}`)).body.files.map((f) => f.name)).toEqual(["Optics.pdf"]);
    expect((await admin.post("/api/materials/uploads/complete", { fileId: fake.outside.id })).status).toBe(404);
    expect((await admin.post("/api/materials/uploads/session", { parentId: root.id, name: "huge.zip", size: 500 * 1024 * 1024 })).status).toBe(413);
    expect((await admin.post("/api/materials/uploads/session", { parentId: fake.outside.id, name: "x.pdf", size: 1 })).status).toBe(404);
  });
});
