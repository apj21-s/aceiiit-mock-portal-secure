const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimit");
const {
  connectGoogleCalendar,
  googleCalendarCallback,
  getCalendarStatus,
  disconnectCalendar,
  toggleAutoAdd,
} = require("../controllers/calendarController");

const { z } = require("zod");
const { validate } = require("../middleware/validate");

const router = express.Router();

const callbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(256).optional(),
  scope: z.string().max(2048).optional(),
  authuser: z.string().max(16).optional(),
  prompt: z.string().max(64).optional(),
});
const autoAddBody = z.object({ enabled: z.boolean() }).strict();


router.get("/google/connect", requireAuth, connectGoogleCalendar);
router.get("/google/callback", requireAuth, validate({ query: callbackQuery }), googleCalendarCallback);
router.get("/google/status", requireAuth, getCalendarStatus);
router.post("/google/disconnect", authLimiter(), requireAuth, disconnectCalendar);
router.put("/google/auto-add", requireAuth, validate({ body: autoAddBody }), toggleAutoAdd);

module.exports = router;
