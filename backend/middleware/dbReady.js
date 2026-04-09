const { isDbReady } = require("../config/db");

function requireDbReady(req, res, next) {
  if (isDbReady()) {
    return next();
  }
  return res.status(503).json({ error: "Server warming up. Please retry." });
}

module.exports = { requireDbReady };
