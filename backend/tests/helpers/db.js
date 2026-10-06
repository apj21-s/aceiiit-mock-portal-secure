const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { connectDb } = require("../../config/db");

const fs = require("fs");
const os = require("os");
const path = require("path");

let mongod = null;
let dbPath = null;

async function startDb() {
  // /tmp is a small quota-limited tmpfs on dev machines, so keep the data files on disk
  // under node_modules/.cache (gitignored) and remove them in stopDb().
  const cacheRoot = path.join(__dirname, "..", "..", "node_modules", ".cache", "mongodb-test-data");
  fs.mkdirSync(cacheRoot, { recursive: true });
  dbPath = fs.mkdtempSync(path.join(cacheRoot, `${os.hostname()}-`));
  mongod = await MongoMemoryServer.create({
    instance: { dbPath, args: ["--wiredTigerCacheSizeGB", "0.25"] },
  });
  await connectDb(mongod.getUri());
  // Build indexes up front so unique constraints behave like production.
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}

async function clearDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
  const { invalidateAllTestCaches } = require("../../services/testDataService");
  invalidateAllTestCaches();
}

async function stopDb() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  mongod = null;
  if (dbPath) fs.rmSync(dbPath, { recursive: true, force: true });
  dbPath = null;
}

module.exports = { startDb, clearDb, stopDb };
