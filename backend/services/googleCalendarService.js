const { google } = require("googleapis");
const GoogleCalendarConnection = require("../models/GoogleCalendarConnection");
const GoogleCalendarEvent = require("../models/GoogleCalendarEvent");

/**
 * Creates and configures a Google OAuth2 client using the environment variables.
 * Note: GOOGLE_CLIENT_SECRET is strictly required for this server-side flow.
 */
function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing Google OAuth Calendar credentials in environment");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generates the Google OAuth authorization URL.
 * @param {string} state - Cryptographically secure state string tying this flow to a specific user.
 * @returns {string} - The URL to redirect the user to.
 */
function getAuthUrl(state) {
  const oauth2Client = getOAuth2Client();
  
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // Force consent to ensure we get a refresh token
    scope: ["openid", "https://www.googleapis.com/auth/calendar.events"],
    state: state,
  });
}

/**
 * Exchanges the authorization code for a set of tokens (including a refresh_token).
 * @param {string} code - The authorization code returned by Google.
 * @returns {Promise<Object>} - Contains tokens and idToken payload.
 */
async function exchangeCodeForTokens(code) {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  
  oauth2Client.setCredentials(tokens);
  
  if (!tokens.id_token) {
    throw new Error("No id_token returned from Google, cannot determine account ID.");
  }

  // Decode the id_token to get the Google Account ID ('sub')
  const ticket = await oauth2Client.verifyIdToken({
    idToken: tokens.id_token,
    audience: oauth2Client._clientId,
  });
  const payload = ticket.getPayload();

  return {
    tokens,
    googleAccountId: payload.sub,
  };
}

module.exports = {
  getOAuth2Client,
  getAuthUrl,
  exchangeCodeForTokens,
  syncReminderToCalendar,
};

// -----------------------------------------------------------------------------
// AUTOMATIC SYNC ENGINE
// -----------------------------------------------------------------------------

function buildGoogleEventPayload(reminder) {
  const planDate = new Date(reminder.plannedAt || reminder.remindAt);
  const endDate = new Date(planDate.getTime() + 3 * 60 * 60 * 1000); // 3 hours duration
  
  const subjectFocus = Array.isArray(reminder.subjectFocus) && reminder.subjectFocus.length
    ? reminder.subjectFocus.join(", ") : "";
  const title = String(reminder.title || "ACE IIIT Mock Plan");
  
  const origin = process.env.CLIENT_ORIGIN || "https://portal.aceiiit.in";
  const testLink = reminder.testId ? `${origin}/#instructions/${reminder.testId}` : `${origin}/#dashboard`;

  let description = `Subject Focus: ${subjectFocus}\n\nLink: ${testLink}`;
  if (reminder.notes) description += `\n\nNotes: ${reminder.notes}`;

  return {
    summary: title,
    description: description,
    start: {
      dateTime: planDate.toISOString(),
    },
    end: {
      dateTime: endDate.toISOString(),
    },
    source: {
      title: "ACE IIIT Mock Portal",
      url: testLink
    }
  };
}

/**
 * Synchronizes a Reminder to the user's Google Calendar asynchronously.
 * Designed to not block the main request thread.
 * 
 * @param {Object} reminder - The Reminder mongoose document.
 * @param {String} action - "CREATE", "UPDATE", or "DELETE"
 */
async function syncReminderToCalendar(reminder, action) {
  try {
    // 1. Fetch user connection
    const connection = await GoogleCalendarConnection.findOne({ userId: reminder.userId, status: "connected" });
    if (!connection || !connection.refreshToken) {
      // User hasn't connected Google Calendar or doesn't have a valid token.
      return;
    }

    if (action === "CREATE" && !connection.autoAddEnabled) {
      // Auto-add is turned off. We skip creation.
      return;
    }

    // 2. Initialize OAuth client and Calendar API
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: connection.refreshToken });
    
    // Note: googleapis handles token refresh automatically before requests if they are expired.
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // 3. Find existing mapping to avoid race conditions and duplicates
    let eventMapping = await GoogleCalendarEvent.findOne({ reminderId: reminder._id });

    if (action === "CREATE") {
      if (eventMapping) {
        // Already created (maybe a concurrent request). Fallback to update.
        action = "UPDATE";
      } else {
        // Insert into Google Calendar
        const eventPayload = buildGoogleEventPayload(reminder);
        const response = await calendar.events.insert({
          calendarId: "primary",
          requestBody: eventPayload,
        });

        // Save mapping
        await GoogleCalendarEvent.create({
          reminderId: reminder._id,
          userId: reminder.userId,
          googleEventId: response.data.id,
          syncStatus: "synced",
        });
        return;
      }
    }

    if (action === "UPDATE") {
      if (!eventMapping) {
        // Was never created (maybe autoAdd was off during CREATE, or deleted manually).
        // Since it's an update now, if autoAdd is on, we could create it, but PRD says
        // autoAdd is for creation. If we strictly follow idempotency, we can just create it.
        if (connection.autoAddEnabled) {
          const eventPayload = buildGoogleEventPayload(reminder);
          const response = await calendar.events.insert({
            calendarId: "primary",
            requestBody: eventPayload,
          });
          await GoogleCalendarEvent.create({
            reminderId: reminder._id,
            userId: reminder.userId,
            googleEventId: response.data.id,
            syncStatus: "synced",
          });
        }
        return;
      }

      // Update existing Google Calendar event
      const eventPayload = buildGoogleEventPayload(reminder);
      await calendar.events.update({
        calendarId: "primary",
        eventId: eventMapping.googleEventId,
        requestBody: eventPayload,
      });

      eventMapping.syncStatus = "synced";
      eventMapping.lastSyncedAt = new Date();
      eventMapping.lastError = "";
      await eventMapping.save();
      return;
    }

    if (action === "DELETE") {
      if (!eventMapping) {
        // Nothing to delete
        return;
      }

      try {
        await calendar.events.delete({
          calendarId: "primary",
          eventId: eventMapping.googleEventId,
        });
      } catch (delErr) {
        // If it's already deleted or not found (404), we can safely ignore
        if (delErr.code !== 404 && delErr.status !== 404) {
          throw delErr;
        }
      }

      // Remove mapping
      await GoogleCalendarEvent.deleteOne({ _id: eventMapping._id });
      return;
    }

  } catch (error) {
    console.error(`[GoogleCalendarSync] Failed to ${action} reminder ${reminder._id}:`, error.message);
    
    // Check if the error is due to a revoked token
    if (error.message && (error.message.includes("invalid_grant") || error.message.includes("revoked"))) {
      await GoogleCalendarConnection.findOneAndUpdate(
        { userId: reminder.userId },
        { $set: { status: "revoked" } }
      );
    }

    // Log the error in mapping if it exists
    if (action !== "DELETE") {
      await GoogleCalendarEvent.findOneAndUpdate(
        { reminderId: reminder._id },
        { 
          $set: { 
            syncStatus: "failed", 
            lastError: error.message || String(error)
          } 
        }
      );
    }
  }
}
