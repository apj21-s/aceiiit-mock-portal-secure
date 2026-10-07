// Escapes user text for use inside a MongoDB $regex (prevents regex injection / ReDoS).
function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { escapeRegex };
