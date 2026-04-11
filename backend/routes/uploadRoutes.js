const express = require("express");

const { requireAuth, requireAdmin } = require("../middleware/auth");
const upload = require("../middleware/upload");
const { uploadImage } = require("../controllers/uploadController");

const router = express.Router();

function extendUploadTimeout(timeoutMs) {
  const safeTimeout = Math.max(15000, Number(timeoutMs) || 45000);
  return function (req, res, next) {
    req.setTimeout(safeTimeout);
    res.setTimeout(safeTimeout);
    next();
  };
}

function maybeUploadQuestionImages() {
  const handler = upload.fields([
    { name: "image", maxCount: 1 },
    { name: "images", maxCount: 8 },
  ]);
  return function (req, res, next) {
    if (req.is("multipart/form-data")) {
      return handler(req, res, next);
    }
    return next();
  };
}

router.post(
  "/",
  requireAuth,
  requireAdmin,
  extendUploadTimeout(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 45000),
  maybeUploadQuestionImages(),
  uploadImage
);

module.exports = router;
