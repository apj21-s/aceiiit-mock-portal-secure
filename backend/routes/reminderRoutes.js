const express = require("express");

const { requireAuth } = require("../middleware/auth");
const { readLimiter } = require("../middleware/rateLimit");
const { listReminders, createReminder, updateReminder, deleteReminder, resendReminder } = require("../controllers/reminderController");

const router = express.Router();

router.get("/", requireAuth, readLimiter(), listReminders);
router.post("/", requireAuth, createReminder);
router.put("/:id", requireAuth, updateReminder);
router.delete("/:id", requireAuth, deleteReminder);
router.post("/:id/resend", requireAuth, resendReminder);

module.exports = router;
