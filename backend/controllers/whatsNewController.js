const { z } = require("zod");

const ReleaseNote = require("../models/ReleaseNote");
const User = require("../models/User");
const { hasAnyActiveEntitlement } = require("../services/entitlementService");

// "What's new": students get the newest published note they haven't seen (once per account);
// admins write, publish and unpublish notes in Studio.

const HTTPS_URL = /^https:\/\/[^\s<>"'`]+$/i;
const PORTAL_ROUTE = /^#\/?[a-z0-9/_-]*$/i;

const safeLink = (message) => z.string().trim().max(300).optional().default("")
  .refine((v) => !v || PORTAL_ROUTE.test(v) || HTTPS_URL.test(v), message);

const itemSchema = z.object({
  icon: z.string().trim().max(16).optional().default(""),
  title: z.string().trim().min(1, "Each item needs a title").max(60),
  body: z.string().trim().max(240).optional().default(""),
  href: safeLink("An item's Try it link must be a portal page like #exams/practice or an https:// address"),
}).strict();

const noteSchema = z.object({
  title: z.string().trim().min(1, "Add a title").max(80),
  summary: z.string().trim().max(280).optional().default(""),
  items: z.array(itemSchema).min(1, "Add at least one item").max(6, "Up to 6 items"),
  imageUrl: z.string().trim().max(500).optional().default("")
    .refine((v) => !v || HTTPS_URL.test(v), "The image must be an https:// link"),
  ctaLabel: z.string().trim().max(30).optional().default(""),
  ctaHref: z.string().trim().max(300).optional().default("")
    .refine((v) => !v || PORTAL_ROUTE.test(v) || HTTPS_URL.test(v), "The button link must be a portal page like #exams/practice or an https:// address"),
  audience: z.enum(["all", "free", "paid"]).optional().default("all"),
}).strict().refine((n) => Boolean(n.ctaLabel) === Boolean(n.ctaHref), { message: "A button needs both a label and a link", path: ["ctaHref"] });

function publicNote(note) {
  return {
    id: String(note._id),
    title: note.title,
    summary: note.summary || "",
    items: (note.items || []).map((i) => ({ icon: i.icon || "", title: i.title, body: i.body || "", href: i.href || "" })),
    imageUrl: note.imageUrl || "",
    cta: note.ctaLabel && note.ctaHref ? { label: note.ctaLabel, href: note.ctaHref } : null,
    publishedAt: note.publishedAt ? new Date(note.publishedAt).toISOString() : null,
  };
}

function adminNote(note) {
  return {
    ...publicNote(note),
    ctaLabel: note.ctaLabel || "",
    ctaHref: note.ctaHref || "",
    audience: note.audience || "all",
    status: note.status,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function sendError(res, err, next) {
  if (err instanceof z.ZodError) {
    const issue = err.issues[0];
    return res.status(400).json({ error: issue ? issue.message : "Invalid note", code: "VALIDATION_ERROR", field: issue && issue.path ? issue.path.join(".") : "" });
  }
  return next(err);
}

/** GET /api/whats-new: the newest unseen note for this student (?latest=1: newest, seen or not). */
async function getForMe(req, res, next) {
  try {
    const user = await User.findById(req.auth.userId).select("email role createdAt whatsNewSeenAt").lean();
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const isAdmin = user.role === "admin";
    // Paid targeting uses the real entitlement on the server, never a client flag.
    const audiences = isAdmin ? ["all", "free", "paid"] : ["all", (await hasAnyActiveEntitlement(user.email)) ? "paid" : "free"];
    const filter = { status: "published", publishedAt: { $ne: null }, audience: { $in: audiences } };
    if (String(req.query.latest || "") !== "1") {
      // Only news from after the account existed and after the last note was closed.
      const since = [user.createdAt, user.whatsNewSeenAt].filter(Boolean).map((d) => new Date(d).getTime());
      if (since.length) filter.publishedAt = { $gt: new Date(Math.max(...since)) };
    }
    const note = await ReleaseNote.findOne(filter).sort({ publishedAt: -1 }).lean();
    return res.json({ note: note ? publicNote(note) : null });
  } catch (err) {
    return next(err);
  }
}

/** POST /api/whats-new/seen */
async function markSeen(req, res, next) {
  try {
    await User.updateOne({ _id: req.auth.userId }, { $set: { whatsNewSeenAt: new Date() } });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function adminList(_req, res, next) {
  try {
    const notes = await ReleaseNote.find({}).sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ notes: notes.map(adminNote) });
  } catch (err) {
    return next(err);
  }
}

async function adminCreate(req, res, next) {
  try {
    const input = noteSchema.parse(req.body || {});
    const note = await ReleaseNote.create({ ...input, status: "draft", createdBy: req.auth.userId });
    res.locals.auditEntityId = String(note._id);
    return res.status(201).json({ note: adminNote(note.toObject()) });
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function adminUpdate(req, res, next) {
  try {
    const input = noteSchema.parse(req.body || {});
    // Editing a published note fixes it in place; it doesn't pop up again for people who saw it.
    const note = await ReleaseNote.findByIdAndUpdate(req.params.id, { $set: input }, { new: true, runValidators: true }).lean();
    if (!note) return res.status(404).json({ error: "Note not found" });
    return res.json({ note: adminNote(note) });
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function adminDelete(req, res, next) {
  try {
    const gone = await ReleaseNote.findByIdAndDelete(req.params.id).lean();
    if (!gone) return res.status(404).json({ error: "Note not found" });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

function setStatus(published) {
  return async function setNoteStatus(req, res, next) {
    try {
      const update = published ? { status: "published", publishedAt: new Date() } : { status: "draft", publishedAt: null };
      const note = await ReleaseNote.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
      if (!note) return res.status(404).json({ error: "Note not found" });
      return res.json({ note: adminNote(note) });
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  getForMe,
  markSeen,
  adminList,
  adminCreate,
  adminUpdate,
  adminDelete,
  adminPublish: setStatus(true),
  adminUnpublish: setStatus(false),
};
