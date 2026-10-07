const express = require("express");

const { requireAuth } = require("../middleware/auth");
const { authLimiter, readLimiter } = require("../middleware/rateLimit");
const { exportMyData, deleteMyAccount } = require("../controllers/accountController");

const router = express.Router();

router.get("/export", requireAuth, readLimiter(), exportMyData);
router.delete("/", authLimiter(), requireAuth, deleteMyAccount);

module.exports = router;
