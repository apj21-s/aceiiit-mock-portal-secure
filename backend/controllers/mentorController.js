const { z } = require("zod");

const Attempt = require("../models/Attempt");
const MentorConversation = require("../models/MentorConversation");
const MentorDailyStat = require("../models/MentorDailyStat");
const MentorMessage = require("../models/MentorMessage");
const MentorUsage = require("../models/MentorUsage");
const Test = require("../models/Test");
const User = require("../models/User");
const { MentorError, sendMessage, getUsageForUser, getAvailability, publicMessage } = require("../services/mentorService");
const { getMentorSettings, updateMentorSettings } = require("../services/mentorSettingsService");
const { usagePeriod } = require("../services/mentorAccessService");

// ACEIIIT Mentor API. The student is always the signed-in user (req.auth); conversations and
// attempts are owner-checked on every request; tier and usage are computed on the server.

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const createSchema = z.object({ attemptId: objectId.optional().nullable() }).strict();
const messageSchema = z.object({
  content: z.string().max(20000),
  clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid message id"),
}).strict();

async function currentUser(req) {
  const user = await User.findById(req.auth.userId).select("email normalizedEmail role deletedAt").lean();
  if (!user || user.deletedAt) throw new MentorError(401, "AUTH_REQUIRED", "Please sign in again.");
  return user;
}

function sendMentorError(res, err) {
  return res.status(err.status || 500).json({
    error: err.message,
    code: err.code,
    retryable: Boolean(err.retryable),
    ...(err.usage ? { usage: err.usage } : {}),
  });
}

async function attemptSummaries(attemptIds) {
  const ids = attemptIds.filter(Boolean);
  if (!ids.length) return new Map();
  const attempts = await Attempt.find({ _id: { $in: ids } }).select("testId submittedAt attemptNumber isPractice").lean();
  const tests = await Test.find({ _id: { $in: attempts.map((a) => a.testId) } }).select("title").lean();
  const titles = new Map(tests.map((t) => [String(t._id), t.title]));
  return new Map(attempts.map((a) => [String(a._id), {
    id: String(a._id),
    test: titles.get(String(a.testId)) || (a.isPractice ? "Practice session" : "Mock test"),
    submittedAt: a.submittedAt,
    attemptNumber: a.attemptNumber,
  }]));
}

function conversationView(c, attempts) {
  return {
    id: String(c._id),
    title: c.title,
    attempt: c.attemptId ? attempts.get(String(c.attemptId)) || null : null,
    messageCount: c.messageCount || 0,
    lastMessageAt: c.lastMessageAt,
    createdAt: c.createdAt,
  };
}

async function usage(req, res, next) {
  try {
    return res.json({ usage: await getUsageForUser(await currentUser(req)) });
  } catch (err) {
    return err instanceof MentorError ? sendMentorError(res, err) : next(err);
  }
}

async function listConversations(req, res, next) {
  try {
    const list = await MentorConversation.find({ userId: req.auth.userId }).sort({ lastMessageAt: -1 }).limit(30).lean();
    const attempts = await attemptSummaries(list.map((c) => c.attemptId));
    return res.json({ conversations: list.map((c) => conversationView(c, attempts)) });
  } catch (err) {
    return next(err);
  }
}

async function createConversation(req, res, next) {
  try {
    const input = createSchema.parse(req.body || {});
    let attemptId = null;
    if (input.attemptId) {
      const attempt = await Attempt.findOne({ _id: input.attemptId, userId: req.auth.userId }).select("_id").lean();
      if (!attempt) return res.status(404).json({ error: "Attempt not found", code: "MENTOR_NOT_FOUND" });
      attemptId = attempt._id;
      // Opening the mentor twice from the same result reuses its empty conversation.
      const empty = await MentorConversation.findOne({ userId: req.auth.userId, attemptId, messageCount: 0 }).lean();
      if (empty) {
        const attempts = await attemptSummaries([attemptId]);
        return res.json({ conversation: conversationView(empty, attempts) });
      }
    }
    const attempts = await attemptSummaries([attemptId]);
    const linked = attemptId ? attempts.get(String(attemptId)) : null;
    const conversation = await MentorConversation.create({
      userId: req.auth.userId,
      attemptId,
      title: linked ? `About ${linked.test}`.slice(0, 120) : "New conversation",
    });
    return res.status(201).json({ conversation: conversationView(conversation.toObject(), attempts) });
  } catch (err) {
    return next(err);
  }
}

async function getConversation(req, res, next) {
  try {
    const conversation = await MentorConversation.findOne({ _id: req.params.id, userId: req.auth.userId }).lean();
    if (!conversation) return res.status(404).json({ error: "Conversation not found", code: "MENTOR_NOT_FOUND" });
    const [messages, attempts] = await Promise.all([
      MentorMessage.find({ conversationId: conversation._id }).sort({ createdAt: 1 }).limit(200).lean(),
      attemptSummaries([conversation.attemptId]),
    ]);
    return res.json({ conversation: conversationView(conversation, attempts), messages: messages.map(publicMessage) });
  } catch (err) {
    return next(err);
  }
}

async function deleteConversation(req, res, next) {
  try {
    const conversation = await MentorConversation.findOne({ _id: req.params.id, userId: req.auth.userId }).select("_id").lean();
    if (!conversation) return res.status(404).json({ error: "Conversation not found", code: "MENTOR_NOT_FOUND" });
    await MentorMessage.deleteMany({ conversationId: conversation._id });
    await MentorConversation.deleteOne({ _id: conversation._id });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function postMessage(req, res, next) {
  try {
    const input = messageSchema.parse(req.body || {});
    const user = await currentUser(req);
    const result = await sendMessage({ user, conversationId: req.params.id, content: input.content, clientMessageId: input.clientMessageId });
    return res.status(result.duplicate ? 200 : 201).json(result);
  } catch (err) {
    if (err instanceof MentorError) {
      if (!err.usage && (err.code === "MENTOR_UNAVAILABLE" || err.code === "MENTOR_PROVIDER_ERROR" || err.code === "MENTOR_LIMIT")) {
        err.usage = await getUsageForUser(await currentUser(req)).catch(() => undefined);
      }
      return sendMentorError(res, err);
    }
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Admin (Studio → ACEIIIT Mentor)
// ---------------------------------------------------------------------------
async function adminMentor(_req, res, next) {
  try {
    const settings = await getMentorSettings({ fresh: true });
    const { period, day } = usagePeriod();
    const [month, availability, days] = await Promise.all([
      MentorUsage.aggregate([
        { $match: { period } },
        { $group: { _id: null, replies: { $sum: "$used" }, students: { $sum: { $cond: [{ $gt: ["$used", 0] }, 1, 0] } } } },
      ]),
      getAvailability(settings),
      MentorDailyStat.find({}).sort({ day: -1 }).limit(7).lean(),
    ]);
    const today = days.find((d) => d.day === day) || { replies: 0, failures: 0 };
    return res.json({
      settings,
      status: {
        ...availability,
        keyConfigured: Boolean(String(process.env.GEMINI_API_KEY || "").trim()),
        model: process.env.GEMINI_MODEL || "",
      },
      stats: {
        period,
        timezone: "Asia/Kolkata",
        monthReplies: month[0] ? month[0].replies : 0,
        monthStudents: month[0] ? month[0].students : 0,
        today: { replies: today.replies || 0, failures: today.failures || 0 },
        lastDays: days.map((d) => ({ day: d.day, replies: d.replies, failures: d.failures })),
      },
    });
  } catch (err) {
    return next(err);
  }
}

async function updateAdminMentor(req, res, next) {
  try {
    const settings = await updateMentorSettings(req.body, req.auth.userId);
    return res.json({ settings });
  } catch (err) {
    return next(err);
  }
}

module.exports = { usage, listConversations, createConversation, getConversation, deleteConversation, postMessage, adminMentor, updateAdminMentor };
