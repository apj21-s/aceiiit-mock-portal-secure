const express = require("express");

const { requireAuth, requireAdmin } = require("../middleware/auth");
const admin = require("../controllers/adminController");
const season = require("../controllers/seasonController");
const payment = require("../controllers/paymentController");
const ai = require("../controllers/aiController");
const upload = require("../middleware/upload");
const { z } = require("zod");
const { validate, objectIdParam, objectId } = require("../middleware/validate");
const { audit } = require("../middleware/audit");

const router = express.Router();

// Every :id is an ObjectId; malformed ids are rejected before reaching a handler.
router.param("id", objectIdParam);

const paging = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const searchText = z.string().trim().max(64).optional();
const boolFlag = z.enum(["true", "false", "1", "0"]).optional();

const schemas = {
  usersList: { query: z.object({ ...paging, search: searchText, role: z.enum(["admin", "student"]).optional(), isPaid: boolFlag, isEnrolledOnly: boolFlag }) },
  payments: { query: z.object({ ...paging, search: searchText, status: z.enum(["pending", "verified", "revoked", "refunded"]).optional(), seasonId: objectId.optional() }) },
  auditLogs: { query: z.object({ ...paging, action: z.string().regex(/^[A-Z_]{2,64}$/).optional(), entityType: z.string().regex(/^[A-Za-z]{2,40}$/).optional(), seasonId: objectId.optional() }) },
  leaderboard: { query: z.object({ testId: objectId, excludeFlagged: z.enum(["0", "1"]).optional() }) },
  trash: { params: z.object({ kind: z.enum(["tests", "questions", "users"]), id: objectId }) },
  verifyPayment: { body: z.object({ sendEmail: z.boolean().optional() }).strict() },
  createSeason: {
    body: z.object({
      name: z.string().trim().min(2).max(80),
      examName: z.string().trim().min(2).max(40).default("UGEE"),
      year: z.coerce.number().int().min(2020).max(2100),
      status: z.enum(["draft", "active", "archived"]).default("draft"),
      startDate: z.string().datetime().optional().nullable(),
      endDate: z.string().datetime().optional().nullable(),
      resourceCode: z.string().trim().regex(/^[A-Z0-9_]{2,64}$/).optional(),
    }),
  },
  questions: {
    query: z.object({
      ...paging,
      section: z.enum(["SUPR", "REAP"]).optional(),
      difficulty: z.enum(["easy", "medium", "hard"]).optional(),
      search: searchText,
      excludeTestId: objectId.optional(),
    }),
  },
  duplicateSeason: { body: z.object({ copyTests: z.boolean().optional(), copyQuestions: z.boolean().optional() }) },
  invalidate: { body: z.object({ reason: z.string().trim().min(3).max(500), restore: z.boolean().optional() }) },
};

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
router.get("/ai-status", requireAuth, requireAdmin, ai.getAiStatus);
router.get("/trash", requireAuth, requireAdmin, admin.trash);
router.put("/config", requireAuth, requireAdmin, audit("CONFIG_UPDATED", "AppConfig"), admin.updateAppConfig);
router.get("/audit-logs", requireAuth, requireAdmin, validate(schemas.auditLogs), admin.getAuditLogsController);

// Analytics & Leaderboard
router.get("/results", requireAuth, requireAdmin, admin.results);
router.get("/leaderboard", requireAuth, requireAdmin, validate(schemas.leaderboard), admin.leaderboard);
router.get("/test/:id/analytics", requireAuth, requireAdmin, admin.testAnalytics);
router.get("/attempts/:id/integrity", requireAuth, requireAdmin, admin.getAttemptIntegrity);
router.post("/attempts/:id/invalidate", requireAuth, requireAdmin, validate(schemas.invalidate), admin.invalidateAttempt);

// Extended User Management
router.get("/users-list", requireAuth, requireAdmin, validate(schemas.usersList), admin.listUsersExtended);
router.get("/users/:id/details", requireAuth, requireAdmin, admin.getUserDetailExtended);
router.delete("/users/:id", requireAuth, requireAdmin, audit("USER_DELETED", "User"), admin.deleteUser);
router.post("/users/:id/revoke-sessions", requireAuth, requireAdmin, admin.revokeUserSessions);
router.post("/users/:id/verify-payment", requireAuth, requireAdmin, audit("USER_ACCESS_GRANTED", "User"), admin.verifyUserPayment);
router.post("/users/:id/revoke-payment", requireAuth, requireAdmin, audit("USER_ACCESS_REVOKED", "User"), admin.revokeUserPayment);

// Season Management API
router.get("/seasons", requireAuth, requireAdmin, season.listSeasons);
router.get("/seasons/active", requireAuth, requireAdmin, season.getActiveSeasonEndpoint);
router.post("/seasons", requireAuth, requireAdmin, validate(schemas.createSeason), season.createSeason);
router.post("/seasons/:id/activate", requireAuth, requireAdmin, season.setActiveSeasonEndpoint);
router.post("/seasons/:id/archive", requireAuth, requireAdmin, season.archiveSeason);
router.post("/seasons/:id/duplicate", requireAuth, requireAdmin, validate(schemas.duplicateSeason), season.duplicateSeasonEndpoint);

// Payment & Entitlement Management API
router.get("/payments", requireAuth, requireAdmin, validate(schemas.payments), payment.listPayments);
router.post("/payments", requireAuth, requireAdmin, payment.createPaymentController);
router.post("/payments/:id/verify", requireAuth, requireAdmin, validate(schemas.verifyPayment), payment.verifyPaymentController);
router.post("/payments/:id/revoke", requireAuth, requireAdmin, payment.revokePaymentController);
router.post("/payments/:id/resend-email", requireAuth, requireAdmin, payment.resendPaymentEmailController);

// Question Management
router.get("/questions", requireAuth, requireAdmin, validate(schemas.questions), admin.listQuestions);
router.post("/questions", requireAuth, requireAdmin, extendUploadTimeout(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 45000), maybeUploadQuestionImages(), audit("QUESTION_CREATED", "Question"), admin.createQuestion);
router.put("/questions/:id", requireAuth, requireAdmin, extendUploadTimeout(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 45000), maybeUploadQuestionImages(), audit("QUESTION_UPDATED", "Question"), admin.updateQuestion);
router.delete("/questions/:id", requireAuth, requireAdmin, audit("QUESTION_DELETED", "Question"), admin.deleteQuestion);

// Trash Management
router.post("/trash/:kind/:id/restore", requireAuth, requireAdmin, validate(schemas.trash), audit("TRASH_RESTORED", "Trash"), admin.restoreTrashItem);
router.delete("/trash/:kind/:id/purge", requireAuth, requireAdmin, validate(schemas.trash), audit("TRASH_PURGED", "Trash"), admin.purgeTrashItem);

// Test Builder & Question Assignment
router.post("/attach", requireAuth, requireAdmin, audit("TEST_QUESTION_ATTACHED", "Test"), admin.attachQuestion);
router.post("/detach", requireAuth, requireAdmin, audit("TEST_QUESTION_DETACHED", "Test"), admin.detachQuestion);
router.post("/attach-bulk", requireAuth, requireAdmin, audit("TEST_QUESTIONS_ATTACHED", "Test"), admin.attachQuestionsBulk);
router.post("/detach-bulk", requireAuth, requireAdmin, audit("TEST_QUESTIONS_DETACHED", "Test"), admin.detachQuestionsBulk);
router.post("/reorder-questions", requireAuth, requireAdmin, audit("TEST_QUESTIONS_REORDERED", "Test"), admin.reorderTestQuestions);
router.post("/test/:id/duplicate", requireAuth, requireAdmin, audit("TEST_DUPLICATED", "Test"), admin.duplicateTest);
router.post("/test/:id/publish", requireAuth, requireAdmin, admin.publishTest);
router.post("/generate-questions", requireAuth, requireAdmin, audit("TEST_QUESTIONS_GENERATED", "Test"), admin.generateQuestionsRandom);

module.exports = router;
