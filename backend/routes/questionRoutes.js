const express = require("express");

const { requireAuth } = require("../middleware/auth");
const { submissionLimiter } = require("../middleware/rateLimit");
const { objectIdParam } = require("../middleware/validate");
const { reportQuestion } = require("../controllers/questionReportController");

const router = express.Router();
router.param("id", objectIdParam);

router.post("/:id/report", requireAuth, submissionLimiter(), reportQuestion);

module.exports = router;
