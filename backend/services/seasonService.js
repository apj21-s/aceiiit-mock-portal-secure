const Season = require("../models/Season");
const Test = require("../models/Test");
const Question = require("../models/Question");
const { logAuditEvent } = require("./auditLogService");

async function getActiveSeason() {
  let active = await Season.findOne({ status: "active" }).exec();
  if (!active) {
    active = await Season.findOne({ isDefaultActive: true }).exec();
  }
  if (!active) {
    // Never treat an archived season as the active one.
    active = await Season.findOne({ status: { $ne: "archived" } }).sort({ createdAt: -1 }).exec();
  }
  // Auto-bootstrap if no season exists in DB
  if (!active) {
    active = await Season.create({
      name: "UGEE 2026",
      examName: "UGEE",
      year: 2026,
      status: "active",
      isDefaultActive: true,
    });
    // Link existing tests without seasonId to this default active season
    await Test.updateMany({ seasonId: null }, { $set: { seasonId: active._id } });
  }
  return active;
}

async function setActiveSeason(seasonId, actorUserId = null) {
  const target = await Season.findById(seasonId);
  if (!target) {
    throw new Error("Season not found");
  }

  // Deactivate existing active seasons
  await Season.updateMany({ status: "active" }, { $set: { status: "draft", isDefaultActive: false } });

  target.status = "active";
  target.isDefaultActive = true;
  await target.save();

  await logAuditEvent({
    actorUserId,
    action: "SEASON_ACTIVATED",
    entityType: "Season",
    entityId: target.id,
    seasonId: target.id,
    after: target.toJSON(),
  });

  return target;
}

async function duplicateSeason(seasonId, options = {}, actorUserId = null) {
  const sourceSeason = await Season.findById(seasonId);
  if (!sourceSeason) {
    throw new Error("Source season not found");
  }

  const newYear = (sourceSeason.year || 2026) + 1;
  const newName = `${sourceSeason.examName || "UGEE"} ${newYear}`;

  const newSeason = await Season.create({
    name: newName,
    examName: sourceSeason.examName || "UGEE",
    year: newYear,
    status: "draft",
    isDefaultActive: false,
    createdById: actorUserId,
  });

  let copiedTestsCount = 0;

  if (options.copyTests !== false) {
    const tests = await Test.find({ seasonId: sourceSeason._id, deletedAt: null }).lean();
    for (const test of tests) {
      const questionIdMap = new Map();
      const newQuestionIds = [];

      if (options.copyQuestions !== false && Array.isArray(test.questionIds) && test.questionIds.length) {
        const questions = await Question.find({ _id: { $in: test.questionIds }, deletedAt: null }).lean();
        for (const q of questions) {
          const { _id, createdAt, updatedAt, ...qData } = q;
          const clonedQ = await Question.create(qData);
          questionIdMap.set(String(_id), clonedQ._id);
        }
        for (const qId of test.questionIds) {
          const mapped = questionIdMap.get(String(qId));
          if (mapped) newQuestionIds.push(mapped);
        }
      }

      const { _id, createdAt, updatedAt, ...testData } = test;
      await Test.create({
        ...testData,
        seasonId: newSeason._id,
        series: newName,
        status: "draft",
        questionIds: newQuestionIds,
      });
      copiedTestsCount += 1;
    }
  }

  await logAuditEvent({
    actorUserId,
    action: "SEASON_DUPLICATED",
    entityType: "Season",
    entityId: newSeason.id,
    seasonId: newSeason.id,
    metadata: { sourceSeasonId: sourceSeason.id, copiedTestsCount },
  });

  return { newSeason, copiedTestsCount };
}

module.exports = {
  getActiveSeason,
  setActiveSeason,
  duplicateSeason,
};
