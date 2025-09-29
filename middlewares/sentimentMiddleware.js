// middlewares/sentimentMiddleware.js
require('dotenv').config();

const axios = require('axios');
const http = require('http');
const https = require('https');
const cron = require('node-cron');
const pool = require('../db/pool');
const { loadModule } = require('cld3-asm'); // CLD3 (WASM)

/* ─────────── Config (Render service oriented) ───────────
   Only the necessary names, with sensible defaults.
   Back-compat: if SENTIMENT_SVC_API_KEY not set, we fallback to HUGGINGFACE_API_KEY. */
const SVC_URL            = process.env.SENTIMENT_SVC_URL || 'http://localhost:8000';
const SVC_API_KEY        = process.env.SENTIMENT_SVC_API_KEY || process.env.HUGGINGFACE_API_KEY || '';
const SVC_TIMEOUT_MS     = Number(process.env.SENTIMENT_TIMEOUT_MS     || 60000);
const SVC_RETRIES        = Number(process.env.SENTIMENT_RETRIES        || 2);
const BATCH_LIMIT        = Number(process.env.SENTIMENT_BATCH_LIMIT    || 200);
const CLD3_EN_CONF       = Number(process.env.SENTIMENT_CLD3_EN_CONF   || 0.70);
const SVC_CALL_GAP_MS    = Number(process.env.SENTIMENT_CALL_GAP_MS    || 0);

//console.log('[SentimentSvc] url=%s timeout=%d retries=%d batch=%d cld3_en_conf=%s call_gap=%d',
//  SVC_URL, SVC_TIMEOUT_MS, SVC_RETRIES, BATCH_LIMIT, CLD3_EN_CONF, SVC_CALL_GAP_MS);

// Endpoints on your Render service
const MODELS = {
  social_en:       `${SVC_URL}/social-en`,
  review_en_3c:    `${SVC_URL}/review/en-3c`,
  review_multi_5s: `${SVC_URL}/review/multi-5s`
};

// Axios with keep-alive + timeout + API key header
const baseHeaders = {};
if (SVC_API_KEY) {
  baseHeaders['X-API-Key'] = SVC_API_KEY; // your service accepts this header
}
const ax = axios.create({
  timeout: SVC_TIMEOUT_MS,
  headers: baseHeaders,
  httpAgent:  new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true })
});

// Utils
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function trimLongText(text, maxChars = 2000) {
  if (!text) return text;
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}
function normalizeSocial(text) {
  if (!text) return text;
  let t = String(text).replace(/\u200B/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/https?:\/\/\S+/gi, 'http');
  t = t.replace(/@\w+/g, '@user');
  return t;
}

// Call Render service with retry/backoff + auto truncation
async function svcCall(text, url, { max_length = 256 } = {}) {
  const payload = {
    inputs: trimLongText(text, 2000),
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
        payload.inputs = trimLongText(text, 1000);
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

// CLD3 init
const cldIdentifierPromise = (async () => {
  const factory = await loadModule();
  return factory.create(0, 1000);
})();
process.on('exit', async () => {
  try { (await cldIdentifierPromise).dispose(); } catch {}
});
async function detectLangLocal(text) {
  try {
    const identifier = await cldIdentifierPromise;
    const res = identifier.findLanguage(trimLongText(text, 1000));
    const lang = res?.language || 'und';
    const conf = typeof res?.probability === 'number' ? res.probability : 0;
    return { lang, conf };
  } catch {
    return { lang: 'und', conf: 0 };
  }
}

// Label mapping
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

// Classifiers via Render service
async function classifySocialEN(text) {
  const out = await svcCall(text, MODELS.social_en);
  const arr = Array.isArray(out) ? out[0] : out;
  const best = arr.sort((a,b) => b.score - a.score)[0];
  const tri = toTri(best.label);
  const stars = triToStars(tri, best.score);
  return { stars, topScore: best.score, label: best.label };
}
async function classifyReview(text, lang) {
  const url = (lang === 'en') ? MODELS.review_en_3c : MODELS.review_multi_5s;
  const out = await svcCall(text, url);
  if (url === MODELS.review_multi_5s) {
    const best = out[0].sort((a,b)=>b.score-a.score)[0];
    const s = parseInt(String(best.label).match(/\d/)[0], 10);
    return { stars: s };
  } else {
    const arr = Array.isArray(out) ? out[0] : out;
    const best = arr.sort((a,b) => b.score - a.score)[0];
    const tri = toTri(best.label);
    const stars = triToStars(tri, best.score);
    return { stars };
  }
}

// Sources
const SOURCES = [
  { table: 'tiktok_posts',       pk: 'post_id',  texts: ['caption'],                 type: 'social' },
  { table: 'youtube_data',       pk: 'video_id', texts: ['title','description'],     type: 'social' },
  { table: 'instagram_mentions', pk: 'post_id',  texts: ['caption'],                 type: 'social' },
  { table: 'twitter_mentions',   pk: 'tweet_id', texts: ['text'],                    type: 'social' },
  { table: 'reddit_posts',       pk: 'id',       texts: ['title','full_review'],     type: 'social' },
  { table: 'facebook_posts',     pk: 'post_id',  texts: ['message'],                 type: 'social' },
  { table: 'linkedin_posts',     pk: 'id',       texts: ['text'],                    type: 'social' },

  { table: 'trustpilot_reviews', pk: 'id',       texts: ['review_title','review_body'], type: 'review' },
  { table: 'feefo_reviews',      pk: 'id',       texts: ['service_review','product_review'], type: 'review' },
  { table: 'google_maps_reviews',pk: 'id',       texts: ['review_text'],             type: 'review' }
];

async function processSentimentForPosts() {
  for (const src of SOURCES) {
    const { table, pk, texts, type } = src;
    const cols = [pk, ...texts].map(c => `"${c}"`).join(', ');

    const { rows } = await pool.query(
      `SELECT ${cols} FROM ${table} WHERE rating IS NULL LIMIT $1`,
      [BATCH_LIMIT]
    );

    let ok = 0, queuedGemini = 0, fail = 0;

    for (const row of rows) {
      try {
        const parts = texts.map(f => row[f]).filter(s => typeof s === 'string' && s.trim());
        if (!parts.length) continue;

        const raw  = parts.join(' ');
        const text = (type === 'social') ? normalizeSocial(raw) : raw;

        const { lang, conf } = await detectLangLocal(text);

        if (type === 'social') {
          if (lang === 'en' && conf >= CLD3_EN_CONF) {
            const { stars } = await classifySocialEN(text);
            await pool.query(
              `UPDATE ${table}
                  SET rating = $1,
                      lang_detected = $2
                WHERE ${pk} = $3`,
              [stars, lang, row[pk]]
            );
            ok++;
          } else {
            await pool.query(
              `UPDATE ${table}
                  SET rating = 0,
                      lang_detected = $1,
                      gemini_checked = 0
                WHERE ${pk} = $2`,
              [lang || 'und', row[pk]]
            );
            queuedGemini++;
          }
        } else {
          const { stars } = await classifyReview(text, (lang || 'en'));
          await pool.query(
            `UPDATE ${table}
                SET rating = $1,
                    lang_detected = $2
              WHERE ${pk} = $3`,
            [stars, lang, row[pk]]
          );
          ok++;
        }
      } catch (err) {
        fail++;
        console.error(`Skipping ${table} ${row[pk]}: ${err.message}`);
      }
    }

    //console.log(`[${table}] ok=${ok} queued_gemini=${queuedGemini} fail=${fail}`);
  }
}

cron.schedule('*/15 * * * *', () => {
  //console.log('Running sentiment classification...');
  processSentimentForPosts().catch(console.error);
});

module.exports = processSentimentForPosts;
