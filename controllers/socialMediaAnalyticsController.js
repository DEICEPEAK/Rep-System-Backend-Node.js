// controllers/socialMediaAnalyticsController.js

const pool = require('../db/pool');

// Helper to pull date range from query or default to past 7 days
function getDateRange(query) {
  const endDate = query.end_date
    ? new Date(query.end_date)
    : new Date();
  const startDate = query.start_date
    ? new Date(query.start_date)
    : new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

  const fmt = d => d.toISOString().slice(0, 10);
  return {
    start:      fmt(startDate),
    end:        fmt(endDate),
    _startDate: startDate,
    _endDate:   endDate,
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


/**
 * Combined “metrics” endpoint covering:
 *  - total mentions (current period)
 *  - total mentions % change vs previous period
 *  - for each sentiment bucket (Neutral, Highly positive,
 *    Moderately positive, Slightly negative, Highly negative):
 *      • count in current period
 *      • percentage of total mentions in current period
 */
exports.mentionMetrics = async (req, res, next) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const company   = await fetchCompanyName(email);
    const { start, end, _startDate, _endDate } = getDateRange(req.query);

    // compute previous period of same length
    const msPerDay  = 24 * 60 * 60 * 1000;
    let periodMs    = _endDate.getTime() - _startDate.getTime();
    if (periodMs < msPerDay) periodMs = msPerDay;

    const prevEnd     = new Date(_startDate.getTime() - msPerDay);
    const prevStart   = new Date(prevEnd.getTime() - periodMs);
    const fmt         = d => d.toISOString().slice(0, 10);
    const prevStartStr = fmt(prevStart);
    const prevEndStr   = fmt(prevEnd);

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
      prevStartStr, prevEndStr
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
        current:      r.current_total,
        previous:     r.previous_total,
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
    next(err);
  }
};


/**
 * Mentions listing endpoint
 */
exports.mentions = async (req, res, next) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const company = await fetchCompanyName(email);

    // union Twitter & Instagram into a unified shape
    const sql = `
      SELECT
        author_name,
        created_at,
        text     AS tweet,
        like_count,
        reply_count,
        'Twitter' AS source
      FROM twitter_mentions
     WHERE company_name = $1

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

     ORDER BY created_at DESC
    `;

    const { rows } = await pool.query(sql, [company]);
    res.json(rows);

  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};
