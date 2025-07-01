// db/pool.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  // Use the full URL from Render
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  // sensible defaults
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

module.exports = pool;
