const { z } = require("zod");

const Question = require("../models/Question");
const Test = require("../models/Test");
const importer = require("../services/questionImportService");
const { recalculateTestsMetadata, getSectionDefaultMarking } = require("./adminController");
const { invalidateAllTestCaches, invalidateCatalogCache, invalidateTestRuntimeCache } = require("../services/testDataService");

// Studio → Import from Excel/CSV. Template download, a preview that saves nothing, and an
// all-or-nothing import that can attach the questions to a test in sheet order.

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid test id");

function sendError(res, err, next) {
  if (err && err.code === "IMPORT_INVALID") return res.status(400).json({ error: err.message, code: err.code });
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0] ? err.issues[0].message : "Invalid request", code: "VALIDATION_ERROR" });
  return next(err);
}

async function downloadTemplate(req, res, next) {
  try {
    const format = String(req.query.format || "xlsx") === "csv" ? "csv" : "xlsx";
    const file = await importer.buildTemplate(format);
    res.setHeader("Content-Type", file.type);
    res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(file.buffer);
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function loadTarget(testId) {
  if (!testId) return null;
  const test = await Test.findOne({ _id: testId, deletedAt: null }).select("_id title questionIds status").lean();
  if (!test) throw Object.assign(new Error("That test no longer exists."), { code: "IMPORT_INVALID" });
  if (test.status === "practice") throw Object.assign(new Error("Questions can't be imported into a practice paper."), { code: "IMPORT_INVALID" });
  return test;
}

async function sectionCounts(questionIds) {
  const ids = (questionIds || []).map(String);
  if (!ids.length) return { SUPR: 0, REAP: 0 };
  const rows = await Question.find({ _id: { $in: ids }, deletedAt: null }).select("section").lean();
  return rows.reduce((acc, q) => { acc[q.section === "REAP" ? "REAP" : "SUPR"] += 1; return acc; }, { SUPR: 0, REAP: 0 });
}

/** Parses and checks the sheet; nothing is saved. */
async function previewImport(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "Choose an .xlsx or .csv file.", code: "IMPORT_INVALID" });
    const testId = req.body && req.body.testId ? objectId.parse(String(req.body.testId)) : null;
    const target = await loadTarget(testId);
    const rows = await importer.previewRows(req.file.buffer, req.file.originalname);

    // Already in the question bank (same section, question and options): import is allowed,
    // but say so, since it's usually a sheet uploaded twice.
    const valid = rows.filter((r) => !r.errors.length);
    const prompts = Array.from(new Set(valid.map((r) => r.question.prompt)));
    if (prompts.length) {
      const existing = await Question.find({ prompt: { $in: prompts }, deletedAt: null }).select("section prompt options").lean();
      const keys = new Set(existing.map((q) => importer.dedupeKey(q)));
      valid.forEach((r) => { if (keys.has(importer.dedupeKey(r.question))) r.warnings.push("already in the question bank"); });
    }

    const adding = valid.reduce((acc, r) => { acc[r.question.section] += 1; return acc; }, { SUPR: 0, REAP: 0 });
    let current = null;
    const notes = [];
    if (target) {
      current = await sectionCounts(target.questionIds);
      ["SUPR", "REAP"].forEach((section) => {
        const after = current[section] + adding[section];
        if (adding[section] && after > importer.SECTION_LIMITS[section]) {
          notes.push(`${target.title} would have ${after} ${section} questions (a full UGEE paper has ${importer.SECTION_LIMITS[section]}).`);
        }
      });
    }
    return res.json({
      rows,
      summary: {
        total: rows.length,
        ready: valid.length,
        withErrors: rows.length - valid.length,
        withWarnings: valid.filter((r) => r.warnings.length).length,
        adding,
      },
      target: target ? { id: String(target._id), title: target.title, current } : null,
      notes,
    });
  } catch (err) {
    return sendError(res, err, next);
  }
}

const commitSchema = z.object({
  testId: objectId.optional().nullable(),
  questions: z.array(z.record(z.any())).min(1).max(importer.MAX_ROWS),
}).strict();

/** Saves every question (all or nothing) and attaches them to the test in order. */
async function commitImport(req, res, next) {
  try {
    const input = commitSchema.parse(req.body || {});
    const target = await loadTarget(input.testId || null);
    const checked = input.questions.map((q, index) => ({ index, ...importer.validateCells(importer.questionToCells(q)) }));
    const bad = checked.filter((c) => c.errors.length);
    if (bad.length) {
      return res.status(400).json({ error: "Some questions have problems; nothing was imported.", code: "IMPORT_INVALID", problems: bad.map((b) => ({ index: b.index, errors: b.errors })) });
    }
    const docs = checked.map(({ question }) => {
      const defaults = getSectionDefaultMarking(question.section);
      return {
        section: question.section,
        topic: question.topic,
        difficulty: question.difficulty,
        prompt: question.prompt,
        passage: question.passage || "",
        options: question.options,
        correctOption: question.correctOption,
        explanation: question.explanation || "",
        imageUrls: question.imageUrls || [],
        imageWidths: (question.imageUrls || []).map(() => 0),
        marks: question.marks !== undefined ? question.marks : defaults.marks,
        negativeMarks: question.negativeMarks !== undefined ? question.negativeMarks : defaults.negativeMarks,
      };
    });
    const saved = await Question.insertMany(docs, { ordered: true });
    const ids = saved.map((q) => q._id);
    if (target) {
      await Test.updateOne({ _id: target._id, deletedAt: null }, { $addToSet: { questionIds: { $each: ids } } });
      await recalculateTestsMetadata([String(target._id)]);
      invalidateTestRuntimeCache(String(target._id));
    }
    invalidateAllTestCaches();
    invalidateCatalogCache();
    res.locals.auditEntityId = target ? String(target._id) : "";
    const bySection = docs.reduce((acc, d) => { acc[d.section] += 1; return acc; }, { SUPR: 0, REAP: 0 });
    return res.status(201).json({ imported: ids.length, bySection, testId: target ? String(target._id) : null, questionIds: ids.map(String) });
  } catch (err) {
    return sendError(res, err, next);
  }
}

module.exports = { downloadTemplate, previewImport, commitImport };
