const express = require("express");

const { requireAuth } = require("../middleware/auth");
const { idempotent } = require("../middleware/idempotency");
const { createRequestQueue } = require("../middleware/requestQueue");
const attempts = require("../controllers/attemptController");
const ai = require("../controllers/aiController");
const { readLimiter, submissionLimiter } = require("../middleware/rateLimit");

const { objectIdParam } = require("../middleware/validate");

const router = express.Router();
router.param("id", objectIdParam);
const attemptQueue = createRequestQueue({
  name: "attemptQueue",
  concurrency: Number(process.env.ATTEMPT_QUEUE_CONCURRENCY || 8),
  maxQueueSize: Number(process.env.ATTEMPT_QUEUE_MAX_SIZE || 180),
  maxWaitMs: Number(process.env.ATTEMPT_QUEUE_MAX_WAIT_MS || 20000),
});

// Exam session lifecycle. Every call after start must carry the X-Exam-Token binding.
router.post("/attempt/start", requireAuth, submissionLimiter(), attempts.startAttempt);
router.get("/attempt/sessions/active", requireAuth, readLimiter(), attempts.listActive);
router.post("/attempt/session/:id/takeover", requireAuth, submissionLimiter(), attempts.takeover);
router.get("/attempt/session/:id/paper", requireAuth, readLimiter(), attempts.getSessionPaper);
router.put("/attempt/session/:id/answers", requireAuth, readLimiter(), attempts.saveSessionProgress);
router.post("/attempt/session/:id/advance", requireAuth, submissionLimiter(), attempts.advance);
router.post("/attempt/session/:id/events", requireAuth, readLimiter(), attempts.postIntegrityEvents);
router.post("/attempt/session/:id/abandon", requireAuth, submissionLimiter(), attempts.abandonAttempt);
router.post("/attempt", requireAuth, submissionLimiter(), idempotent("attempt.submit"), attemptQueue, attempts.submitAttempt);

// Results
router.get("/result/:id", requireAuth, readLimiter(), attempts.getResult);
router.get("/analysis/:id", requireAuth, readLimiter(), attempts.getAnalysisSummary);
router.get("/analysis/:id/questions", requireAuth, readLimiter(), attempts.getAnalysisQuestions);
router.get("/analysis/:id/interpretation", requireAuth, readLimiter(), ai.getInterpretation);
router.get("/attempts", requireAuth, readLimiter(), attempts.listAttempts);

router.attemptQueue = attemptQueue;

module.exports = router;
