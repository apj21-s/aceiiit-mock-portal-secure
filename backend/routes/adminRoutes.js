const express = require("express");

const { requireAuth, requireAdmin } = require("../middleware/auth");
const admin = require("../controllers/adminController");
const season = require("../controllers/seasonController");
const payment = require("../controllers/paymentController");
const upload = require("../middleware/upload");

const router = express.Router();

function extendUploadTimeout(timeoutMs) {
  const safeTimeout = Math.max(15000, Number(timeoutMs) || 45000);
  return function (req, res, next) {
    req.setTimeout(safeTimeout);
    res.setTimeout(safeTimeout);
    next();
  };
}

function maybeUploadQuestionImages() {
  const handler = upload.fields([
    { name: "image", maxCount: 1 },
    { name: "images", maxCount: 8 },
  ]);
  return function (req, res, next) {
    if (req.is("multipart/form-data")) {
      return handler(req, res, next);
    }
    return next();
  };
}

// Core Admin Snapshot & Dashboard
router.get("/snapshot", requireAuth, requireAdmin, admin.snapshot);
router.get("/dashboard", requireAuth, requireAdmin, admin.getDashboardMetrics);
router.get("/trash", requireAuth, requireAdmin, admin.trash);
router.put("/config", requireAuth, requireAdmin, admin.updateAppConfig);
router.get("/audit-logs", requireAuth, requireAdmin, admin.getAuditLogsController);

// Analytics & Leaderboard
router.get("/results", requireAuth, requireAdmin, admin.results);
router.get("/leaderboard", requireAuth, requireAdmin, admin.leaderboard);
router.get("/test/:id/analytics", requireAuth, requireAdmin, admin.testAnalytics);

// Extended User Management
router.get("/users-list", requireAuth, requireAdmin, admin.listUsersExtended);
router.get("/users/:id/details", requireAuth, requireAdmin, admin.getUserDetailExtended);
router.delete("/users/:id", requireAuth, requireAdmin, admin.deleteUser);
router.post("/users/:id/verify-payment", requireAuth, requireAdmin, admin.verifyUserPayment);
router.post("/users/:id/revoke-payment", requireAuth, requireAdmin, admin.revokeUserPayment);

// Season Management API
router.get("/seasons", requireAuth, requireAdmin, season.listSeasons);
router.get("/seasons/active", requireAuth, requireAdmin, season.getActiveSeasonEndpoint);
router.post("/seasons", requireAuth, requireAdmin, season.createSeason);
router.post("/seasons/:id/activate", requireAuth, requireAdmin, season.setActiveSeasonEndpoint);
router.post("/seasons/:id/archive", requireAuth, requireAdmin, season.archiveSeason);
router.post("/seasons/:id/duplicate", requireAuth, requireAdmin, season.duplicateSeasonEndpoint);

// Payment & Entitlement Management API
router.get("/payments", requireAuth, requireAdmin, payment.listPayments);
router.post("/payments/sync", requireAuth, requireAdmin, payment.syncPaymentsController);
router.post("/payments/:id/verify", requireAuth, requireAdmin, payment.verifyPaymentController);
router.post("/payments/:id/revoke", requireAuth, requireAdmin, payment.revokePaymentController);
router.post("/payments/:id/resend-email", requireAuth, requireAdmin, payment.resendPaymentEmailController);
router.post("/sync-sheets", requireAuth, requireAdmin, admin.syncPaidSheets); // Legacy fallback endpoint

// Question Management
router.post("/questions", requireAuth, requireAdmin, extendUploadTimeout(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 45000), maybeUploadQuestionImages(), admin.createQuestion);
router.put("/questions/:id", requireAuth, requireAdmin, extendUploadTimeout(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 45000), maybeUploadQuestionImages(), admin.updateQuestion);
router.delete("/questions/:id", requireAuth, requireAdmin, admin.deleteQuestion);

// Trash Management
router.post("/trash/:kind/:id/restore", requireAuth, requireAdmin, admin.restoreTrashItem);
router.delete("/trash/:kind/:id/purge", requireAuth, requireAdmin, admin.purgeTrashItem);

// Test Builder & Question Assignment
router.post("/attach", requireAuth, requireAdmin, admin.attachQuestion);
router.post("/detach", requireAuth, requireAdmin, admin.detachQuestion);
router.post("/attach-bulk", requireAuth, requireAdmin, admin.attachQuestionsBulk);
router.post("/detach-bulk", requireAuth, requireAdmin, admin.detachQuestionsBulk);
router.post("/reorder-questions", requireAuth, requireAdmin, admin.reorderTestQuestions);
router.post("/test/:id/duplicate", requireAuth, requireAdmin, admin.duplicateTest);
router.post("/test/:id/publish", requireAuth, requireAdmin, admin.publishTest);
router.post("/generate-questions", requireAuth, requireAdmin, admin.generateQuestionsRandom);

module.exports = router;
