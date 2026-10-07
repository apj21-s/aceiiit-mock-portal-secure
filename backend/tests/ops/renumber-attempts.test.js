// Migration: duplicate (userId, testId, attemptNumber) rows from the old client flow are
// renumbered in submission order, only for affected groups, so the unique index can build.
const mongoose = require("mongoose");

const Attempt = require("../../models/Attempt");
const { renumberDuplicateAttempts } = require("../../scripts/migrations/2026-10-renumber-duplicate-attempts");
const { startDb, stopDb } = require("../helpers/db");

beforeAll(startDb);
afterAll(stopDb);

test("renumbers only affected groups, in submission order, and lets the unique index build", async () => {
  const coll = mongoose.connection.db.collection("attempts");
  await Attempt.collection.dropIndexes(); // legacy data predates the unique index
  const [u1, u2, t] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const at = (m) => new Date(Date.UTC(2026, 8, 1, 10, m));
  await coll.insertMany([
    { userId: u1, testId: t, attemptNumber: 1, submittedAt: at(5), score: 10 },
    { userId: u1, testId: t, attemptNumber: 1, submittedAt: at(1), score: 20 }, // earliest → #1
    { userId: u1, testId: t, attemptNumber: 2, submittedAt: at(9), score: 30 },
    { userId: u2, testId: t, attemptNumber: 1, submittedAt: at(2), score: 40 }, // clean group: untouched
    { userId: u2, testId: t, attemptNumber: 2, submittedAt: at(3), score: 50 },
  ]);

  expect(await renumberDuplicateAttempts(mongoose.connection.db)).toEqual({ affectedGroups: 1, attemptsRenumbered: 2 });
  expect(await coll.countDocuments({ userId: u1, attemptNumber: 1 })).toBe(2); // dry run changed nothing

  expect(await renumberDuplicateAttempts(mongoose.connection.db, { apply: true })).toEqual({ affectedGroups: 1, attemptsRenumbered: 2 });
  const u1Rows = await coll.find({ userId: u1 }).sort({ attemptNumber: 1 }).toArray();
  expect(u1Rows.map((r) => [r.attemptNumber, r.score])).toEqual([[1, 20], [2, 10], [3, 30]]);
  const u2Rows = await coll.find({ userId: u2 }).sort({ attemptNumber: 1 }).toArray();
  expect(u2Rows.map((r) => r.attemptNumber)).toEqual([1, 2]);

  expect(await renumberDuplicateAttempts(mongoose.connection.db, { apply: true })).toEqual({ affectedGroups: 0, attemptsRenumbered: 0 });
  await expect(Attempt.syncIndexes()).resolves.toBeDefined();
});
