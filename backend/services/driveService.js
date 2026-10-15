const { google } = require("googleapis");

const DriveConnection = require("../models/DriveConnection");
const { encryptSecret, decryptSecret } = require("../utils/crypto");
const { logger, errorSummary } = require("../utils/logger");

// Study materials live in the admin's Google Drive, under one root folder; Drive is the source
// of truth, so files added in Drive itself show up here. This service is the only code that
// talks to Drive:
// - OAuth (full Drive scope: drive.file would only see files the portal uploaded itself);
// - listings and metadata, cached briefly in memory and cleared on every portal write;
// - the ancestry guard: an id is usable only if it lies under the root folder, so the portal
//   can never expose anything else in that Drive;
// - streaming file bytes, and opening resumable upload sessions the admin's browser uploads to.
// Tests swap the Drive calls with setDriveImplementation().

const SCOPES = ["https://www.googleapis.com/auth/drive", "openid", "email"];
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DEFAULT_ROOT_NAME = "AceIIIT Study Materials";
const LIST_TTL_MS = 60 * 1000;
const META_TTL_MS = 5 * 60 * 1000;
const MAX_DEPTH = 32;
const ITEM_FIELDS = "id,name,mimeType,size,modifiedTime,parents,folderColorRgb,hasThumbnail,trashed,webViewLink";
const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

class DriveError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

function portalBaseUrl() {
  return String(process.env.PORTAL_BASE_URL || "http://localhost:4000").replace(/\/+$/, "");
}

function redirectUri() {
  const uri = String(process.env.GOOGLE_DRIVE_REDIRECT_URI || `${portalBaseUrl()}/api/materials/drive/callback`);
  if (process.env.NODE_ENV === "production" && !uri.startsWith("https://")) {
    throw new Error("The Google Drive redirect URI must use https in production.");
  }
  return uri;
}

function oauthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new DriveError(503, "DRIVE_NOT_CONFIGURED", "Google sign-in isn't configured on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri());
}

/** The real Google calls. Every method takes the decrypted refresh token first. */
const realImplementation = {
  authUrl(state) {
    return oauthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", include_granted_scopes: true, scope: SCOPES, state });
  },
  async exchangeCode(code) {
    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    let email = "";
    if (tokens.id_token) {
      try {
        const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
        email = (ticket.getPayload() || {}).email || "";
      } catch (_err) {
        email = "";
      }
    }
    return { refreshToken: tokens.refresh_token || "", email };
  },
  async revoke(refreshToken) {
    await oauthClient().revokeToken(refreshToken);
  },
  files(refreshToken) {
    const auth = oauthClient();
    auth.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: "v3", auth }).files;
  },
  /** Opens a resumable upload; the browser then PUTs the bytes straight to the returned URL. */
  async createUploadSession(refreshToken, { name, parentId, mimeType, size, origin }) {
    const auth = oauthClient();
    auth.setCredentials({ refresh_token: refreshToken });
    const { token } = await auth.getAccessToken();
    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=" + encodeURIComponent(ITEM_FIELDS), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType || "application/octet-stream",
        ...(size ? { "X-Upload-Content-Length": String(size) } : {}),
        // The session URL only accepts the browser's PUT from this origin (CORS).
        Origin: origin,
      },
      body: JSON.stringify({ name, parents: [parentId], ...(mimeType ? { mimeType } : {}) }),
    });
    if (!res.ok) throw Object.assign(new Error(`Drive upload session failed (${res.status})`), { status: res.status });
    return res.headers.get("location");
  },
  async thumbnail(refreshToken, link) {
    const auth = oauthClient();
    auth.setCredentials({ refresh_token: refreshToken });
    const { token } = await auth.getAccessToken();
    return fetch(link, { headers: { Authorization: `Bearer ${token}` } });
  },
};

let impl = realImplementation;

function setDriveImplementation(next) {
  impl = next || realImplementation;
  clearDriveCache();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
let connectionCache = null;

async function getConnection() {
  if (connectionCache && connectionCache.expiresAt > Date.now()) return connectionCache.value;
  const doc = await DriveConnection.findOne({ key: "materials" }).lean();
  connectionCache = { value: doc, expiresAt: Date.now() + 30 * 1000 };
  return doc;
}

function tokenOf(connection) {
  if (!connection) throw new DriveError(409, "DRIVE_NOT_CONNECTED", "Google Drive isn't connected yet.");
  try {
    return decryptSecret(connection.refreshToken);
  } catch (_err) {
    throw new DriveError(503, "DRIVE_RECONNECT", "Google Drive needs to be connected again.");
  }
}

/** Maps Google errors to portal errors; a revoked or expired grant asks for a reconnect. */
async function call(fn) {
  const connection = await getConnection();
  const token = tokenOf(connection);
  try {
    return await fn(token, connection);
  } catch (err) {
    if (err instanceof DriveError) throw err;
    const status = Number(err && (err.status || err.code || (err.response && err.response.status))) || 0;
    const reason = String((err && err.message) || "");
    if (/invalid_grant|unauthorized_client|Token has been expired or revoked/i.test(reason) || status === 401) {
      await DriveConnection.updateOne({ key: "materials" }, { $set: { status: "needs_reconnect" } }).catch(() => {});
      connectionCache = null;
      throw new DriveError(503, "DRIVE_RECONNECT", "Google Drive needs to be connected again (access was revoked or expired).");
    }
    if (status === 404) throw new DriveError(404, "DRIVE_NOT_FOUND", "That file or folder isn't in the study materials.");
    if (status === 403 && /rate|quota/i.test(reason)) throw new DriveError(503, "DRIVE_BUSY", "Google Drive is busy. Try again in a moment.");
    logger.warn({ err: errorSummary(err), status }, "google drive call failed");
    throw new DriveError(502, "DRIVE_FAILED", "Google Drive didn't respond. Try again in a moment.");
  }
}

async function saveConnection({ refreshToken, email, rootFolderId, rootFolderName, userId }) {
  await DriveConnection.findOneAndUpdate(
    { key: "materials" },
    {
      $set: {
        refreshToken: encryptSecret(refreshToken),
        accountEmail: email || "",
        rootFolderId,
        rootFolderName: rootFolderName || "",
        connectedBy: userId || null,
        connectedAt: new Date(),
        status: "connected",
      },
    },
    { upsert: true, new: true }
  );
  connectionCache = null;
  clearDriveCache();
}

async function disconnect() {
  const connection = await DriveConnection.findOne({ key: "materials" }).lean();
  if (connection) {
    try {
      await impl.revoke(decryptSecret(connection.refreshToken));
    } catch (err) {
      logger.warn({ err: errorSummary(err) }, "drive token revoke failed (removed locally anyway)");
    }
  }
  await DriveConnection.deleteOne({ key: "materials" });
  connectionCache = null;
  clearDriveCache();
}

/** Finds the default root folder in My Drive, or creates it. */
async function ensureRootFolder(refreshToken) {
  const files = impl.files(refreshToken);
  const q = `name = '${DEFAULT_ROOT_NAME}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`;
  const found = await files.list({ q, fields: "files(id,name)", pageSize: 1, spaces: "drive" });
  const existing = found.data && found.data.files && found.data.files[0];
  if (existing) return existing;
  const created = await files.create({ requestBody: { name: DEFAULT_ROOT_NAME, mimeType: FOLDER_MIME }, fields: "id,name" });
  return created.data;
}

// ---------------------------------------------------------------------------
// Caches and the ancestry guard
// ---------------------------------------------------------------------------
const listCache = new Map();
const metaCache = new Map();

function clearDriveCache() {
  listCache.clear();
  metaCache.clear();
}

function assertId(id) {
  if (!ID_RE.test(String(id || ""))) throw new DriveError(400, "DRIVE_BAD_ID", "Invalid file or folder id.");
}

async function meta(files, id) {
  const hit = metaCache.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const res = await files.get({ fileId: id, fields: ITEM_FIELDS, supportsAllDrives: true });
  metaCache.set(id, { value: res.data, expiresAt: Date.now() + META_TTL_MS });
  return res.data;
}

/** The chain from the root down to `id` (inclusive), or a 404 if `id` isn't under the root. */
async function pathTo(files, connection, id) {
  assertId(id);
  const chain = [];
  let current = id;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const item = await meta(files, current);
    if (!item || item.trashed) break;
    chain.unshift(item);
    if (item.id === connection.rootFolderId) return chain;
    const parent = item.parents && item.parents[0];
    if (!parent) break;
    current = parent;
  }
  throw new DriveError(404, "DRIVE_NOT_FOUND", "That file or folder isn't in the study materials.");
}

function isFolder(item) {
  return item && item.mimeType === FOLDER_MIME;
}

function itemView(item, counts) {
  const folder = isFolder(item);
  return {
    id: item.id,
    name: item.name,
    kind: folder ? "folder" : "file",
    mimeType: item.mimeType,
    size: item.size ? Number(item.size) : null,
    modifiedTime: item.modifiedTime || null,
    color: folder ? item.folderColorRgb || "" : "",
    hasThumbnail: Boolean(item.hasThumbnail),
    googleType: !folder && /^application\/vnd\.google-apps\./.test(item.mimeType || "") ? item.mimeType.split(".").pop() : "",
    ...(folder ? { itemCount: counts ? counts.get(item.id) || 0 : null } : {}),
  };
}

async function listAll(files, params) {
  const out = [];
  let pageToken;
  do {
    const res = await files.list({ ...params, pageSize: 1000, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true });
    (res.data.files || []).forEach((f) => out.push(f));
    pageToken = res.data.nextPageToken;
  } while (pageToken && out.length < 5000);
  return out;
}

/** One folder's contents: folders first, then files, in natural name order. */
async function listFolder(folderId) {
  return call(async (token, connection) => {
    const files = impl.files(token);
    const id = folderId || connection.rootFolderId;
    const chain = await pathTo(files, connection, id);
    const folder = chain[chain.length - 1];
    if (!isFolder(folder)) throw new DriveError(400, "DRIVE_NOT_A_FOLDER", "That isn't a folder.");
    const cached = listCache.get(id);
    let items;
    let counts;
    if (cached && cached.expiresAt > Date.now()) {
      ({ items, counts } = cached.value);
    } else {
      items = await listAll(files, { q: `'${id}' in parents and trashed = false`, fields: `nextPageToken, files(${ITEM_FIELDS})`, orderBy: "folder,name_natural" });
      items.forEach((item) => metaCache.set(item.id, { value: item, expiresAt: Date.now() + META_TTL_MS }));
      counts = new Map();
      const folderIds = items.filter(isFolder).map((f) => f.id);
      for (let i = 0; i < folderIds.length; i += 40) {
        const chunk = folderIds.slice(i, i + 40);
        const children = await listAll(files, { q: `(${chunk.map((c) => `'${c}' in parents`).join(" or ")}) and trashed = false`, fields: "nextPageToken, files(id,parents)" });
        children.forEach((child) => (child.parents || []).forEach((p) => { if (chunk.includes(p)) counts.set(p, (counts.get(p) || 0) + 1); }));
      }
      listCache.set(id, { value: { items, counts }, expiresAt: Date.now() + LIST_TTL_MS });
    }
    return {
      folder: { id: folder.id, name: id === connection.rootFolderId ? "Study material" : folder.name, isRoot: id === connection.rootFolderId },
      breadcrumbs: chain.filter(isFolder).map((f) => ({ id: f.id, name: f.id === connection.rootFolderId ? "Study material" : f.name })),
      folders: items.filter(isFolder).map((f) => itemView(f, counts)),
      files: items.filter((f) => !isFolder(f)).map((f) => itemView(f)),
    };
  });
}

function escapeQuery(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Name search across Drive, keeping only items under the root (with their folder path). */
async function search(text) {
  const term = String(text || "").trim().slice(0, 80);
  if (term.length < 2) return { items: [] };
  return call(async (token, connection) => {
    const files = impl.files(token);
    const res = await files.list({
      q: `name contains '${escapeQuery(term)}' and trashed = false`,
      fields: `files(${ITEM_FIELDS})`,
      pageSize: 60,
      orderBy: "folder,name_natural",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const items = [];
    for (const item of res.data.files || []) {
      if (item.id === connection.rootFolderId) continue;
      try {
        const chain = await pathTo(files, connection, item.id);
        items.push({ ...itemView(item), path: chain.slice(0, -1).map((f) => (f.id === connection.rootFolderId ? "Study material" : f.name)) });
      } catch (_err) {
        // Not under the study-materials root: never shown.
      }
    }
    return { items };
  });
}

const INLINE_TYPES = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain|audio\/[\w.+-]+|video\/(mp4|webm|ogg))$/;
const EXPORTS = {
  "application/vnd.google-apps.document": { mime: "application/pdf", ext: "pdf" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/pdf", ext: "pdf" },
  "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: "pdf" },
  "application/vnd.google-apps.drawing": { mime: "application/pdf", ext: "pdf" },
};

/**
 * The bytes of a file under the root, for streaming to a signed-in user. Only safe types are
 * shown inline (never HTML/SVG/scripts from someone's Drive on the portal's origin).
 */
async function openFile(id, { range, download } = {}) {
  return call(async (token, connection) => {
    const files = impl.files(token);
    const chain = await pathTo(files, connection, id);
    const item = chain[chain.length - 1];
    if (isFolder(item)) throw new DriveError(400, "DRIVE_IS_FOLDER", "That's a folder, not a file.");
    const exported = EXPORTS[item.mimeType];
    if (/^application\/vnd\.google-apps\./.test(item.mimeType) && !exported) {
      throw new DriveError(415, "DRIVE_CANT_EXPORT", "This kind of Google file can't be opened here. Open it in Google Drive.");
    }
    const contentType = exported ? exported.mime : item.mimeType || "application/octet-stream";
    const name = exported && !/\.pdf$/i.test(item.name) ? `${item.name}.pdf` : item.name;
    const res = exported
      ? await files.export({ fileId: id, mimeType: exported.mime }, { responseType: "stream" })
      : await files.get({ fileId: id, alt: "media", supportsAllDrives: true }, { responseType: "stream", headers: range ? { Range: range } : {} });
    const headers = res.headers || {};
    return {
      stream: res.data,
      status: res.status === 206 ? 206 : 200,
      contentType,
      name,
      inline: !download && INLINE_TYPES.test(contentType),
      length: headers["content-length"] || (exported ? null : item.size) || null,
      contentRange: headers["content-range"] || null,
    };
  });
}

async function openThumbnail(id) {
  return call(async (token, connection) => {
    const files = impl.files(token);
    await pathTo(files, connection, id);
    const res = await files.get({ fileId: id, fields: "thumbnailLink", supportsAllDrives: true });
    const link = res.data && res.data.thumbnailLink;
    if (!link) throw new DriveError(404, "DRIVE_NO_THUMBNAIL", "No preview for this file.");
    const upstream = await impl.thumbnail(token, link);
    if (!upstream.ok) throw new DriveError(404, "DRIVE_NO_THUMBNAIL", "No preview for this file.");
    return upstream;
  });
}

// ---------------------------------------------------------------------------
// Admin writes (each clears the caches)
// ---------------------------------------------------------------------------
function cleanName(name) {
  // Drop control characters (code points below 32, and 127).
  const n = Array.from(String(name || "")).filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join("").trim().slice(0, 200);
  if (!n) throw new DriveError(400, "DRIVE_BAD_NAME", "Give it a name.");
  return n;
}

async function createFolder(parentId, name) {
  return call(async (token, connection) => {
    const files = impl.files(token);
    const parent = parentId || connection.rootFolderId;
    const chain = await pathTo(files, connection, parent);
    if (!isFolder(chain[chain.length - 1])) throw new DriveError(400, "DRIVE_NOT_A_FOLDER", "Folders can only be made inside folders.");
    const res = await files.create({ requestBody: { name: cleanName(name), mimeType: FOLDER_MIME, parents: [parent] }, fields: ITEM_FIELDS, supportsAllDrives: true });
    clearDriveCache();
    return itemView(res.data, new Map());
  });
}

/** Rename, move (to another folder under the root) and/or recolour a folder. */
async function updateItem(id, { name, parentId, color } = {}) {
  return call(async (token, connection) => {
    const files = impl.files(token);
    if (id === connection.rootFolderId) throw new DriveError(400, "DRIVE_ROOT", "The study-materials folder itself can't be changed here.");
    const chain = await pathTo(files, connection, id);
    const item = chain[chain.length - 1];
    const requestBody = {};
    const params = { fileId: id, fields: ITEM_FIELDS, supportsAllDrives: true };
    if (name !== undefined) requestBody.name = cleanName(name);
    if (color !== undefined) {
      if (!isFolder(item)) throw new DriveError(400, "DRIVE_NOT_A_FOLDER", "Only folders have colours.");
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new DriveError(400, "DRIVE_BAD_COLOR", "Use a colour like #4285f4.");
      requestBody.folderColorRgb = color || null;
    }
    if (parentId !== undefined) {
      const target = await pathTo(files, connection, parentId);
      if (!isFolder(target[target.length - 1])) throw new DriveError(400, "DRIVE_NOT_A_FOLDER", "Move it into a folder.");
      if (target.some((f) => f.id === id)) throw new DriveError(400, "DRIVE_MOVE_INTO_SELF", "A folder can't be moved inside itself.");
      params.addParents = parentId;
      params.removeParents = (item.parents || []).join(",");
    }
    const res = await files.update({ ...params, requestBody });
    clearDriveCache();
    return itemView(res.data, new Map());
  });
}

/** Moves to Drive's trash (recoverable in Drive for 30 days). */
async function trashItem(id) {
  return call(async (token, connection) => {
    const files = impl.files(token);
    if (id === connection.rootFolderId) throw new DriveError(400, "DRIVE_ROOT", "The study-materials folder itself can't be deleted here.");
    await pathTo(files, connection, id);
    await files.update({ fileId: id, requestBody: { trashed: true }, supportsAllDrives: true });
    clearDriveCache();
  });
}

async function startUpload({ parentId, name, mimeType, size, origin }) {
  return call(async (token, connection) => {
    const files = impl.files(token);
    const parent = parentId || connection.rootFolderId;
    const chain = await pathTo(files, connection, parent);
    if (!isFolder(chain[chain.length - 1])) throw new DriveError(400, "DRIVE_NOT_A_FOLDER", "Upload into a folder.");
    const url = await impl.createUploadSession(token, { name: cleanName(name), parentId: parent, mimeType, size, origin });
    if (!url) throw new DriveError(502, "DRIVE_FAILED", "Google Drive didn't open the upload. Try again.");
    return { uploadUrl: url, parentId: parent };
  });
}

/** After the browser finished an upload: check it landed under the root and refresh listings. */
async function finishUpload(fileId) {
  return call(async (token, connection) => {
    const files = impl.files(token);
    metaCache.delete(fileId);
    const chain = await pathTo(files, connection, fileId);
    clearDriveCache();
    return itemView(chain[chain.length - 1]);
  });
}

/** Points the materials at another folder the connected account can open (by id or URL). */
async function setRootFolder(idOrUrl) {
  const match = /(?:folders\/|id=)([A-Za-z0-9_-]{8,128})/.exec(String(idOrUrl || "")) || /^([A-Za-z0-9_-]{8,128})$/.exec(String(idOrUrl || "").trim());
  if (!match) throw new DriveError(400, "DRIVE_BAD_ID", "Paste a Google Drive folder link.");
  return call(async (token) => {
    const files = impl.files(token);
    const res = await files.get({ fileId: match[1], fields: ITEM_FIELDS, supportsAllDrives: true });
    if (!isFolder(res.data) || res.data.trashed) throw new DriveError(400, "DRIVE_NOT_A_FOLDER", "That link isn't a folder.");
    await DriveConnection.updateOne({ key: "materials" }, { $set: { rootFolderId: res.data.id, rootFolderName: res.data.name } });
    connectionCache = null;
    clearDriveCache();
    return { id: res.data.id, name: res.data.name };
  });
}

async function status() {
  const connection = await getConnection();
  if (!connection) return { connected: false };
  return {
    connected: true,
    needsReconnect: connection.status === "needs_reconnect",
    accountEmail: connection.accountEmail,
    root: { id: connection.rootFolderId, name: connection.rootFolderName, url: `https://drive.google.com/drive/folders/${connection.rootFolderId}` },
    connectedAt: connection.connectedAt,
  };
}

function maxUploadBytes() {
  const n = Number(process.env.MATERIAL_MAX_BYTES || 100 * 1024 * 1024);
  return Number.isFinite(n) && n > 0 ? n : 100 * 1024 * 1024;
}

module.exports = {
  DriveError,
  FOLDER_MIME,
  DEFAULT_ROOT_NAME,
  authUrl: (state) => impl.authUrl(state),
  exchangeCode: (code) => impl.exchangeCode(code),
  ensureRootFolder: (token) => ensureRootFolder(token),
  saveConnection,
  disconnect,
  status,
  listFolder,
  search,
  openFile,
  openThumbnail,
  createFolder,
  updateItem,
  trashItem,
  startUpload,
  finishUpload,
  setRootFolder,
  clearDriveCache,
  maxUploadBytes,
  setDriveImplementation,
  portalBaseUrl,
};
