// controllers/profileController.js

const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const { makeGeminiClient } = require('../services/geminiClientImpl');

// Initialize Gemini client
const geminiClient = makeGeminiClient({ apiKey: process.env.GEMINI_API_KEY });


const DETAIL_FIELDS = [
  'company_web_address',
  'company_name',
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

// 1) View Profile
// GET /api/profile
exports.viewProfile = async (req, res, next) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT
         email,
         first_name,
         last_name,
         company_name,
          description,
         country,
         telephone,
         company_web_address,
         instagram_username,
         feefo_business_info,
         twitter_username,
         facebook_username,
         linkedin_username,
         place_url,
         tiktok_profile,
         youtube_channel
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

// 2) Edit Business Details

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '');
}

exports.editBusinessDetails = async (req, res, next) => {
  const userId = req.user.id;

  try {
    if (Object.prototype.hasOwnProperty.call(req.body, 'company_name')) {
      return res.status(400).json({ error: 'company_name cannot be changed.' });
    }

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
        [email, userId]
      );
      if (dup.length) {
        return res.status(409).json({ error: 'Email already in use.' });
      }
    }

    const sets = [];
    const vals = [];
    let idx = 1;

    DETAIL_FIELDS.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        sets.push(`${field} = $${idx}`);
        vals.push(req.body[field]);
        idx++;
      }
    });

    if (!sets.length) {
      return res.status(400).json({ error: 'No business detail fields provided.' });
    }

    // Only update if the user exists AND is not deleted/suspended
    vals.push(userId);
    const sql = `
      UPDATE users
         SET ${sets.join(', ')}
       WHERE id = $${idx}
         AND is_deleted = FALSE
         AND is_suspended = FALSE
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
      return res.status(404).json({ error: 'User not found or unavailable.' });
    }

    return res.json({ businessDetails: rows[0] });
  } catch (err) {
    next(err);
  }
};





// Password strength helper (reuse from authController)
function validatePassword(password) {
  const re = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
  return re.test(password);
}

// 3) Change Password
// PUT /api/profile/change-password
// Body: { current_password, new_password, confirm_password }
exports.changePassword = async (req, res, next) => {
  const userId = req.user.id;
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).json({ error: 'All password fields are required.' });
  }
  if (new_password !== confirm_password) {
    return res.status(400).json({ error: 'New passwords do not match.' });
  }
  if (!validatePassword(new_password)) {
    return res.status(400).json({
      error: 'Password must be ≥8 chars and include uppercase, lowercase, number, special char.'
    });
  }

  try {
    const { rows } = await pool.query(
      `SELECT password FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });

    const match = await bcrypt.compare(current_password, rows[0].password);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query(
      `UPDATE users SET password = $1 WHERE id = $2`,
      [hashed, userId]
    );
    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    next(err);
  }
};

// 4) Completed Business Info %
// GET /api/profile/completed-info
exports.completedInfo = async (req, res, next) => {
  const userId = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT ${DETAIL_FIELDS.join(', ')} FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });

    const user = rows[0];
    const filled = DETAIL_FIELDS.reduce((acc, f) => {
      if (user[f] !== null && user[f] !== '') return acc + 1;
      return acc;
    }, 0);
    const pct = Math.round((filled / DETAIL_FIELDS.length) * 100);
    res.json({ completedBusinessInfoPercent: pct });
  } catch (err) {
    next(err);
  }
};


exports.getMyCompany = async (req, res, next) => {
  const userId = req.user.id;      // set by your auth middleware

  try {
    const { rows } = await pool.query(
      `SELECT company_name
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ company_name: rows[0].company_name });
  } catch (err) {
    next(err);
  }
};



// Returns: { refined_description, meta? }

exports.aiDescription = async (req, res, next) => {
  const userId = req.user.id;
  const { description, word_limit, tone } = req.body || {};

  if (!description || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }

  const MAX_CHARS = 4000;
  const safeDescription = description.length > MAX_CHARS
    ? description.slice(0, MAX_CHARS)
    : description;

  try {
    // Fetch company details
    const { rows } = await pool.query(
      `SELECT company_name, company_web_address
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId]
    );

    if (!rows.length) return res.status(404).json({ error: 'User not found.' });

    const companyName = rows[0].company_name || 'Your company';
    const website = rows[0].company_web_address;

    // Call Gemini refinement
    const result = await geminiClient.refineBusinessDescription({
      companyName,
      description: safeDescription,
      website,
      wordLimit: Number.isFinite(word_limit) ? Math.max(40, Math.min(160, Number(word_limit))) : 120,
      tone: tone || 'warm, credible, professional',
    });

    if (!result.ok) {
      const status = (result.code === 'BAD_REQUEST') ? 400
                   : (result.code === 'RATE_LIMIT' || result.code === 'TIMEOUT') ? 503
                   : 502;
      return res.status(status).json({
        error: 'AI refinement failed',
        code: result.code,
        message: result.message
      });
    }

    return res.json({
      refined_description: result.refinedText,
      meta: {
        model: result.model,
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
        latency_ms: result.latencyMs
      }
    });
  } catch (err) {
    next(err);
  }
};