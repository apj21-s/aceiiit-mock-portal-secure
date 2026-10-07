const { z } = require("zod");

// Route-level input validation. Parsed (and coerced/stripped) values replace the raw
// request parts, so handlers only ever see validated input.

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Invalid id");

function validate(schemas) {
  return function validationMiddleware(req, res, next) {
    for (const part of ["params", "query", "body"]) {
      if (!schemas[part]) continue;
      const raw = req[part] || {};
      // Empty query values (e.g. "?role=") mean "not provided", not an invalid filter.
      const input = part === "query"
        ? Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ""))
        : raw;
      const result = schemas[part].safeParse(input);
      if (!result.success) {
        const issue = result.error.issues[0];
        const where = issue && issue.path && issue.path.length ? ` (${issue.path.join(".")})` : "";
        return res.status(400).json({ error: `${issue ? issue.message : "Invalid request"}${where}`, code: "VALIDATION_FAILED" });
      }
      req[part] = result.data;
    }
    return next();
  };
}

/** router.param("id", objectIdParam): every :id must be a Mongo ObjectId (400 otherwise). */
function objectIdParam(req, res, next, value) {
  if (!/^[a-f0-9]{24}$/i.test(String(value || ""))) {
    return res.status(400).json({ error: "Invalid id", code: "INVALID_ID" });
  }
  return next();
}

module.exports = { validate, objectIdParam, objectId };
