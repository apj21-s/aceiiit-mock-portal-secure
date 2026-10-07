const { captureException } = require("../utils/sentry");

function notFound(_req, res, _next) {
  res.status(404).json({ error: "Not found" });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  if (err && err.name === "MulterError") {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "Image is too large. Max allowed size is 4MB."
      : "Invalid image upload.";
    return res.status(400).json({ error: message });
  }
  if (err && err.name === "ZodError") {
    return res.status(400).json({
      error: err.issues && err.issues[0] && err.issues[0].message ? err.issues[0].message : "Invalid request",
    });
  }
  if (err && (err.name === "CastError" || err.name === "BSONError")) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const status = Number(err.status || err.statusCode || 500);
  const message = err.expose ? err.message : "Internal server error";
  if (status >= 500) {
    if (req.log) req.log.error({ err }, "request failed");
    captureException(err, { requestId: req.id });
  }
  const body = { error: message };
  if (status >= 500 && req.id) body.requestId = req.id;
  if (err.expose && err.code && typeof err.code === "string") body.code = err.code;
  if (err.expose && err.extra && typeof err.extra === "object") Object.assign(body, err.extra);
  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
