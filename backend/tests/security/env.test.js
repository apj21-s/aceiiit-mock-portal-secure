// M1: production environment validation fails fast on unsafe configuration.
const { validateEnv, isInsecureDevAuthAllowed } = require("../../config/env");

const SECRET = "x".repeat(40);

function prodEnv(overrides = {}) {
  return {
    NODE_ENV: "production",
    JWT_SECRET: SECRET,
    MONGODB_URI: "mongodb://db.example/portal",
    GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
    INTERNAL_API_SECRET: SECRET,
    PORTAL_BASE_URL: "https://mock.aceiiit.in",
    CALENDAR_TOKEN_KEY: SECRET,
    RESEND_API_KEY: "re_test",
    ...overrides,
  };
}

describe("validateEnv (production)", () => {
  test("a complete production environment passes", () => {
    expect(() => validateEnv(prodEnv())).not.toThrow();
  });

  test.each([
    "JWT_SECRET",
    "MONGODB_URI",
    "GOOGLE_CLIENT_ID",
    "INTERNAL_API_SECRET",
    "PORTAL_BASE_URL",
    "CALENDAR_TOKEN_KEY",
  ])("missing %s fails boot", (key) => {
    const env = prodEnv();
    delete env[key];
    expect(() => validateEnv(env)).toThrow(new RegExp(key));
  });

  test("short secrets fail boot", () => {
    expect(() => validateEnv(prodEnv({ JWT_SECRET: "short" }))).toThrow(/JWT_SECRET/);
    expect(() => validateEnv(prodEnv({ INTERNAL_API_SECRET: "secret" }))).toThrow(/INTERNAL_API_SECRET/);
  });

  test("non-https portal URL fails boot", () => {
    expect(() => validateEnv(prodEnv({ PORTAL_BASE_URL: "http://mock.aceiiit.in" }))).toThrow(/PORTAL_BASE_URL/);
  });

  test("no email provider key fails boot", () => {
    const env = prodEnv();
    delete env.RESEND_API_KEY;
    expect(() => validateEnv(env)).toThrow(/email provider/);
  });

  test("ALLOW_INSECURE_DEV_AUTH is refused in production", () => {
    expect(() => validateEnv(prodEnv({ ALLOW_INSECURE_DEV_AUTH: "true" }))).toThrow(/ALLOW_INSECURE_DEV_AUTH/);
    expect(isInsecureDevAuthAllowed({ NODE_ENV: "production", ALLOW_INSECURE_DEV_AUTH: "true" })).toBe(false);
  });
});

describe("validateEnv (development)", () => {
  test("only JWT_SECRET is required", () => {
    expect(() => validateEnv({ NODE_ENV: "development", JWT_SECRET: "dev" })).not.toThrow();
    expect(() => validateEnv({ NODE_ENV: "development" })).toThrow(/JWT_SECRET/);
  });

  test("dev auth mocks need an explicit opt-in", () => {
    expect(isInsecureDevAuthAllowed({ NODE_ENV: "development" })).toBe(false);
    expect(isInsecureDevAuthAllowed({ NODE_ENV: "development", ALLOW_INSECURE_DEV_AUTH: "true" })).toBe(true);
  });
});
