// services/sourceResolver.js
const pool = require('../db/pool');

exports.fetchText = async (company, src) => {
  const { table, id, field } = src || {};
  if (!table || !id || !field) {
    const err = new Error('Missing source.table/id/field');
    err.status = 400;
    throw err;
  }
  // NOTE: whitelist tables/fields to avoid SQL injection
  const ALLOWED = {
    trustpilot_reviews: ['review_title','review_body'],
    feefo_reviews: ['service_review','product_review'],
    google_maps_reviews: ['review_text'],
    reddit_posts: ['title','full_review'],
  };
  if (!ALLOWED[table] || !ALLOWED[table].includes(field)) {
    const err = new Error('Unsupported table/field');
    err.status = 400;
    throw err;
  }

  const sql = `SELECT "${field}" AS text
               FROM ${table}
               WHERE company_name = $1 AND id::text = $2
               LIMIT 1`;
  const { rows } = await pool.query(sql, [company, String(id)]);
  if (!rows.length || !rows[0].text) {
    const err = new Error('Source not found');
    err.status = 404;
    throw err;
  }
  return {
    text: String(rows[0].text),
    key: { sourceTable: table, sourceId: String(id), sourceField: field }
  };
};
