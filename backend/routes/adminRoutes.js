const express = require("express");

const { requireAuth, requireAdmin } = require("../middleware/auth");
const admin = require("../controllers/adminController");
const upload = require("../middleware/upload");

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

router.get("/snapshot", requireAuth, requireAdmin, admin.snapshot);
router.get("/trash", requireAuth, requireAdmin, admin.trash);

router.get("/results", requireAuth, requireAdmin, admin.results);
router.get("/leaderboard", requireAuth, requireAdmin, admin.leaderboard);
router.get("/test/:id/analytics", requireAuth, requireAdmin, admin.testAnalytics);

router.delete("/users/:id", requireAuth, requireAdmin, admin.deleteUser);

router.post("/questions", requireAuth, requireAdmin, extendUploadTimeout(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 45000), maybeUploadQuestionImages(), admin.createQuestion);
router.put("/questions/:id", requireAuth, requireAdmin, extendUploadTimeout(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 45000), maybeUploadQuestionImages(), admin.updateQuestion);
router.delete("/questions/:id", requireAuth, requireAdmin, admin.deleteQuestion);

router.post("/trash/:kind/:id/restore", requireAuth, requireAdmin, admin.restoreTrashItem);
router.delete("/trash/:kind/:id/purge", requireAuth, requireAdmin, admin.purgeTrashItem);

router.post("/attach", requireAuth, requireAdmin, admin.attachQuestion);
router.post("/detach", requireAuth, requireAdmin, admin.detachQuestion);

module.exports = router;
