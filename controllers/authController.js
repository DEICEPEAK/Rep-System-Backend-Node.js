/*
File: controllers/authController.js
Description: Implements register, login, and password-reset logic
*/
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();

// Helper: validate password strength
function validatePassword(password) {
  const re = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
  return re.test(password);
}


function isEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

// LOGIN
exports.loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (!isEmail(email))     return res.status(400).json({ error: 'Invalid email.' });

    const { rows } = await pool.query(
      `SELECT id, password
         FROM users
        WHERE LOWER(email) = LOWER($1)
          AND is_deleted = FALSE
          AND is_suspended = FALSE
        LIMIT 1`,
      [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials.' });

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '12h' });
    res.json({ token });
  } catch (err) { next(err); }
};

// FORGOT PASSWORD
exports.requestPasswordReset = async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    if (!isEmail(email)) return res.status(400).json({ error: 'Invalid email.' });

    const { rows } = await pool.query(
      `SELECT id
         FROM users
        WHERE LOWER(email) = LOWER($1)
          AND is_deleted = FALSE
        LIMIT 1`,
      [email]
    );
    if (!rows.length) return res.status(404).json({ error: 'No user with that email.' });

    const userId = rows[0].id;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await pool.query(
      `INSERT INTO password_resets (user_id, otp, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '2 minutes')
       ON CONFLICT (user_id) DO UPDATE
         SET otp = EXCLUDED.otp, expires_at = EXCLUDED.expires_at`,
      [userId, otp]
    );

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +process.env.SMTP_PORT,
      secure: +process.env.SMTP_PORT === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: email,
      subject: 'Your password reset code',
      text: `Your OTP is ${otp}. It expires in 2 minutes.`,
    });

    res.json({ message: 'OTP sent to email.' });
  } catch (err) { next(err); }
};

// RESET PASSWORD
exports.resetPassword = async (req, res, next) => {
  try {
    const { email, otp, new_password, confirm_password } = req.body || {};
    if (!email || !otp || !new_password || !confirm_password)
      return res.status(400).json({ error: 'All fields are required.' });
    if (!isEmail(email)) return res.status(400).json({ error: 'Invalid email.' });
    if (new_password !== confirm_password)
      return res.status(400).json({ error: 'Passwords do not match.' });
    if (!validatePassword(new_password))
      return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.' });

    const { rows: userRows } = await pool.query(
      `SELECT id
         FROM users
        WHERE LOWER(email) = LOWER($1)
          AND is_deleted = FALSE
        LIMIT 1`,
      [email]
    );
    if (!userRows.length) return res.status(404).json({ error: 'No user with that email.' });

    const userId = userRows[0].id;

    const { rows } = await pool.query(
      `SELECT otp, expires_at
         FROM password_resets
        WHERE user_id = $1
        ORDER BY expires_at DESC
        LIMIT 1`,
      [userId]
    );
    if (!rows.length || rows[0].otp !== otp || rows[0].expires_at < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired OTP.' });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [hashed, userId]);
    await pool.query(`DELETE FROM password_resets WHERE user_id = $1`, [userId]);

    res.json({ message: 'Password has been reset.' });
  } catch (err) { next(err); }
};

