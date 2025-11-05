// controllers/webContentController.js
const pool = require('../db/pool');

// ————— helpers —————
function getDateRange(query) {
  ['start_date', 'end_date'].forEach(k => {
    if (query[k] && isNaN(Date.parse(query[k]))) {
      const err = new Error(`Invalid ${k}: ${query[k]}`);
      err.status = 400;
      throw err;
    }
  });

  const end = query.end_date ? new Date(query.end_date) : new Date();
  const start = query.start_date
    ? new Date(query.start_date)
    : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [s, e] = start > end ? [end, start] : [start, end];
  return { start: s.toISOString().slice(0,10), end: e.toISOString().slice(0,10) };
}

async function fetchCompanyNameByUserId(userId) {
  const { rows } = await pool.query(
    `SELECT company_name
       FROM users
      WHERE id = $1
      LIMIT 1`,
    [userId]
  );
  if (!rows.length) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  return rows[0].company_name;
}

// One place to define a safe date expression that exists in all 3 tables.
// We assume every table has fetched_at; if published_at/updated_at are missing,
// Postgres will still succeed because we reference only existing columns in each SELECT.
const DATE_EXPR_INV = `COALESCE(published_at::date, updated_at::date, fetched_at::date)`;
const DATE_EXPR_NW  = `COALESCE(published_at::date, updated_at::date, fetched_at::date)`;
const DATE_EXPR_BR  = `COALESCE(published_at::date, updated_at::date, fetched_at::date)`;

// ————— counting across sources —————
async function countAcrossSources(companyName, dr, ratingSql, ratingParam) {
  // NOTE: only rows with rating are counted; if your schema hasn’t added rating yet,
  // remove the "AND rating IS NOT NULL" and adjust the conditions.
  const invSql = `
    SELECT COUNT(*)::int AS c
      FROM investopedia_posts
     WHERE company_name = $1
       AND ${DATE_EXPR_INV} BETWEEN $2 AND $3
       AND rating IS NOT NULL
       AND ${ratingSql}
  `;
  const nwSql = `
    SELECT COUNT(*)::int AS c
      FROM nerdwallet_posts
     WHERE company_name = $1
       AND ${DATE_EXPR_NW} BETWEEN $2 AND $3
       AND rating IS NOT NULL
       AND ${ratingSql}
  `;
  const brSql = `
    SELECT COUNT(*)::int AS c
      FROM bankrate_posts
     WHERE company_name = $1
       AND ${DATE_EXPR_BR} BETWEEN $2 AND $3
       AND rating IS NOT NULL
       AND ${ratingSql}
  `;

  const params = [companyName, dr.start, dr.end, ratingParam];
  const [inv, nw, br] = await Promise.all([
    pool.query(invSql, params),
    pool.query(nwSql, params),
    pool.query(brSql, params),
  ]);
  return inv.rows[0].c + nw.rows[0].c + br.rows[0].c;
}

// ————— endpoints —————
exports.positiveCount = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized' });
    const companyName = await fetchCompanyNameByUserId(req.user.id);
    const dr = getDateRange(req.query);
    const count = await countAcrossSources(companyName, dr, 'rating > $4', 3);
    res.json({ count });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
};

exports.neutralCount = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized' });
    const companyName = await fetchCompanyNameByUserId(req.user.id);
    const dr = getDateRange(req.query);
    const count = await countAcrossSources(companyName, dr, 'rating = $4', 3);
    res.json({ count });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
};

exports.negativeCount = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized' });
    const companyName = await fetchCompanyNameByUserId(req.user.id);
    const dr = getDateRange(req.query);
    const count = await countAcrossSources(companyName, dr, 'rating < $4', 3);
    res.json({ count });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
};

exports.allWebContent = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'Unauthorized' });
    const companyName = await fetchCompanyNameByUserId(req.user.id);
    const dr = getDateRange(req.query);

    const page   = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    // Build union with per-table date expressions (avoid referencing columns that don’t exist)
    const sql = `
      WITH unioned AS (
        SELECT post_title AS title, full_content_text, author, published_at, updated_at
        FROM investopedia_posts
        WHERE company_name = $1
          AND ${DATE_EXPR_INV} BETWEEN $2 AND $3

        UNION ALL

        SELECT post_title AS title, full_content_text, author, published_at, updated_at
        FROM nerdwallet_posts
        WHERE company_name = $1
          AND ${DATE_EXPR_NW} BETWEEN $2 AND $3

        UNION ALL

        SELECT post_title AS title, full_content_text, author, published_at, updated_at
        FROM bankrate_posts
        WHERE company_name = $1
          AND ${DATE_EXPR_BR} BETWEEN $2 AND $3
      )
      SELECT title, full_content_text, author, published_at, updated_at
      FROM unioned
      ORDER BY COALESCE(published_at, updated_at) DESC NULLS LAST
      LIMIT $4 OFFSET $5
    `;

    const params = [companyName, dr.start, dr.end, limit, offset];
    const { rows } = await pool.query(sql, params);
    res.json({ page, limit, count: rows.length, items: rows });
  } catch (err) {
    // Log full error so your global handler doesn’t hide the root cause
    console.error('[allWebContent] error:', err);
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};
