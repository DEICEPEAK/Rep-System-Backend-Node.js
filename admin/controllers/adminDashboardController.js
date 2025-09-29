/**
 * File: /admin/controllers/adminDashboardController.js
 * Purpose: Admin dashboard actions
 *  - addNewCompany: create a new user/company (admin-only, both roles)
 *  - getUsersOverview: total users + list of users with selected fields
 */
const crypto = require('crypto')
const pool = require('../../db/pool');
const bcrypt = require('bcrypt');
const { createUserToken, invalidateActiveTokensForUser } = require('../../services/tokenService');
const { enqueueEmail } = require('../../services/emailQueue');

// Reuse the same strength rule you had
function validatePassword(password) {
  const re = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
  return re.test(password);
}



const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.7blab.com';


exports.addNewCompany = async (req, res, next) => {
  try {
    const {
      first_name,
      last_name,
      company_name,
      email,
      country,
      telephone,
      company_web_address
    } = req.body || {};

    if (!first_name || !last_name || !company_name || !email || !country || !telephone) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    const { rows: exists } = await pool.query(
      `SELECT 1 FROM users WHERE LOWER(email)=LOWER($1) OR LOWER(company_name)=LOWER($2) LIMIT 1`,
      [email, company_name]
    );
    if (exists.length) {
      return res.status(409).json({ error: 'Email or company name already in use.' });
    }

    const randomSecret = crypto.randomBytes(32).toString('hex');
    const hashed = await bcrypt.hash(randomSecret, 10);

    const insertSql = `
      INSERT INTO users (
        first_name, last_name, password, company_name, email, country, telephone, company_web_address, email_verified
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, FALSE)
      RETURNING id, email, company_name, created_at
    `;
    const { rows } = await pool.query(insertSql, [
      first_name, last_name, hashed, company_name, email, country, telephone, company_web_address || null
    ]);
    const user = rows[0];

    await invalidateActiveTokensForUser(user.id, 'email_verify');
    await invalidateActiveTokensForUser(user.id, 'password_reset');

    const { token: verifyToken } = await createUserToken({
      userId: user.id, type: 'email_verify', ttlSeconds: 7 * 24 * 3600, metadata: { issued_by: 'admin' }
    });
    const { token: setupToken } = await createUserToken({
      userId: user.id, type: 'password_reset', ttlSeconds: 24 * 3600, metadata: { issued_by: 'admin_first_setup' }
    });

    const verifyUrl = `${FRONTEND_URL}/verify?token=${encodeURIComponent(verifyToken)}`;
    const setupUrl  = `${FRONTEND_URL}/setup-password?token=${encodeURIComponent(setupToken)}`;

    await enqueueEmail('invite', {
      to: user.email,
      companyName: user.company_name,
      verifyUrl,
      setupUrl,
    });

    // ⬇️ Include a top-level user_id while preserving the existing `user` payload
    return res.status(201).json({
      message: 'Company created and invite sent.',
      user_id: user.id,
      user
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /admin/dashboard/users
 * Returns:
 *  {
 *    total_users: number,
 *    users: [{ id, company_name, country, telephone, description, company_web_address, created_at, email }]
 *  }
 * Requires: protectAdmin + requireAdmin (admin or global_admin)
 * Optional query params: page, limit (defaults page=1, limit=50)
 */
exports.getUsersOverview = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const countSql = `SELECT COUNT(*)::int AS total FROM users`;
    const listSql = `
      SELECT
        id,
        email,
        company_name,
        CONCAT(first_name, ' ', last_name) AS full_name,
        country,
        telephone,
        description,
        company_web_address,
        created_at,
        email_verified,
        is_suspended,
        last_login_at,
        instagram_username,
        last_fetched_instagram,
        linkedin_username,
        last_fetched_linkedin,
        facebook_username,
        last_fetched_facebook,
        twitter_username,
        last_fetched_twitter,
        place_url,
        last_fetched_google_maps,
        tiktok_profile,
        last_fetched_tiktok,
        youtube_channel,
        last_fetched_youtube

      FROM users
      WHERE is_deleted = FALSE
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const [{ rows: countRows }, { rows: userRows }] = await Promise.all([
      pool.query(countSql),
      pool.query(listSql, [limit, offset])
    ]);

    return res.json({
      total_users: countRows[0].total,
      page,
      limit,
      users: userRows
    });
  } catch (err) {
    next(err);
  }
};


// --- Admin analytics --- //
exports.loginsToday = async (req, res, next) => {
  try {
    // “Today” relative to DB timezone (typically UTC in containers)
    const sql = `
      SELECT COUNT(*)::int AS count
      FROM users
      WHERE is_deleted = FALSE
        AND is_suspended = FALSE
        AND last_login_at >= date_trunc('day', NOW())
    `;
    const { rows } = await pool.query(sql);
    return res.json({ logins_today: rows[0].count });
  } catch (err) {
    next(err);
  }
};

exports.activeUsers15d = async (req, res, next) => {
  try {
    const sql = `
      SELECT COUNT(*)::int AS count
      FROM users
      WHERE is_deleted = FALSE
        AND is_suspended = FALSE
        AND last_login_at >= NOW() - INTERVAL '15 days'
    `;
    const { rows } = await pool.query(sql);
    return res.json({ active_users_15d: rows[0].count });
  } catch (err) {
    next(err);
  }
};

/**
 * A compact one-call summary for the dashboard header cards.
 * Feel free to extend as needed.
 */
exports.analyticsSummary = async (req, res, next) => {
  try {
    const sql = `
      SELECT
        /* core user counters */
        (SELECT COUNT(*)::int FROM users WHERE is_deleted = FALSE)                                          AS total_users,
        (SELECT COUNT(*)::int FROM users WHERE is_deleted = FALSE AND email_verified = TRUE)                AS verified_users,
        (SELECT COUNT(*)::int FROM users WHERE is_deleted = FALSE AND created_at >= NOW() - INTERVAL '7 days') AS new_users,
        (SELECT COUNT(*)::int FROM users WHERE is_suspended = TRUE)                                         AS suspended_users,

        /* activity */
        (SELECT COUNT(*)::int FROM users WHERE is_deleted = FALSE AND is_suspended = FALSE
           AND last_login_at >= date_trunc('day', NOW()))                                                   AS logins_today,
        (SELECT COUNT(*)::int FROM users WHERE is_deleted = FALSE AND is_suspended = FALSE
           AND last_login_at >= NOW() - INTERVAL '15 days')                                                 AS active_users_15d
    `;
    const { rows } = await pool.query(sql);
    return res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};



exports.resendUserVerification = async (req, res, next) => {
  try {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const { rows } = await pool.query(
      `SELECT id, email, company_name, email_verified, is_deleted, is_suspended
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId]
    );

    if (!rows.length) return res.status(404).json({ error: 'User not found.' });

    const u = rows[0];

    if (u.is_deleted)    return res.status(400).json({ error: 'User is deleted.' });
    if (u.is_suspended)  return res.status(400).json({ error: 'User is suspended.' });

    // Already verified → return the exact message requested
    if (u.email_verified) {
      return res.status(200).json({ message: 'User has already verified email' });
    }

    // Invalidate prior active verify tokens (paranoid)
    await invalidateActiveTokensForUser(u.id, 'email_verify');

    // Fresh verify token (7d TTL)
    const { token: verifyToken } = await createUserToken({
      userId: u.id,
      type: 'email_verify',
      ttlSeconds: 7 * 24 * 3600,
      metadata: { issued_by: 'admin_resend' }
    });
    const verifyUrl = `${FRONTEND_URL}/verify?token=${encodeURIComponent(verifyToken)}`;

    // (Optional but helpful) also include a fresh setup-password token (24h TTL)
    const { token: setupToken } = await createUserToken({
      userId: u.id,
      type: 'password_reset',
      ttlSeconds: 24 * 3600,
      metadata: { issued_by: 'admin_resend' }
    });
    const setupUrl = `${FRONTEND_URL}/setup-password?token=${encodeURIComponent(setupToken)}`;

    // Reuse your existing onboarding/invite template
    await enqueueEmail('invite', {
      to: u.email,
      companyName: u.company_name,
      verifyUrl,
      setupUrl
    });

    return res.json({ message: 'Verification email sent.' });
  } catch (err) {
    next(err);
  }
};



// Admin-editable fields (company_name EXCLUDED)
const ADMIN_DETAIL_FIELDS = [
  'company_web_address',
  'description',
  'email',
  'twitter_username',
  'instagram_username',
  'feefo_business_info',
  'facebook_username',
  'linkedin_username',
  'place_url',
  'tiktok_profile',
  'youtube_channel'
];

function isEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || ''); }

exports.editUserBusinessDetails = async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    // Hard block: company_name cannot be changed
    if (Object.prototype.hasOwnProperty.call(req.body, 'company_name')) {
      return res.status(400).json({ error: 'company_name cannot be changed.' });
    }

    // If email is present, validate non-empty + format + uniqueness
    if (Object.prototype.hasOwnProperty.call(req.body, 'email')) {
      const email = (req.body.email || '').trim();
      if (!email) return res.status(400).json({ error: 'Email cannot be empty.' });
      if (!isEmail(email)) return res.status(400).json({ error: 'Invalid email.' });

      const { rows: dup } = await pool.query(
        `SELECT 1
           FROM users
          WHERE is_deleted = FALSE
            AND LOWER(email) = LOWER($1)
            AND id <> $2
          LIMIT 1`,
        [email, targetUserId]
      );
      if (dup.length) {
        return res.status(409).json({ error: 'Email already in use.' });
      }
    }

    // Build dynamic SET clause from allowed fields only
    const sets = [];
    const vals = [];
    let idx = 1;

    ADMIN_DETAIL_FIELDS.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        sets.push(`${field} = $${idx}`);
        vals.push(req.body[field]);
        idx++;
      }
    });

    if (!sets.length) {
      return res.status(400).json({ error: 'No editable business detail fields provided.' });
    }

    // Target + not deleted
    vals.push(targetUserId);
    const sql = `
      UPDATE users
         SET ${sets.join(', ')}
       WHERE id = $${idx} AND is_deleted = FALSE
       RETURNING
         company_web_address,
         company_name,
         description,
         email,
         twitter_username,
         instagram_username,
         feefo_business_info,
         facebook_username,
         linkedin_username,
         place_url,
         tiktok_profile,
         youtube_channel
    `;

    const { rows } = await pool.query(sql, vals);
    if (!rows.length) {
      // Either user not found, or user is deleted (blocked by WHERE)
      return res.status(404).json({ error: 'User not found or deleted.' });
    }

    return res.json({ businessDetails: rows[0] });
  } catch (err) {
    next(err);
  }
};
