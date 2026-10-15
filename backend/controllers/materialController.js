const crypto = require("crypto");
const { z } = require("zod");

const cloudinary = require("../config/cloudinary");
const StudyFile = require("../models/StudyFile");
const StudyFolder = require("../models/StudyFolder");
const { logger, errorSummary } = require("../utils/logger");

// Study materials (Resources → Study material), free for every signed-in student.
// Upload flow, Drive-style: the admin's browser asks for a signed upload (POST /uploads/sign),
// sends the file straight to Cloudinary with progress (the server never buffers it), then
// registers it (POST /files), which only succeeds once Cloudinary confirms the asset.
// Files are "authenticated" Cloudinary assets: no public links; downloads go through a
// short-lived signed URL handed out to signed-in users.

const PUBLIC_ID_PREFIX = "study-materials/";
const DOWNLOAD_TTL_SECONDS = 5 * 60;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // Cloudinary's free-plan per-file limit

const FILE_TYPES = {
  pdf: { resourceType: "raw", mime: "application/pdf" },
  png: { resourceType: "image", mime: "image/png" },
  jpg: { resourceType: "image", mime: "image/jpeg" },
  jpeg: { resourceType: "image", mime: "image/jpeg" },
  webp: { resourceType: "image", mime: "image/webp" },
  doc: { resourceType: "raw", mime: "application/msword" },
  docx: { resourceType: "raw", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ppt: { resourceType: "raw", mime: "application/vnd.ms-powerpoint" },
  pptx: { resourceType: "raw", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  xls: { resourceType: "raw", mime: "application/vnd.ms-excel" },
  xlsx: { resourceType: "raw", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  txt: { resourceType: "raw", mime: "text/plain" },
  csv: { resourceType: "raw", mime: "text/csv" },
};

function maxBytes() {
  const value = Number(process.env.MATERIAL_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, expose: true, code });
}

function extOf(name) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(String(name || ""));
  return match ? match[1].toLowerCase() : "";
}

function typeFor(name) {
  const type = FILE_TYPES[extOf(name)];
  if (!type) {
    throw httpError(400, "This file type isn't supported. Upload PDF, images (PNG, JPG, WebP), Word, PowerPoint, Excel, TXT or CSV.", "MATERIAL_TYPE");
  }
  return type;
}

/** A readable, URL-safe base name for the Cloudinary id (it becomes the download filename). */
function slugBase(name) {
  return String(name || "")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "file";
}

function publicIdFor(dir, name, type) {
  return `${PUBLIC_ID_PREFIX}${dir}/${slugBase(name)}${type.resourceType === "raw" ? `.${extOf(name)}` : ""}`;
}

function cloudinaryReady() {
  const cfg = cloudinary.config();
  return Boolean(cfg.cloud_name && cfg.api_key && cfg.api_secret);
}

function folderView(folder, files) {
  return {
    id: String(folder._id),
    name: folder.name,
    icon: folder.icon || "📁",
    color: folder.color || "",
    createdAt: folder.createdAt,
    files: (files || []).map(fileView),
  };
}

function fileView(file) {
  return {
    id: String(file._id),
    folderId: String(file.folderId),
    name: file.name,
    ext: extOf(file.name),
    mimeType: file.mimeType || "",
    bytes: Number(file.bytes || 0),
    createdAt: file.createdAt,
  };
}

/** "Notes.pdf" → "Notes (1).pdf" when the folder already has that name, as in Drive. */
async function uniqueName(folderId, name, excludeId = null) {
  const ext = extOf(name);
  const base = ext ? name.slice(0, -(ext.length + 1)) : name;
  const siblings = await StudyFile.find({ folderId, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select("name").lean();
  const taken = new Set(siblings.map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${base} (${n})${ext ? `.${ext}` : ""}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} (${Date.now()})${ext ? `.${ext}` : ""}`;
}

async function destroyAsset(file) {
  try {
    await cloudinary.uploader.destroy(file.publicId, { resource_type: file.resourceType, type: "authenticated", invalidate: true });
  } catch (err) {
    logger.warn({ err: errorSummary(err), fileId: String(file._id) }, "study material delete at Cloudinary failed");
  }
}

async function loadFolder(id) {
  const folder = await StudyFolder.findById(id);
  if (!folder) throw httpError(404, "Folder not found.", "FOLDER_NOT_FOUND");
  return folder;
}

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");
const folderSchema = z.object({
  name: z.string().trim().min(1).max(80),
  icon: z.string().trim().max(8).optional(),
  color: z.string().trim().max(40).optional(),
});
const signSchema = z.object({
  folderId: objectId,
  name: z.string().trim().min(1).max(160),
  bytes: z.coerce.number().int().min(1),
});
const registerSchema = z.object({
  folderId: objectId,
  name: z.string().trim().min(1).max(160),
  publicId: z.string().trim().min(1).max(300),
  resourceType: z.enum(["image", "raw"]),
});
const renameSchema = z.object({ name: z.string().trim().min(1).max(160) });

// ---------------------------------------------------------------------------
// Everyone signed in
// ---------------------------------------------------------------------------
async function listMaterials(_req, res, next) {
  try {
    const [folders, files] = await Promise.all([
      StudyFolder.find({}).sort({ createdAt: 1 }).lean(),
      StudyFile.find({}).collation({ locale: "en", strength: 2 }).sort({ name: 1 }).lean(),
    ]);
    const byFolder = files.reduce((acc, file) => {
      (acc[String(file.folderId)] = acc[String(file.folderId)] || []).push(file);
      return acc;
    }, {});
    res.set("Cache-Control", "no-store");
    res.json({ folders: folders.map((folder) => folderView(folder, byFolder[String(folder._id)])), maxBytes: maxBytes() });
  } catch (err) {
    next(err);
  }
}

async function downloadMaterial(req, res, next) {
  try {
    const file = await StudyFile.findById(req.params.id).lean();
    if (!file) return res.status(404).json({ error: "File not found." });
    const url = cloudinary.utils.private_download_url(file.publicId, file.resourceType === "image" ? file.format || "" : "", {
      resource_type: file.resourceType,
      type: "authenticated",
      expires_at: Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS,
      attachment: req.query.inline !== "1",
    });
    res.set("Cache-Control", "no-store");
    return res.redirect(302, url);
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
async function createFolder(req, res, next) {
  try {
    const input = folderSchema.parse(req.body || {});
    const folder = await StudyFolder.create({ ...input, icon: input.icon || "📁", createdBy: req.auth.userId });
    res.locals.auditEntityId = String(folder._id);
    res.status(201).json({ folder: folderView(folder, []) });
  } catch (err) {
    next(err);
  }
}

async function updateFolder(req, res, next) {
  try {
    const input = folderSchema.partial().parse(req.body || {});
    const folder = await loadFolder(req.params.id);
    Object.assign(folder, input);
    await folder.save();
    const files = await StudyFile.find({ folderId: folder._id }).sort({ name: 1 }).lean();
    res.json({ folder: folderView(folder, files) });
  } catch (err) {
    next(err);
  }
}

async function deleteFolder(req, res, next) {
  try {
    const folder = await loadFolder(req.params.id);
    const files = await StudyFile.find({ folderId: folder._id }).lean();
    await Promise.all(files.map(destroyAsset));
    await StudyFile.deleteMany({ folderId: folder._id });
    await StudyFolder.deleteOne({ _id: folder._id });
    res.json({ ok: true, deletedFiles: files.length });
  } catch (err) {
    next(err);
  }
}

/** Signs one direct browser → Cloudinary upload into a fresh, unique id. */
async function signUpload(req, res, next) {
  try {
    if (!cloudinaryReady()) throw httpError(503, "File storage isn't configured on the server.", "STORAGE_UNAVAILABLE");
    const input = signSchema.parse(req.body || {});
    await loadFolder(input.folderId);
    const type = typeFor(input.name);
    const limit = maxBytes();
    if (input.bytes > limit) {
      throw httpError(400, `This file is larger than the ${Math.round(limit / (1024 * 1024))} MB limit.`, "MATERIAL_TOO_LARGE");
    }
    const cfg = cloudinary.config();
    const publicId = publicIdFor(crypto.randomBytes(8).toString("hex"), input.name, type);
    const fields = { public_id: publicId, timestamp: Math.floor(Date.now() / 1000), type: "authenticated" };
    const signature = cloudinary.utils.api_sign_request(fields, cfg.api_secret);
    res.json({
      uploadUrl: `https://api.cloudinary.com/v1_1/${cfg.cloud_name}/${type.resourceType}/upload`,
      fields: { ...fields, api_key: cfg.api_key, signature },
      publicId,
      resourceType: type.resourceType,
    });
  } catch (err) {
    next(err);
  }
}

/** Registers an uploaded file once Cloudinary confirms the asset exists where we signed it. */
async function registerFile(req, res, next) {
  try {
    const input = registerSchema.parse(req.body || {});
    await loadFolder(input.folderId);
    const type = typeFor(input.name);
    if (!input.publicId.startsWith(PUBLIC_ID_PREFIX) || input.resourceType !== type.resourceType) {
      throw httpError(400, "That upload doesn't match this file.", "MATERIAL_MISMATCH");
    }
    let info;
    try {
      info = await cloudinary.api.resource(input.publicId, { resource_type: input.resourceType, type: "authenticated" });
    } catch (_err) {
      throw httpError(400, "The upload wasn't found in file storage. Please upload it again.", "MATERIAL_NOT_UPLOADED");
    }
    const file = { publicId: input.publicId, resourceType: input.resourceType };
    if (Number(info.bytes || 0) > maxBytes()) {
      await destroyAsset(file);
      throw httpError(400, "This file is larger than the upload limit.", "MATERIAL_TOO_LARGE");
    }
    const created = await StudyFile.create({
      folderId: input.folderId,
      name: await uniqueName(input.folderId, input.name),
      mimeType: type.mime,
      bytes: Number(info.bytes || 0),
      format: String(info.format || ""),
      publicId: input.publicId,
      resourceType: input.resourceType,
      createdBy: req.auth.userId,
    });
    res.locals.auditEntityId = String(created._id);
    res.status(201).json({ file: fileView(created) });
  } catch (err) {
    next(err);
  }
}

/** Renames a file (its extension is kept) and, best effort, its Cloudinary id so downloads match. */
async function renameFile(req, res, next) {
  try {
    const input = renameSchema.parse(req.body || {});
    const file = await StudyFile.findById(req.params.id);
    if (!file) return res.status(404).json({ error: "File not found." });
    const ext = extOf(file.name);
    let name = input.name;
    if (ext && extOf(name) !== ext) name = `${name}.${ext}`;
    file.name = await uniqueName(file.folderId, name, file._id);
    const dir = file.publicId.slice(PUBLIC_ID_PREFIX.length).split("/")[0];
    const nextPublicId = publicIdFor(dir, file.name, FILE_TYPES[ext] || { resourceType: file.resourceType });
    if (nextPublicId !== file.publicId) {
      try {
        await cloudinary.uploader.rename(file.publicId, nextPublicId, { resource_type: file.resourceType, type: "authenticated", to_type: "authenticated" });
        file.publicId = nextPublicId;
      } catch (err) {
        logger.warn({ err: errorSummary(err), fileId: String(file._id) }, "study material rename at Cloudinary failed (kept the old id)");
      }
    }
    await file.save();
    res.json({ file: fileView(file) });
  } catch (err) {
    next(err);
  }
}

async function deleteFile(req, res, next) {
  try {
    const file = await StudyFile.findById(req.params.id).lean();
    if (!file) return res.status(404).json({ error: "File not found." });
    await destroyAsset(file);
    await StudyFile.deleteOne({ _id: file._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listMaterials,
  downloadMaterial,
  createFolder,
  updateFolder,
  deleteFolder,
  signUpload,
  registerFile,
  renameFile,
  deleteFile,
  FILE_TYPES,
  PUBLIC_ID_PREFIX,
};
