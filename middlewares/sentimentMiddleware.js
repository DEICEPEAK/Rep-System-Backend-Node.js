// File: middlewares/sentimentMiddleware.js

const axios = require('axios');
const cron = require('node-cron');
const pool = require('../db/pool');

const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;
const MODEL_URL = 'https://api-inference.huggingface.co/models/nlptown/bert-base-multilingual-uncased-sentiment';

// Sentiment helper (unchanged)
async function getSentimentRating(text) {
  if (!text || !text.trim()) return null;
  try {
    const { data } = await axios.post(
      MODEL_URL,
      { inputs: text },
      { headers: { Authorization: `Bearer ${HUGGINGFACE_API_KEY}` } }
    );
    if (Array.isArray(data[0])) {
      const best = data[0].sort((a,b) => b.score - a.score)[0].label;
      return parseInt(best.split(' ')[0], 10);
    }
  } catch (e) {
    //console.error('HuggingFace error:', e.message);
  }
  return null;
}

async function processSentimentForPosts() {
  // define each table, its PK, and which fields to use
  const sources = [
    { table: 'instagram_mentions', pk: 'post_id', texts: ['caption'] },
    { table: 'twitter_mentions',   pk: 'tweet_id', texts: ['text'] },
    { table: 'trustpilot_reviews', pk: 'id',       texts: ['review_title','review_body'] },
    { table: 'feefo_reviews',      pk: 'id',       texts: ['service_review','product_review'] },
    { table: 'google_maps_reviews',pk: 'id',       texts: ['review_text'] },
    { table: 'reddit_posts',       pk: 'id',       texts: ['title','full_review'] },
    { table: 'facebook_posts',     pk: 'post_id',       texts: ['message'] },
    { table: 'linkedin_posts',     pk: 'id',       texts: ['text'] }
  ];

  for (const src of sources) {
    const { table, pk, texts } = src;

    // build SELECT: pk plus each text field
    const cols = [pk, ...texts].map(c => `"${c}"`).join(', ');
    const rows = (await pool.query(
      `SELECT ${cols} FROM ${table} WHERE rating IS NULL`
    )).rows;

    for (const row of rows) {
      // gather non‐empty text fields
      const parts = texts
        .map(f => row[f])
        .filter(s => typeof s === 'string' && s.trim());
      if (parts.length === 0) {
        // console.log(`Skipping ${table} ${row[pk]} — no text to classify.`);
        continue;
      }

      const text = parts.join(' ');
      const rating = await getSentimentRating(text);
      if (rating == null) {
        // console.log(`No rating from model for ${table} ${row[pk]}.`);
        continue;
      }

      // update that table
      await pool.query(
        `UPDATE ${table} SET rating = $1 WHERE ${pk} = $2`,
        [rating, row[pk]]
      );
      console.log(`Updated ${table} ${row[pk]} → rating ${rating}`);
    }
  }
}

// run every minute
cron.schedule('*/5 * * * *', () => {
  console.log('Running sentiment classification...');
  processSentimentForPosts().catch(console.error);
});

module.exports = processSentimentForPosts;
