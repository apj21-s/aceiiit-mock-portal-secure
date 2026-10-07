const { extractUploadedFiles, uploadImages } = require("../services/imageUploadService");

async function uploadImage(req, res, next) {
  try {
    const files = extractUploadedFiles(req);
    if (!files.length) {
      return res.status(400).json({ error: "No image file uploaded." });
    }
    const urls = await uploadImages(files);
    return res.json({ url: urls[0], secure_url: urls[0], urls });
  } catch (err) {
    return next(err);
  }
}

module.exports = { uploadImage };
