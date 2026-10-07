// M1: Google/Apple sign-in verifies signature, issuer, audience, expiry and subject,
// fails closed, never accepts mock credentials unless explicitly enabled outside production,
// and only links accounts by provider subject or a provider-verified email.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const { createApp } = require("../../app");
const User = require("../../models/User");
const { startDb, clearDb, stopDb } = require("../helpers/db");
const { createUser } = require("../helpers/fixtures");
const { newClient } = require("../helpers/session");

const GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
const APPLE_CLIENT_ID = "in.aceiiit.test";
const KID = "test-kid-1";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const attackerKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = Object.assign(publicKey.export({ format: "jwk" }), { kid: KID, alg: "RS256", use: "sig" });

function googleToken(claims = {}, options = {}) {
  return jwt.sign(
    { sub: "google-sub-1", email: "g.user@test.local", email_verified: true, name: "G User", ...claims },
    options.key || privateKey,
    {
      algorithm: "RS256",
      keyid: KID,
      issuer: options.issuer || "https://accounts.google.com",
      audience: options.audience || GOOGLE_CLIENT_ID,
      expiresIn: options.expiresIn || "10m",
    }
  );
}

function appleToken(claims = {}, options = {}) {
  return jwt.sign(
    { sub: "apple-sub-1", email: "a.user@test.local", email_verified: "true", ...claims },
    options.key || privateKey,
    {
      algorithm: "RS256",
      keyid: KID,
      issuer: "https://appleid.apple.com",
      audience: options.audience || APPLE_CLIENT_ID,
      expiresIn: options.expiresIn || "10m",
    }
  );
}

let app;
let fetchSpy;

beforeAll(async () => {
  await startDb();
  app = createApp();
});

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
  process.env.APPLE_CLIENT_ID = APPLE_CLIENT_ID;
  delete process.env.ALLOW_INSECURE_DEV_AUTH;
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("googleapis.com/oauth2/v3/certs") || String(url).includes("appleid.apple.com/auth/keys")) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.APPLE_CLIENT_ID;
  delete process.env.ALLOW_INSECURE_DEV_AUTH;
  await clearDb();
});

afterAll(async () => {
  await stopDb();
});

async function postGoogle(body) {
  const client = await newClient(app);
  return client.post("/api/auth/google", body);
}

async function postApple(body) {
  const client = await newClient(app);
  return client.post("/api/auth/apple", body);
}

describe("Google sign-in", () => {
  test("mock_google_ credential is rejected (401) without the dev opt-in", async () => {
    const res = await postGoogle({ credential: "mock_google_admin@test.local", email: "admin@test.local" });
    expect(res.status).toBe(401);
    expect(await User.countDocuments({})).toBe(0);
  });

  test("a body email without a credential is rejected", async () => {
    const res = await postGoogle({ email: "admin@test.local" });
    expect(res.status).toBe(400);
  });

  test("a token signed by an attacker key is rejected (401)", async () => {
    const res = await postGoogle({ credential: googleToken({}, { key: attackerKeys.privateKey }) });
    expect(res.status).toBe(401);
  });

  test("a token for another app's audience is rejected (401)", async () => {
    const res = await postGoogle({ credential: googleToken({}, { audience: "someone-else.apps.googleusercontent.com" }) });
    expect(res.status).toBe(401);
  });

  test("a token from the wrong issuer is rejected (401)", async () => {
    const res = await postGoogle({ credential: googleToken({}, { issuer: "https://evil.example" }) });
    expect(res.status).toBe(401);
  });

  test("an expired token is rejected (401)", async () => {
    const res = await postGoogle({ credential: googleToken({}, { expiresIn: -60 }) });
    expect(res.status).toBe(401);
  });

  test("an unverified Google email is rejected (401)", async () => {
    const res = await postGoogle({ credential: googleToken({ email_verified: false }) });
    expect(res.status).toBe(401);
  });

  test("Google not configured fails closed (503)", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await postGoogle({ credential: googleToken() });
    expect(res.status).toBe(503);
  });

  test("a valid token signs in and sets the session cookie", async () => {
    const res = await postGoogle({ credential: googleToken() });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("g.user@test.local");
    expect(res.body.token).toBeUndefined();
    expect(String(res.headers["set-cookie"])).toMatch(/aceiiit_session=/);
    const user = await User.findOne({ email: "g.user@test.local" });
    expect(user.googleSubject).toBe("google-sub-1");
  });

  test("the request-body email can't override the verified token email", async () => {
    const res = await postGoogle({ credential: googleToken(), email: "admin@test.local" });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("g.user@test.local");
    expect(res.body.user.role).toBe("student");
  });

  test("links an existing password account only via the provider-verified email", async () => {
    await createUser({ email: "g.user@test.local" });
    const res = await postGoogle({ credential: googleToken() });
    expect(res.status).toBe(200);
    expect(await User.countDocuments({ email: "g.user@test.local" })).toBe(1);
    expect((await User.findOne({ email: "g.user@test.local" })).googleSubject).toBe("google-sub-1");
  });

  test("refuses to relink an email already bound to a different Google subject", async () => {
    await createUser({ email: "g.user@test.local", googleSubject: "google-sub-OTHER" });
    const res = await postGoogle({ credential: googleToken() });
    expect(res.status).toBe(409);
  });

  test("dev mocks work only with ALLOW_INSECURE_DEV_AUTH=true outside production", async () => {
    process.env.ALLOW_INSECURE_DEV_AUTH = "true";
    const res = await postGoogle({ credential: "mock_google_dev@test.local" });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("dev@test.local");
  });
});

describe("Apple sign-in", () => {
  test("mock_apple_ token is rejected (401) without the dev opt-in", async () => {
    const res = await postApple({ identityToken: "mock_apple_admin@test.local", email: "admin@test.local" });
    expect(res.status).toBe(401);
  });

  test("a forged (badly signed) token is rejected (401) with no unsigned fallback", async () => {
    const forged = appleToken({ email: "admin@test.local" }, { key: attackerKeys.privateKey });
    const res = await postApple({ identityToken: forged });
    expect(res.status).toBe(401);
    expect(await User.countDocuments({})).toBe(0);
  });

  test("an unsigned alg:none token is rejected (401)", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", kid: KID })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "x", email: "admin@test.local", iss: "https://appleid.apple.com", aud: APPLE_CLIENT_ID })).toString("base64url");
    const res = await postApple({ identityToken: `${header}.${payload}.` });
    expect(res.status).toBe(401);
  });

  test("a wrong-audience token is rejected (401)", async () => {
    const res = await postApple({ identityToken: appleToken({}, { audience: "com.other.app" }) });
    expect(res.status).toBe(401);
  });

  test("an expired token is rejected (401)", async () => {
    const res = await postApple({ identityToken: appleToken({}, { expiresIn: -60 }) });
    expect(res.status).toBe(401);
  });

  test("Apple not configured fails closed (503)", async () => {
    delete process.env.APPLE_CLIENT_ID;
    const res = await postApple({ identityToken: appleToken() });
    expect(res.status).toBe(503);
  });

  test("a valid token signs in", async () => {
    const res = await postApple({ identityToken: appleToken() });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("a.user@test.local");
  });

  test("an unverified Apple email does not link to an existing account", async () => {
    await createUser({ email: "a.user@test.local" });
    const res = await postApple({ identityToken: appleToken({ email_verified: "false" }) });
    expect(res.status).toBe(400);
    expect((await User.findOne({ email: "a.user@test.local" })).appleSubject).toBeNull();
  });
});
