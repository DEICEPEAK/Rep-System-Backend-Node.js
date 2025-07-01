// controllers/profileController.js

const pool = require('../db/pool');
const bcrypt = require('bcrypt');

// Fields we consider “business details”
const DETAIL_FIELDS = [
  'company_web_address',
  'company_name',
  'email',
  'twitter_username',
  'instagram_username',
  'feefo_business_info',
  'place_id',
  'place_url'
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
         country,
         telephone,
         company_web_address,
         instagram_username,
         feefo_business_info,
         place_id,
         place_url
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
// PUT /api/profile/business-details
exports.editBusinessDetails = async (req, res, next) => {
  const userId = req.user.id;
  const sets = [];
  const vals = [];
  let idx = 1;

  DETAIL_FIELDS.forEach(field => {
    if (req.body[field] !== undefined) {
      sets.push(`${field} = $${idx}`);
      vals.push(req.body[field]);
      idx++;
    }
  });

  if (!sets.length) {
    return res.status(400).json({ error: 'No business detail fields provided.' });
  }

  vals.push(userId);
  const sql = `
    UPDATE users
       SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING
       company_web_address,
       company_name,
       email,
       twitter_username,
       instagram_username,
       feefo_business_info,
       place_id,
       place_url
  `;
  try {
    const { rows } = await pool.query(sql, vals);
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    res.json({ businessDetails: rows[0] });
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