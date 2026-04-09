const cloudinary = require("../config/cloudinary");

function uploadBufferToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    if (
      (!process.env.CLOUDINARY_URL) &&
      (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)
    ) {
      const error = new Error(
        "Cloudinary is not configured (set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET)."
      );
      error.status = 500;
      error.expose = true;
      return reject(error);
    }
    const stream = cloudinary.uploader.upload_stream(options || {}, (error, result) => {
      if (error) {
        const wrapped = new Error(`Cloudinary upload failed: ${error.message || String(error)}`);
        wrapped.status = 502;
        wrapped.expose = true;
        return reject(wrapped);
      }
      return resolve(result);
    });
    stream.end(buffer);
  });
}

module.exports = { uploadBufferToCloudinary };
