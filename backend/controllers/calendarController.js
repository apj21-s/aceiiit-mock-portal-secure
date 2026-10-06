const crypto = require("crypto");
const GoogleCalendarConnection = require("../models/GoogleCalendarConnection");
const { getAuthUrl, exchangeCodeForTokens } = require("../services/googleCalendarService");

/**
 * Initiates the Google Calendar OAuth flow.
 * GET /api/calendar/google/connect
 */
async function connectGoogleCalendar(req, res) {
  try {
    // Generate a secure CSRF state token
    const state = crypto.randomBytes(32).toString("hex");
    
    // In a real production system, you would store this state in a session, Redis, or signed cookie
    // to verify it when Google redirects back.
    // For this implementation, we will use an HttpOnly signed cookie.
    res.cookie("google_calendar_oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 10 * 60 * 1000, // 10 minutes
    });

    const authUrl = getAuthUrl(state);
    return res.json({ url: authUrl });
  } catch (err) {
    console.error("Calendar connect error:", err);
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
      console.warn("Google OAuth returned error:", error);
      // We redirect to the frontend with an error
      return res.redirect("/#calendar?error=access_denied");
    }

    const savedState = req.cookies && req.cookies.google_calendar_oauth_state;
    if (!state || !savedState || state !== savedState) {
      console.warn("Invalid OAuth state.");
      return res.status(400).send("Invalid OAuth state. Please try connecting again.");
    }

    // Clear the state cookie
    res.clearCookie("google_calendar_oauth_state");

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
        console.error("No refresh token provided by Google despite prompt=consent.");
        return res.redirect("/#calendar?error=no_refresh_token");
      }
    }

    // Upsert the connection
    const updateData = {
      googleAccountId,
      status: "connected",
    };
    
    if (tokens.refresh_token) {
      updateData.refreshToken = tokens.refresh_token;
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
    console.error("Calendar callback error:", err);
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
    console.error("Calendar status error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

/**
 * Disconnects the calendar (revokes token).
 * POST /api/calendar/google/disconnect
 */
async function disconnectCalendar(req, res) {
  try {
    // We could call Google's revoke endpoint here if we want to explicitly revoke the token on Google's side
    // For now, we just mark it disconnected and delete the refresh token
    await GoogleCalendarConnection.findOneAndUpdate(
      { userId: req.auth.userId },
      { 
        $set: { status: "disconnected" },
        $unset: { refreshToken: "", tokenExpiry: "", googleAccountId: "" }
      }
    );
    
    return res.json({ success: true, status: "disconnected" });
  } catch (err) {
    console.error("Calendar disconnect error:", err);
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
    console.error("Calendar toggle auto-add error:", err);
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
