function notFound(_req, res, _next) {
  res.status(404).json({ error: "Not found" });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err && err.name === "MulterError") {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "Image is too large. Max allowed size is 2MB."
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
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(status).json({ error: message });
}

module.exports = { notFound, errorHandler };
