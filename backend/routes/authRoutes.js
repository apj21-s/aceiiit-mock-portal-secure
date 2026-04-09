const express = require("express");

const { sendOtp, verifyOtp, me } = require("../controllers/authController");
const { requireAuth } = require("../middleware/auth");
const { authLimiter, otpLimiter } = require("../middleware/rateLimit");

const router = express.Router();

router.post("/send-otp", otpLimiter(), sendOtp);
router.post("/verify-otp", authLimiter(), verifyOtp);
router.get("/me", requireAuth, me);

module.exports = router;
