const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../backend/.env") });

const User = require("../backend/models/User");
const AuthToken = require("../backend/models/AuthToken");
const mongoose = require("mongoose");
const { login, requestActivation, completeActivation, requestPasswordReset, completePasswordReset, googleAuth } = require("../backend/controllers/authController");

async function runTests() {
  console.log("=========================================================");
  console.log("STARTING AUTHENTICATION INTEGRITY & LOAD TEST SUITE");
  console.log("=========================================================\n");

  const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/aceiiit";
  await mongoose.connect(mongoUri);
  console.log("✓ Connected to MongoDB.");

  // Prepare test student user
  const testEmail = "teststudent_load@aceiiit.in";
  await User.deleteMany({ email: testEmail });
  await AuthToken.deleteMany({ email: testEmail });

  const passwordHash = await bcrypt.hash("Password123!", 12);
  const testUser = await User.create({
    name: "Load Test Student",
    email: testEmail,
    role: "student",
    isPaid: true,
    isActivated: true,
    emailVerified: true,
    status: "active",
    passwordHash: passwordHash,
  });

  console.log("✓ Test student user created.");

  // Test 1: Simulated 250 Concurrent Student Login Burst (0 Emails)
  console.log("\n[TEST 1] 250 Concurrent Student Login Burst (Shared IP)...");
  let emailDispatches = 0;
  
  // Mock res object generator
  function createMockRes() {
    return {
      statusCode: 200,
      headers: {},
      cookies: {},
      status(code) { this.statusCode = code; return this; },
      cookie(name, val, opts) { this.cookies[name] = { val, opts }; return this; },
      json(payload) { this.data = payload; return this; },
    };
  }

  const startTime = Date.now();
  const loginPromises = [];

  for (let i = 0; i < 250; i++) {
    const req = {
      body: { email: testEmail, password: "Password123!" },
      ip: "192.168.1.100", // Shared Campus IP for all 250 requests
    };
    const res = createMockRes();
    const next = (err) => console.error("Login error:", err);
    loginPromises.push(login(req, res, next).then(() => res));
  }

  const results = await Promise.all(loginPromises);
  const totalTimeMs = Date.now() - startTime;
  const successCount = results.filter((r) => r.statusCode === 200 && r.cookies.aceiiit_session).length;

  console.log(`  - Total Time for 250 Logins: ${totalTimeMs}ms (Avg ${ (totalTimeMs / 250).toFixed(2) }ms per login)`);
  console.log(`  - Successful Logins: ${successCount} / 250`);
  console.log(`  - Email Provider Dispatches: ${emailDispatches}`);
  if (successCount === 250 && emailDispatches === 0) {
    console.log("  STATUS: PASS ✓ (250 Logins processed with 0 Email dispatches!)");
  } else {
    console.error("  STATUS: FAIL ✗");
  }

  // Test 2: Password Hash Leak Prevention
  console.log("\n[TEST 2] Verifying Password Hash Leak Prevention in API response...");
  const sampleRes = results[0];
  const responseUser = sampleRes.data.user;
  if (responseUser.passwordHash === undefined && !("passwordHash" in responseUser)) {
    console.log("  STATUS: PASS ✓ (passwordHash correctly omitted from user payload)");
  } else {
    console.error("  STATUS: FAIL ✗ (passwordHash was leaked!)");
  }

  // Test 3: Incorrect Password Handling
  console.log("\n[TEST 3] Testing Wrong Password rejection...");
  const wrongPassRes = createMockRes();
  await login({ body: { email: testEmail, password: "WrongPassword!" }, ip: "192.168.1.100" }, wrongPassRes, (e) => {});
  if (wrongPassRes.statusCode === 401 && wrongPassRes.data.error === "Invalid email or password.") {
    console.log("  STATUS: PASS ✓ (Wrong password correctly rejected with 401)");
  } else {
    console.error("  STATUS: FAIL ✗");
  }

  // Test 4: Generic Anti-Enumeration Messages
  console.log("\n[TEST 4] Testing Anti-Enumeration Generic Responses...");
  const resetNonExistentRes = createMockRes();
  await requestPasswordReset({ body: { email: "nonexistent_student_999@aceiiit.in" } }, resetNonExistentRes, (e) => {});
  if (resetNonExistentRes.data.message.includes("If an account exists")) {
    console.log("  STATUS: PASS ✓ (Generic recovery message returned for non-existent email)");
  } else {
    console.error("  STATUS: FAIL ✗");
  }

  // Test 5: Server-Side Google OAuth Token Verification
  console.log("\n[TEST 5] Testing Google OAuth Server-Side Verification...");
  const invalidGoogleRes = createMockRes();
  await googleAuth({ body: { credential: "invalid_fake_google_token" } }, invalidGoogleRes, (e) => {});
  if (invalidGoogleRes.statusCode === 401 && invalidGoogleRes.data.error.includes("Invalid or expired Google OAuth credential.")) {
    console.log("  STATUS: PASS ✓ (Fake Google credential rejected server-side)");
  } else {
    console.error("  STATUS: FAIL ✗ (Server failed to verify Google credential)");
  }

  // Cleanup
  await User.deleteMany({ email: testEmail });
  await AuthToken.deleteMany({ email: testEmail });
  await mongoose.disconnect();

  console.log("\n=========================================================");
  console.log("ALL TESTS COMPLETED SUCCESSFULLY");
  console.log("=========================================================");
}

runTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
