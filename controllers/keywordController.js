// controllers/keywordController.js

const { WordTokenizer } = require('natural');
const { lemmatizer }    = require('lemmatizer');   // ← destructure the named export here
const stopword          = require('stopword');
const pool              = require('../db/pool');

// one tokenizer instance
const tokenizer = new WordTokenizer();

// table→fields mapping
const TABLE_CONFIGS = {
  social: [
    { table: 'instagram_mentions', fields: ['caption'] },
    { table: 'facebook_posts',    fields: ['message'] },
    { table: 'twitter_mentions',   fields: ['text'] },
    { table: 'linkedin_posts',     fields: ['text'] },
  ],
  review: [
    { table: 'trustpilot_reviews',   fields: ['review_title','review_body'] },
    { table: 'feefo_reviews',        fields: ['service_review','product_review'] },
    { table: 'google_maps_reviews',   fields: ['review_text'] },
    { table: 'reddit_posts',          fields: ['title','full_review'] },
  ],
};
TABLE_CONFIGS.general = [
  ...TABLE_CONFIGS.social,
  ...TABLE_CONFIGS.review,
];

/**
 * Fetch company_name for the current user
 */
async function fetchCompanyName(userId) {
  const { rows } = await pool.query(
    `SELECT company_name FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  if (!rows.length) throw { status: 404, message: 'User not found' };
  return rows[0].company_name;
}

/**
 * Given an array of arbitrary texts, return top N lemmatized keywords
 */
function getTopKeywords(texts, topN = 5) {
  // 1) join, lowercase, tokenize
  const all    = texts.join(' ').toLowerCase();
  const tokens = tokenizer.tokenize(all);

  // 2) remove stopwords & non-alpha & short words
  const filtered = stopword
    .removeStopwords(tokens)
    .filter(w => /^[a-z]+$/.test(w) && w.length > 2);

  // 3) lemmatize & count
  const freq = {};
  for (const w of filtered) {
    const lemma = lemmatizer(w);
    freq[lemma] = (freq[lemma] || 0) + 1;
  }

  // 4) sort and pick top
  return Object.entries(freq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN)
    .map(([keyword, count]) => ({ keyword, count }));
}

/**
 * Core extraction logic
 */
async function extractKeywords(req, res, sourceType) {
  try {
    const userId = req.user.id;             // set by your auth middleware
    const company = await fetchCompanyName(userId);
    const cfg     = TABLE_CONFIGS[sourceType];

    // collect all texts
    const texts = [];
    await Promise.all(cfg.map(async ({ table, fields }) => {
      const cols = fields.map(f => `"${f}"`).join(', ');
      const { rows } = await pool.query(
        `SELECT ${cols} FROM ${table} WHERE company_name = $1`,
        [company]
      );
      for (const row of rows) {
        for (const f of fields) {
          const v = row[f];
          if (typeof v === 'string' && v.trim()) texts.push(v.trim());
        }
      }
    }));

    const keywords = getTopKeywords(texts);
    res.json({ keywords });
  } catch (err) {
    console.error(err);
    res
      .status(err.status || 500)
      .json({ error: err.message || 'Internal error' });
  }
}

// handlers for each route
async function getSocialKeywords(req, res) {
  return extractKeywords(req, res, 'social');
}
async function getReviewKeywords(req, res) {
  return extractKeywords(req, res, 'review');
}
async function getGeneralKeywords(req, res) {
  return extractKeywords(req, res, 'general');
}

module.exports = {
  getSocialKeywords,
  getReviewKeywords,
  getGeneralKeywords,
};
