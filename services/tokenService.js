// services/tokenService.js
const crypto = require('crypto');
const pool = require('../db/pool');

const HASH_ALGO = 'sha256';

/** Generate a 48-byte random token, return base64url */
function generateToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url'); // Node 16+ supports base64url
}

function sha256Hex(input) {
  return crypto.createHash(HASH_ALGO).update(input, 'utf8').digest('hex');
}

/**
 * Create a single-use token record (returns plaintext "token" for email links).
 * @param {string} userId
 * @param {'email_verify'|'password_reset'} type
 * @param {number} ttlSeconds
 * @param {object} metadata (optional)
 */
async function createUserToken({ userId, type, ttlSeconds, metadata }) {
  const token = generateToken(48);
  const tokenHash = sha256Hex(token);
  const { rows } = await pool.query(
    `INSERT INTO user_tokens (user_id, type, token_hash, expires_at, metadata)
     VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::interval, $5)
     RETURNING id, expires_at`,
    [userId, type, tokenHash, ttlSeconds, metadata || null]
  );
  return { token, id: rows[0].id, expires_at: rows[0].expires_at };
}

/**
 * Lookup token by plaintext; ensure type matches.
 * Returns { row, status } or throws with a safe error.
 */
async function getValidTokenRow({ token, type }) {
  const tokenHash = sha256Hex(token);
  const { rows } = await pool.query(
    `SELECT id, user_id, type, expires_at, used_at
       FROM user_tokens
      WHERE token_hash = $1 AND type = $2
      LIMIT 1`,
    [tokenHash, type]
  );
  if (!rows.length) {
    const e = new Error('Invalid token');
    e.status = 400;
    throw e;
  }
  const row = rows[0];
  if (row.used_at) {
    const e = new Error('Token already used');
    e.status = 400;
    throw e;
  }
  if (new Date(row.expires_at) < new Date()) {
    const e = new Error('Token expired');
    e.status = 400;
    throw e;
  }
  return row;
}

/** Mark token as used (single use) */
async function consumeToken(tokenId) {
  await pool.query(
    `UPDATE user_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
    [tokenId]
  );
}

/** Invalidate all active tokens of a type for a user (optional hardening) */
async function invalidateActiveTokensForUser(userId, type) {
  await pool.query(
    `UPDATE user_tokens
        SET expires_at = LEAST(expires_at, NOW())
      WHERE user_id = $1 AND type = $2 AND used_at IS NULL AND expires_at > NOW()`,
    [userId, type]
  );
}

/** Purge tokens: expired > 30d ago and used > 30d ago */
async function purgeOldTokens() {
  await pool.query(`
    DELETE FROM user_tokens
     WHERE (expires_at < NOW() - INTERVAL '30 days')
        OR (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '30 days')
  `);
}

module.exports = {
  createUserToken,
  getValidTokenRow,
  consumeToken,
  invalidateActiveTokensForUser,
  purgeOldTokens,
};
