/*
File: controllers/authController.js
Description: Implements register, login, and password-reset logic
*/

// controllers/authController.js
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createUserToken, getValidTokenRow, consumeToken, invalidateActiveTokensForUser } = require('../services/tokenService');
const { enqueueEmail } = require('../services/emailQueue');
require('dotenv').config();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.7blab.com';

// Helper: validate password strength
function validatePassword(password) {
  const re = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
  return re.test(password);
}
function isEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }



exports.loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (!isEmail(email))     return res.status(400).json({ error: 'Invalid email.' });

    const { rows } = await pool.query(
      `SELECT id, password, email_verified, is_deleted, is_suspended
         FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1`,
      [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials.' });

    const user = rows[0];
    if (user.is_deleted || user.is_suspended) {
      return res.status(403).json({ error: 'Account unavailable.' });
    }
    if (!user.email_verified) {
      
      return res.status(403).json({ error: 'Please verify your email before logging in.' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

    await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '12h' });
    res.json({ token });
  } catch (err) { next(err); }
};

// VERIFY EMAIL (POST /api/auth/verify-email { token })
exports.verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Token is required.' });

    const tok = await getValidTokenRow({ token, type: 'email_verify' });

    // Flip verified (idempotent)
    const { rows } = await pool.query(
      `UPDATE users
          SET email_verified = TRUE,
              verified_at    = COALESCE(verified_at, NOW())
        WHERE id = $1
        RETURNING email_verified, email, company_name, verified_at`,
      [tok.user_id]
    );

    // Consume token (single-use)
    await consumeToken(tok.id);

    // On first verification, send onboarding
    if (rows.length && rows[0].verified_at) {
      await enqueueEmail('onboarding', { to: rows[0].email, companyName: rows[0].company_name });
    }

    return res.json({ message: 'Email verified.' });
  } catch (err) {
    // If token was used/expired, try to be idempotent-friendly:
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
};

// SETUP PASSWORD (first-time) OR RESET PASSWORD (same token type: password_reset)
exports.setupPassword = async (req, res, next) => {
  try {
    const { token, new_password, confirm_password } = req.body || {};
    if (!token || !new_password || !confirm_password)
      return res.status(400).json({ error: 'Token and new password are required.' });
    if (new_password !== confirm_password)
      return res.status(400).json({ error: 'Passwords do not match.' });
    if (!validatePassword(new_password))
      return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.' });

    const tok = await getValidTokenRow({ token, type: 'password_reset' });

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [hashed, tok.user_id]);

    // Consume this token and invalidate siblings to prevent re-use
    await consumeToken(tok.id);
    await invalidateActiveTokensForUser(tok.user_id, 'password_reset');

    res.json({ message: 'Password has been set.' });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
};

// REQUEST PASSWORD RESET (token-based)
exports.requestPasswordReset = async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email || !isEmail(email)) return res.status(400).json({ error: 'Valid email is required.' });

    const { rows } = await pool.query(
      `SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND is_deleted=FALSE LIMIT 1`,
      [email]
    );
    if (!rows.length) return res.status(200).json({ message: 'If that email exists, a reset link will be sent.' });

    const userId = rows[0].id;

    // Optional: throttle by invalidating previous active reset tokens first
    await invalidateActiveTokensForUser(userId, 'password_reset');

    const { token: resetToken } = await createUserToken({
      userId, type: 'password_reset', ttlSeconds: 24 * 3600, metadata: { origin: 'self_service' }
    });

    const resetUrl = `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(resetToken)}`;
    await enqueueEmail('reset', { to: email, resetUrl });

    res.json({ message: 'If that email exists, a reset link will be sent.' });
  } catch (err) { next(err); }
};
