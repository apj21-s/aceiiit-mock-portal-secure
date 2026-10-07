const crypto = require("crypto");
const GoogleCalendarConnection = require("../models/GoogleCalendarConnection");
const { getAuthUrl, exchangeCodeForTokens, encryptRefreshToken, revokeRefreshToken } = require("../services/googleCalendarService");
const { logger, errorSummary } = require("../utils/logger");

/**
 * Initiates the Google Calendar OAuth flow.
 * GET /api/calendar/google/connect
 */
async function connectGoogleCalendar(req, res) {
  try {
    // Generate a secure CSRF state token
    const state = crypto.randomBytes(32).toString("hex");
    
    // The state is bound to this browser in an HttpOnly cookie and checked on callback (CSRF).
    res.cookie("google_calendar_oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 10 * 60 * 1000, // 10 minutes
    });

    const authUrl = getAuthUrl(state);
    return res.json({ url: authUrl });
  } catch (err) {
    logger.error({ err: errorSummary(err) }, "calendar connect failed");
    return res.status(500).json({ error: "Failed to generate authorization URL." });
  }
}

/**
 * Handles the Google OAuth callback.
 * GET /api/calendar/google/callback
 */
async function googleCalendarCallback(req, res) {
  try {
    const { code, state, error } = req.query;

    if (error) {
      logger.warn({ oauthError: String(error).slice(0, 100) }, "google oauth returned an error");
      // We redirect to the frontend with an error
      return res.redirect("/#calendar?error=access_denied");
    }

    const savedState = req.cookies && req.cookies.google_calendar_oauth_state;
    if (!state || !savedState || state !== savedState) {
      logger.warn("calendar oauth: invalid state");
      return res.status(400).send("Invalid OAuth state. Please try connecting again.");
    }

    // Clear the state cookie
    res.clearCookie("google_calendar_oauth_state", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" });

    // We must ensure the user is logged into the portal (we'll check req.auth from middleware)
    if (!req.auth || !req.auth.userId) {
      return res.status(401).send("You must be logged in to connect your calendar.");
    }

    const { tokens, googleAccountId } = await exchangeCodeForTokens(code);

    if (!tokens.refresh_token) {
      // If we don't get a refresh token, it means the user already granted access previously 
      // but didn't revoke it. We need a refresh token for offline access.
      // A common workaround is to revoke and try again, but for now we'll just check if we already have one.
      const existing = await GoogleCalendarConnection.findOne({ userId: req.auth.userId });
      if (!existing || !existing.refreshToken) {
        // Without a refresh token, this connection is useless.
        // We'd have to prompt them with 'prompt=consent' again, which we already do in getAuthUrl.
        // If it still happens, it's a fatal error.
        logger.error("calendar oauth: no refresh token despite prompt=consent");
        return res.redirect("/#calendar?error=no_refresh_token");
      }
    }

    // Upsert the connection
    const updateData = {
      googleAccountId,
      status: "connected",
    };
    
    if (tokens.refresh_token) {
      // Encrypted at rest (AES-256-GCM, CALENDAR_TOKEN_KEY).
      updateData.refreshToken = encryptRefreshToken(tokens.refresh_token);
    }
    if (tokens.expiry_date) {
      updateData.tokenExpiry = new Date(tokens.expiry_date);
    }

    await GoogleCalendarConnection.findOneAndUpdate(
      { userId: req.auth.userId },
      { $set: updateData },
      { upsert: true, new: true }
    );

    // Redirect back to the frontend exam calendar
    return res.redirect("/#calendar?connected=true");
  } catch (err) {
    logger.error({ err: errorSummary(err) }, "calendar callback failed");
    return res.redirect("/#calendar?error=server_error");
  }
}

/**
 * Returns the current Calendar sync status for the authenticated user.
 * GET /api/calendar/google/status
 */
async function getCalendarStatus(req, res) {
  try {
    const connection = await GoogleCalendarConnection.findOne({ userId: req.auth.userId });
    if (!connection) {
      return res.json({ status: "disconnected" });
    }
    
    return res.json({
      status: connection.status,
      autoAddEnabled: connection.autoAddEnabled,
    });
  } catch (err) {
    logger.error({ err: errorSummary(err) }, "calendar status failed");
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * Disconnects the calendar (revokes token).
 * POST /api/calendar/google/disconnect
 */
async function disconnectCalendar(req, res) {
  try {
    const connection = await GoogleCalendarConnection.findOne({ userId: req.auth.userId });
    if (connection) {
      // Revoke at Google first (best effort), then drop the stored token.
      await revokeRefreshToken(connection);
    }
    await GoogleCalendarConnection.findOneAndUpdate(
      { userId: req.auth.userId },
      {
        $set: { status: "disconnected" },
        $unset: { refreshToken: "", tokenExpiry: "", googleAccountId: "" }
      }
    );

    return res.json({ success: true, status: "disconnected" });
  } catch (err) {
    logger.error({ err: errorSummary(err) }, "calendar disconnect failed");
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * Toggles auto-add.
 * PUT /api/calendar/google/auto-add
 */
async function toggleAutoAdd(req, res) {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Invalid payload" });
    }

    const connection = await GoogleCalendarConnection.findOneAndUpdate(
      { userId: req.auth.userId },
      { $set: { autoAddEnabled: enabled } },
      { new: true }
    );
    
    if (!connection) {
      return res.status(404).json({ error: "Not connected" });
    }
    
    return res.json({ success: true, autoAddEnabled: connection.autoAddEnabled });
  } catch (err) {
    logger.error({ err: errorSummary(err) }, "calendar auto-add toggle failed");
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = {
  connectGoogleCalendar,
  googleCalendarCallback,
  getCalendarStatus,
  disconnectCalendar,
  toggleAutoAdd,
};
