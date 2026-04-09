function requestTimeout(timeoutMs) {
  const timeout = Number(timeoutMs);
  const safeTimeout = Number.isFinite(timeout) && timeout > 0 ? timeout : 15 * 1000;

  return function timeoutMiddleware(req, res, next) {
    req.setTimeout(safeTimeout);
    res.setTimeout(safeTimeout);

    let finished = false;
    res.on("finish", () => {
      finished = true;
    });

    const timer = setTimeout(() => {
      if (finished || res.headersSent) return;
      res.status(503).json({ error: "Request timed out. Please retry." });
    }, safeTimeout);

    res.on("close", () => clearTimeout(timer));
    res.on("finish", () => clearTimeout(timer));
    next();
  };
}

module.exports = { requestTimeout };
