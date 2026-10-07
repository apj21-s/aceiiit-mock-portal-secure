// M4: image uploads (4MB, real-byte type checks, no base64 fallback, controlled storage
// errors) and Google Calendar refresh tokens (encrypted at rest, revoked on disconnect).
const mockRevokeToken = jest.fn(async () => ({}));
jest.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: jest.fn(() => ({ revokeToken: mockRevokeToken, setCredentials: jest.fn(), generateAuthUrl: jest.fn(() => "https://accounts.google.com/x") })) },
    calendar: jest.fn(),
  },
}));
jest.mock("../../utils/uploadToCloudinary", () => ({ uploadBufferToCloudinary: jest.fn() }));

const { uploadBufferToCloudinary } = require("../../utils/uploadToCloudinary");
const { createApp } = require("../../app");
const GoogleCalendarConnection = require("../../models/GoogleCalendarConnection");
const { encryptSecret, decryptSecret, isEncrypted } = require("../../utils/crypto");
const { encryptRefreshToken, readRefreshToken } = require("../../services/googleCalendarService");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser } = require("../helpers/fixtures");
const { loginClient } = require("../helpers/session");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
let app;

beforeAll(async () => {
  process.env.CALENDAR_TOKEN_KEY = "calendar-key-for-tests-0123456789abcdef";
  process.env.GOOGLE_CLIENT_ID = "cid";
  process.env.GOOGLE_CLIENT_SECRET = "csecret";
  await startDb();
  app = createApp();
});

afterEach(async () => {
  uploadBufferToCloudinary.mockReset();
  mockRevokeToken.mockClear();
  await clearDb();
});

afterAll(async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  await stopDb();
});

async function adminClient() {
  await createUser({ email: "admin@test.local", role: "admin", name: "Admin" });
  return loginClient(app, "admin@test.local");
}

function upload(client, buffer, filename, contentType) {
  return client.agent.post("/api/upload-image").set("X-CSRF-Token", client.csrf).attach("image", buffer, { filename, contentType });
}

describe("image uploads", () => {
  test("a valid PNG is stored in Cloudinary and its URL returned", async () => {
    const client = await adminClient();
    uploadBufferToCloudinary.mockResolvedValue({ secure_url: "https://res.cloudinary.com/x/a.png" });
    const res = await upload(client, PNG, "a.png", "image/png");
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://res.cloudinary.com/x/a.png");
  });

  test("over 4MB → 400", async () => {
    const client = await adminClient();
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024 + 10, 1)]);
    const res = await upload(client, big, "big.png", "image/png");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/4MB/);
    expect(uploadBufferToCloudinary).not.toHaveBeenCalled();
  });

  test("a file claiming to be PNG but with other bytes → 400", async () => {
    const client = await adminClient();
    const res = await upload(client, Buffer.from("<svg onload=alert(1)>....padding"), "evil.png", "image/png");
    expect(res.status).toBe(400);
    expect(uploadBufferToCloudinary).not.toHaveBeenCalled();
  });

  test("disallowed declared types (e.g. SVG) → 400", async () => {
    const client = await adminClient();
    const res = await upload(client, Buffer.from("<svg></svg>"), "x.svg", "image/svg+xml");
    expect(res.status).toBe(400);
  });

  test("Cloudinary failure → controlled 502, never a base64 data URI", async () => {
    const client = await adminClient();
    uploadBufferToCloudinary.mockRejectedValue(Object.assign(new Error("boom"), { status: 502 }));
    const res = await upload(client, PNG, "a.png", "image/png");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("IMAGE_STORAGE_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toMatch(/data:image/);
  });

  test("students can't upload", async () => {
    await createUser();
    const client = await loginClient(app, "student1@test.local");
    expect((await upload(client, PNG, "a.png", "image/png")).status).toBe(403);
  });
});

describe("calendar token encryption", () => {
  test("AES-256-GCM round trip; tampering is detected; legacy plaintext still readable", () => {
    const enc = encryptSecret("1//refresh-token");
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toMatch(/refresh-token/);
    expect(decryptSecret(enc)).toBe("1//refresh-token");
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
    expect(decryptSecret("plain-legacy-token")).toBe("plain-legacy-token");
  });

  test("stored connection holds ciphertext; disconnect revokes at Google and clears it", async () => {
    const user = await createUser();
    await GoogleCalendarConnection.create({ userId: user._id, googleAccountId: "sub", refreshToken: encryptRefreshToken("1//rt"), status: "connected" });
    const stored = await GoogleCalendarConnection.findOne({ userId: user._id }).lean();
    expect(stored.refreshToken).not.toMatch(/1\/\/rt/);
    expect(readRefreshToken(stored)).toBe("1//rt");

    const client = await loginClient(app, "student1@test.local");
    const res = await client.post("/api/calendar/google/disconnect");
    expect(res.status).toBe(200);
    expect(mockRevokeToken).toHaveBeenCalledWith("1//rt");
    const after = await GoogleCalendarConnection.findOne({ userId: user._id }).lean();
    expect(after.status).toBe("disconnected");
    expect(after.refreshToken).toBeUndefined();
  });
});
