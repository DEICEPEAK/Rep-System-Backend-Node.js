// middlewares/impersonationGate.js

const micromatch = require('micromatch');

// Comma-separated globs. Reasonable defaults:
const DEFAULT_GLOBS = [
  '/api/profile/change-password',
  '/api/auth/setup-password',
  '/api/auth/request-password-reset',
  '/api/auth/verify-email' 
];

const DENY_GLOBS = (process.env.IMPERSONATION_DENY_GLOBS || DEFAULT_GLOBS.join(','))
  .split(',').map(s => s.trim()).filter(Boolean);

// Optional allowlist scope check for limited write actions
function hasScope(req, name) {
  return Array.isArray(req.impersonation?.scope) && req.impersonation.scope.includes(name);
}

module.exports = function impersonationGate(req, res, next) {
  if (!req.impersonation) return next();

  // Block by path glob
  if (micromatch.isMatch(req.path, DENY_GLOBS)) {
    return res.status(403).json({ error: 'IMPERSONATION_FORBIDDEN' });
  }

  // Example: allow only GET by default; POST/PUT/DELETE require explicit scope
  if (req.method !== 'GET' && !hasScope(req, 'support-actions')) {
    return res.status(403).json({ error: 'IMPERSONATION_READ_ONLY' });
  }

  return next();
};
