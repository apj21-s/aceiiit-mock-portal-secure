const express = require("express");

const { listTests, getTestById, getTestQuestions, createTest, updateTest, deleteTest, submitQotdAttempt, createPracticeTest } = require("../controllers/testController");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { readLimiter, submissionLimiter } = require("../middleware/rateLimit");

const { objectIdParam } = require("../middleware/validate");
const { audit } = require("../middleware/audit");

const router = express.Router();
router.param("id", objectIdParam);

router.get("/", requireAuth, readLimiter(), listTests);
router.post("/qotd-attempt", requireAuth, submitQotdAttempt);
router.post("/practice", requireAuth, submissionLimiter(), createPracticeTest);
router.get("/:id", requireAuth, readLimiter(), getTestById);
router.get("/:id/questions", requireAuth, readLimiter(), getTestQuestions);

router.post("/", requireAuth, requireAdmin, audit("TEST_CREATED", "Test"), createTest);
router.put("/:id", requireAuth, requireAdmin, audit("TEST_UPDATED", "Test"), updateTest);
router.delete("/:id", requireAuth, requireAdmin, audit("TEST_DELETED", "Test"), deleteTest);

module.exports = router;
