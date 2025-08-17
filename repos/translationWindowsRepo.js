// repos/translationWindowsRepo.js
const pool = require('../db/pool');

exports.findActive = async (userId, key) => {
  const { rows } = await pool.query(
    `SELECT * FROM translation_windows
     WHERE user_id=$1 AND source_table=$2 AND source_id=$3 AND source_field=$4
       AND expires_at > now()
     LIMIT 1`,
    [userId, key.sourceTable, key.sourceId, key.sourceField]
  );
  return rows[0] || null;
};

exports.countActive = async (userId) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM translation_windows
      WHERE user_id=$1 AND expires_at > now()`,
    [userId]
  );
  return rows[0].c;
};

exports.earliestExpiry = async (userId) => {
  const { rows } = await pool.query(
    `SELECT MIN(expires_at) AS at
       FROM translation_windows
      WHERE user_id=$1 AND expires_at > now()`,
    [userId]
  );
  return rows[0].at;
};

// repos/translationWindowsRepo.js
exports.insertIfActiveUnique = async (client, row) => {
  try {
    const { rows } = await client.query(
      `INSERT INTO translation_windows
         (id, user_id, company_name, source_table, source_id, source_field,
          content_hash, target_lang, detected_lang, translated_text, provider,
          tokens_in, tokens_out, latency_ms, created_at, expires_at)
       VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5,
          $6, $7, $8, $9, COALESCE($10, 'gemini-1.5-flash'),
          $11, $12, $13, now(), $14
       )
       RETURNING *`,
      [
        row.user_id,
        row.company_name,
        row.source_table,
        row.source_id,
        row.source_field,
        row.content_hash,
        row.target_lang,
        row.detected_lang,
        row.translated_text,
        row.provider || null,
        row.tokens_in || null,
        row.tokens_out || null,
        row.latency_ms || null,
        row.expires_at
      ]
    );
    return rows[0]; // success
  } catch (e) {
    // 23P01 = exclusion constraint violation (our no_overlap_per_review)
    if (e.code === '23P01') return null; // treat as "someone else inserted an active window"
    throw e;
  }
};
