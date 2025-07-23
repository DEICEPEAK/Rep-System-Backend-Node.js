// controllers/socialMediaAnalyticsController.js

const pool = require('../db/pool');

// 1) Date‐range helper with validation and swap
function getDateRange(query, defaultToSevenDays = true) {
  ['start_date', 'end_date'].forEach(key => {
    if (query[key] && isNaN(Date.parse(query[key]))) {
      const err = new Error(`Invalid ${key}: ${query[key]}`);
      err.status = 400;
      throw err;
    }
  });

  let end = query.end_date
    ? new Date(query.end_date)
    : defaultToSevenDays
      ? new Date()
      : null;
  let start = query.start_date
    ? new Date(query.start_date)
    : defaultToSevenDays
      ? new Date((end || new Date()).getTime() - 7 * 24 * 60 * 60 * 1000)
      : null;

  if (!start && !end) {
    return { start: null, end: null, _startDate: null, _endDate: null };
  }
  if (!start) start = new Date(end);
  if (!end)   end   = new Date(start);

  if (start > end) {
    [start, end] = [end, start];
  }

  const fmt = d => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end), _startDate: start, _endDate: end };
}

// 2) Company lookup by user ID
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

// Shared CTE for any metric
async function loadMetrics(req) {
  const userId  = req.user.id;
  const company = await fetchCompanyNameById(userId);
  const { start, end, _startDate, _endDate } = getDateRange(req.query, true);

  const msPerDay = 24 * 60 * 60 * 1000;
  let periodMs   = _endDate.getTime() - _startDate.getTime();
  if (periodMs < msPerDay) periodMs = msPerDay;

  const prevEnd   = new Date(_startDate.getTime() - msPerDay);
  const prevStart = new Date(prevEnd.getTime() - periodMs);
  const fmt       = d => d.toISOString().slice(0, 10);

  const sql = `
    WITH current_period AS (
      SELECT rating
        FROM twitter_mentions
       WHERE company_name = $1
         AND created_at::date BETWEEN $2 AND $3
      UNION ALL
      SELECT rating
        FROM instagram_mentions
       WHERE company_name = $1
         AND created_at::date BETWEEN $2 AND $3
      UNION ALL
      SELECT rating
        FROM facebook_posts
       WHERE company_name = $1
         AND created_at::date BETWEEN $2 AND $3
      UNION ALL
      SELECT rating
        FROM linkedin_posts
       WHERE company_name = $1
         AND posted_at_iso::date BETWEEN $2 AND $3
    ),
    previous_period AS (
      SELECT rating
        FROM twitter_mentions
       WHERE company_name = $1
         AND created_at::date BETWEEN $4 AND $5
      UNION ALL
      SELECT rating
        FROM instagram_mentions
       WHERE company_name = $1
         AND created_at::date BETWEEN $4 AND $5
      UNION ALL
      SELECT rating
        FROM facebook_posts
       WHERE company_name = $1
         AND created_at::date BETWEEN $4 AND $5
      UNION ALL
      SELECT rating
        FROM linkedin_posts
       WHERE company_name = $1
         AND posted_at_iso::date BETWEEN $4 AND $5
    )
    SELECT
      (SELECT COUNT(*) FROM current_period) AS current_total,
      (SELECT COUNT(*) FROM previous_period) AS previous_total,
      COUNT(*) FILTER (WHERE rating = 3)             AS neutral_count,
      COUNT(*) FILTER (WHERE rating = 5)     AS highly_positive_count,
      COUNT(*) FILTER (WHERE rating = 4) AS moderately_positive_count,
      COUNT(*) FILTER (WHERE rating = 2)   AS slightly_negative_count,
      COUNT(*) FILTER (WHERE rating = 1)     AS highly_negative_count
    FROM current_period
  `;

  const { rows } = await pool.query(sql, [
    company,
    start, end,
    fmt(prevStart), fmt(prevEnd)
  ]);
  const r = rows[0];

  // % change helper for total
  let pctChange;
  if (r.previous_total === 0) {
    pctChange = r.current_total === 0 ? 0 : 100;
  } else {
    pctChange = ((r.current_total - r.previous_total) / r.previous_total) * 100;
  }
  pctChange = Math.round(pctChange * 100) / 100;

  // % of total helper
  const pctOfTotal = (cnt, total) =>
    total === 0 ? 0 : Math.round((cnt / total) * 10000) / 100;

  return { r, pctChange, pctOfTotal };
}


/**
 * 1) Total mentions & % change
 */
exports.totalMentions = async (req, res, next) => {
  try {
    const { r, pctChange } = await loadMetrics(req);
    res.json({
      current_count:       r.current_total,
      //previous:      r.previous_total,
      percent_change: pctChange
    });
  } catch (err) {
    if (err.status === 404 || err.status === 400) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * 2) Neutral count & %
 */
exports.neutralMetrics = async (req, res, next) => {
  try {
    const { r, pctOfTotal } = await loadMetrics(req);
    res.json({
      count:      r.neutral_count,
      percentage: pctOfTotal(r.neutral_count, r.current_total)
    });
  } catch (err) {
    if (err.status === 404 || err.status === 400) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * 3) Highly positive count & %
 */
exports.highlyPositiveMetrics = async (req, res, next) => {
  try {
    const { r, pctOfTotal } = await loadMetrics(req);
    res.json({
      count:      r.highly_positive_count,
      percentage: pctOfTotal(r.highly_positive_count, r.current_total)
    });
  } catch (err) {
    if (err.status === 404 || err.status === 400) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * 4) Moderately positive count & %
 */
exports.moderatelyPositiveMetrics = async (req, res, next) => {
  try {
    const { r, pctOfTotal } = await loadMetrics(req);
    res.json({
      count:      r.moderately_positive_count,
      percentage: pctOfTotal(r.moderately_positive_count, r.current_total)
    });
  } catch (err) {
    if (err.status === 404 || err.status === 400) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * 5) Slightly negative count & %
 */
exports.slightlyNegativeMetrics = async (req, res, next) => {
  try {
    const { r, pctOfTotal } = await loadMetrics(req);
    res.json({
      count:      r.slightly_negative_count,
      percentage: pctOfTotal(r.slightly_negative_count, r.current_total)
    });
  } catch (err) {
    if (err.status === 404 || err.status === 400) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * 6) Highly negative count & %
 */
exports.highlyNegativeMetrics = async (req, res, next) => {
  try {
    const { r, pctOfTotal } = await loadMetrics(req);
    res.json({
      count:      r.highly_negative_count,
      percentage: pctOfTotal(r.highly_negative_count, r.current_total)
    });
  } catch (err) {
    if (err.status === 404 || err.status === 400) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
};


/**
 * Mentions listing endpoint.
 * If start_date/end_date provided, applies BETWEEN filter; otherwise returns all.
 */
exports.mentions = async (req, res, next) => {
  try {
    const userId  = req.user.id;
    const company = await fetchCompanyNameById(userId);

    // Determine if date filtering is requested
    const hasDateFilter = !!(req.query.start_date || req.query.end_date);
    const params = [company];

    // Build separate date filters for created_at vs. posted_at_iso
    let twitterDateClause  = '';
    let linkedinDateClause = '';
    if (hasDateFilter) {
      const { start, end } = getDateRange(req.query, false);
      twitterDateClause  = 'AND created_at::date    BETWEEN $2 AND $3';
      linkedinDateClause = 'AND posted_at_iso::date BETWEEN $2 AND $3';
      params.push(start, end);
    }

    const sql = `
      SELECT
        author_handle,
        created_at,
        tweet,
        like_count,
        reply_count,
        rating,
        CASE
          WHEN rating = 5 THEN 'Highly Positive'
          WHEN rating = 4 THEN 'Moderately Positive'
          WHEN rating = 3 THEN 'Neutral'
          WHEN rating = 2 THEN 'Slightly Negative'
          WHEN rating = 1 THEN 'Highly Negative'
          ELSE 'Unknown'
        END AS sentiment_class,
        source
      FROM (
        SELECT
          author_name,
          created_at,
          text             AS tweet,
          like_count,
          reply_count,
          rating,
          'Twitter'        AS source
        FROM twitter_mentions
        WHERE company_name = $1
          ${twitterDateClause}

        UNION ALL

        SELECT
          author_handle    AS author_name,
          created_at,
          caption          AS tweet,
          like_count,
          comment_count    AS reply_count,
          rating,
          'Instagram'      AS source
        FROM instagram_mentions
        WHERE company_name = $1
          ${twitterDateClause}

        UNION ALL

        SELECT
          author_name,
          created_at,
          message          AS tweet,
          reactions_count  AS like_count,
          comments_count   AS reply_count,
          rating,
          'Facebook'       AS source
        FROM facebook_posts
        WHERE company_name = $1
          ${twitterDateClause}

        UNION ALL

        SELECT
          author_name,
          posted_at_iso    AS created_at,
          text             AS tweet,
          total_reactions  AS like_count,
          comments_count   AS reply_count,
          rating,
          'LinkedIn'       AS source
        FROM linkedin_posts
        WHERE company_name = $1
          ${linkedinDateClause}
      ) AS combined
      ORDER BY created_at DESC
    `;

    const { rows } = await pool.query(sql, params);
    res.json(rows);

  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
};

