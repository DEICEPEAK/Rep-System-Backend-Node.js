// controllers/socialMediaAnalyticsController.js

const pool = require('../db/pool');

// 1) Date‐range helper with validation and swap
function getDateRange(query, defaultToSevenDays = true) {
  // Validate date inputs
  ['start_date', 'end_date'].forEach(key => {
    if (query[key] && isNaN(Date.parse(query[key]))) {
      const err = new Error(`Invalid ${key}: ${query[key]}`);
      err.status = 400;
      throw err;
    }
  });

  // Build Date objects (defaulting to 7 days back if desired)
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

  // If neither date is provided and defaultToSevenDays is false, return nulls
  if (!start && !end) {
    return { start: null, end: null, _startDate: null, _endDate: null };
  }

  // If only one bound is provided and we aren't defaulting, set the other to the same day
  if (!start) start = new Date(end);
  if (!end)   end   = new Date(start);

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
  return {
    start:      fmt(start),
    end:        fmt(end),
    _startDate: start,
    _endDate:   end,
  };
}

// 2) Fetch company_name by user ID
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


/**
 * Combined “metrics” endpoint covering total mentions & sentiment buckets.
 * Defaults to past 7 days if no dates provided.
 */
exports.mentionMetrics = async (req, res, next) => {
  try {
    const userId  = req.user.id;
    const company = await fetchCompanyNameById(userId);

    // getDateRange: default to 7 days
    const { start, end, _startDate, _endDate } = getDateRange(req.query, true);

    // compute previous period of same length (at least 1 day)
    const msPerDay = 24 * 60 * 60 * 1000;
    let periodMs   = _endDate.getTime() - _startDate.getTime();
    if (periodMs < msPerDay) periodMs = msPerDay;

    const prevEnd   = new Date(_startDate.getTime() - msPerDay);
    const prevStart = new Date(prevEnd.getTime() - periodMs);
    const fmt       = d => d.toISOString().slice(0, 10);

    // single SQL to union both tables for current & previous, then aggregate
    const metricsSql = `
      WITH current_period AS (
        SELECT sentiment
          FROM twitter_mentions
         WHERE company_name = $1
           AND created_at::date BETWEEN $2 AND $3
        UNION ALL
        SELECT sentiment
          FROM instagram_mentions
         WHERE company_name = $1
           AND created_at::date BETWEEN $2 AND $3
      ),
      previous_period AS (
        SELECT sentiment
          FROM twitter_mentions
         WHERE company_name = $1
           AND created_at::date BETWEEN $4 AND $5
        UNION ALL
        SELECT sentiment
          FROM instagram_mentions
         WHERE company_name = $1
           AND created_at::date BETWEEN $4 AND $5
      )
      SELECT
        (SELECT COUNT(*) FROM current_period) AS current_total,
        (SELECT COUNT(*) FROM previous_period) AS previous_total,
        COUNT(*) FILTER (WHERE sentiment = 'Neutral')            AS neutral_count,
        COUNT(*) FILTER (WHERE sentiment = 'Highly positive')    AS highly_positive_count,
        COUNT(*) FILTER (WHERE sentiment = 'Moderately positive')AS moderately_positive_count,
        COUNT(*) FILTER (WHERE sentiment = 'Slightly negative')  AS slightly_negative_count,
        COUNT(*) FILTER (WHERE sentiment = 'Highly negative')    AS highly_negative_count
      FROM current_period
    `;

    const { rows } = await pool.query(metricsSql, [
      company,
      start, end,
      fmt(prevStart), fmt(prevEnd)
    ]);
    const r = rows[0];

    // calculate % change for total mentions
    let pctChange;
    if (r.previous_total === 0) {
      pctChange = r.current_total === 0 ? 0 : 100;
    } else {
      pctChange = ((r.current_total - r.previous_total) / r.previous_total) * 100;
    }
    pctChange = Math.round(pctChange * 100) / 100;

    // helper to get sentiment % of current total
    const pctOfTotal = (cnt, total) =>
      total === 0 ? 0 : Math.round((cnt / total) * 10000) / 100;

    res.json({
      total: {
        current:       r.current_total,
        previous:      r.previous_total,
        percent_change: pctChange
      },
      neutral: {
        count:      r.neutral_count,
        percentage: pctOfTotal(r.neutral_count, r.current_total)
      },
      highlyPositive: {
        count:      r.highly_positive_count,
        percentage: pctOfTotal(r.highly_positive_count, r.current_total)
      },
      moderatelyPositive: {
        count:      r.moderately_positive_count,
        percentage: pctOfTotal(r.moderately_positive_count, r.current_total)
      },
      slightlyNegative: {
        count:      r.slightly_negative_count,
        percentage: pctOfTotal(r.slightly_negative_count, r.current_total)
      },
      highlyNegative: {
        count:      r.highly_negative_count,
        percentage: pctOfTotal(r.highly_negative_count, r.current_total)
      }
    });

  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.status === 400) return res.status(400).json({ error: err.message });
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
    let dateClause = '';
    const params = [company];

    if (hasDateFilter) {
      const { start, end } = getDateRange(req.query, false);
      dateClause = 'AND created_at::date BETWEEN $2 AND $3';
      params.push(start, end);
    }

    // Combine Twitter & Instagram
    const sql = `
      SELECT
        author_name,
        created_at,
        text        AS tweet,
        like_count,
        reply_count,
        'Twitter'   AS source
      FROM twitter_mentions
     WHERE company_name = $1
       ${dateClause}

      UNION ALL

      SELECT
        author_handle AS author_name,
        created_at,
        caption       AS tweet,
        like_count,
        comment_count AS reply_count,
        'Instagram'   AS source
      FROM instagram_mentions
     WHERE company_name = $1
       ${dateClause}

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
