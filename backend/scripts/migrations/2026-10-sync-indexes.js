// Creates every index the schemas declare that is missing from MongoDB. Production runs with
// autoIndex off, so this is how new indexes reach it, including the unique ones that the
// exam-integrity guarantees depend on (one active session per user/test, idempotent submit,
// one AI interpretation per attempt, one QOTD pick per day).
//
// Create-only: indexes present in MongoDB but not in a schema are listed for review and never
// dropped (the old users.deletedAt TTL index has its own migration: 2026-10-drop-user-ttl.js).
// A unique index fails to build if existing documents violate it; the error is printed.
//
//   cd backend && node scripts/migrations/2026-10-sync-indexes.js            # dry run
//   cd backend && node scripts/migrations/2026-10-sync-indexes.js --apply    # create
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const { diffAllIndexes } = require("../../services/indexCheck");

async function main() {
  const apply = process.argv.includes("--apply");
  // autoCreate off: a dry run must not even create empty collections.
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  const report = await diffAllIndexes();
  let failures = 0;
  for (const entry of report) {
    if (entry.error) console.log(`${entry.model}: could not diff (${entry.error})`);
    for (const idx of entry.toCreate) {
      const label = `${entry.collection} ${JSON.stringify(idx.key)}${idx.options.unique ? " unique" : ""}${idx.options.partialFilterExpression ? " partial" : ""}`;
      if (!apply) {
        console.log(`[dry run] Would create ${label}`);
        continue;
      }
      try {
        await mongoose.model(entry.model).collection.createIndex(idx.key, idx.options);
        console.log(`Created ${label}`);
      } catch (err) {
        failures += 1;
        console.log(`FAILED ${label}: ${err.message}`);
      }
    }
    for (const name of entry.toDrop) {
      console.log(`[review] ${entry.collection} has index "${name}" that no schema declares (not dropped)`);
    }
  }
  if (!report.some((r) => r.toCreate.length)) console.log("All schema indexes exist.");
  await mongoose.disconnect();
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
