const crypto = require("crypto");
const { z } = require("zod");

const drive = require("../services/driveService");
const { logger, errorSummary } = require("../utils/logger");
const { logAuditEvent } = require("../services/auditLogService");

// Study materials (Resources → Study material), free for every signed-in student. The files
// live in the admin's Google Drive under one root folder (services/driveService.js); this
// controller is the portal's window onto it: students browse, search, open and download;
// admins also connect Drive, make folders (any depth), upload, rename, move and delete.

const STATE_COOKIE = "google_drive_oauth_state";
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "Invalid id");

function sendError(res, err, next) {
  if (err instanceof drive.DriveError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues[0] ? err.issues[0].message : "Invalid input", code: "VALIDATION_ERROR" });
  return next(err);
}

function cookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" };
}

// ---------------------------------------------------------------------------
// Connection (admin)
// ---------------------------------------------------------------------------
async function driveStatus(_req, res, next) {
  try {
    return res.json({ drive: await drive.status() });
  } catch (err) {
    return sendError(res, err, next);
  }
}

/** Returns Google's consent URL; the browser goes there and comes back to /drive/callback. */
async function connectDrive(_req, res, next) {
  try {
    const state = crypto.randomBytes(32).toString("hex");
    res.cookie(STATE_COOKIE, state, { ...cookieOptions(), maxAge: 10 * 60 * 1000 });
    return res.json({ url: drive.authUrl(state) });
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function driveCallback(req, res) {
  const back = (result) => res.redirect(`/?drive=${encodeURIComponent(result)}#admin`);
  try {
    const { code, state, error } = req.query || {};
    const saved = req.cookies && req.cookies[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, cookieOptions());
    if (error) return back("denied");
    if (!state || !saved || String(state).length !== saved.length || !crypto.timingSafeEqual(Buffer.from(String(state)), Buffer.from(saved))) {
      logger.warn("drive oauth: invalid state");
      return res.status(400).send("Invalid OAuth state. Please try connecting again from Studio.");
    }
    if (!req.auth || req.auth.role !== "admin") return res.status(403).send("Only admins can connect Google Drive.");
    const { refreshToken, email } = await drive.exchangeCode(String(code || ""));
    if (!refreshToken) return back("no_refresh_token");
    const root = await drive.ensureRootFolder(refreshToken);
    await drive.saveConnection({ refreshToken, email, rootFolderId: root.id, rootFolderName: root.name, userId: req.auth.userId });
    await logAuditEvent({ actorUserId: req.auth.userId, action: "MATERIALS_DRIVE_CONNECTED", entityType: "DriveConnection", entityId: root.id, metadata: { accountEmail: email, rootFolderName: root.name } }).catch(() => {});
    return back("connected");
  } catch (err) {
    logger.warn({ err: errorSummary(err) }, "drive oauth callback failed");
    return back("failed");
  }
}

async function disconnectDrive(_req, res, next) {
  try {
    await drive.disconnect();
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function setRoot(req, res, next) {
  try {
    const { folder } = z.object({ folder: z.string().trim().min(1).max(500) }).strict().parse(req.body || {});
    return res.json({ root: await drive.setRootFolder(folder) });
  } catch (err) {
    return sendError(res, err, next);
  }
}

// ---------------------------------------------------------------------------
// Browsing (every signed-in user)
// ---------------------------------------------------------------------------
async function listMaterials(req, res, next) {
  try {
    const status = await drive.status();
    if (!status.connected) return res.json({ connected: false });
    const folder = req.query.folder ? idSchema.parse(String(req.query.folder)) : null;
    const listing = await drive.listFolder(folder);
    return res.json({ connected: true, ...listing, maxBytes: drive.maxUploadBytes() });
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function searchMaterials(req, res, next) {
  try {
    const status = await drive.status();
    if (!status.connected) return res.json({ connected: false, items: [] });
    const q = z.string().max(80).parse(String(req.query.q || ""));
    return res.json({ connected: true, ...(await drive.search(q)) });
  } catch (err) {
    return sendError(res, err, next);
  }
}

function contentDisposition(kind, name) {
  const ascii = String(name || "file").replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name || "file")}`;
}

/** Streams a file (Range-aware, so PDFs scroll); Google Docs/Sheets/Slides come as PDF. */
async function fileContent(req, res, next) {
  try {
    const id = idSchema.parse(req.params.id);
    const download = String(req.query.download || "") === "1";
    const range = typeof req.headers.range === "string" && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : null;
    const file = await drive.openFile(id, { range, download });
    res.status(file.status);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", contentDisposition(file.inline ? "inline" : "attachment", file.name));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Accept-Ranges", "bytes");
    if (file.length) res.setHeader("Content-Length", String(file.length));
    if (file.contentRange) res.setHeader("Content-Range", file.contentRange);
    file.stream.on("error", (err) => {
      logger.warn({ err: errorSummary(err) }, "drive stream failed");
      res.destroy(err);
    });
    return file.stream.pipe(res);
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function fileThumbnail(req, res, next) {
  try {
    const id = idSchema.parse(req.params.id);
    const upstream = await drive.openThumbnail(id);
    const type = upstream.headers.get("content-type") || "image/jpeg";
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type.split(";")[0])) return res.status(404).json({ error: "No preview", code: "DRIVE_NO_THUMBNAIL" });
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    return sendError(res, err, next);
  }
}

// ---------------------------------------------------------------------------
// Managing (admin)
// ---------------------------------------------------------------------------
const folderSchema = z.object({ parentId: idSchema.optional().nullable(), name: z.string().min(1).max(200) }).strict();
const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  parentId: idSchema.optional(),
  color: z.union([z.literal(""), z.string().regex(/^#[0-9a-f]{6}$/i)]).optional(),
}).strict();
const uploadSchema = z.object({
  parentId: idSchema.optional().nullable(),
  name: z.string().min(1).max(200),
  mimeType: z.string().max(200).optional().default(""),
  size: z.number().int().min(0),
}).strict();

async function createFolder(req, res, next) {
  try {
    const input = folderSchema.parse(req.body || {});
    return res.status(201).json({ folder: await drive.createFolder(input.parentId || null, input.name) });
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function updateItem(req, res, next) {
  try {
    const id = idSchema.parse(req.params.id);
    const input = updateSchema.parse(req.body || {});
    if (!Object.keys(input).length) return res.status(400).json({ error: "Nothing to change", code: "VALIDATION_ERROR" });
    return res.json({ item: await drive.updateItem(id, input) });
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function deleteItem(req, res, next) {
  try {
    await drive.trashItem(idSchema.parse(req.params.id));
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err, next);
  }
}

/** Opens a resumable upload in the target folder; the browser sends the bytes to Drive. */
async function startUpload(req, res, next) {
  try {
    const input = uploadSchema.parse(req.body || {});
    if (input.size > drive.maxUploadBytes()) {
      return res.status(413).json({ error: `Files can be up to ${Math.round(drive.maxUploadBytes() / (1024 * 1024))} MB.`, code: "FILE_TOO_LARGE" });
    }
    const origin = String(req.get("origin") || drive.portalBaseUrl());
    return res.json(await drive.startUpload({ parentId: input.parentId || null, name: input.name, mimeType: input.mimeType, size: input.size, origin }));
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function finishUpload(req, res, next) {
  try {
    const { fileId } = z.object({ fileId: idSchema }).strict().parse(req.body || {});
    return res.json({ file: await drive.finishUpload(fileId) });
  } catch (err) {
    return sendError(res, err, next);
  }
}

async function refresh(_req, res) {
  drive.clearDriveCache();
  return res.json({ ok: true });
}

module.exports = {
  driveStatus,
  connectDrive,
  driveCallback,
  disconnectDrive,
  setRoot,
  listMaterials,
  searchMaterials,
  fileContent,
  fileThumbnail,
  createFolder,
  updateItem,
  deleteItem,
  startUpload,
  finishUpload,
  refresh,
};
