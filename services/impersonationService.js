const crypto = require('crypto');
const pool = require('../db/pool');

function genCode(bytes = 24) {
  // short, url-safe
  return crypto.randomBytes(bytes).toString('base64url');
}
function hashCode(code) {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

async function createImpersonationSession({ adminId, userId, scope = ['read'], ttlSec = 60, reason, ip, ua }) {
  const code = genCode(24);
  const codeHash = hashCode(code);
  const { rows } = await pool.query(
    `INSERT INTO impersonation_sessions
       (admin_id, user_id, scope, reason, code_hash, expires_at, created_ip, created_user_agent)
     VALUES
       ($1, $2, $3::jsonb, $4, $5, NOW() + ($6 || ' seconds')::interval, $7, $8)
     RETURNING id, expires_at`,
    [adminId, userId, JSON.stringify(scope), reason || null, codeHash, ttlSec, ip || null, ua || null]
  );
  return { code, sessionId: rows[0].id, expiresAt: rows[0].expires_at };
}

async function exchangeCodeForSession(code) {
  const h = hashCode(code);
  const { rows } = await pool.query(
    `SELECT id, admin_id, user_id, scope, expires_at, used_at, revoked_at
       FROM impersonation_sessions
      WHERE code_hash = $1
      LIMIT 1`,
    [h]
  );
  if (!rows.length) return { ok: false, code: 'NOT_FOUND' };
  const s = rows[0];
  if (s.revoked_at) return { ok: false, code: 'REVOKED' };
  if (s.used_at)    return { ok: false, code: 'USED' };
  if (new Date(s.expires_at) < new Date()) return { ok: false, code: 'EXPIRED' };

  await pool.query(`UPDATE impersonation_sessions SET used_at = NOW() WHERE id = $1`, [s.id]);
  return { ok: true, session: { id: s.id, adminId: s.admin_id, userId: s.user_id, scope: s.scope } };
}

async function isSessionActive(sessionId, adminId, userId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM impersonation_sessions
      WHERE id = $1 AND admin_id = $2 AND user_id = $3 AND revoked_at IS NULL
      LIMIT 1`,
    [sessionId, adminId, userId]
  );
  return !!rows.length;
}

async function revokeSession(sessionId) {
  await pool.query(`UPDATE impersonation_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
}

async function auditImpersonatedRequest({ sessionId, adminId, userId, method, path, status, ip, payloadDigest }) {
  await pool.query(
    `INSERT INTO impersonation_audit
       (session_id, admin_id, user_id, method, path, status, ip, payload_digest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [sessionId, adminId, userId, method, path, status, ip || null, payloadDigest || null]
  );
}

module.exports = {
  createImpersonationSession,
  exchangeCodeForSession,
  isSessionActive,
  revokeSession,
  auditImpersonatedRequest,
};
