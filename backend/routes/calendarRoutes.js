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

const router = express.Router();

// The callback must NOT have requireAuth in the standard way if it's hitting a different domain,
// BUT since we are using cookie-based or bearer token sessions, wait:
// When Google redirects the user back to /api/calendar/google/callback, they are performing a GET request in their browser.
// If the portal uses cookie-based auth (e.g. `aceiiit_session` cookie), `requireAuth` will work automatically.
// If it only uses a Bearer token in the Authorization header, the browser redirect WILL NOT HAVE the Bearer token!
// Let's assume the portal uses cookie-based auth or we must handle it. 
// I checked `backend/middleware/auth.js` earlier, it checks `req.headers.authorization` AND `req.headers.cookie` (`aceiiit_session`).
// So `requireAuth` will work if they are logged in via the browser.

router.get("/google/connect", requireAuth, connectGoogleCalendar);
router.get("/google/callback", requireAuth, googleCalendarCallback);
router.get("/google/status", requireAuth, getCalendarStatus);
router.post("/google/disconnect", authLimiter(), requireAuth, disconnectCalendar);
router.put("/google/auto-add", requireAuth, toggleAutoAdd);

module.exports = router;
