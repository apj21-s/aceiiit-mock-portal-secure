const { logAuditEvent } = require("../services/auditLogService");

const MAX_BODY_CHARS = 4000;

function summarizeBody(body) {
  if (!body || typeof body !== "object") return null;
  const json = JSON.stringify(body);
  return json.length > MAX_BODY_CHARS ? { truncated: true, preview: json.slice(0, MAX_BODY_CHARS) } : body;
}

/**
 * Records a successful (2xx) admin mutation in the append-only audit log once the response
 * finishes. Secrets are redacted by auditLogService. Handlers may set res.locals.auditEntityId
 * (e.g. the id of a newly created document).
 */
function audit(action, entityType) {
  return function auditMiddleware(req, res, next) {
    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const entityId = res.locals.auditEntityId || (req.params && req.params.id) || (req.body && (req.body.testId || req.body.questionId)) || "";
      logAuditEvent({
        actorUserId: req.auth && req.auth.userId,
        action,
        entityType,
        entityId: String(entityId),
        metadata: {
          method: req.method,
          path: req.originalUrl.split("?")[0],
          params: req.params,
          body: summarizeBody(req.body),
        },
      }).catch(() => {});
    });
    next();
  };
}

module.exports = { audit };
