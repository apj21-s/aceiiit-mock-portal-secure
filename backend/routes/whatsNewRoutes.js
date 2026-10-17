const express = require("express");

const { requireAuth } = require("../middleware/auth");
const { readLimiter } = require("../middleware/rateLimit");
const whatsNew = require("../controllers/whatsNewController");

const router = express.Router();

router.get("/", requireAuth, readLimiter(), whatsNew.getForMe);
router.post("/seen", requireAuth, whatsNew.markSeen);

module.exports = router;
