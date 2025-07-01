// controllers/reviewController.js

const pool = require('../db/pool');

// 1) Date‐range helper
function getDateRange(query) {
  const end = query.end_date ? new Date(query.end_date) : new Date();
  const start = query.start_date
    ? new Date(query.start_date)
    : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// 2) Fetch company_name by user ID
async function fetchCompanyNameById(userId) {
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

// 3) Generic counter across three tables
async function countReviews(company, start, end, cond) {
  // cond is a SQL snippet like "rating > $4" plus param value(s)
  const tpSql = `
    SELECT COUNT(*)::int AS c
      FROM trustpilot_reviews
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
       AND ${cond.sql}
  `;
  const ffSql = `
    SELECT COUNT(*)::int AS c
      FROM feefo_reviews
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
       AND ${cond.sql.replace(/rating|review_date/g, 'sentiment')}
  `;
  const gmSql = `
    SELECT COUNT(*)::int AS c
      FROM google_maps_reviews
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
       AND ${cond.sql}
  `;

  const params = [company, start, end, ...cond.params];
  const [[tp], [ff], [gm]] = await Promise.all([
    pool.query(tpSql, params),
    pool.query(ffSql, params),
    pool.query(gmSql, params),
  ]);
  return tp.c + ff.c + gm.c;
}async function countReviews(company, start, end, cond) {
  // cond is a SQL snippet like "rating > $4" plus param value(s)
  const tpSql = `
    SELECT COUNT(*)::int AS c
      FROM trustpilot_reviews
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
       AND ${cond.sql}
  `;
  const ffSql = `
    SELECT COUNT(*)::int AS c
      FROM feefo_reviews
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
       AND ${cond.sql.replace(/rating|review_date/g, 'sentiment')}
  `;
  const gmSql = `
    SELECT COUNT(*)::int AS c
      FROM google_maps_reviews
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
       AND ${cond.sql}
  `;

  const params = [company, start, end, ...cond.params];
  const [tpRes, ffRes, gmRes] = await Promise.all([
    pool.query(tpSql, params),
    pool.query(ffSql, params),
    pool.query(gmSql, params),
  ]);
  
  return tpRes.rows[0].c + ffRes.rows[0].c + gmRes.rows[0].c;
}


// 4) Build each endpoint
const endpoints = {
  positive:        { sql: 'rating > $4',     params: [3] },
  neutral:         { sql: 'rating = $4',     params: [3] },
  negative:        { sql: 'rating < $4',     params: [3] },
  highlyPositive:  { sql: 'rating > $4',     params: [4] },
  moderatelyPositive: { sql: 'rating = $4', params: [4] },
  slightlyNegative:   { sql: 'rating = $4', params: [2] },
  highlyNegative:     { sql: 'rating < $4', params: [2] },
};

Object.entries(endpoints).forEach(([key, cond]) => {
  exports[`${key}Reviews`] = async (req, res, next) => {
    try {
      const userId = req.user.id;
      const company = await fetchCompanyNameById(userId);
      const { start, end } = getDateRange(req.query);
      const count = await countReviews(company, start, end, cond);
      return res.json({ count });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      next(err);
    }
  };
});

// 5) Combined “reviews” endpoint
exports.reviews = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const company = await fetchCompanyNameById(userId);
    const { start, end } = getDateRange(req.query);

    // Trustpilot
    const tpQ = `
      SELECT
        rating,
        review_title  AS title,
        review_body   AS body,
        author_name   AS author,
        review_date   AS created_at
      FROM trustpilot_reviews
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
    `;

    // Feefo
    const ffQ = `
      SELECT
        sentiment     AS rating,
        service_review AS title,
        COALESCE(product_review, service_review) AS body,
        customer_name AS author,
        review_date   AS created_at
      FROM feefo_reviews
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
    `;

    // Google Maps
    const gmQ = `
      SELECT
        rating,
        review_text   AS title,
        review_text   AS body,
        reviewer_name AS author,
        review_date   AS created_at
      FROM google_maps_reviews
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
    `;

    const [tpRes, ffRes, gmRes] = await Promise.all([
      pool.query(tpQ, [company, start, end]),
      pool.query(ffQ, [company, start, end]),
      pool.query(gmQ, [company, start, end]),
    ]);

    // Tag source
    const tag = (rows, source) => rows.map(r => ({ ...r, source }));
    let all = [
      ...tag(tpRes.rows, 'Trustpilot'),
      ...tag(ffRes.rows, 'Feefo'),
      ...tag(gmRes.rows, 'Google Maps'),
    ];

    // Sort newest first
    all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Classify sentiment
    const classify = rating =>
      rating >  3 ? 'positive' :
      rating === 3 ? 'neutral' :
      'negative';

    // Build response objects
    const now = Date.now();
    const results = all.map(r => {
      // human-friendly whenPosted
      const diffDays = Math.floor((now - new Date(r.created_at)) / (86400e3));
      const whenPosted =
        diffDays === 0 ? 'today' :
        diffDays === 1 ? '1 day ago' :
        `${diffDays} days ago`;

      return {
        rating:      r.rating,
        reviewTitle: r.title,
        reviewBody:  r.body,
        authorName:  r.author,
        source:      r.source,
        sentiment:   classify(r.rating),
        whenPosted
      };
    });

    res.json(results);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};
