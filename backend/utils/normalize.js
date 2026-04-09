function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

module.exports = { normalizeEmail };

