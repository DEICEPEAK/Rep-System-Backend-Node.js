// src/db/pool.js
const { Pool } = require('pg');
const { db } = require('../config');



const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });


module.exports = pool;
