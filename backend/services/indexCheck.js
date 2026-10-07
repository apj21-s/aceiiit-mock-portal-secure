const mongoose = require("mongoose");

const { logger } = require("../utils/logger");

/** Loads every model so mongoose.models is complete. */
function loadAllModels() {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "models");
  fs.readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .forEach((file) => require(path.join(dir, file)));
  return mongoose.models;
}

const sameJson = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

/**
 * Compares the indexes each schema declares with what exists in MongoDB (key, plus the
 * partial filter where one is declared). Production runs with autoIndex off, so new indexes,
 * including the unique ones that enforce one active exam session, idempotent submits and one
 * AI interpretation per attempt, only exist after
 * `scripts/migrations/2026-10-sync-indexes.js --apply`.
 */
async function diffAllIndexes() {
  const models = loadAllModels();
  const report = [];
  for (const model of Object.values(models)) {
    const entry = { model: model.modelName, collection: model.collection.collectionName, toCreate: [], toDrop: [] };
    let existing = [];
    try {
      existing = await model.collection.indexes();
    } catch (err) {
      // A collection that doesn't exist yet simply has no indexes.
      if (err.code !== 26 && err.codeName !== "NamespaceNotFound") {
        entry.error = err.message;
        report.push(entry);
        continue;
      }
    }
    const declared = model.schema.indexes();
    entry.toCreate = declared
      .filter(([fields, options]) => !existing.some((idx) => sameJson(idx.key, fields) && sameJson(idx.partialFilterExpression, (options || {}).partialFilterExpression)))
      .map(([fields, options]) => ({ key: fields, options: { ...(options || {}) } }));
    entry.toDrop = existing
      .filter((idx) => idx.name !== "_id_" && !declared.some(([fields]) => sameJson(idx.key, fields)))
      .map((idx) => idx.name);
    report.push(entry);
  }
  return report;
}

/** Boot-time warning only: never creates or drops anything. */
async function warnOnMissingIndexes() {
  const report = await diffAllIndexes();
  const missing = report.filter((r) => r.toCreate.length);
  if (missing.length) {
    logger.warn(
      { missing: missing.map((r) => ({ model: r.model, indexes: r.toCreate.map((i) => JSON.stringify(i.key)) })) },
      "MongoDB is missing schema indexes; run scripts/migrations/2026-10-sync-indexes.js --apply"
    );
  }
  return missing.length;
}

module.exports = { diffAllIndexes, warnOnMissingIndexes, loadAllModels };
