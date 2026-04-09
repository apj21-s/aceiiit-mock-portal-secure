const cloudinary = require("cloudinary").v2;

function parseCloudinaryUrl(value) {
  try {
    if (!value) return null;
    const url = new URL(String(value));
    // cloudinary://<api_key>:<api_secret>@<cloud_name>
    const cloudName = url.hostname;
    const apiKey = decodeURIComponent(url.username || "");
    const apiSecret = decodeURIComponent(url.password || "");
    if (!cloudName || !apiKey || !apiSecret) return null;
    return { cloudName, apiKey, apiSecret };
  } catch (_err) {
    return null;
  }
}

const parsed = parseCloudinaryUrl(process.env.CLOUDINARY_URL);

cloudinary.config({
  secure: true,
  cloud_name: parsed ? parsed.cloudName : process.env.CLOUDINARY_CLOUD_NAME,
  api_key: parsed ? parsed.apiKey : process.env.CLOUDINARY_API_KEY,
  api_secret: parsed ? parsed.apiSecret : process.env.CLOUDINARY_API_SECRET,
});

module.exports = cloudinary;
