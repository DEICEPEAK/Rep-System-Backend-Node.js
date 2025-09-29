const pool = require('../../db/pool');
const { createImpersonationSession } = require('../../services/impersonationService');

exports.startImpersonation = async (req, res, next) => {
  try {
    const { user_id, scope, reason } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const { rows } = await pool.query(`SELECT id FROM users WHERE id=$1 AND is_deleted=FALSE LIMIT 1`, [user_id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const ttlSec = parseInt(process.env.IMPERSONATE_CODE_TTL_SEC || '60', 10); // default 60s
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const ua = req.get('user-agent') || '';

    const out = await createImpersonationSession({
      adminId: req.admin.adminId,
      userId: user_id,
      scope: Array.isArray(scope) && scope.length ? scope : ['read'],
      ttlSec,
      reason,
      ip,
      ua
    });

    // Return the one-time code to the admin app (front-end will immediately exchange it on the user app)
    res.json({ code: out.code, session_id: out.sessionId, expires_at: out.expiresAt });
  } catch (err) {
    next(err);
  }
};
