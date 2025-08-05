// controllers/reviewController.js

const pool = require('../db/pool');

// 1) Date‐range helper with validation, swap, and commented logs
function getDateRange(query) {
  // Validate date inputs
  ['start_date', 'end_date'].forEach(key => {
    if (query[key] && isNaN(Date.parse(query[key]))) {
      const err = new Error(`Invalid ${key}: ${query[key]}`);
      err.status = 400;
      throw err;
    }
  });

  // Build Date objects
  let end = query.end_date
    ? new Date(query.end_date)
    : new Date();
  let start = query.start_date
    ? new Date(query.start_date)
    : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Swap if out of order
  if (start > end) {
    // console.warn(
    //   `[getDateRange] start (${start.toISOString().slice(0,10)}) ` +
    //   `> end (${end.toISOString().slice(0,10)}); swapping`
    // );
    [start, end] = [end, start];
  }

  // Format YYYY-MM-DD
  const fmt = d => d.toISOString().slice(0, 10);
  const result = { start: fmt(start), end: fmt(end) };

  // console.log(
  //   '[getDateRange]',
  //   'raw inputs →',
  //   `start_date=${query.start_date}`, `end_date=${query.end_date}`,
  //   '→ formatted →', result
  // );

  return result;
}

// 2) Fetch company_name by user ID (with commented logs)
async function fetchCompanyNameById(userId) {
  // console.log('[fetchCompanyNameById] userId=', userId);
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
  // console.log('[fetchCompanyNameById] company=', rows[0].company_name);
  return rows[0].company_name;
}

// 3) Generic counter across three tables (with commented logs)
async function countReviews(company, start, end, cond) {
  // console.log(
  //   '[countReviews]',
  //   'company=', company,
  //   'start=', start,
  //   'end=', end,
  //   'cond=', cond
  // );

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
       AND ${cond.sql}
  `;
  const gmSql = `
    SELECT COUNT(*)::int AS c
      FROM google_maps_reviews
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
       AND ${cond.sql}
  `;
  const rdSql = `
    SELECT COUNT(*)::int AS c
      FROM reddit_posts
     WHERE company_name = $1
       AND review_date BETWEEN $2 AND $3
       AND ${cond.sql}
  `;
 
  const params = [company, start, end, ...cond.params];
  // console.log(
  //   '[countReviews]',
  //   'tpSql=', tpSql.trim(),
  //   'ffSql=', ffSql.trim(),
  //   'gmSql=', gmSql.trim(),
  //   'params=', params
  // );

  const [tpRes, ffRes, gmRes, rdRes] = await Promise.all([
    pool.query(tpSql, params),
    pool.query(ffSql, params),
    pool.query(gmSql, params),
    pool.query(rdSql, params),
  ]);

  // console.log(
  //   '[countReviews] counts →',
  //   'TP:', tpRes.rows[0].c,
  //   'FF:', ffRes.rows[0].c,
  //   'GM:', gmRes.rows[0].c
  // );
  return tpRes.rows[0].c + ffRes.rows[0].c + gmRes.rows[0].c + rdRes.rows[0].c;
}

// 4) Build each “count” endpoint
const endpoints = {
  positive:           { sql: 'rating > $4', params: [3] },
  neutral:            { sql: 'rating = $4', params: [3] },
  negative:           { sql: 'rating < $4', params: [3] },
  highlyPositive:     { sql: 'rating > $4', params: [4] },
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

// 5) Combined “reviews” endpoint (with commented logs)
exports.reviews = async (req, res, next) => {
  try {
    // console.log('[reviews] req.user.id=', req.user.id, 'query=', req.query);

    const userId = req.user.id;
    const company = await fetchCompanyNameById(userId);
    // console.log('[reviews] company=', company);

    const hasDateFilter = !!(req.query.start_date || req.query.end_date);
    let dateClause = '';
    const params = [company];

    if (hasDateFilter) {
      const { start, end } = getDateRange(req.query);
      // console.log('[reviews] date filter applied: start=', start, 'end=', end);
      dateClause = 'AND review_date BETWEEN $2 AND $3';
      params.push(start, end);
    } else {
      // console.log('[reviews] no date filter, fetching all reviews');
    }

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
       ${dateClause}
    `;

    // Feefo
    const ffQ = `
      SELECT
        rating,
        service_review                                 AS title,
        COALESCE(NULLIF(product_review, ''), service_review) AS body,
        customer_name                                  AS author,
        review_date                                    AS created_at
      FROM feefo_reviews
     WHERE company_name = $1
       ${dateClause}
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
       ${dateClause}
    `;

    // Reddit posts
    const rdQ = `
      SELECT
        rating,
        title    AS title,
        COALESCE(NULLIF(full_review, ''), full_review) AS body,
        author   AS author,
        review_date   AS created_at
      FROM reddit_posts
     WHERE company_name = $1
       ${dateClause}
    `;




    // console.log('[reviews] SQL queries built, params=', params);
    const [tpRes, ffRes, gmRes, rdRes] = await Promise.all([
      pool.query(tpQ, params),
      pool.query(ffQ, params),
      pool.query(gmQ, params),
      pool.query(rdQ, params),
    ]);

    // console.log(
    //   '[reviews] raw row counts →',
    //   'Trustpilot:', tpRes.rows.length,
    //   'Feefo:',      ffRes.rows.length,
    //   'GoogleMaps:', gmRes.rows.length
    // );

    // Tag source
    const tag = (rows, source) => rows.map(r => ({ ...r, source }));
    const all = [
      ...tag(tpRes.rows, 'Trustpilot'),
      ...tag(ffRes.rows, 'Feefo'),
      ...tag(gmRes.rows, 'Google Maps'),
      ...tag(rdRes.rows, 'Reddit'),
    ];
    // console.log('[reviews] combined rows before sort:', all.length);

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
      const diffDays = Math.floor((now - new Date(r.created_at)) / 86400000);
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

    // console.log('[reviews] final results count:', results.length);
    res.json(results);

  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};


const reviewStatsSql = `
WITH company AS (
  SELECT company_name
  FROM users
  WHERE id = $1
  LIMIT 1
),
reviews_today AS (
  /* Google Maps – includes possible owner response */
  SELECT
    rating,
    (owner_response IS NOT NULL) AS responded
  FROM google_maps_reviews
  WHERE company_name = (SELECT company_name FROM company)
    AND review_date = CURRENT_DATE

  UNION ALL
  /* Trustpilot – placeholder responded = FALSE until you store replies */
  SELECT
    rating,
    FALSE AS responded
  FROM trustpilot_reviews
  WHERE company_name = (SELECT company_name FROM company)
    AND review_date = CURRENT_DATE

  UNION ALL
  /* Feefo */
  SELECT
    rating,
    FALSE AS responded
  FROM feefo_reviews
  WHERE company_name = (SELECT company_name FROM company)
    AND review_date = CURRENT_DATE

  UNION ALL
  /* Reddit posts (rated by your model) */
  SELECT
    rating,
    FALSE AS responded
  FROM reddit_posts
  WHERE company_name = (SELECT company_name FROM company)
    AND review_date = CURRENT_DATE
)
SELECT
  COUNT(*)                           AS new_reviews,
  COALESCE(ROUND(AVG(rating), 2), 0) AS average_rating,
  CASE
    WHEN COUNT(*) = 0
      THEN 0
    ELSE ROUND(
      SUM(CASE WHEN responded THEN 1 ELSE 0 END)::numeric
      / COUNT(*)::numeric * 100, 2
    )
  END                                AS response_rate
FROM reviews_today;
`;


/**
 *  Review KPIs for “today” (new reviews, avg rating, response rate)
 *  Route:  GET /reviews/stats/today
 */
exports.reviewStatsToday = async (req, res, next) => {
  try {
    const userId  = req.user.id;
    const { rows } = await pool.query(reviewStatsSql, [userId]);

    // rows[0] = { new_reviews, average_rating, response_rate }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};
