// One-off cleanup: study materials moved to Google Drive, so the old Cloudinary study files
// (and their studyfiles / studyfolders records) are deleted. Question images are not touched.
// Dry run by default; --apply deletes. Safe to run more than once.
//
//   cd backend && node scripts/migrations/2026-10-delete-cloudinary-materials.js            # dry run
//   cd backend && node scripts/migrations/2026-10-delete-cloudinary-materials.js --apply    # delete
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const cloudinary = require("../../config/cloudinary");

async function main() {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const files = await db.collection("studyfiles").find({}).toArray();
  const folders = await db.collection("studyfolders").countDocuments({});
  console.log(`${files.length} Cloudinary study file(s) in ${folders} old folder(s).`);
  let failed = 0;
  for (const file of files) {
    const publicId = String(file.publicId || "");
    if (!publicId.startsWith("study-materials/")) {
      console.log(`Skipping ${file.name}: not a study-materials asset (${publicId || "no id"})`);
      continue;
    }
    console.log(`${apply ? "Deleting" : "[dry run] Would delete"} ${file.name} (${file.resourceType}, ${publicId})`);
    if (!apply) continue;
    try {
      const out = await cloudinary.uploader.destroy(publicId, { resource_type: file.resourceType || "raw", type: "authenticated", invalidate: true });
      if (out && (out.result === "ok" || out.result === "not found")) {
        await db.collection("studyfiles").deleteOne({ _id: file._id });
      } else {
        failed += 1;
        console.log(`  FAILED: Cloudinary said ${JSON.stringify(out)}`);
      }
    } catch (err) {
      failed += 1;
      console.log(`  FAILED: ${err && err.message}`);
    }
  }
  if (apply && !failed) {
    const removed = await db.collection("studyfolders").deleteMany({});
    console.log(`Removed ${removed.deletedCount} old folder record(s).`);
  }
  if (failed) console.log(`${failed} file(s) not deleted; run again to retry.`);
  await mongoose.disconnect();
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
