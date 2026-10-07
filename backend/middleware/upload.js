const multer = require("multer");

const { MAX_IMAGE_BYTES, ALLOWED_MIME_TYPES } = require("../services/imageUploadService");

// First-pass filter on the declared type; the real bytes are verified again in
// services/imageUploadService.js before anything is stored.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 9, fields: 50 },
  fileFilter: (_req, file, cb) => {
    const mime = String((file && file.mimetype) || "").toLowerCase();
    if (!ALLOWED_MIME_TYPES.includes(mime)) {
      const err = new Error("Only PNG, JPEG, WebP or GIF images are allowed.");
      err.status = 400;
      err.expose = true;
      return cb(err);
    }
    return cb(null, true);
  },
});

module.exports = upload;
