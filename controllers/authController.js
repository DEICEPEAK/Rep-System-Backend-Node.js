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

// Register a new user
// Register a new user
exports.registerUser = async (req, res, next) => {
  try {
    const { first_name, last_name, password, confirm_password, company_name, email, country, telephone, company_web_address } = req.body;

    // 1. All fields required (except company_web_address)
    if (!first_name || !last_name || !password || !confirm_password || !company_name || !email || !country || !telephone) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    // 2. Password match & strength
    if (password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.'
      });
    }

    // 3. Check unique email and company_name
    const { rows: exists } = await pool.query(
      `SELECT 1 FROM users WHERE email = $1 OR company_name = $2 LIMIT 1`,
      [email, company_name]
    );
    if (exists.length) {
      return res.status(409).json({ error: 'Email or company name already in use.' });
    }

    // 4. Hash password
    const hashed = await bcrypt.hash(password, 10);

    // 5. Insert user
    await pool.query(
      `INSERT INTO users (first_name, last_name, password, company_name, email, country, telephone, company_web_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ first_name, last_name, hashed, company_name, email, country, telephone, company_web_address || null ]
    );

    res.status(201).json({ message: 'User registered successfully.' });
  } catch (err) {
    next(err);
  }
};

// Login user
exports.loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const { rows } = await pool.query(`SELECT id, password FROM users WHERE email = $1`, [email]);
    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // 3. Generate JWT
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    res.json({ token });
  } catch (err) {
    next(err);
  }
};

// Request password reset: send OTP
exports.requestPasswordReset = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (!rows.length) return res.status(404).json({ error: 'No user with that email.' });

    const userId = rows[0].id;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes

    // Upsert OTP
    await pool.query(
      `INSERT INTO password_resets (user_id, otp, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET otp = EXCLUDED.otp,
             expires_at = EXCLUDED.expires_at`,
      [userId, otp, expiresAt]
    );

    // Send email
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +process.env.SMTP_PORT,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: email,
      subject: 'Your password reset code',
      text: `Your OTP is ${otp}. It expires in 2 minutes.`,
    });

    res.json({ message: 'OTP sent to email.' });
  } catch (err) {
    next(err);
  }
};

// Reset password
exports.resetPassword = async (req, res, next) => {
  try {
    const { email, otp, new_password, confirm_password } = req.body;
    if (!email || !otp || !new_password || !confirm_password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (new_password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (!validatePassword(new_password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.'
      });
    }

    // Verify user & OTP
    const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
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
    if (!rows.length || rows[0].otp !== otp || new Date(rows[0].expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired OTP.' });
    }

    // Update password
    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [hashed, userId]);
    // Cleanup
    await pool.query(`DELETE FROM password_resets WHERE user_id = $1`, [userId]);

    res.json({ message: 'Password has been reset.' });
  } catch (err) {
    next(err);
  }
};
