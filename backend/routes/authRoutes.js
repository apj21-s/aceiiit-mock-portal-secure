const express = require("express");

const {
  login,
  requestActivation,
  verifyActivationToken,
  completeActivation,
  requestPasswordReset,
  verifyResetToken,
  completePasswordReset,
  googleAuth,
  appleAuth,
  getAuthConfig,
  logout,
  logoutAll,
  me,
  updatePassword,
} = require("../controllers/authController");
const { requireAuth } = require("../middleware/auth");
const { issueCsrfToken } = require("../middleware/csrf");
const { authLimiter, loginAccountLimiter, readLimiter, activationLimiter, passwordResetLimiter } = require("../middleware/rateLimit");

const router = express.Router();

// Public OAuth & Client Configuration
router.get("/config", readLimiter(), getAuthConfig);

// CSRF token bootstrap (sets the aceiiit_csrf cookie if missing and echoes its value)
router.get("/csrf", readLimiter(), issueCsrfToken);

// Email + Password Normal Login
router.post("/login", authLimiter(), loginAccountLimiter(), login);

// Account Activation Flow
router.post("/activate/request", activationLimiter(), requestActivation);
router.get("/activate/verify", readLimiter(), verifyActivationToken);
router.post("/activate/complete", authLimiter(), completeActivation);

// Password Reset Recovery Flow
router.post("/forgot-password/request", passwordResetLimiter(), requestPasswordReset);
router.get("/forgot-password/verify", readLimiter(), verifyResetToken);
router.post("/forgot-password/complete", authLimiter(), completePasswordReset);

// OAuth Integration
router.post("/google", authLimiter(), googleAuth);
router.post("/apple", authLimiter(), appleAuth);

// Session & User Info
router.post("/logout", logout);
router.post("/logout-all", authLimiter(), requireAuth, logoutAll);
router.get("/me", requireAuth, me);
router.put("/password", authLimiter(), requireAuth, updatePassword);

module.exports = router;
