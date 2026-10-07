const { uploadBufferToCloudinary } = require("../utils/uploadToCloudinary");

// Shared image upload pipeline for question images. Files are validated by their actual
// bytes (not the client-declared MIME type) and stored in Cloudinary only: there is no
// base64-in-MongoDB fallback, which used to bloat documents toward the 16MB limit.

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  err.code = code;
  return err;
}

/** Detects the real image type from magic bytes; returns a MIME type or null. */
function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer.slice(1, 4).toString("ascii") === "PNG") return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const head = buffer.slice(0, 6).toString("ascii");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  return null;
}

function validateImageFile(file) {
  if (!file || !file.buffer) throw httpError(400, "No image file uploaded.", "NO_FILE");
  if (file.buffer.length > MAX_IMAGE_BYTES) throw httpError(400, "Image is too large. Max allowed size is 4MB.", "FILE_TOO_LARGE");
  const actual = sniffImageType(file.buffer);
  if (!actual || !ALLOWED_MIME_TYPES.includes(actual)) {
    throw httpError(400, "Only PNG, JPEG, WebP or GIF images are allowed.", "INVALID_IMAGE");
  }
  return actual;
}

function extractUploadedFiles(req) {
  const files = [];
  if (req && req.file && req.file.buffer) files.push(req.file);
  if (req && req.files) {
    const list = Array.isArray(req.files) ? req.files : ["image", "images"].flatMap((field) => req.files[field] || []);
    list.forEach((file) => {
      if (file && file.buffer) files.push(file);
    });
  }
  return files;
}

async function uploadImages(files) {
  files.forEach(validateImageFile);
  const urls = [];
  for (const file of files) {
    let result;
    try {
      result = await uploadBufferToCloudinary(file.buffer, { folder: "ugee-questions", resource_type: "image" });
    } catch (err) {
      throw httpError(err.status === 500 ? 503 : 502, "Image storage is unavailable right now. Please try again shortly.", "IMAGE_STORAGE_UNAVAILABLE");
    }
    if (!result || !result.secure_url) {
      throw httpError(502, "Image storage didn't return a URL. Please try again.", "IMAGE_STORAGE_UNAVAILABLE");
    }
    urls.push(result.secure_url);
  }
  return urls;
}

module.exports = { MAX_IMAGE_BYTES, ALLOWED_MIME_TYPES, sniffImageType, validateImageFile, extractUploadedFiles, uploadImages };
