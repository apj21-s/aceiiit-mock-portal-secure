const { z } = require("zod");
const mongoose = require("mongoose");

const Attempt = require("../models/Attempt");
const Question = require("../models/Question");
const QuestionReport = require("../models/QuestionReport");
const Test = require("../models/Test");

// Students report a problem with a question they answered; admins see the reports grouped by
// question in Studio → Reports and resolve them after fixing (or checking) the question.

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const REASONS = ["wrong_answer", "typo", "maths", "image", "other"];

const reportSchema = z.object({
  attemptId: objectId,
  reason: z.enum(REASONS),
  note: z.string().trim().max(500).optional().default(""),
}).strict();

const resolveSchema = z.object({ note: z.string().trim().max(300).optional().default("") }).strict();

function sendError(res, err, next) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: (err.issues[0] && err.issues[0].message) || "Invalid report", code: "VALIDATION_ERROR" });
  return next(err);
}

/** POST /api/questions/:id/report: only for a question in one of your own submitted attempts. */
async function reportQuestion(req, res, next) {
  try {
    const input = reportSchema.parse(req.body || {});
    const questionId = req.params.id;
    // questionReview is a free-form array, so match the id as stored (ObjectId) or as text.
    const attempt = await Attempt.findOne({
      _id: input.attemptId,
      userId: req.auth.userId,
      "questionReview.questionId": { $in: [new mongoose.Types.ObjectId(questionId), questionId] },
    }).select("_id").lean();
    if (!attempt) return res.status(404).json({ error: "You can report questions from your own results.", code: "REPORT_NOT_ALLOWED" });
    const update = { reason: input.reason, note: input.note, attemptId: attempt._id };
    const report = await QuestionReport.findOneAndUpdate(
      { userId: req.auth.userId, questionId, status: "open" },
      { $set: update, $setOnInsert: { userId: req.auth.userId, questionId, status: "open" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return res.status(201).json({ report: { id: String(report._id), reason: report.reason, status: report.status } });
  } catch (err) {
    return sendError(res, err, next);
  }
}

/** GET /api/admin/reports?status=open|resolved: grouped by question, newest first. */
async function adminListReports(req, res, next) {
  try {
    const status = req.query.status === "resolved" ? "resolved" : "open";
    const reports = await QuestionReport.find({ status }).sort({ createdAt: -1 }).limit(500)
      .populate("userId", "name").lean();
    const byQuestion = new Map();
    reports.forEach((r) => {
      const key = String(r.questionId);
      if (!byQuestion.has(key)) byQuestion.set(key, []);
      byQuestion.get(key).push(r);
    });
    const ids = Array.from(byQuestion.keys());
    const [questions, tests] = await Promise.all([
      Question.find({ _id: { $in: ids } }).select("section topic prompt options correctOption deletedAt").lean(),
      Test.find({ questionIds: { $in: ids }, deletedAt: null, status: { $ne: "practice" } }).select("title questionIds").lean(),
    ]);
    const qById = new Map(questions.map((q) => [String(q._id), q]));
    const items = ids.map((id) => {
      const list = byQuestion.get(id);
      const q = qById.get(id);
      const reasons = {};
      list.forEach((r) => { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
      return {
        questionId: id,
        question: q ? {
          section: q.section, topic: q.topic, prompt: q.prompt, options: q.options || [], correctOption: q.correctOption, deleted: Boolean(q.deletedAt),
          tests: tests.filter((t) => (t.questionIds || []).some((x) => String(x) === id)).map((t) => ({ id: String(t._id), title: t.title })),
        } : null,
        count: list.length,
        reasons,
        latestAt: list[0].createdAt,
        reports: list.slice(0, 20).map((r) => ({
          id: String(r._id),
          reason: r.reason,
          note: r.note || "",
          student: r.userId && r.userId.name ? r.userId.name : "Student",
          createdAt: r.createdAt,
          resolvedAt: r.resolvedAt,
          resolutionNote: r.resolutionNote || "",
        })),
      };
    }).sort((a, b) => b.count - a.count || new Date(b.latestAt) - new Date(a.latestAt));
    const openTotal = status === "open" ? reports.length : await QuestionReport.countDocuments({ status: "open" });
    return res.json({ items, openTotal });
  } catch (err) {
    return next(err);
  }
}

/** POST /api/admin/reports/:id/resolve (:id = question id): resolves every open report on it. */
async function adminResolveReports(req, res, next) {
  try {
    const input = resolveSchema.parse(req.body || {});
    const result = await QuestionReport.updateMany(
      { questionId: req.params.id, status: "open" },
      { $set: { status: "resolved", resolvedBy: req.auth.userId, resolvedAt: new Date(), resolutionNote: input.note } }
    );
    res.locals.auditEntityId = String(req.params.id);
    return res.json({ resolved: result.modifiedCount || 0 });
  } catch (err) {
    return sendError(res, err, next);
  }
}

/** Open report counts per question (for the Review tab's health check). */
async function adminOpenReportCounts(_req, res, next) {
  try {
    const rows = await QuestionReport.aggregate([{ $match: { status: "open" } }, { $group: { _id: "$questionId", count: { $sum: 1 } } }]);
    return res.json({ counts: Object.fromEntries(rows.map((r) => [String(r._id), r.count])) });
  } catch (err) {
    return next(err);
  }
}

module.exports = { reportQuestion, adminListReports, adminResolveReports, adminOpenReportCounts };
