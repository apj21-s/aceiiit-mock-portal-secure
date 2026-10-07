const crypto = require("crypto");

// AES-256-GCM encryption for secrets stored at rest (Google Calendar refresh tokens).
// Format: "v1:<iv b64>:<auth tag b64>:<ciphertext b64>". The key is derived from
// CALENDAR_TOKEN_KEY (32+ chars, required in production).

const PREFIX = "v1";

function keyFrom(secret) {
  const raw = String(secret || process.env.CALENDAR_TOKEN_KEY || "");
  if (!raw) throw new Error("CALENDAR_TOKEN_KEY is not configured.");
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptSecret(plaintext, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`) && value.split(":").length === 4;
}

/** Decrypts a stored secret. Legacy plaintext values (pre-migration) are returned as-is. */
function decryptSecret(value, secret) {
  if (!value) return "";
  if (!isEncrypted(value)) return String(value);
  const [, ivB64, tagB64, dataB64] = value.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

module.exports = { encryptSecret, decryptSecret, isEncrypted };
