/**
 * File: /admin/controllers/accessController.js
 * Adds: suspend, delete, and manual unsuspend (with audit)
 */

const pool = require('../../db/pool');

async function findUserByIdOrEmail({ user_id, email }, client = pool) {
  if (!user_id && !email) return null;
  const sql = user_id
    ? `SELECT id, email, company_name, company_web_address, is_deleted, is_suspended
         FROM users WHERE id = $1 LIMIT 1`
    : `SELECT id, email, company_name, company_web_address, is_deleted, is_suspended
         FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`;
  const { rows } = await client.query(sql, [user_id || email]);
  return rows[0] || null;
}

/**
 * POST /admin/access/suspend
 * Body: { user_id?: string, email?: string, reason: string, till_when?: string(ISO) }
 * Auth: protectAdmin + requireAdmin (admin or global_admin)
 * Rules: If no till_when provided => NULL (indefinite)
 * Audit: suspended_users.performed_by_admin_id
 */
exports.suspendUserAccount = async (req, res, next) => {
  const { user_id, email, reason, till_when } = req.body || {};
  const performedBy = req.admin?.adminId;

  if ((!user_id && !email) || !reason) {
    return res.status(400).json({ error: 'user_id or email, and reason are required.' });
  }

  let tillWhenTs = null;
  if (till_when) {
    const ts = new Date(till_when);
    if (isNaN(ts.getTime())) {
      return res.status(400).json({ error: 'Invalid till_when date format.' });
    }
    tillWhenTs = ts.toISOString();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const user = await findUserByIdOrEmail({ user_id, email }, client);
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }
    if (user.is_deleted) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot suspend a deleted account.' });
    }
    if (user.is_suspended) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'User is already suspended.' });
    }

    await client.query(`UPDATE users SET is_suspended = TRUE WHERE id = $1`, [user.id]);

    await client.query(
      `INSERT INTO suspended_users
         (user_id, company_name, email, company_web_address, reason, till_when, performed_by_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE
         SET company_name = EXCLUDED.company_name,
             email        = EXCLUDED.email,
             company_web_address = EXCLUDED.company_web_address,
             reason       = EXCLUDED.reason,
             suspension_date = NOW(),
             till_when    = EXCLUDED.till_when,
             performed_by_admin_id = EXCLUDED.performed_by_admin_id`,
      [user.id, user.company_name, user.email, user.company_web_address, reason, tillWhenTs, performedBy]
    );

    await client.query('COMMIT');
    return res.json({ message: 'User suspended successfully.', user_id: user.id, till_when: tillWhenTs });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

/**
 * POST /admin/access/delete
 * Body: { user_id?: string, email?: string, reason: string }
 * Auth: protectAdmin + requireGlobalAdmin
 * Behavior: soft-delete; audit insert to deleted_users with performed_by_admin_id
 */
exports.deleteUserAccount = async (req, res, next) => {
  const { user_id, email, reason } = req.body || {};
  const performedBy = req.admin?.adminId;

  if ((!user_id && !email) || !reason) {
    return res.status(400).json({ error: 'user_id or email, and reason are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const user = await findUserByIdOrEmail({ user_id, email }, client);
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }
    if (user.is_deleted) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'User already deleted.' });
    }

    await client.query(
      `UPDATE users SET is_deleted = TRUE, is_suspended = FALSE WHERE id = $1`,
      [user.id]
    );

    await client.query(
      `INSERT INTO deleted_users
         (user_id, company_name, email, company_web_address, reason, performed_by_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE
         SET company_name = EXCLUDED.company_name,
             email = EXCLUDED.email,
             company_web_address = EXCLUDED.company_web_address,
             reason = EXCLUDED.reason,
             deleted_at = NOW(),
             performed_by_admin_id = EXCLUDED.performed_by_admin_id`,
      [user.id, user.company_name, user.email, user.company_web_address, reason, performedBy]
    );

    await client.query('COMMIT');
    return res.json({ message: 'User deleted (soft) successfully.', user_id: user.id });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

/**
 * POST /admin/access/unsuspend
 * Body: { user_id?: string, email?: string }
 * Auth: protectAdmin + requireAdmin (both roles)
 * Behavior: clears users.is_suspended and removes row from suspended_users
 */
exports.unsuspendUserAccount = async (req, res, next) => {
  const { user_id, email } = req.body || {};
  if (!user_id && !email) {
    return res.status(400).json({ error: 'user_id or email is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const user = await findUserByIdOrEmail({ user_id, email }, client);
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }
    if (!user.is_suspended) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'User is not suspended.' });
    }

    await client.query(`UPDATE users SET is_suspended = FALSE WHERE id = $1`, [user.id]);
    await client.query(`DELETE FROM suspended_users WHERE user_id = $1`, [user.id]);

    await client.query('COMMIT');
    return res.json({ message: 'User unsuspended successfully.', user_id: user.id });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};
