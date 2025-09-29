// middlewares/impersonationAudit.js


const crypto = require('crypto');
const { auditImpersonatedRequest } = require('../services/impersonationService');

module.exports = function impersonationAudit(req, res, next) {
  if (!req.impersonation) return next();

  const start = Date.now();
  const bodyDigest = (() => {
    try {
      // Avoid logging PII; hash the payload
      if (!req.body || Object.keys(req.body).length === 0) return null;
      const raw = JSON.stringify(req.body);
      return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    } catch { return null; }
  })();

  res.on('finish', () => {
    auditImpersonatedRequest({
      sessionId: req.impersonation.sessionId,
      adminId: req.impersonation.adminId,
      userId: req.user?.id,
      method: req.method,
      path: req.originalUrl || req.path,
      status: res.statusCode,
      ip: req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
      payloadDigest: bodyDigest
    }).catch(() => {});
  });

  next();
};
