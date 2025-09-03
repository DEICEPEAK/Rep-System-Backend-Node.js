/**
 * File: /admin/controllers/adminAuthController.js
 * Purpose: Admin-only auth
 *  - loginAdmin (existing)
 *  - requestAdminPasswordReset  (NEW)
 *  - resetAdminPassword         (NEW)
 *  - addNewAdmin                (NEW, global_admin only)
 */

const pool = require('../../db/pool'); // adjust if your folder layout differs
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();

const ADMIN_ROLES = new Set(['admin', 'global_admin']);

function getJwtSecret() {
  return process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
}
function getJwtExpiry() {
  return process.env.ADMIN_JWT_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '12h';
}
function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
// password strength (same policy you already use elsewhere)
function validatePassword(password) {
  const re = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
  return re.test(password);
}

/**
 * POST /admin/login
 * Body: { admin_id?: string, email?: string, password: string }
 * Either admin_id or email is required (plus password)
 */
exports.loginAdmin = async (req, res, next) => {
  try {
    const { admin_id, email, password } = req.body || {};

    if (!password) {
      return res.status(400).json({ error: 'Password is required.' });
    }
    if (!admin_id && !email) {
      return res.status(400).json({ error: 'Provide admin_id or email.' });
    }
    if (email && !isEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' });
    }

    let query, params;
    if (admin_id) {
      query = `
        SELECT admin_id, email, password, role
        FROM admins
        WHERE admin_id = $1
        LIMIT 1
      `;
      params = [admin_id];
    } else {
      query = `
        SELECT admin_id, email, password, role
        FROM admins
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
      `;
      params = [email];
    }

    const { rows } = await pool.query(query, params);
    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const admin = rows[0];
    if (!ADMIN_ROLES.has(admin.role)) {
      return res.status(403).json({ error: 'Account is not permitted to access admin portal.' });
    }

    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { adminId: admin.admin_id, role: admin.role },
      getJwtSecret(),
      { expiresIn: getJwtExpiry() }
    );

    return res.json({ token });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /admin/password/forgot
 * Body: { email?: string, admin_id?: string }
 * Finds the admin and emails a 6-digit OTP. Expires in 2 minutes.
 */
exports.requestAdminPasswordReset = async (req, res, next) => {
  try {
    const { email, admin_id } = req.body || {};
    if (!email && !admin_id) {
      return res.status(400).json({ error: 'Provide email or admin_id.' });
    }
    if (email && !isEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' });
    }

    const findSql = email
      ? `SELECT admin_id, email FROM admins WHERE LOWER(email) = LOWER($1) LIMIT 1`
      : `SELECT admin_id, email FROM admins WHERE admin_id = $1 LIMIT 1`;
    const { rows } = await pool.query(findSql, [email || admin_id]);
    if (!rows.length) return res.status(404).json({ error: 'Admin not found.' });

    const admin = rows[0];

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Upsert OTP (table: admin_password_resets (admin_id pk/unique, otp, expires_at))
    await pool.query(
      `INSERT INTO admin_password_resets (admin_id, otp, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '2 minutes')
       ON CONFLICT (admin_id) DO UPDATE
         SET otp = EXCLUDED.otp,
             expires_at = EXCLUDED.expires_at`,
      [admin.admin_id, otp]
    );

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +process.env.SMTP_PORT,
      secure: +process.env.SMTP_PORT === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: admin.email,
      subject: 'Your admin password reset code',
      text: `Your OTP is ${otp}. It expires in 2 minutes.`,
    });

    return res.json({ message: 'OTP sent to email.' });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /admin/password/reset
 * Body: { email?: string, admin_id?: string, otp: string, new_password: string, confirm_password: string }
 */
exports.resetAdminPassword = async (req, res, next) => {
  try {
    const { email, admin_id, otp, new_password, confirm_password } = req.body || {};
    if ((!email && !admin_id) || !otp || !new_password || !confirm_password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (email && !isEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' });
    }
    if (new_password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (!validatePassword(new_password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.'
      });
    }

    const findSql = email
      ? `SELECT admin_id FROM admins WHERE LOWER(email) = LOWER($1) LIMIT 1`
      : `SELECT admin_id FROM admins WHERE admin_id = $1 LIMIT 1`;
    const { rows: adminRows } = await pool.query(findSql, [email || admin_id]);
    if (!adminRows.length) return res.status(404).json({ error: 'Admin not found.' });

    const theAdminId = adminRows[0].admin_id;

    const { rows } = await pool.query(
      `SELECT otp, expires_at
         FROM admin_password_resets
        WHERE admin_id = $1
        ORDER BY expires_at DESC
        LIMIT 1`,
      [theAdminId]
    );

    if (!rows.length || rows[0].otp !== otp || rows[0].expires_at < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired OTP.' });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query(`UPDATE admins SET password = $1 WHERE admin_id = $2`, [hashed, theAdminId]);

    // cleanup reset row
    await pool.query(`DELETE FROM admin_password_resets WHERE admin_id = $1`, [theAdminId]);

    return res.json({ message: 'Password has been reset.' });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /admin/admins
 * Body: { admin_id: string, email: string, password: string, confirm_password: string, role: 'admin'|'global_admin' }
 * Only a global_admin can create new admins.
 * Requires: protectAdmin + requireGlobalAdmin
 */
exports.addNewAdmin = async (req, res, next) => {
  try {
    const { admin_id, email, password, confirm_password, role } = req.body || {};

    if (!admin_id || !email || !password || !confirm_password || !role) {
      return res.status(400).json({ error: 'admin_id, email, password, confirm_password and role are required.' });
    }
    if (!isEmail(email)) {
      return res.status(400).json({ error: 'Invalid email.' });
    }
    if (!ADMIN_ROLES.has(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be "admin" or "global_admin".' });
    }
    if (password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.'
      });
    }

    // Uniqueness check
    const { rows: exists } = await pool.query(
      `SELECT 1 FROM admins WHERE admin_id = $1 OR LOWER(email) = LOWER($2) LIMIT 1`,
      [admin_id, email]
    );
    if (exists.length) {
      return res.status(409).json({ error: 'admin_id or email already in use.' });
    }

    const hashed = await bcrypt.hash(password, 10);

    const insertSql = `
      INSERT INTO admins (admin_id, email, password, role)
      VALUES ($1, LOWER($2), $3, $4)
      RETURNING admin_id, email, role, created_at
    `;
    const { rows } = await pool.query(insertSql, [admin_id, email, hashed, role]);

    return res.status(201).json({ message: 'Admin created successfully.', admin: rows[0] });
  } catch (err) {
    next(err);
  }
};
