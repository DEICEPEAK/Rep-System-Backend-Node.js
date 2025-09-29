// controllers/impersonationController.js

const jwt = require('jsonwebtoken');
const { exchangeCodeForSession, revokeSession } = require('../services/impersonationService');

function getJwtSecret() {
  return process.env.JWT_SECRET;
}
function getImpersonationExpiry() {

  return process.env.IMPERSONATION_JWT_EXPIRES_IN || '30m';
}

exports.exchangeCode = async (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });

    const out = await exchangeCodeForSession(code);
    if (!out.ok) {
      const map = { NOT_FOUND: 404, EXPIRED: 400, USED: 400, REVOKED: 410 };
      return res.status(map[out.code] || 400).json({ error: out.code });
    }
    const { session } = out;
    const payload = {
      userId: session.userId,
      imp: {
        sessionId: session.id,
        adminId: session.adminId,
        scope: session.scope
      }
    };
    const token = jwt.sign(payload, getJwtSecret(), { expiresIn: getImpersonationExpiry() });
    return res.json({ token, impersonating: true });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/impersonate/exit  (requires current impersonation token)
exports.exitImpersonation = async (req, res, next) => {
  try {
    const imp = req.impersonation;
    if (!imp) return res.status(400).json({ error: 'Not in impersonation mode' });
    await revokeSession(imp.sessionId);
    return res.json({ message: 'Impersonation ended.' });
  } catch (err) {
    next(err);
  }
};
