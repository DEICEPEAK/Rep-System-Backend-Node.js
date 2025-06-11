// controllers/analyticsController.js
const pool = require('../db/pool');

// Helper to pull date range from query or default to past 7 days
function getDateRange(query) {
  const endDate = query.end_date
    ? new Date(query.end_date)
    : new Date();
  const startDate = query.start_date
    ? new Date(query.start_date)
    : new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

  // format as YYYY-MM-DD for Postgres DATE comparison
  const format = d => d.toISOString().slice(0, 10);
  return {
    start: format(startDate),
    end:   format(endDate),
  };
}

// Helper to lookup company_name by user email
async function fetchCompanyName(email) {
  const { rows } = await pool.query(
    `SELECT company_name
       FROM users
      WHERE email = $1
      LIMIT 1`,
    [email]
  );
  if (!rows.length) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  return rows[0].company_name;
}

// Generic counter builder
function makeCounter(ratingConditionSql, ratingParams = []) {
  return async (req, res, next) => {
    try {
      const { email } = req.query;
      if (!email) return res.status(400).json({ error: 'Email is required.' });

      const company = await fetchCompanyName(email);
      const { start, end } = getDateRange(req.query);

      const sql = `
        SELECT COUNT(*)::int AS count
          FROM trustpilot_reviews
         WHERE company_name = $1
           AND review_date BETWEEN $2 AND $3
           AND ${ratingConditionSql}
      `;
      const params = [company, start, end, ...ratingParams];
      const { rows } = await pool.query(sql, params);
      res.json({ count: rows[0].count });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: err.message });
      next(err);
    }
  };
}

// 1. positive: rating > 3
exports.positiveReviews = makeCounter(`rating > $4`, [3]);

// 2. neutral: rating = 3
exports.neutralReviews = makeCounter(`rating = $4`, [3]);

// 3. negative: rating < 3
exports.negativeReviews = makeCounter(`rating < $4`, [3]);

// 4. highly positive: rating > 4
exports.highlyPositiveReviews = makeCounter(`rating > $4`, [4]);

// 5. moderately positive: rating = 4
exports.moderatelyPositiveReviews = makeCounter(`rating = $4`, [4]);

// 6. slightly negative: rating = 2
exports.slightlyNegativeReviews = makeCounter(`rating = $4`, [2]);

// 7. highly negative: rating < 2
exports.highlyNegativeReviews = makeCounter(`rating < $4`, [2]);

// 8. combined reviews endpoint
exports.reviews = async (req, res, next) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const company = await fetchCompanyName(email);

    // Fetch Trustpilot reviews
    const tpSql = `
      SELECT
        rating,
        review_title  AS title,
        review_body   AS body,
        author_name,
        review_date   AS created_at
      FROM trustpilot_reviews
     WHERE company_name = $1
    `;
    // Fetch Twitter mentions
    const twSql = `
      SELECT
        NULL::int    AS rating,
        text         AS title,
        text         AS body,
        NULL::text   AS author_name,
        created_at
      FROM twitter_mentions
     WHERE company_name = $1
    `;

    const [tpRes, twRes] = await Promise.all([
      pool.query(tpSql, [company]),
      pool.query(twSql, [company]),
    ]);

    // Tag source
    const tpRows = tpRes.rows.map(r => ({ ...r, source: 'Trustpilot' }));
    const twRows = twRes.rows.map(r => ({ ...r, source: 'Twitter' }));

    // Merge & sort by freshness
    const all = [...tpRows, ...twRows].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );

    // Compute sentiment & human-friendly "when posted"
    const now = Date.now();
    const results = all.map(r => {
      const diffDays = Math.floor((now - new Date(r.created_at)) / (1000 * 60 * 60 * 24));
      const whenPosted =
        diffDays === 0 ? 'today'
      : diffDays === 1 ? '1 day ago'
      : `${diffDays} days ago`;

      let sentiment = null;
      if (r.rating != null) {
        sentiment =
          r.rating >  3 ? 'positive'
        : r.rating === 3 ? 'neutral'
        :                  'negative';
      }

      return {
        rating:      r.rating,
        reviewTitle: r.title,
        reviewBody:  r.body,
        authorName:  r.author_name,
        source:      r.source,
        sentiment,
        whenPosted,
      };
    });

    res.json(results);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};
// 9. reviews count by rating
exports.reviewsCountByRating = async (req, res, next) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const company = await fetchCompanyName(email);
    const { start, end } = getDateRange(req.query);

    const sql = `
      SELECT rating, COUNT(*)::int AS count
        FROM trustpilot_reviews
       WHERE company_name = $1
         AND review_date BETWEEN $2 AND $3
       GROUP BY rating
       ORDER BY rating
    `;
    const params = [company, start, end];
    const { rows } = await pool.query(sql, params);
    
    // Fill in missing ratings with 0 counts
    const ratings = [1, 2, 3, 4, 5];
    const counts = ratings.reduce((acc, rating) => {
      acc[rating] = 0;
      return acc;
    }, {});
    
    rows.forEach(row => {
      counts[row.rating] = row.count;
    });

    res.json(counts);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};