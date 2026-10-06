const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const User = require("../models/User");
const Test = require("../models/Test");
const PaymentRecord = require("../models/PaymentRecord");
const Entitlement = require("../models/Entitlement");
const AuditLog = require("../models/AuditLog");
const Season = require("../models/Season");

const { getActiveSeason } = require("../services/seasonService");
const { canAccessTest, linkPendingPaymentToUser } = require("../services/entitlementService");
const { syncGoogleSheetPayments, verifyPaymentManually, revokePaymentManually } = require("../services/paymentSyncService");
const { paidSheetService } = require("../services/paidSheetService");

async function runSmokeTest() {
    console.log("=== ACEIIIT PRODUCTION SMOKE TEST ===");
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        throw new Error("MONGODB_URI missing from environment.");
    }

    console.log("1. Connecting to MongoDB...");
    await mongoose.connect(mongoUri);
    console.log("   ✓ MongoDB Connected successfully.");

    const activeSeason = await getActiveSeason();
    console.log(`   ✓ Active Season: ${activeSeason.name} (ID: ${activeSeason._id})`);

    // Ensure at least one paid test exists for testing
    let paidTest = await Test.findOne({ isFree: false, deletedAt: null });
    if (!paidTest) {
        paidTest = await Test.create({
            title: "Smoke Test Paid Series Mock 1",
            series: activeSeason.name,
            seasonId: activeSeason._id,
            isFree: false,
            status: "live",
            durationMinutes: 180,
            questionIds: [],
        });
        console.log(`   ✓ Created temporary paid test for smoke test: ${paidTest._id}`);
    } else {
        console.log(`   ✓ Found paid test: ${paidTest.title} (ID: ${paidTest._id})`);
    }

    // ---------------------------------------------------------------------------
    // STEP 1: FREE USER CREATION & ACCESS BLOCK VERIFICATION
    // ---------------------------------------------------------------------------
    console.log("\n2. STEP 1: Creating Free User & Verifying Access Block...");
    const freeEmail = "smoketest_free_" + Date.now() + "@example.com";
    const freeUser = await User.create({
        name: "Smoke Free Student",
        email: freeEmail,
        normalizedEmail: freeEmail,
        role: "student",
        isPaid: false,
        status: "active",
        isActivated: true,
    });
    console.log(`   ✓ Free user created: ${freeUser.email} (ID: ${freeUser._id})`);

    const freeAccessCheck = await canAccessTest(freeUser, paidTest);
    console.log(`   → Free User Access Check to Paid Test: ${freeAccessCheck}`);
    if (freeAccessCheck !== false) {
        throw new Error("FAIL: Free user was incorrectly granted access to paid test!");
    }
    console.log("   ✓ PASS: Free user is strictly BLOCKED from paid test.");

    // ---------------------------------------------------------------------------
    // STEP 2: GOOGLE SHEET LIVE FETCH & SYNC VERIFICATION
    // ---------------------------------------------------------------------------
    console.log("\n3. STEP 2: Fetching Actual Google Sheet Data & Running Admin Sync...");
    console.log(`   API Key present: ${Boolean(process.env.PAID_SHEETS_API_KEY)}`);
    console.log(`   Sheet ID: ${process.env.PAID_SHEETS_SHEET_ID}`);
    console.log(`   Range: ${process.env.PAID_SHEETS_RANGE}`);

    await paidSheetService.syncOnce({ throwOnError: true });
    const sheetEntries = paidSheetService.entries || [];
    console.log(`   ✓ Fetched ${sheetEntries.length} verified email entries from Google Sheet Verified!A:A.`);

    let targetSheetEmail = "";
    if (sheetEntries.length > 0) {
        targetSheetEmail = sheetEntries[0].email;
        console.log(`   ✓ Selected real sheet email for test: ${targetSheetEmail}`);
    } else {
        targetSheetEmail = "smoketest_sheet_user_" + Date.now() + "@example.com";
        console.log(`   (No sheet rows found, creating mock entry: ${targetSheetEmail})`);
    }

    // Register user with this sheet email first as free user
    let sheetUser = await User.findOne({ normalizedEmail: targetSheetEmail });
    if (!sheetUser) {
        sheetUser = await User.create({
            name: "Sheet Test Student",
            email: targetSheetEmail,
            normalizedEmail: targetSheetEmail,
            role: "student",
            isPaid: false,
            status: "active",
            isActivated: true,
        });
        console.log(`   ✓ User created for sheet email: ${sheetUser.email}`);
    } else {
        sheetUser.isPaid = false;
        await sheetUser.save();
        console.log(`   ✓ Existing user reset to free: ${sheetUser.email}`);
    }

    // Ensure PaymentRecord exists for sync test
    let existingPayment = await PaymentRecord.findOne({ seasonId: activeSeason._id, normalizedEmail: targetSheetEmail });
    if (!existingPayment) {
        existingPayment = await PaymentRecord.create({
            seasonId: activeSeason._id,
            email: targetSheetEmail,
            normalizedEmail: targetSheetEmail,
            status: "pending",
            source: "google_sheet",
        });
    }

    console.log("   Running Admin Google Sheet Sync...");
    const syncResult = await syncGoogleSheetPayments({ targetSeasonId: activeSeason._id, actorUserId: null });
    console.log("   ✓ Sync Output Summary:", JSON.stringify(syncResult));

    // Verify DB state
    const updatedSheetUser = await User.findById(sheetUser._id);
    const entitlement = await Entitlement.findOne({ seasonId: activeSeason._id, normalizedEmail: targetSheetEmail, status: "active" });
    const paymentRecord = await PaymentRecord.findOne({ seasonId: activeSeason._id, normalizedEmail: targetSheetEmail });

    console.log(`   DB State after Sync:`);
    console.log(`   - User isPaid: ${updatedSheetUser.isPaid}`);
    console.log(`   - Entitlement Status: ${entitlement ? entitlement.status : "NONE"}`);
    console.log(`   - Payment Record Status: ${paymentRecord ? paymentRecord.status : "NONE"}`);
    console.log(`   - Confirmation Email Sent At: ${paymentRecord ? paymentRecord.confirmationEmailSentAt : "NONE"}`);

    const paidAccessCheck = await canAccessTest(updatedSheetUser, paidTest);
    console.log(`   → Paid Access Check: ${paidAccessCheck}`);
    if (!paidAccessCheck) {
        throw new Error("FAIL: Paid user was not granted access after sync!");
    }
    console.log("   ✓ PASS: Paid user access UNLOCKED after Google Sheet sync.");

    // ---------------------------------------------------------------------------
    // STEP 3: REPEATED SYNC IDEMPOTENCY
    // ---------------------------------------------------------------------------
    console.log("\n4. STEP 3: Running Repeated Sync for Email Idempotency Check...");
    const firstEmailSentAt = paymentRecord.confirmationEmailSentAt;
    const syncResult2 = await syncGoogleSheetPayments({ targetSeasonId: activeSeason._id, actorUserId: null });
    console.log("   ✓ Second Sync Output Summary:", JSON.stringify(syncResult2));

    const paymentRecord2 = await PaymentRecord.findOne({ seasonId: activeSeason._id, normalizedEmail: targetSheetEmail });
    console.log(`   - Emails sent in 2nd sync: ${syncResult2.emailsSent}`);
    if (syncResult2.emailsSent !== 0) {
        throw new Error("FAIL: Duplicate email sent on repeated sync!");
    }
    console.log("   ✓ PASS: Repeated sync is IDEMPOTENT. 0 duplicate emails sent.");

    // ---------------------------------------------------------------------------
    // STEP 4: MANUAL ADMIN REVOCATION
    // ---------------------------------------------------------------------------
    console.log("\n5. STEP 4: Admin Revokes Paid Access...");
    await revokePaymentManually({ paymentId: paymentRecord2._id, actorUserId: null });

    const revokedUser = await User.findById(sheetUser._id);
    const revokedEntitlement = await Entitlement.findOne({ seasonId: activeSeason._id, normalizedEmail: targetSheetEmail });
    const revokedPayment = await PaymentRecord.findById(paymentRecord2._id);

    console.log(`   DB State after Revocation:`);
    console.log(`   - User isPaid: ${revokedUser.isPaid}`);
    console.log(`   - Entitlement Status: ${revokedEntitlement.status}`);
    console.log(`   - Payment Record Status: ${revokedPayment.status}`);

    const revokedAccessCheck = await canAccessTest(revokedUser, paidTest);
    console.log(`   → Access Check after Revocation: ${revokedAccessCheck}`);
    if (revokedAccessCheck !== false) {
        throw new Error("FAIL: Revoked user still has access to paid test!");
    }
    console.log("   ✓ PASS: Revoked user is IMMEDIATELY BLOCKED from paid test.");

    // ---------------------------------------------------------------------------
    // STEP 5: MANUAL ADMIN RE-VERIFICATION
    // ---------------------------------------------------------------------------
    console.log("\n6. STEP 5: Admin Re-verifies Paid Access...");
    await verifyPaymentManually({ paymentId: paymentRecord2._id, actorUserId: null, sendEmail: false });

    const reVerifiedUser = await User.findById(sheetUser._id);
    const reVerifiedEntitlement = await Entitlement.findOne({ seasonId: activeSeason._id, normalizedEmail: targetSheetEmail });
    const reVerifiedAccessCheck = await canAccessTest(reVerifiedUser, paidTest);

    console.log(`   DB State after Re-verification:`);
    console.log(`   - User isPaid: ${reVerifiedUser.isPaid}`);
    console.log(`   - Entitlement Status: ${reVerifiedEntitlement.status}`);
    console.log(`   → Access Check after Re-verification: ${reVerifiedAccessCheck}`);
    if (!reVerifiedAccessCheck) {
        throw new Error("FAIL: Re-verified user access was not restored!");
    }
    console.log("   ✓ PASS: Re-verified user access RESTORED successfully.");

    // ---------------------------------------------------------------------------
    // STEP 6: PRE-ACCOUNT VERIFIED PAYMENT AUTO-LINKING
    // ---------------------------------------------------------------------------
    console.log("\n7. STEP 6: Testing Payment Existing Before User Registers (Auto-Link)...");
    const preAccountEmail = "smoketest_preaccount_" + Date.now() + "@example.com";

    // 1. Payment created in DB before account registration
    const prePayment = await PaymentRecord.create({
        seasonId: activeSeason._id,
        email: preAccountEmail,
        normalizedEmail: preAccountEmail,
        name: "Pre Account Buyer",
        status: "verified",
        source: "google_sheet",
        verifiedAt: new Date(),
    });
    console.log(`   ✓ Verified PaymentRecord created prior to registration: ${prePayment.normalizedEmail}`);

    // 2. User registers later
    const newUser = await User.create({
        name: "Newly Registered Student",
        email: preAccountEmail,
        normalizedEmail: preAccountEmail,
        role: "student",
        isPaid: false,
        status: "active",
        isActivated: true,
    });
    console.log(`   ✓ New User registered: ${newUser.email} (Initial isPaid: ${newUser.isPaid})`);

    // 3. User logs in (triggers linkPendingPaymentToUser)
    await linkPendingPaymentToUser(newUser);

    const linkedUser = await User.findById(newUser._id);
    const linkedEntitlement = await Entitlement.findOne({ seasonId: activeSeason._id, normalizedEmail: preAccountEmail, status: "active" });
    const preAccountAccessCheck = await canAccessTest(linkedUser, paidTest);

    console.log(`   DB State after Registration & Link:`);
    console.log(`   - User isPaid: ${linkedUser.isPaid}`);
    console.log(`   - Entitlement Status: ${linkedEntitlement ? linkedEntitlement.status : "NONE"}`);
    console.log(`   → Access Check for Pre-Account User: ${preAccountAccessCheck}`);
    if (!preAccountAccessCheck) {
        throw new Error("FAIL: Pre-account payment was not automatically linked on registration!");
    }
    console.log("   ✓ PASS: Pre-account payment automatically linked to newly registered user.");

    // ---------------------------------------------------------------------------
    // CLEANUP
    // ---------------------------------------------------------------------------
    console.log("\n8. Cleaning up smoke test artifacts...");
    await User.deleteMany({ email: { $in: [freeEmail, targetSheetEmail, preAccountEmail] } });
    await PaymentRecord.deleteMany({ normalizedEmail: { $in: [freeEmail, targetSheetEmail, preAccountEmail] } });
    await Entitlement.deleteMany({ normalizedEmail: { $in: [freeEmail, targetSheetEmail, preAccountEmail] } });
    if (paidTest.title.startsWith("Smoke Test Paid Series")) {
        await Test.deleteOne({ _id: paidTest._id });
    }
    console.log("   ✓ Cleaned up test database records.");

    console.log("\n==================================================");
    console.log("ALL PRODUCTION SMOKE TESTS PASSED 100% SUCCESSFULLY");
    console.log("==================================================");
    await mongoose.disconnect();
}

runSmokeTest().catch((err) => {
    console.error("\n❌ SMOKE TEST FAILED WITH ERROR:", err);
    mongoose.disconnect().finally(() => process.exit(1));
});
