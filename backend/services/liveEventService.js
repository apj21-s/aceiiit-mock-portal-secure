const Test = require("../models/Test");

// Live mock events: a scheduled test that students join within a window after it opens (each
// still gets the full time from their own start), with scores, ranks and review held back until
// a set time so nobody sees results while others are still writing.

function isEvent(test) {
  return Boolean(test && test.event && test.event.enabled && test.event.startsAt);
}

/** When joining closes, or null when the test isn't an event. */
function joinClosesAt(test) {
  if (!isEvent(test)) return null;
  return new Date(new Date(test.event.startsAt).getTime() + Number(test.event.joinMinutes || 15) * 60000);
}

/** When results come out, or null when they aren't being held. */
function resultsHeldUntil(test, now = Date.now()) {
  if (!isEvent(test) || !test.event.resultsAt) return null;
  const at = new Date(test.event.resultsAt);
  return at.getTime() > now ? at : null;
}

/** Map of testId → resultsAt for the given tests whose results are still held. */
async function heldResults(testIds, now = new Date()) {
  const ids = Array.from(new Set((testIds || []).filter(Boolean).map(String)));
  if (!ids.length) return new Map();
  const rows = await Test.find({ _id: { $in: ids }, "event.enabled": true, "event.resultsAt": { $gt: now } }).select("_id event.resultsAt").lean();
  return new Map(rows.map((t) => [String(t._id), t.event.resultsAt]));
}

async function heldTestIds(testIds, now = new Date()) {
  return new Set((await heldResults(testIds, now)).keys());
}

/** What students see about an event in the catalog. */
function eventView(test) {
  if (!isEvent(test)) return null;
  return {
    startsAt: new Date(test.event.startsAt).toISOString(),
    joinMinutes: Number(test.event.joinMinutes || 15),
    joinClosesAt: joinClosesAt(test).toISOString(),
    resultsAt: test.event.resultsAt ? new Date(test.event.resultsAt).toISOString() : null,
  };
}

module.exports = { isEvent, joinClosesAt, resultsHeldUntil, heldResults, heldTestIds, eventView };
