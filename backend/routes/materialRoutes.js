const express = require("express");

const materials = require("../controllers/materialController");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { readLimiter } = require("../middleware/rateLimit");
const { audit } = require("../middleware/audit");

// Study materials, stored in the admin's Google Drive. Every signed-in user (free or paid) can
// browse, search, open and download; only admins connect Drive and change folders or files.
// Bulk uploads make two requests per file, so admin writes use the read limiter.
const router = express.Router();

router.get("/", requireAuth, readLimiter(), materials.listMaterials);
router.get("/search", requireAuth, readLimiter(), materials.searchMaterials);
router.get("/files/:id/content", requireAuth, readLimiter(), materials.fileContent);
router.get("/files/:id/thumbnail", requireAuth, readLimiter(), materials.fileThumbnail);

router.get("/drive", requireAuth, requireAdmin, readLimiter(), materials.driveStatus);
router.post("/drive/connect", requireAuth, requireAdmin, readLimiter(), materials.connectDrive);
router.get("/drive/callback", requireAuth, requireAdmin, materials.driveCallback);
router.post("/drive/disconnect", requireAuth, requireAdmin, readLimiter(), audit("MATERIALS_DRIVE_DISCONNECTED", "DriveConnection"), materials.disconnectDrive);
router.post("/drive/root", requireAuth, requireAdmin, readLimiter(), audit("MATERIALS_DRIVE_ROOT_SET", "DriveConnection"), materials.setRoot);
router.post("/refresh", requireAuth, requireAdmin, readLimiter(), materials.refresh);

router.post("/folders", requireAuth, requireAdmin, readLimiter(), audit("MATERIAL_FOLDER_CREATED", "DriveItem"), materials.createFolder);
router.patch("/items/:id", requireAuth, requireAdmin, readLimiter(), audit("MATERIAL_ITEM_UPDATED", "DriveItem"), materials.updateItem);
router.delete("/items/:id", requireAuth, requireAdmin, readLimiter(), audit("MATERIAL_ITEM_TRASHED", "DriveItem"), materials.deleteItem);
router.post("/uploads/session", requireAuth, requireAdmin, readLimiter(), materials.startUpload);
router.post("/uploads/complete", requireAuth, requireAdmin, readLimiter(), audit("MATERIAL_FILE_UPLOADED", "DriveItem"), materials.finishUpload);

module.exports = router;
