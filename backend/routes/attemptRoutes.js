const express = require("express");

const { requireAuth } = require("../middleware/auth");
const { createRequestQueue } = require("../middleware/requestQueue");
const {
  submitAttempt,
  getResult,
  listAttempts,
  getAnalysisSummary,
  getAnalysisQuestions,
} = require("../controllers/attemptController");
const { readLimiter, submissionLimiter } = require("../middleware/rateLimit");

const router = express.Router();
const attemptQueue = createRequestQueue({
  name: "attemptQueue",
  concurrency: Number(process.env.ATTEMPT_QUEUE_CONCURRENCY || 8),
  maxQueueSize: Number(process.env.ATTEMPT_QUEUE_MAX_SIZE || 180),
  maxWaitMs: Number(process.env.ATTEMPT_QUEUE_MAX_WAIT_MS || 20000),
});

router.post("/attempt", requireAuth, submissionLimiter(), attemptQueue, submitAttempt);
router.get("/result/:id", requireAuth, readLimiter(), getResult);
router.get("/analysis/:id", requireAuth, readLimiter(), getAnalysisSummary);
router.get("/analysis/:id/questions", requireAuth, readLimiter(), getAnalysisQuestions);
router.get("/attempts", requireAuth, readLimiter(), listAttempts);

module.exports = router;
