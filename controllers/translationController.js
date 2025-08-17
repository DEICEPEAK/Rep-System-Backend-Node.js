// controllers/translationController.js
const { translateOnceOrLock } = require('../services/translationService');
const pool = require('../db/pool');

async function getCompanyNameForUser(userId) {
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



module.exports.translate = async (req, res, next) => {
  try {
    const userId  = req.user.id;
    const company = await getCompanyNameForUser(userId); // or your existing helper
    const requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random()}`;

    // Lazy inject your Gemini client implementation
    const geminiClient = req.app.get('geminiClient');

    const result = await translateOnceOrLock({
      userId,
      company,
      body: req.body,
      geminiClient,
      requestId
    });

    res.json({
      translated_text: result.translated_text,
      detected_lang: result.detected_lang,
      target_lang: result.target_lang,
      window_expires_at: result.window_expires_at,
      cached: result.cached,
      source_ref: result.source_ref
    });
  } catch (err) {
    if (err.status) {
      const payload = { error: err.message };
      if (err.code) payload.code = err.code;
      if (err.retry_after_seconds) payload.retry_after_seconds = err.retry_after_seconds;
      if (err.expires_at) payload.expires_at = err.expires_at;
      return res.status(err.status).json(payload);
    }
    next(err);
  }
};
