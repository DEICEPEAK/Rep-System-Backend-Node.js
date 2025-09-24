// controllers/videoContentController.js
const pool = require('../db/pool');

/** ──────────────────────────────────────────────────────────────
 * Date-range helper: validates, swaps if needed, and defaults to
 * the last 30 days when not provided. Returns { start, end } as
 * 'YYYY-MM-DD' strings, matching your existing pattern.
 * ────────────────────────────────────────────────────────────── */
function getDateRange(query) {
  ['start_date', 'end_date'].forEach(key => {
    if (query[key] && isNaN(Date.parse(query[key]))) {
      const err = new Error(`Invalid ${key}: ${query[key]}`);
      err.status = 400;
      throw err;
    }
  });

  let end = query.end_date ? new Date(query.end_date) : new Date();
  let start = query.start_date
    ? new Date(query.start_date)
    : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (start > end) [start, end] = [end, start];

  const fmt = d => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

/** fetch company name by user id (same behavior as in your sample) */
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

/** simple rating → sentiment mapping (exactly like your reviews controller) */
function classifySentiment(rating) {
  return rating > 3 ? 'positive' : rating === 3 ? 'neutral' : 'negative';
}

/** 
 * GET /video_contents
 * Optional query params: ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * (defaults to last 30 days if omitted)
 */
exports.videoContents = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const company = await fetchCompanyNameById(userId);
    const { start, end } = getDateRange(req.query);

    // NOTE:
    // - twitter & instagram: only rows where videourl IS NOT NULL
    // - tiktok: all rows (schema note says "All")
    // - youtube: build full URL from video_id
    // - unify column names for a single UNION ALL result
    const sql = `
      /* ───────── Twitter (only with videourl) ───────── */
      SELECT
        tm.text                           AS caption,
        tm.author_handle                  AS author,
        tm.rating                         AS rating,
        tm.created_at                     AS post_date,
        tm.videourl                       AS video_url,
        'twitter'                         AS source
      FROM twitter_mentions tm
      WHERE tm.company_name = $1
        AND tm.created_at::date BETWEEN $2 AND $3
        AND tm.videourl IS NOT NULL

      UNION ALL

      /* ───────── Instagram (only with videourl) ───────── */
      SELECT
        im.caption                        AS caption,
        im.author_handle                  AS author,
        im.rating                         AS rating,
        im.created_at                     AS post_date,
        im.videourl                       AS video_url,
        'instagram'                       AS source
      FROM instagram_mentions im
      WHERE im.company_name = $1
        AND im.created_at::date BETWEEN $2 AND $3
        AND im.videourl IS NOT NULL

      UNION ALL

      /* ───────── TikTok (all) ───────── */
      SELECT
        tt.caption                        AS caption,
        tt.author_handle                  AS author,
        tt.rating                         AS rating,
        tt.created_at                     AS post_date,
        tt.post_url                       AS video_url,
        'tiktok'                          AS source
      FROM tiktok_posts tt
      WHERE tt.company_name = $1
        AND tt.created_at::date BETWEEN $2 AND $3

      UNION ALL

      /* ───────── YouTube (all; construct full URL) ───────── */
      SELECT
        yd.title                          AS caption,
        yd.channel_name                   AS author,
        yd.rating                         AS rating,
        yd.published_at                   AS post_date,
        ('https://www.youtube.com/watch?v=' || yd.video_id) AS video_url,
        'youtube'                         AS source
      FROM youtube_data yd
      WHERE yd.company_name = $1
        AND yd.published_at::date BETWEEN $2 AND $3

      ORDER BY post_date DESC
    `;

    const params = [company, start, end];
    const { rows } = await pool.query(sql, params);

    // normalize to the response shape you requested
    const results = rows.map(r => ({
      captions: r.caption,
      author: r.author,
      rating: r.rating,
      sentiment: classifySentiment(r.rating),
      post_date: r.post_date,                 // keep original timestamp/date
      video_urls: r.video_url ? [r.video_url] : [],   // plural, so wrap in array
      source: r.source                        // 'twitter' | 'instagram' | 'tiktok' | 'youtube'
    }));

    return res.json(results);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
};


// ---- 30-day video stats (TikTok + YouTube) ----
const videoStats30dSql = `
WITH company AS (
  SELECT company_name
  FROM users
  WHERE id = $1
  LIMIT 1
),
tiktok AS (
  SELECT
    COALESCE(SUM(play_count), 0)      AS plays,
    COALESCE(SUM(like_count), 0)      AS likes,
    COALESCE(SUM(comment_count), 0)   AS comments,
    COALESCE(SUM(share_count), 0)     AS shares,
    COALESCE(SUM(collect_count), 0)   AS collects,
    COALESCE(SUM(rating::numeric), 0) AS sum_rating,
    COUNT(rating)                      AS cnt_rating
  FROM tiktok_posts
  WHERE company_name = (SELECT company_name FROM company)
    AND created_at::date BETWEEN CURRENT_DATE - INTERVAL '30 days' AND CURRENT_DATE
),
youtube AS (
  SELECT
    COALESCE(SUM(view_count), 0)      AS views,
    COALESCE(SUM(like_count), 0)      AS likes,
    COALESCE(SUM(comments_count), 0)  AS comments,
    COALESCE(SUM(rating::numeric), 0) AS sum_rating,
    COUNT(rating)                      AS cnt_rating
  FROM youtube_data
  WHERE company_name = (SELECT company_name FROM company)
    AND published_at::date BETWEEN CURRENT_DATE - INTERVAL '30 days' AND CURRENT_DATE
)
SELECT
  (t.plays + y.views) AS total_views_30d,
  CASE
    WHEN (t.plays + y.views) = 0 THEN 0
    ELSE ROUND(
      ((t.likes + t.comments + t.shares + t.collects + y.likes + y.comments)::numeric
       / NULLIF((t.plays + y.views), 0)) * 100, 2
    )
  END AS engagement_rate_30d,
  CASE
    WHEN (t.cnt_rating + y.cnt_rating) = 0 THEN 0
    ELSE ROUND(
      (t.sum_rating + y.sum_rating)::numeric / (t.cnt_rating + y.cnt_rating), 2
    )
  END AS average_rating_30d
FROM tiktok t, youtube y;
`;

/**
 * GET /video/stats/30d
 * Response:
 * {
 *   total_views_30d: number,
 *   engagement_rate_30d: number,  // %
 *   average_rating_30d: number
 * }
 */
exports.videoStats= async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { rows } = await pool.query(videoStats30dSql, [userId]);
    const r = rows[0] || {
      total_views_30d: 0,
      engagement_rate_30d: 0,
      average_rating_30d: 0
    };
    res.json(r);
  } catch (err) {
    next(err);
  }
};