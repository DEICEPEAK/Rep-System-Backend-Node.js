/**
 * File: /admin/controllers/adminDashboardController.js
 * Purpose: Admin dashboard actions
 *  - addNewCompany: create a new user/company (admin-only, both roles)
 *  - getUsersOverview: total users + list of users with selected fields
 */

const pool = require('../../db/pool');
const bcrypt = require('bcrypt');

// Reuse the same strength rule you had
function validatePassword(password) {
  const re = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
  return re.test(password);
}

/**
 * POST /admin/dashboard/company
 * Body:
 *  { first_name, last_name, password, confirm_password,
 *    company_name, email, country, telephone, company_web_address }
 * Requires: protectAdmin + requireAdmin (admin or global_admin)
 */
exports.addNewCompany = async (req, res, next) => {
  try {
    const {
      first_name,
      last_name,
      password,
      confirm_password,
      company_name,
      email,
      country,
      telephone,
      company_web_address
    } = req.body || {};

    // 1) Validate required fields
    if (!first_name || !last_name || !password || !confirm_password || !company_name || !email || !country || !telephone) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    // 2) Password checks
    if (password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.'
      });
    }

    // 3) Uniqueness (email or company_name)
    const { rows: exists } = await pool.query(
      `SELECT 1 FROM users WHERE email = $1 OR company_name = $2 LIMIT 1`,
      [email, company_name]
    );
    if (exists.length) {
      return res.status(409).json({ error: 'Email or company name already in use.' });
    }

    // 4) Hash password
    const hashed = await bcrypt.hash(password, 10);

    // 5) Insert user (NO role column used)
    const insertSql = `
      INSERT INTO users (
        first_name, last_name, password, company_name, email, country, telephone, company_web_address
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, email, company_name, created_at
    `;
    const { rows } = await pool.query(insertSql, [
      first_name,
      last_name,
      hashed,
      company_name,
      email,
      country,
      telephone,
      company_web_address || null
    ]);

    return res.status(201).json({
      message: 'Company created successfully.',
      user: rows[0]
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
        country,
        telephone,
        description,
        company_web_address,
        created_at
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
