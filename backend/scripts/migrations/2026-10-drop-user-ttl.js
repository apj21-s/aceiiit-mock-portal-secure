// One-off migration: drop the TTL index that auto-deleted trashed users after 30 days
// (it orphaned attempts, entitlements and reminders). Safe to run more than once.
//
//   cd backend && node scripts/migrations/2026-10-drop-user-ttl.js            # dry run
//   cd backend && node scripts/migrations/2026-10-drop-user-ttl.js --apply    # apply
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

async function main() {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI);
  const users = mongoose.connection.db.collection("users");
  const indexes = await users.indexes();
  const ttl = indexes.filter((idx) => idx.key && idx.key.deletedAt === 1 && Object.keys(idx.key).length === 1 && idx.expireAfterSeconds !== undefined);
  if (!ttl.length) {
    console.log("No TTL index on users.deletedAt; nothing to do.");
  }
  for (const idx of ttl) {
    console.log(`${apply ? "Dropping" : "[dry run] Would drop"} index ${idx.name} (expireAfterSeconds=${idx.expireAfterSeconds})`);
    if (apply) await users.dropIndex(idx.name);
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
