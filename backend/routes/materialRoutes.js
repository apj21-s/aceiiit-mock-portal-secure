const express = require("express");

const materials = require("../controllers/materialController");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { readLimiter } = require("../middleware/rateLimit");
const { objectIdParam } = require("../middleware/validate");
const { audit } = require("../middleware/audit");

// Study materials: every signed-in user (free or paid) can list and download; only admins
// manage folders and files. Bulk uploads make two requests per file, so admin writes use the
// read limiter rather than the 20/min submission limiter.
const router = express.Router();
router.param("id", objectIdParam);

router.get("/", requireAuth, readLimiter(), materials.listMaterials);
router.get("/files/:id/download", requireAuth, readLimiter(), materials.downloadMaterial);

router.post("/folders", requireAuth, requireAdmin, readLimiter(), audit("MATERIAL_FOLDER_CREATED", "StudyFolder"), materials.createFolder);
router.patch("/folders/:id", requireAuth, requireAdmin, readLimiter(), audit("MATERIAL_FOLDER_UPDATED", "StudyFolder"), materials.updateFolder);
router.delete("/folders/:id", requireAuth, requireAdmin, readLimiter(), audit("MATERIAL_FOLDER_DELETED", "StudyFolder"), materials.deleteFolder);
router.post("/uploads/sign", requireAuth, requireAdmin, readLimiter(), materials.signUpload);
router.post("/files", requireAuth, requireAdmin, readLimiter(), audit("MATERIAL_FILE_UPLOADED", "StudyFile"), materials.registerFile);
router.patch("/files/:id", requireAuth, requireAdmin, readLimiter(), audit("MATERIAL_FILE_RENAMED", "StudyFile"), materials.renameFile);
router.delete("/files/:id", requireAuth, requireAdmin, readLimiter(), audit("MATERIAL_FILE_DELETED", "StudyFile"), materials.deleteFile);

module.exports = router;
