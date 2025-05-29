const pool = require('../db/pool');

/**
 * Return daily negative sentiment rate
 */
exports.getSentimentTrend = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const { rows } = await pool.query(
      `SELECT
         date_trunc('day', ts)::date AS day,
         AVG(CASE WHEN label='NEGATIVE' THEN 1 ELSE 0 END)::float AS neg_rate,
         COUNT(*) AS total_mentions
       FROM sentiment
       WHERE ts BETWEEN $1 AND $2
       GROUP BY day
       ORDER BY day`,
      [from, to]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

/**
 * Return total mentions per channel and negative rate by channel
 */
exports.getChannelBreakdown = async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const { rows } = await pool.query(
      `SELECT
         channel,
         COUNT(*) AS mentions,
         AVG(CASE WHEN label='NEGATIVE' THEN 1 ELSE 0 END)::float AS neg_rate
       FROM sentiment
       JOIN mentions USING (mention_id)
       WHERE ts BETWEEN $1 AND $2
       GROUP BY channel
       ORDER BY mentions DESC`,
      [from, to]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};
