// One-off migration: the old client-side flow could save two attempts with the same
// (userId, testId, attemptNumber). That double-counts "first attempts" in rankings and
// blocks the unique index the server now relies on. For every affected (user, test) group
// only, attempts are renumbered 1..N in submission order (submittedAt, then _id).
// Run BEFORE 2026-10-sync-indexes.js. Safe to run repeatedly.
//
//   cd backend && node scripts/migrations/2026-10-renumber-duplicate-attempts.js            # dry run
//   cd backend && node scripts/migrations/2026-10-renumber-duplicate-attempts.js --apply    # apply
const path = require("path");

async function renumberDuplicateAttempts(db, { apply = false } = {}) {
  const attempts = db.collection("attempts");
  const groups = await attempts
    .aggregate([
      { $group: { _id: { userId: "$userId", testId: "$testId", attemptNumber: "$attemptNumber" }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $group: { _id: { userId: "$_id.userId", testId: "$_id.testId" } } },
    ])
    .toArray();
  let changed = 0;
  for (const group of groups) {
    const rows = await attempts
      .find({ userId: group._id.userId, testId: group._id.testId })
      .project({ attemptNumber: 1, submittedAt: 1 })
      .sort({ submittedAt: 1, _id: 1 })
      .toArray();
    const updates = rows
      .map((row, index) => ({ row, number: index + 1 }))
      .filter(({ row, number }) => row.attemptNumber !== number);
    changed += updates.length;
    if (apply && updates.length) {
      await attempts.bulkWrite(updates.map(({ row, number }) => ({ updateOne: { filter: { _id: row._id }, update: { $set: { attemptNumber: number } } } })));
    }
  }
  return { affectedGroups: groups.length, attemptsRenumbered: changed };
}

async function main() {
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
  const mongoose = require("mongoose");
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  const result = await renumberDuplicateAttempts(mongoose.connection.db, { apply });
  console.log(
    `${apply ? "Renumbered" : "[dry run] Would renumber"} ${result.attemptsRenumbered} attempt(s) across ${result.affectedGroups} student/test group(s).`
  );
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { renumberDuplicateAttempts };
