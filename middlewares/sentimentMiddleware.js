// middlewares/sentimentMiddleware.js
const axios = require('axios');
const cron = require('node-cron');
const pool = require('../db/pool');

const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;

// ----- Tunables (via .env) -----
const HF_TIMEOUT_MS = Number(process.env.HF_TIMEOUT_MS || 60000); // default 60s
const HF_RETRIES    = Number(process.env.HF_RETRIES || 2);        // retry 2 times on timeout/429/5xx
const BATCH_LIMIT   = Number(process.env.SENTIMENT_BATCH_LIMIT || 200); // rows per table per run
const FORCE_SOCIAL_EN = process.env.HF_SOCIAL_FORCE_EN === '1';   // force english social model (escape hatch)
const PREWARM = process.env.HF_PREWARM === '1';                   // warm models on boot

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
  // alternative: 'https://api-inference.huggingface.co/models/LiYuan/amazon-review-sentiment-analysis'
};

// --- Utilities ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function trimLongText(text, maxChars = 2000) {
  if (!text) return text;
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}

// Optional: chunk + vote for very long bodies (reviews, long posts)
function chunkText(text, chunkSize = 900) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= chunkSize) return [clean];
  const chunks = [];
  for (let i = 0; i < clean.length; i += chunkSize) {
    chunks.push(clean.slice(i, i + chunkSize));
  }
  return chunks;
}

// --- Hugging Face call (with truncation + cold-start handling + retries) ---
async function hf(text, url, { max_length = 256, top_k = null } = {}) {
  const payload = {
    inputs: trimLongText(text, 2000),
    parameters: {
      truncation: true,
      max_length,
      return_all_scores: true,
      ...(top_k != null ? { top_k } : {})
    },
    options: { wait_for_model: true }
  };

  for (let attempt = 1; attempt <= HF_RETRIES + 1; attempt++) {
    try {
      const { data } = await axios.post(url, payload, {
        headers: { Authorization: Bearer ${HUGGINGFACE_API_KEY} },
        timeout: HF_TIMEOUT_MS
      });
      return data;
    } catch (e) {
      const status = e.response?.status;
      const msg = e?.response?.data?.error || e.message || '';
      const isLenErr = /expanded size|sequence length|must match the existing size/i.test(msg);
      const retryable = e.code === 'ECONNABORTED' || status === 429 || (status >= 500 && status < 600);

      // If tokenizer complains once, shrink and retry immediately
      if (isLenErr) {
        payload.inputs = trimLongText(text, 1000);
        payload.parameters.max_length = 128;
        continue;
      }

      if (retryable && attempt <= HF_RETRIES) {
        const backoff = Math.min(15000, 1000 * attempt ** 2); // 1s, 4s, 9s...
        await sleep(backoff);
        continue;
      }

      // Surface a compact error (prevents leaking request/keys)
      throw new Error(HF request failed (${url.split('/').pop()}): ${msg});
    }
  }
}

// --- Language detection ---
async function detectLang(text) {
  try {
    const out = await hf(text, MODELS.lid);
    const top = Array.isArray(out) ? out[0][0] : out[0];
    return (top && top.label) ? top.label.replace('_label_','') : 'und';
  } catch { return 'und'; }
}

function pickSocialModel(lang) {
  if (FORCE_SOCIAL_EN) return MODELS.social_en;
  return lang === 'en' ? MODELS.social_en : MODELS.social_multi;
}
function pickReviewModel(lang) {
  return lang === 'en' ? MODELS.review_en_3c : MODELS.review_multi_5s;
}

// Map various label formats to tri-class
function toTri(label) {
  const L = String(label).toUpperCase();
  if (['LABEL_0','0','NEGATIVE','NEG'].includes(L)) return -1;
  if (['LABEL_1','1','NEUTRAL','NEU'].includes(L)) return 0;
  if (['LABEL_2','2','POSITIVE','POS'].includes(L)) return +1;
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
  { table: 'youtube_data',       pk: 'video_id', texts: ['caption'], type: 'social' },
  { table: 'tiktok_posts',       pk: 'post_id',  texts: ['title','description'], type: 'social' },

  // reviews (fallback only for rows where you don't already have a star)
  { table: 'trustpilot_reviews', pk: 'id', texts: ['review_title','review_body'], type: 'review' },
  { table: 'feefo_reviews',      pk: 'id', texts: ['service_review','product_review'], type: 'review' },
  { table: 'google_maps_reviews',pk: 'id', texts: ['review_text'], type: 'review' }
];

async function processSentimentForPosts() {
  for (const src of SOURCES) {
    const { table, pk, texts, type } = src;
    const cols = [pk, ...texts].map(c => "${c}").join(', ');

    let rows = [];
    try {
      const res = await pool.query(
        SELECT ${cols} FROM ${table} WHERE rating IS NULL LIMIT $1,
        [BATCH_LIMIT]
      );
      rows = res.rows || [];
    } catch (err) {
      console.error(Query failed for ${table}: ${err.message});
      continue; // move to next table
    }

    for (const row of rows) {
      const parts = texts
        .map(f => row[f])
        .filter(s => typeof s === 'string' && s.trim());

      if (!parts.length) continue;

      const text = parts.join(' ');

      try {
        const lang = await detectLang(text); // 'en', 'es', etc.

        const { stars } = type === 'social'
          ? await classifySocial(text, lang)
          : await classifyReview(text, lang);

        await pool.query(
          UPDATE ${table} SET rating = $1 WHERE ${pk} = $2,
          [stars, row[pk]]
        );

        console.log(Updated ${table} ${row[pk]} → rating ${stars} (lang=${lang}, type=${type}));
      } catch (err) {
        console.error(Skipping ${table} ${row[pk]}: ${err.message});
      }
    }
  }
}

// run every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('Running sentiment classification...');
  processSentimentForPosts().catch(e => console.error('Batch failed:', e.message));
});

module.exports = processSentimentForPosts;

// Optional: warm common models to reduce first-call latency
if (PREWARM) {
  setImmediate(() => {
    Promise.allSettled([
      hf('hello', MODELS.lid).catch(() => {}),
      hf('I love this', MODELS.social_en).catch(() => {}),
      hf("C'est superbe", MODELS.social_multi).catch(() => {}),
    ]).then(() => console.log('HF models prewarmed'));
  });
}