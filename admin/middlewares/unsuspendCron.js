/**
 * File: /admin/middlewares/unsuspendCron.js
 * Schedules a daily job to auto-unsuspend users whose till_when has passed.
 * Uses housekeeping_daily ledger to ensure once-per-day execution.
 */

const cron = require('node-cron');
const pool = require('../../db/pool');

async function runUnsuspendNow() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure we run at most once per day via ledger
    const name = 'unsuspend_expired';
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const { rows: led } = await client.query(
      `SELECT last_run_date FROM housekeeping_daily WHERE name = $1 LIMIT 1`,
      [name]
    );

    if (led.length && led[0].last_run_date && led[0].last_run_date.toISOString().slice(0,10) === today) {
      await client.query('ROLLBACK'); // already ran today
      return { ran: false, count: 0 };
    }

    // Find all users with due suspensions
    const { rows: dueRows } = await client.query(
      `SELECT user_id
         FROM suspended_users
        WHERE till_when IS NOT NULL
          AND till_when <= NOW()`
    );

    let count = 0;
    if (dueRows.length) {
      const ids = dueRows.map(r => r.user_id);

      await client.query(`UPDATE users SET is_suspended = FALSE WHERE id = ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM suspended_users WHERE user_id = ANY($1::uuid[])`, [ids]);
      count = ids.length;
    }

    // Upsert ledger
    await client.query(
      `INSERT INTO housekeeping_daily (name, last_run_date)
       VALUES ($1, CURRENT_DATE)
       ON CONFLICT (name) DO UPDATE SET last_run_date = EXCLUDED.last_run_date`,
      [name]
    );

    await client.query('COMMIT');
    return { ran: true, count };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Call this once during app startup.
 * Schedules at 02:15 daily (server local time).
 */
function startUnsuspendCron() {
  cron.schedule('15 2 * * *', async () => {
    try {
      await runUnsuspendNow();
    } catch (e) {
      // log as you like
      console.error('[unsuspendCron] error:', e.message);
    }
  });
}

module.exports = { startUnsuspendCron, runUnsuspendNow };
