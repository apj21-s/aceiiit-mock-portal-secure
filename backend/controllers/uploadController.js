const { uploadBufferToCloudinary } = require("../utils/uploadToCloudinary");

function extractUploadedFiles(req) {
  const files = [];

  if (req && req.file && req.file.buffer) {
    files.push(req.file);
  }

  if (req && req.files) {
    if (Array.isArray(req.files)) {
      req.files.forEach((file) => {
        if (file && file.buffer) files.push(file);
      });
    } else {
      ["image", "images"].forEach((fieldName) => {
        const fieldFiles = req.files[fieldName];
        if (Array.isArray(fieldFiles)) {
          fieldFiles.forEach((file) => {
            if (file && file.buffer) files.push(file);
          });
        }
      });
    }
  }

  return files;
}

async function uploadImage(req, res, next) {
  try {
    const files = extractUploadedFiles(req);
    if (!files.length) {
      return res.status(400).json({ error: "No image file uploaded." });
    }

    const uploadedUrls = [];
    for (const file of files) {
      try {
        const result = await uploadBufferToCloudinary(file.buffer, {
          folder: "ugee-questions",
          resource_type: "image",
        });
        if (result && result.secure_url) {
          uploadedUrls.push(result.secure_url);
        }
      } catch (_cloudErr) {
        const mime = file.mimetype || "image/jpeg";
        const base64 = file.buffer.toString("base64");
        uploadedUrls.push(`data:${mime};base64,${base64}`);
      }
    }

    if (!uploadedUrls.length) {
      return res.status(400).json({ error: "Could not process image upload." });
    }

    return res.json({
      url: uploadedUrls[0],
      secure_url: uploadedUrls[0],
      urls: uploadedUrls,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { uploadImage };
