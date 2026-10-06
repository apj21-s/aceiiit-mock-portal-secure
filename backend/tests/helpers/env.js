// Test-only environment. Never loads backend/.env, so tests can't touch real services or data.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.TEST_JWT_SECRET || "test-jwt-secret-0123456789abcdef0123456789abcdef";
process.env.ADMIN_EMAILS = "admin@test.local";
process.env.REQUEST_TIMEOUT_MS = "30000";
delete process.env.MONGODB_URI;
delete process.env.RESEND_API_KEY;
delete process.env.BREVO_API_KEY;
delete process.env.PAID_SHEETS_API_KEY;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.APPLE_CLIENT_ID;
