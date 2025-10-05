// middlewares/sentimentMiddleware.js
require('dotenv').config();

const axios = require('axios');
const http = require('http');
const https = require('https');
const cron = require('node-cron');
const pool = require('../db/pool');

/* ─────────── Config ─────────── */
const SVC_URL         = process.env.SENTIMENT_SVC_URL || 'http://localhost:8000';
const SVC_API_KEY     = process.env.SENTIMENT_SVC_API_KEY || process.env.HUGGINGFACE_API_KEY || '';
const SVC_TIMEOUT_MS  = Number(process.env.SENTIMENT_TIMEOUT_MS  || 60000);
const SVC_RETRIES     = Number(process.env.SENTIMENT_RETRIES     || 2);
const BATCH_LIMIT     = Number(process.env.SENTIMENT_BATCH_LIMIT || 200);
const SVC_CALL_GAP_MS = Number(process.env.SENTIMENT_CALL_GAP_MS || 0);

const MODELS = {
  social_en:    `${SVC_URL}/social-en`,     // twitter-roberta-base-sentiment-latest
  review_en_3c: `${SVC_URL}/review/en-3c`   // j-hartmann/sentiment-roberta-large-english-3-classes
};

const baseHeaders = {};
if (SVC_API_KEY) baseHeaders['X-API-Key'] = SVC_API_KEY;

const ax = axios.create({
  timeout: SVC_TIMEOUT_MS,
  headers: baseHeaders,
  httpAgent:  new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true })
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ─────────── Label mapping (3-class -> stars) ─────────── */
function toTri(label) {
  const L = String(label).toUpperCase();
  if (['LABEL_0','0','NEGATIVE','NEG'].includes(L)) return -1;
  if (['LABEL_1','1','NEUTRAL','NEU'].includes(L))  return 0;
  if (['LABEL_2','2','POSITIVE','POS'].includes(L)) return +1;
  return 0;
}
function triToStars(tri, prob) {
  if (prob < 0.55) return 3;
  if (tri === -1)  return prob < 0.70 ? 2 : 1;
  if (tri ===  1)  return prob < 0.70 ? 4 : 5;
  return 3;
}

async function svcCall(text, url, { max_length = 256 } = {}) {
  const payload = {
    inputs: String(text || '').slice(0, 2000),
    parameters: { truncation: true, max_length, return_all_scores: true },
    options: { wait_for_model: true }
  };

  for (let attempt = 1; attempt <= SVC_RETRIES + 1; attempt++) {
    try {
      const { data } = await ax.post(url, payload);
      if (SVC_CALL_GAP_MS) await sleep(SVC_CALL_GAP_MS);
      return data;
    } catch (e) {
      const status = e.response?.status;
      const msg = e.response?.data?.error || e.message || '';
      const isLenErr = /expanded size|sequence length|must match the existing size/i.test(msg);
      const retryable = e.code === 'ECONNABORTED' || status === 429 || (status >= 500 && status < 600);

      if (isLenErr) {
        payload.inputs = String(text || '').slice(0, 1000);
        payload.parameters.max_length = 128;
        continue;
      }
      if (retryable && attempt <= SVC_RETRIES) {
        const backoff = Math.min(15000, 1000 * attempt ** 2);
        await sleep(backoff);
        continue;
      }
      throw new Error(`SentimentSvc failed (${url.split('/').pop()}): ${msg}`);
    }
  }
}

/* ─────────── Sources & routing ─────────── */
const SOCIAL_SOURCES = [
  { table: 'tiktok_posts',       pk: 'post_id'  },
  { table: 'youtube_data',       pk: 'video_id' },
  { table: 'instagram_mentions', pk: 'post_id'  },
  { table: 'twitter_mentions',   pk: 'tweet_id' },
  { table: 'reddit_posts',       pk: 'id'       },
  { table: 'facebook_posts',     pk: 'post_id'  },
  { table: 'linkedin_posts',     pk: 'id'       }
];

const REVIEW_SOURCES = [
  { table: 'trustpilot_reviews',   pk: 'id' },
  { table: 'feefo_reviews',        pk: 'id' },
  { table: 'google_maps_reviews',  pk: 'id' }
];

/* ─────────── Main worker ─────────── */
async function processSentimentForPosts() {
  // SOCIAL
  for (const { table, pk } of SOCIAL_SOURCES) {
    const { rows } = await pool.query(
      `SELECT "${pk}" AS pk, eng_translated
         FROM ${table}
        WHERE rating IS NULL
          AND eng_translated IS NOT NULL
        LIMIT $1`,
      [BATCH_LIMIT]
    );

    for (const row of rows) {
      try {
        const text = row.eng_translated;
        if (!text) throw new Error('empty eng_translated');

        const out = await svcCall(text, MODELS.social_en);
        const arr = Array.isArray(out) ? out[0] : out;
        const best = arr.sort((a,b)=>b.score-a.score)[0];
        const stars = triToStars(toTri(best.label), best.score);

        await pool.query(
          `UPDATE ${table}
              SET rating = $1,
                  gemini_checked = 0
            WHERE "${pk}" = $2`,
          [stars, row.pk]
        );
      } catch (err) {
        await pool.query(
          `UPDATE ${table}
              SET rating = 0,
                  gemini_checked = 0
            WHERE "${pk}" = $1`,
          [row.pk]
        );
      }
    }
  }

  // REVIEWS
  for (const { table, pk } of REVIEW_SOURCES) {
    const { rows } = await pool.query(
      `SELECT "${pk}" AS pk, eng_translated
         FROM ${table}
        WHERE rating IS NULL
          AND eng_translated IS NOT NULL
        LIMIT $1`,
      [BATCH_LIMIT]
    );

    for (const row of rows) {
      try {
        const text = row.eng_translated;
        if (!text) throw new Error('empty eng_translated');

        const out = await svcCall(text, MODELS.review_en_3c);
        const arr = Array.isArray(out) ? out[0] : out;
        const best = arr.sort((a,b)=>b.score-a.score)[0];
        const stars = triToStars(toTri(best.label), best.score);

        await pool.query(
          `UPDATE ${table}
              SET rating = $1,
                  gemini_checked = 0
            WHERE "${pk}" = $2`,
          [stars, row.pk]
        );
      } catch (err) {
        await pool.query(
          `UPDATE ${table}
              SET rating = 0,
                  gemini_checked = 0
            WHERE "${pk}" = $1`,
          [row.pk]
        );
      }
    }
  }
}

// Run every 15 minutes (same as before)
cron.schedule('*/15 * * * *', () => {
  processSentimentForPosts().catch(console.error);
});

module.exports = processSentimentForPosts;
