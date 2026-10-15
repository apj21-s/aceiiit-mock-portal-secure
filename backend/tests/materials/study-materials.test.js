// Study materials are server-backed and free for every signed-in student. Admins upload
// straight to Cloudinary with a signed request; a file is only registered once Cloudinary
// confirms the asset. Cloudinary is stubbed here (no network).
const { createApp } = require("../../app");
const cloudinary = require("../../config/cloudinary");
const StudyFile = require("../../models/StudyFile");
const StudyFolder = require("../../models/StudyFolder");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser } = require("../helpers/fixtures");
const { newClient, loginClient } = require("../helpers/session");

let app;
let savedConfig;

beforeAll(async () => {
  await startDb();
  app = createApp();
  savedConfig = { ...cloudinary.config() };
  cloudinary.config({ cloud_name: "demo-cloud", api_key: "demo-key", api_secret: "demo-secret" });
});

beforeEach(() => {
  jest.spyOn(cloudinary.api, "resource").mockImplementation(async (publicId) => ({ public_id: publicId, bytes: 2048, format: "", type: "authenticated" }));
  jest.spyOn(cloudinary.uploader, "destroy").mockResolvedValue({ result: "ok" });
  jest.spyOn(cloudinary.uploader, "rename").mockResolvedValue({});
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearDb();
});

afterAll(async () => {
  cloudinary.config(savedConfig);
  await stopDb();
});

async function clients() {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  await createUser({ email: "student1@test.local", name: "Free Student" });
  return { admin: await loginClient(app, "admin@test.local"), student: await loginClient(app, "student1@test.local") };
}

async function uploadPdf(admin, folderId, name = "Notes.pdf") {
  const signed = await admin.post("/api/materials/uploads/sign", { folderId, name, bytes: 2048 });
  expect(signed.status).toBe(200);
  return admin.post("/api/materials/files", { folderId, name, publicId: signed.body.publicId, resourceType: signed.body.resourceType });
}

test("listing requires sign-in; any student (free) can list, only admins can change", async () => {
  const anon = await newClient(app);
  expect((await anon.get("/api/materials")).status).toBe(401);
  const { student } = await clients();
  const list = await student.get("/api/materials");
  expect(list.status).toBe(200);
  expect(list.body.folders).toEqual([]);
  expect((await student.post("/api/materials/folders", { name: "Mine" })).status).toBe(403);
  expect((await student.post("/api/materials/uploads/sign", { folderId: "a".repeat(24), name: "x.pdf", bytes: 1 })).status).toBe(403);
});

test("signing checks the folder, file type and size, and signs an authenticated upload", async () => {
  const { admin } = await clients();
  const folder = (await admin.post("/api/materials/folders", { name: "Physics notes", icon: "📘" })).body.folder;
  const bad = await admin.post("/api/materials/uploads/sign", { folderId: folder.id, name: "setup.exe", bytes: 10 });
  expect(bad.status).toBe(400);
  expect(bad.body.code).toBe("MATERIAL_TYPE");
  const big = await admin.post("/api/materials/uploads/sign", { folderId: folder.id, name: "huge.pdf", bytes: 50 * 1024 * 1024 });
  expect(big.body.code).toBe("MATERIAL_TOO_LARGE");
  const missing = await admin.post("/api/materials/uploads/sign", { folderId: "b".repeat(24), name: "a.pdf", bytes: 10 });
  expect(missing.status).toBe(404);

  const ok = await admin.post("/api/materials/uploads/sign", { folderId: folder.id, name: "Kinematics Notes.pdf", bytes: 2048 });
  expect(ok.status).toBe(200);
  expect(ok.body.uploadUrl).toBe("https://api.cloudinary.com/v1_1/demo-cloud/raw/upload");
  expect(ok.body.resourceType).toBe("raw");
  expect(ok.body.publicId).toMatch(/^study-materials\/[a-f0-9]{16}\/Kinematics-Notes\.pdf$/);
  expect(ok.body.fields).toMatchObject({ type: "authenticated", api_key: "demo-key", public_id: ok.body.publicId });
  const expected = cloudinary.utils.api_sign_request({ public_id: ok.body.publicId, timestamp: ok.body.fields.timestamp, type: "authenticated" }, "demo-secret");
  expect(ok.body.fields.signature).toBe(expected);
  const image = await admin.post("/api/materials/uploads/sign", { folderId: folder.id, name: "diagram.PNG", bytes: 10 });
  expect(image.body.resourceType).toBe("image");
});

test("registering needs the asset in storage; duplicate names get (1); students see files without storage ids", async () => {
  const { admin, student } = await clients();
  const folder = (await admin.post("/api/materials/folders", { name: "Maths" })).body.folder;

  cloudinary.api.resource.mockRejectedValueOnce(Object.assign(new Error("not found"), { http_code: 404 }));
  const notUploaded = await uploadPdf(admin, folder.id);
  expect(notUploaded.status).toBe(400);
  expect(notUploaded.body.code).toBe("MATERIAL_NOT_UPLOADED");

  const forged = await admin.post("/api/materials/files", { folderId: folder.id, name: "a.pdf", publicId: "elsewhere/a.pdf", resourceType: "raw" });
  expect(forged.body.code).toBe("MATERIAL_MISMATCH");

  const first = await uploadPdf(admin, folder.id);
  expect(first.status).toBe(201);
  expect(first.body.file).toMatchObject({ name: "Notes.pdf", bytes: 2048, ext: "pdf" });
  const second = await uploadPdf(admin, folder.id);
  expect(second.body.file.name).toBe("Notes (1).pdf");

  const list = await student.get("/api/materials");
  expect(list.body.folders).toHaveLength(1);
  expect(list.body.folders[0].files.map((f) => f.name)).toEqual(["Notes (1).pdf", "Notes.pdf"]);
  expect(JSON.stringify(list.body)).not.toMatch(/study-materials\//);
});

test("downloads redirect to a short-lived signed Cloudinary link (inline or attachment)", async () => {
  const { admin, student } = await clients();
  const folder = (await admin.post("/api/materials/folders", { name: "Chemistry" })).body.folder;
  const file = (await uploadPdf(admin, folder.id)).body.file;
  const download = await student.get(`/api/materials/files/${file.id}/download`);
  expect(download.status).toBe(302);
  const url = new URL(download.headers.location);
  expect(url.host).toBe("api.cloudinary.com");
  expect(url.pathname).toBe("/v1_1/demo-cloud/raw/download");
  expect(url.searchParams.get("type")).toBe("authenticated");
  expect(url.searchParams.get("attachment")).toBe("true");
  expect(Number(url.searchParams.get("expires_at"))).toBeGreaterThan(Date.now() / 1000);
  const inline = await student.get(`/api/materials/files/${file.id}/download?inline=1`);
  expect(new URL(inline.headers.location).searchParams.get("attachment")).toBe("false");
  const anon = await newClient(app);
  expect((await anon.get(`/api/materials/files/${file.id}/download`)).status).toBe(401);
});

test("rename keeps the extension and moves the Cloudinary id; deletes clean up storage", async () => {
  const { admin } = await clients();
  const folder = (await admin.post("/api/materials/folders", { name: "Physics" })).body.folder;
  const file = (await uploadPdf(admin, folder.id)).body.file;
  const renamed = await admin.patch(`/api/materials/files/${file.id}`, { name: "Chapter 1 summary" });
  expect(renamed.status).toBe(200);
  expect(renamed.body.file.name).toBe("Chapter 1 summary.pdf");
  expect(cloudinary.uploader.rename).toHaveBeenCalledWith(
    expect.stringMatching(/\/Notes\.pdf$/),
    expect.stringMatching(/\/Chapter-1-summary\.pdf$/),
    expect.objectContaining({ resource_type: "raw", type: "authenticated" })
  );

  const other = (await uploadPdf(admin, folder.id, "Other.pdf")).body.file;
  expect((await admin.del(`/api/materials/files/${other.id}`)).status).toBe(200);
  expect(cloudinary.uploader.destroy).toHaveBeenCalledTimes(1);

  const removed = await admin.del(`/api/materials/folders/${folder.id}`);
  expect(removed.body.deletedFiles).toBe(1);
  expect(await StudyFile.countDocuments({})).toBe(0);
  expect(await StudyFolder.countDocuments({})).toBe(0);
  expect(cloudinary.uploader.destroy).toHaveBeenCalledTimes(2);
});
