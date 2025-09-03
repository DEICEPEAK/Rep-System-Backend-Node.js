// sentimentMiddleware.js (key parts only)
const axios = require('axios');
const cron = require('node-cron');
const pool = require('../db/pool');

const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;

// --- Models ---
const MODELS = {
  // Language ID
  lid: 'https://api-inference.huggingface.co/models/facebook/fasttext-language-identification',

  // Social
  social_en: 'https://api-inference.huggingface.co/models/cardiffnlp/twitter-roberta-base-sentiment-latest',
  social_multi: 'https://api-inference.huggingface.co/models/cardiffnlp/twitter-xlm-roberta-base-sentiment',

  // Reviews (fallback when stars missing)
  review_en_3c: 'https://api-inference.huggingface.co/models/j-hartmann/sentiment-roberta-large-english-3-classes',
  review_multi_5s: 'https://api-inference.huggingface.co/models/nlptown/bert-base-multilingual-uncased-sentiment'
  // or: 'https://api-inference.huggingface.co/models/LiYuan/amazon-review-sentiment-analysis'
};

// --- Utilities ---
function trimLongText(text, maxChars = 2000) {
  // keep enough context; 2000 chars ~ well under 512 tokens for most languages,
  // but we ALSO set tokenizer truncation for safety.
  if (!text) return text;
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}

// Optional: chunk + vote for very long bodies (reviews, long posts)
function chunkText(text, chunkSize = 900) { // chars, heuristic
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= chunkSize) return [clean];
  const chunks = [];
  for (let i = 0; i < clean.length; i += chunkSize) {
    chunks.push(clean.slice(i, i + chunkSize));
  }
  return chunks;
}

// --- Hugging Face call (with truncation + cold-start handling) ---
async function hf(text, url, { max_length = 256, top_k = null } = {}) {
  const payload = {
    inputs: trimLongText(text, 2000),
    parameters: {
      truncation: true,
      max_length,             // tokenizer-level max
      return_all_scores: true,
      ...(top_k != null ? { top_k } : {}) // keep default behavior unless we want top-1
    },
    options: { wait_for_model: true }     // avoid 503 when model is cold
  };

  try {
    const { data } = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${HUGGINGFACE_API_KEY}` },
      timeout: 20000,
      // tiny retry for transient 5xx/429 could be added here if you want
    });
    return data;
  } catch (e) {
    // If the model still complains about length, retry with a stricter cap.
    const msg = e?.response?.data?.error || e.message || '';
    if (/expanded size|sequence length|must match the existing size/i.test(msg)) {
      const { data } = await axios.post(url, {
        ...payload,
        inputs: trimLongText(text, 1000),
        parameters: { ...payload.parameters, max_length: 128 }
      }, {
        headers: { Authorization: `Bearer ${HUGGINGFACE_API_KEY}` },
        timeout: 20000
      });
      return data;
    }
    // surface a compact error instead of dumping the whole request (prevents key leakage)
    throw new Error(`HF request failed (${url.split('/').pop()}): ${msg}`);
  }
}


async function detectLang(text) {
  try {
    const out = await hf(text, MODELS.lid);
    const top = Array.isArray(out) ? out[0][0] : out[0];
    return (top && top.label) ? top.label.replace('__label__','') : 'und';
  } catch { return 'und'; }
}

function pickSocialModel(lang) {
  return lang === 'en' ? MODELS.social_en : MODELS.social_multi;
}
function pickReviewModel(lang) {
  return lang === 'en' ? MODELS.review_en_3c : MODELS.review_multi_5s;
}

// Map various label formats to tri-class
function toTri(label) {
  const L = String(label).toUpperCase();
  if (['LABEL_0','0','NEGATIVE'].includes(L)) return -1;
  if (['LABEL_1','1','NEUTRAL'].includes(L))  return 0;
  if (['LABEL_2','2','POSITIVE'].includes(L)) return +1;
  return 0;
}

// Convert tri-class + prob → 1..5 stars (confidence-aware)
function triToStars(tri, prob) {
  if (prob < 0.55) return 3;              // neutral-favoring threshold
  if (tri === -1)  return prob < 0.70 ? 2 : 1;
  if (tri ===  1)  return prob < 0.70 ? 4 : 5;
  return 3;
}

async function classifySocial(text, lang) {
  const out = await hf(text, pickSocialModel(lang));
  const arr = Array.isArray(out) ? out[0] : out;
  const best = arr.sort((a,b) => b.score - a.score)[0];
  const tri = toTri(best.label);
  const stars = triToStars(tri, best.score);
  return { stars };
}

async function classifyReview(text, lang) {
  const url = pickReviewModel(lang);
  const out = await hf(text, url);

  // star-model path
  if (url === MODELS.review_multi_5s) {
    // Hugging Face returns: [{label:'1 star',score:...},...]
    const best = out[0].sort((a,b)=>b.score-a.score)[0];
    const s = parseInt(String(best.label).match(/\d/)[0], 10);
    return { stars: s };
  }

  // 3-class path (English)
  const arr = Array.isArray(out) ? out[0] : out;
  const best = arr.sort((a,b)=>b.score-a.score)[0];
  const tri = toTri(best.label);
  const stars = triToStars(tri, best.score);
  return { stars };
}

// Which tables go where
const SOURCES = [
  // social
  { table: 'instagram_mentions', pk: 'post_id', texts: ['caption'], type: 'social' },
  { table: 'twitter_mentions',   pk: 'tweet_id', texts: ['text'],    type: 'social' },
  { table: 'reddit_posts',       pk: 'id',       texts: ['title','full_review'], type: 'social' },
  { table: 'facebook_posts',     pk: 'post_id',  texts: ['message'], type: 'social' },
  { table: 'linkedin_posts',     pk: 'id',       texts: ['text'],    type: 'social' },

  // reviews (fallback only for rows where you don't already have a star)
  { table: 'trustpilot_reviews', pk: 'id', texts: ['review_title','review_body'], type: 'review' },
  { table: 'feefo_reviews',      pk: 'id', texts: ['service_review','product_review'], type: 'review' },
  { table: 'google_maps_reviews',pk: 'id', texts: ['review_text'], type: 'review' }
];

async function processSentimentForPosts() {
  for (const src of SOURCES) {
    const { table, pk, texts, type } = src;
    const cols = [pk, ...texts].map(c => `"${c}"`).join(', ');
    const rows = (await pool.query(`SELECT ${cols} FROM ${table} WHERE rating IS NULL`)).rows;

    for (const row of rows) {
      const parts = texts.map(f => row[f]).filter(s => typeof s === 'string' && s.trim());
      if (!parts.length) continue;

      const text = parts.join(' ');
      const lang = await detectLang(text); // 'en', 'es', etc.

      const { stars } = type === 'social'
        ? await classifySocial(text, lang)
        : await classifyReview(text, lang);

      await pool.query(`UPDATE ${table} SET rating = $1 WHERE ${pk} = $2`, [stars, row[pk]]);
      console.log(`Updated ${table} ${row[pk]} → rating ${stars} (lang=${lang}, type=${type})`);
    }
  }
}

// run every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('Running sentiment classification...');
  processSentimentForPosts().catch(console.error);
});

module.exports = processSentimentForPosts;
