// controllers/keywordController.js
const pool = require('../db/pool');

async function getCachedKeywords(req, res, sourceType) {
  try {
    const userId = req.user.id;
    
    const { rows } = await pool.query(
      `SELECT keywords, processed_at 
       FROM keyword_cache 
       WHERE user_id = $1 AND source_type = $2 
       AND expires_at > NOW()
       ORDER BY processed_at DESC 
       LIMIT 1`,
      [userId, sourceType]
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        error: 'Keywords not available yet', 
        message: 'Keywords are processed daily. Please check back later.',
        source: 'cache_miss'
      });
    }

    res.json({
      keywords: rows[0].keywords,
      source: 'cache',
      processed_at: rows[0].processed_at,
      expires_in: '24_hours'
    });
    
  } catch (error) {
    console.error('Keyword cache error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch keywords',
      message: 'Please try again later.' 
    });
  }
}

// Simple handlers
async function getSocialKeywords(req, res) {
  return getCachedKeywords(req, res, 'social');
}

async function getReviewKeywords(req, res) {
  return getCachedKeywords(req, res, 'review');
}

async function getGeneralKeywords(req, res) {
  return getCachedKeywords(req, res, 'general');
}

module.exports = {
  getSocialKeywords,
  getReviewKeywords,
  getGeneralKeywords
};