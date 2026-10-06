const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

// Stub nodemailer
const nodemailer = require('nodemailer');
let sentEmails = [];
nodemailer.createTransport = function(options) {
  return {
    sendMail: async function(payload) {
      sentEmails.push(payload);
      return { messageId: 'test-id' };
    }
  };
};

// Also mock Google Calendar service to avoid errors

const { sendCalendarInviteEmail } = require('../backend/utils/mailService');

async function runTests() {
  console.log("Starting End-to-End ICS Verification...\n");
  
  const testReminderId = new mongoose.Types.ObjectId().toString();
  const testEmail = "student@test.com";
  const testLink = "https://portal.aceiiit.in/test/mock-id";
  
  const reminder = {
    _id: testReminderId,
    email: testEmail,
    title: "UGEE 2026 Mock Test 1",
    plannedAt: new Date("2026-10-15T10:00:00Z"),
    subjectFocus: ["Math", "SUPR"],
    sequence: 0,
    save: async function() {}
  };

  // Test 1: Initial Invitation
  sentEmails = [];
  await sendCalendarInviteEmail(reminder, testLink, "REQUEST", "CONFIRMED");
  const email1 = sentEmails[0];
  
  console.log("--- Test 1: Initial Invitation ---");
  if (!email1) {
    console.error("FAIL: No email sent");
  } else {
    const icsContent = email1.icalEvent.content;
    console.log("ICS Content Extracted:\n" + icsContent + "\n");
    console.log("Checks:");
    console.log("1. METHOD:REQUEST -", icsContent.includes("METHOD:REQUEST") ? "PASS" : "FAIL");
    console.log("2. UID -", icsContent.includes(`UID:${testReminderId}@aceiiit.in`) ? "PASS" : "FAIL");
    console.log("3. SEQUENCE:0 -", icsContent.includes("SEQUENCE:0") ? "PASS" : "FAIL");
    console.log("4. No localhost URL -", (!icsContent.includes("localhost")) ? "PASS" : "FAIL");
  }

  // Test 2: Resend
  sentEmails = [];
  await sendCalendarInviteEmail(reminder, testLink, "REQUEST", "CONFIRMED");
  const email2 = sentEmails[0];
  console.log("\n--- Test 2: Resend ---");
  if (!email2) {
    console.error("FAIL: No email sent");
  } else {
    const icsContent2 = email2.icalEvent.content;
    console.log("Checks:");
    console.log("1. UID Match -", icsContent2.includes(`UID:${testReminderId}@aceiiit.in`) ? "PASS" : "FAIL");
    console.log("2. SEQUENCE:0 -", icsContent2.includes("SEQUENCE:0") ? "PASS" : "FAIL");
  }

  // Test 3: Reschedule
  sentEmails = [];
  reminder.sequence = 1;
  reminder.plannedAt = new Date("2026-10-16T10:00:00Z");
  await sendCalendarInviteEmail(reminder, testLink, "REQUEST", "CONFIRMED");
  const email3 = sentEmails[0];
  console.log("\n--- Test 3: Reschedule ---");
  if (!email3) {
    console.error("FAIL: No email sent");
  } else {
    const icsContent3 = email3.icalEvent.content;
    console.log("Checks:");
    console.log("1. UID Match -", icsContent3.includes(`UID:${testReminderId}@aceiiit.in`) ? "PASS" : "FAIL");
    console.log("2. SEQUENCE:1 -", icsContent3.includes("SEQUENCE:1") ? "PASS" : "FAIL");
  }
}

runTests().catch(console.error);
