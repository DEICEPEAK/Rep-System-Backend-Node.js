// scripts/initDb.js -- newly updated for users, password_resets, twitter_mentions, instagram_mentions

const pool = require('../db/pool');

;(async () => {
  try {
    // 1. Enable UUID
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    // 2. Create users table (if not exists) AND add created_at + last_fetched_at
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              UUID      PRIMARY KEY DEFAULT uuid_generate_v4(),
        first_name      TEXT      NOT NULL,
        last_name       TEXT      NOT NULL,
        password        TEXT      NOT NULL,
        company_name    TEXT      NOT NULL,
        company_web_address   TEXT,
        email           TEXT      NOT NULL,
        country         TEXT      NOT NULL,
        telephone       TEXT      NOT NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        last_fetched_at TIMESTAMPTZ NULL
      );
    `);

    // 3. Unique constraints and indexes
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
      ON users(email);
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_company
      ON users(company_name);
    `);

    // 4. Create password_resets table (if not exists)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        user_id    UUID      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        otp        VARCHAR(6) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);

    // 5. Create twitter_mentions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS twitter_mentions (
        tweet_id         VARCHAR(50)     PRIMARY KEY,     -- tweet ID as string
        company_name     TEXT            NOT NULL,
        text             TEXT            NOT NULL,
        author_handle    TEXT            NOT NULL,
        created_at       TIMESTAMPTZ     NOT NULL,
        reply_count      INTEGER         DEFAULT 0,
        fetched_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_twitter_company_date
      ON twitter_mentions(company_name, created_at);
    `);

    // 6. Create instagram_mentions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS instagram_mentions (
        post_id          VARCHAR(50)     PRIMARY KEY,     -- post ID
        company_name     TEXT            NOT NULL,
        caption          TEXT            NOT NULL,
        author_handle    TEXT            NOT NULL,
        created_at       TIMESTAMPTZ     NOT NULL,
        like_count       INTEGER         DEFAULT 0,
        comment_count    INTEGER         DEFAULT 0,
        fetched_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_insta_company_date
      ON instagram_mentions(company_name, created_at);
    `);


    // 7. Create trustpilot_reviews table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trustpilot_reviews (
        id                  SERIAL         PRIMARY KEY,
        company_name        TEXT           NOT NULL,      -- for easy filtering
        company_web_address TEXT           NOT NULL,
        author_name         TEXT           NULL,
        rating              INTEGER        NULL,
        review_title        TEXT           NULL,
        review_body         TEXT           NULL,
        review_date         DATE           NULL,
        created_at       TIMESTAMPTZ     NOT NULL,          -- parsed date
        fetched_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_tp_company_date
      ON trustpilot_reviews(company_name, review_date);
    `);

    console.log('✓ Database schema is ready for ETL');
  } catch (err) {
    console.error('✗ Error initializing database schema', err);
  } finally {
    await pool.end();
  }
})();
