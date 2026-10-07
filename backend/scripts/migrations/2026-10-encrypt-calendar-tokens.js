// One-off migration: encrypt Google Calendar refresh tokens stored in plaintext.
// Requires CALENDAR_TOKEN_KEY. Safe to run repeatedly (already-encrypted rows are skipped).
//
//   cd backend && node scripts/migrations/2026-10-encrypt-calendar-tokens.js            # dry run
//   cd backend && node scripts/migrations/2026-10-encrypt-calendar-tokens.js --apply    # apply
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { encryptSecret, isEncrypted } = require("../../utils/crypto");

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.CALENDAR_TOKEN_KEY) throw new Error("Set CALENDAR_TOKEN_KEY first.");
  await mongoose.connect(process.env.MONGODB_URI);
  const collection = mongoose.connection.db.collection("googlecalendarconnections");
  const rows = await collection.find({ refreshToken: { $exists: true, $nin: ["", null] } }).toArray();
  let pending = 0;
  for (const row of rows) {
    if (isEncrypted(row.refreshToken)) continue;
    pending += 1;
    if (apply) await collection.updateOne({ _id: row._id }, { $set: { refreshToken: encryptSecret(row.refreshToken) } });
  }
  console.log(`${apply ? "Encrypted" : "[dry run] Would encrypt"} ${pending} of ${rows.length} stored token(s).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
