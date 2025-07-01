// scripts/initDb.js

const pool = require('../db/pool');

;(async () => {
  try {
    // 1. Enable UUID support
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    // 2. Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                         UUID      PRIMARY KEY DEFAULT uuid_generate_v4(),
        first_name                 TEXT      NOT NULL,
        last_name                  TEXT      NOT NULL,
        password                   TEXT      NOT NULL,
        company_name               TEXT      NOT NULL UNIQUE,
        email                      TEXT      NOT NULL UNIQUE,
        country                    TEXT      NOT NULL,
        telephone                  TEXT      NOT NULL,
        company_web_address        TEXT,
        twitter_username           TEXT,
        instagram_username         TEXT,
        feefo_business_info        TEXT,
        place_id      TEXT,
        place_url           TEXT,
        last_fetched_twitter       TIMESTAMPTZ,
        last_fetched_twitter2      TIMESTAMPTZ,
        last_fetched_instagram     TIMESTAMPTZ,
        last_fetched_trustpilot    TIMESTAMPTZ,
        last_fetched_feefo         TIMESTAMPTZ,
        last_fetched_google        TIMESTAMPTZ,
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 3. Password resets
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        user_id    UUID      PRIMARY KEY
                    REFERENCES users(id) ON DELETE CASCADE,
        otp        VARCHAR(6) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);

    // 4. Twitter mentions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS twitter_mentions (
        tweet_id      TEXT        PRIMARY KEY,
        company_name  TEXT        NOT NULL,
        text          TEXT        DEFAULT '',
        author_handle TEXT        DEFAULT '',
        created_at    TIMESTAMPTZ NOT NULL,
        reply_count   INTEGER     NOT NULL DEFAULT 0,
        retweet_count INTEGER     NOT NULL DEFAULT 0,
        like_count    INTEGER     NOT NULL DEFAULT 0,
        sentiment      TEXT       DEFAULT 'neutral',
        image_url     TEXT,
        video_url     TEXT,
        fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_twitter_company_date
      ON twitter_mentions(company_name, created_at);
    `);

    // 5. Instagram mentions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS instagram_mentions (
        post_id       TEXT        PRIMARY KEY,
        company_name  TEXT        NOT NULL,
        caption       TEXT        DEFAULT '',
        author_handle TEXT        DEFAULT '',
        created_at    TIMESTAMPTZ NOT NULL,
        like_count    INTEGER     NOT NULL DEFAULT 0,
        comment_count INTEGER     NOT NULL DEFAULT 0,
        sentiment      TEXT       DEFAULT 'neutral',
        image_url     TEXT,
        video_url     TEXT,
        fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_instagram_company_date
      ON instagram_mentions(company_name, created_at);
    `);

    // 6. Trustpilot reviews
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trustpilot_reviews (
        id                    SERIAL       PRIMARY KEY,
        company_name          TEXT         NOT NULL,
        company_web_address   TEXT         NOT NULL,
        author_name           TEXT,
        rating                INTEGER      DEFAULT 0,
        review_title          TEXT,
        review_body           TEXT,
        review_date           DATE,
        fetched_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_tp_reviews UNIQUE
          (company_name, author_name, review_title, review_date)
      );
    `);

    // 7. Feefo reviews
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feefo_reviews (
        id                       SERIAL       PRIMARY KEY,
        company_name             TEXT         NOT NULL,
        feefo_business_info      TEXT         NOT NULL,
        customer_name              TEXT,
        rating                   INTEGER,
        service_review           TEXT,
        product_review           TEXT,
        review_date              DATE,
        customer_location        TEXT,
        fetched_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_feefo_reviews UNIQUE
          (company_name, feefo_business_info, customer_name, service_review, review_date)
      );
    `);



    // 8. Google reviews
    await pool.query(`
      CREATE TABLE IF NOT EXISTS google_maps_reviews (
        id                    SERIAL       PRIMARY KEY,
        company_name          TEXT         NOT NULL,
        place_url             TEXT         NOT NULL,  
        place_id              TEXT         NOT NULL,
        reviewer_name         TEXT,                   
        rating                INTEGER,                
        review_text           TEXT,                  
        review_date           TIMESTAMPTZ,           
        review_url            TEXT,                   
        owner_response        TEXT,                   
        fetched_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_gmaps_reviews UNIQUE (place_id, reviewer_name, review_date)
      );
    `);












    console.log('✓ Database schema is ready');
  } catch (err) {
    console.error('✗ Error initializing database schema', err);
  } finally {
    await pool.end();
  }
})();
