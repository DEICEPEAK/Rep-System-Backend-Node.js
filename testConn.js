// testConn.js
const pool = require('./db/pool');
;(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('🎉 DB connection successful');
  } catch (err) {
    console.error('❌ DB connection failed:', err.message);
  } finally {
    await pool.end();
  }
})();
