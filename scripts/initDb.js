// scripts/initDb.js

const pool = require('../db/pool');

;(async () => {
  try {
    // 1. Enable UUID generation function
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    // 2. Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        first_name   TEXT    NOT NULL,
        last_name    TEXT    NOT NULL,
        password     TEXT    NOT NULL,
        company_name TEXT    NOT NULL,
        email        TEXT    NOT NULL,
        country      TEXT    NOT NULL,
        telephone    TEXT    NOT NULL
      );
    `);

    // 3. Index on email for fast lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email
      ON users(email);
    `);

    // 4. Create password_resets table for OTP workflows
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        otp        VARCHAR(6) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);

    console.log('✓ database schema is ready');
  } catch (err) {
    console.error('✗ error initializing database schema', err);
  } finally {
    await pool.end();
  }
})();
