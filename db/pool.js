// src/db/pool.js
const { Pool } = require('pg');
const { db } = require('../config');

const pool = new Pool({
  host: db.host,
  port: db.port,
  user: db.user,
  password: db.pass,
  database: db.name,
  max: 20,            // adjust pool size as needed
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

module.exports = pool;
