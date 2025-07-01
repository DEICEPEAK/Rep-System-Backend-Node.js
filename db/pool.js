// db/pool.js
const { Pool } = require('pg');
const { parse } = require('pg-connection-string');
require('dotenv').config();

// If you've set DATABASE_URL, use that. Otherwise fall back to individual DB_* vars.
let config;
if (process.env.DATABASE_URL) {
  // Parse the full URL (including host, port, user, pass, database)
  config = parse(process.env.DATABASE_URL);
  // Enforce SSL (Render uses self-signed certs)
  config.ssl = { rejectUnauthorized: false };
} else {
  // Local development fallback
  config = {
    host:     process.env.DB_HOST,
    port:     +process.env.DB_PORT,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  };
}

const pool = new Pool({
  ...config,
  max:                    20,
  idleTimeoutMillis:      30_000,
  connectionTimeoutMillis: 2_000,
});

module.exports = pool;
