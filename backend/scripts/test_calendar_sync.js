const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const GoogleCalendarConnection = require('../models/GoogleCalendarConnection');
const GoogleCalendarEvent = require('../models/GoogleCalendarEvent');

// Stub out googleapis
const { google } = require('googleapis');

let insertedEvents = [];
let updatedEvents = [];
let deletedEvents = [];

const mockCalendar = {
  events: {
    insert: async (params) => {
      insertedEvents.push(params.requestBody);
      return { data: { id: "google-event-id-123" } };
    },
    update: async (params) => {
      updatedEvents.push({ id: params.eventId, body: params.requestBody });
      return { data: { id: params.eventId } };
    },
    delete: async (params) => {
      deletedEvents.push(params.eventId);
      return { data: {} };
    }
  }
};
google.calendar = () => mockCalendar;

const { syncReminderToCalendar } = require('../services/googleCalendarService');

async function runTests() {
  console.log("Starting Automatic Sync Engine Verification...\n");
  
  // Create an in-memory test database using an arbitrary URI if we were connecting, 
  // but we will stub mongoose models directly to avoid needing a real db.
  
  const testUserId = new mongoose.Types.ObjectId().toString();
  const testReminderId = new mongoose.Types.ObjectId().toString();
  
  const testConnection = {
    userId: testUserId,
    refreshToken: "mock_refresh_token",
    autoAddEnabled: true,
    status: "connected"
  };

  const testReminder = {
    _id: testReminderId,
    userId: testUserId,
    title: "UGEE 2026 Mock Test Sync",
    plannedAt: new Date("2026-11-01T10:00:00Z"),
    subjectFocus: ["Math"],
    testId: "test-id-1"
  };

  // Mock Mongoose operations
  GoogleCalendarConnection.findOne = async () => testConnection;
  
  let currentMapping = null;
  GoogleCalendarEvent.findOne = async () => currentMapping;
  GoogleCalendarEvent.create = async (data) => {
    currentMapping = { ...data, _id: "mapping-id", save: async function() {} };
    return currentMapping;
  };
  GoogleCalendarEvent.deleteOne = async () => {
    currentMapping = null;
    return { deletedCount: 1 };
  };

  // 1. CREATE test
  await syncReminderToCalendar(testReminder, "CREATE");
  console.log("--- Test 1: CREATE ---");
  if (insertedEvents.length === 1 && currentMapping) {
    console.log("PASS: Inserted Google Event & Created Mapping.");
    console.log("Payload:", JSON.stringify(insertedEvents[0].summary));
  } else {
    console.log("FAIL: Did not insert properly.");
  }

  // 2. UPDATE test
  testReminder.title = "UGEE 2026 Mock Test Sync (Updated)";
  await syncReminderToCalendar(testReminder, "UPDATE");
  console.log("\n--- Test 2: UPDATE ---");
  if (updatedEvents.length === 1 && updatedEvents[0].id === "google-event-id-123") {
    console.log("PASS: Updated Google Event accurately using mapping.");
    console.log("Payload:", JSON.stringify(updatedEvents[0].body.summary));
  } else {
    console.log("FAIL: Did not update properly.");
  }

  // 3. DELETE test
  await syncReminderToCalendar(testReminder, "DELETE");
  console.log("\n--- Test 3: DELETE ---");
  if (deletedEvents.length === 1 && deletedEvents[0] === "google-event-id-123" && !currentMapping) {
    console.log("PASS: Deleted Google Event & removed mapping.");
  } else {
    console.log("FAIL: Did not delete properly.");
  }
}

runTests().catch(console.error);
