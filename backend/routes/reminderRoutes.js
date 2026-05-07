const express = require("express");

const { requireAuth } = require("../middleware/auth");
const { readLimiter } = require("../middleware/rateLimit");
const { listReminders, createReminder, updateReminder, deleteReminder } = require("../controllers/reminderController");

const router = express.Router();

router.get("/", requireAuth, readLimiter(), listReminders);
router.post("/", requireAuth, createReminder);
router.put("/:id", requireAuth, updateReminder);
router.delete("/:id", requireAuth, deleteReminder);

module.exports = router;
