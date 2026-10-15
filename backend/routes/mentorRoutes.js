const express = require("express");
const rateLimit = require("express-rate-limit");

const mentor = require("../controllers/mentorController");
const { requireAuth } = require("../middleware/auth");
const { readLimiter } = require("../middleware/rateLimit");
const { objectIdParam } = require("../middleware/validate");

// ACEIIIT Mentor (signed-in students). Sending is limited per student per minute on top of the
// monthly allowance; reads use the normal read limiter.
const router = express.Router();
router.param("id", objectIdParam);

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Math.max(1, Number(process.env.MENTOR_SENDS_PER_MINUTE || 6)),
  keyGenerator: (req) => `mentor:${req.auth.userId}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You're sending messages quickly. Wait a moment and try again.", code: "MENTOR_RATE_LIMITED", retryable: true },
});

router.get("/usage", requireAuth, readLimiter(), mentor.usage);
router.get("/conversations", requireAuth, readLimiter(), mentor.listConversations);
router.post("/conversations", requireAuth, readLimiter(), mentor.createConversation);
router.get("/conversations/:id", requireAuth, readLimiter(), mentor.getConversation);
router.delete("/conversations/:id", requireAuth, readLimiter(), mentor.deleteConversation);
router.post("/conversations/:id/messages", requireAuth, sendLimiter, mentor.postMessage);

module.exports = router;
