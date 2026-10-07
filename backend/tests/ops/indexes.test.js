// Production runs with autoIndex off; the index check finds missing schema indexes (such as
// the partial unique index behind "one active exam session") so the migration can create them.
const mongoose = require("mongoose");

const { diffAllIndexes, warnOnMissingIndexes, loadAllModels } = require("../../services/indexCheck");
const { startDb, stopDb } = require("../helpers/db");

loadAllModels(); // so the DB helper syncs every model's indexes

beforeAll(startDb);
afterAll(stopDb);

test("no differences after a full sync", async () => {
  const report = await diffAllIndexes();
  expect(report.length).toBeGreaterThan(10);
  expect(report.filter((r) => r.toCreate.length)).toEqual([]);
  expect(await warnOnMissingIndexes()).toBe(0);
});

test("a dropped integrity index is reported and can be recreated from the report", async () => {
  const AttemptSession = mongoose.model("AttemptSession");
  const indexes = await AttemptSession.collection.indexes();
  const partial = indexes.find((i) => i.partialFilterExpression && i.unique);
  expect(partial).toBeTruthy();
  await AttemptSession.collection.dropIndex(partial.name);

  const missing = (await diffAllIndexes()).find((r) => r.model === "AttemptSession").toCreate;
  expect(missing).toHaveLength(1);
  expect(missing[0].options.unique).toBe(true);
  expect(await warnOnMissingIndexes()).toBe(1);

  await AttemptSession.collection.createIndex(missing[0].key, missing[0].options);
  expect((await diffAllIndexes()).find((r) => r.model === "AttemptSession").toCreate).toEqual([]);
});
