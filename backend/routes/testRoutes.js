const express = require("express");

const { listTests, getTestById, getTestQuestions, createTest, updateTest, deleteTest } = require("../controllers/testController");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { readLimiter } = require("../middleware/rateLimit");

const router = express.Router();

router.get("/", requireAuth, readLimiter(), listTests);
router.get("/:id", requireAuth, readLimiter(), getTestById);
router.get("/:id/questions", requireAuth, readLimiter(), getTestQuestions);

router.post("/", requireAuth, requireAdmin, createTest);
router.put("/:id", requireAuth, requireAdmin, updateTest);
router.delete("/:id", requireAuth, requireAdmin, deleteTest);

module.exports = router;
