const multer = require("multer");

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit per image
  fileFilter: (_req, file, cb) => {
    if (!file || !file.mimetype || !String(file.mimetype).toLowerCase().startsWith("image/")) {
      const err = new Error("Only image uploads are allowed.");
      err.status = 400;
      err.expose = true;
      return cb(err);
    }
    return cb(null, true);
  },
});

module.exports = upload;
