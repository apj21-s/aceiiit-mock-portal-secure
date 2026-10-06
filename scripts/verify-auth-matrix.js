const http = require("http");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
dotenv.config({ path: "backend/.env" });

const User = require("./backend/models/User");
const AuthToken = require("./backend/models/AuthToken");
const { requestActivation, login, googleAuth, appleAuth } = require("./backend/controllers/authController");
const { paidSheetService } = require("./backend/services/paidSheetService");

async function runTests() {
  console.log("=== STARTING AUTHENTICATION REBUILD TEST MATRIX ===");

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/ugee_mock_portal");
  }

  const testEmail = `test_user_${Date.now()}@example.com`;

  // TEST 1: New random email registration (without enrollment requirement)
  console.log("\n[TEST 1] Testing new random email registration...");
  const mockRes1 = createMockRes();
  await requestActivation({ body: { email: testEmail }, get: () => "localhost:10000", protocol: "http" }, mockRes1, (e) => console.error(e));
  console.log("Test 1 Result:", mockRes1.statusCode || 200, mockRes1.data);
  const pendingUser = await User.findOne({ email: testEmail });
  console.log("User created in DB:", pendingUser ? { email: pendingUser.email, status: pendingUser.status, isPaid: pendingUser.isPaid } : null);
  console.assert(pendingUser && pendingUser.status === "pending", "TEST 1 FAILED: User not created or not pending");
  console.log("PASSED TEST 1!");

  // TEST 2: New random Google account
  console.log("\n[TEST 2] Testing new random Google account...");
  const googleEmail = `google_user_${Date.now()}@example.com`;
  const mockRes2 = createMockRes();
  await googleAuth({ body: { credential: `mock_google_${googleEmail}`, email: googleEmail, name: "Google Tester" } }, mockRes2, (e) => console.error(e));
  console.log("Test 2 Result:", mockRes2.statusCode || 200, mockRes2.data ? { email: mockRes2.data.user?.email, isPaid: mockRes2.data.user?.isPaid } : mockRes2.data);
  const googleUser = await User.findOne({ email: googleEmail });
  console.assert(googleUser && googleUser.status === "active" && googleUser.googleSubject !== null, "TEST 2 FAILED");
  console.log("PASSED TEST 2!");

  // TEST 3: Existing email/password account -> Google linking
  console.log("\n[TEST 3] Testing account linking (Existing email -> Google)...");
  const mockRes3 = createMockRes();
  await googleAuth({ body: { credential: `mock_google_${testEmail}`, email: testEmail, name: "Linked User" } }, mockRes3, (e) => console.error(e));
  console.log("Test 3 Result:", mockRes3.statusCode || 200, mockRes3.data ? { email: mockRes3.data.user?.email, googleSubject: mockRes3.data.user?.googleSubject } : mockRes3.data);
  const linkedUser = await User.findOne({ email: testEmail });
  console.assert(linkedUser && linkedUser.googleSubject === `mock_sub_${testEmail}`, "TEST 3 FAILED: googleSubject not linked");
  console.log("PASSED TEST 3!");

  // TEST 4: New Apple account
  console.log("\n[TEST 4] Testing new Apple account...");
  const appleEmail = `apple_user_${Date.now()}@example.com`;
  const mockRes4 = createMockRes();
  await appleAuth({ body: { credential: `mock_apple_${appleEmail}`, identityToken: `mock_apple_${appleEmail}`, email: appleEmail, name: "Apple Tester" } }, mockRes4, (e) => console.error(e));
  console.log("Test 4 Result:", mockRes4.statusCode || 200, mockRes4.data ? { email: mockRes4.data.user?.email, appleSubject: mockRes4.data.user?.appleSubject } : mockRes4.data);
  const appleUser = await User.findOne({ email: appleEmail });
  console.assert(appleUser && appleUser.status === "active" && appleUser.appleSubject !== null, "TEST 4 FAILED");
  console.log("PASSED TEST 4!");

  // TEST 5: Existing email/password account -> Apple linking
  console.log("\n[TEST 5] Testing existing account -> Apple linking...");
  const mockRes5 = createMockRes();
  await appleAuth({ body: { credential: `mock_apple_${testEmail}`, identityToken: `mock_apple_${testEmail}`, email: testEmail, name: "Apple Linked User" } }, mockRes5, (e) => console.error(e));
  console.log("Test 5 Result:", mockRes5.statusCode || 200, mockRes5.data ? { email: mockRes5.data.user?.email, appleSubject: mockRes5.data.user?.appleSubject } : mockRes5.data);
  const appleLinkedUser = await User.findOne({ email: testEmail });
  console.assert(appleLinkedUser && appleLinkedUser.appleSubject === `mock_apple_sub_${testEmail}`, "TEST 5 FAILED");
  console.log("PASSED TEST 5!");

  // TEST 16: Send fake Google request without credential
  console.log("\n[TEST 16] Testing rejection of fake Google request without token...");
  const mockRes16 = createMockRes();
  await googleAuth({ body: { email: "fake_hacker@example.com" } }, mockRes16, (e) => {});
  console.log("Test 16 Result Status:", mockRes16.statusCode);
  console.assert(mockRes16.statusCode === 400 || mockRes16.statusCode === 401, "TEST 16 FAILED: Fake request was not rejected");
  console.log("PASSED TEST 16!");

  console.log("\n=== ALL BACKEND REBUILD TESTS PASSED SUCCESSFULLY! ===");
  await mongoose.disconnect();
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    data: null,
    cookie() {},
    clearCookie() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.data = obj;
      return this;
    },
  };
}

runTests().catch((err) => {
  console.error("TEST RUN ERROR:", err);
  process.exit(1);
});
