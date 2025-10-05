// middlewares/geminiSentimentRecheck.js
require('dotenv').config();

const cron = require('node-cron');
const pool = require('../db/pool');
const { makeGeminiClient } = require('../services/geminiClientImpl');

/* ─────────── Config ─────────── */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;          // use client default: gemini-2.0-flash-001
const CRON_EXPR      = process.env.GEMINI_RECHECK_CRON || '*/10 * * * *';
const ROW_LIMIT      = Number(process.env.GEMINI_RECHECK_LIMIT || 200);
const DEBUG_GEMINI   = process.env.DEBUG_GEMINI === '1';

const client = makeGeminiClient({ apiKey: GEMINI_API_KEY }); // no model override

const ALLOWED = new Set(['NEGATIVE','SLIGHTLY_NEGATIVE','NEUTRAL','SLIGHTLY_POSITIVE','POSITIVE']);
function mapLabelToStars(label) {
  switch (String(label).toUpperCase()) {
    case 'NEGATIVE':           return 1;
    case 'SLIGHTLY_NEGATIVE':  return 2;
    case 'NEUTRAL':            return 3;
    case 'SLIGHTLY_POSITIVE':  return 4;
    case 'POSITIVE':           return 5;
    default:                   return 3;
  }
}

/* Tables to recheck (social + reviews) */
const SOURCES = [
  // social
  { table: 'tiktok_posts',       pk: 'post_id'  },
  { table: 'youtube_data',       pk: 'video_id' },
  { table: 'instagram_mentions', pk: 'post_id'  },
  { table: 'twitter_mentions',   pk: 'tweet_id' },
  { table: 'reddit_posts',       pk: 'id'       },
  { table: 'facebook_posts',     pk: 'post_id'  },
  { table: 'linkedin_posts',     pk: 'id'       },
  // reviews
  { table: 'trustpilot_reviews',   pk: 'id' },
  { table: 'feefo_reviews',        pk: 'id' },
  { table: 'google_maps_reviews',  pk: 'id' }
];

/* Label-only prompt with company context */
function makeSystemInstruction(companyName, companyDesc) {
  return [
    'You are a strict sentiment rater.',
    `Task: Classify the sentiment EXPRESSED TOWARD THIS COMPANY only: "${companyName}".`,
    'Context (about the company) to help you disambiguate:',
    companyDesc,
    '',
    'RULES:',
    '- Consider ONLY sentiment toward the company (ignore unrelated topics).',
    '- Do not explain.',
    '- Output EXACTLY ONE TOKEN in ALL CAPS from this set:',
    'NEGATIVE | SLIGHTLY_NEGATIVE | NEUTRAL | SLIGHTLY_POSITIVE | POSITIVE'
  ].join('\n');
}

async function recheckSentimentWithGemini() {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY missing - Gemini recheck disabled');
    return;
  }

  for (const { table, pk } of SOURCES) {
    // Require: gemini_checked=0, rating in {0,1,2,5}, eng_translated NOT NULL,
    // and users.company_description NOT NULL. company_name is assumed present.
    const { rows } = await pool.query(
      `
      SELECT t."${pk}" AS pk, t.eng_translated, t.company_name, u.company_description
        FROM ${table} t
        JOIN users u ON LOWER(u.company_name) = LOWER(t.company_name)
       WHERE t.gemini_checked = 0
         AND t.rating IN (0,1,2,5)
         AND t.eng_translated IS NOT NULL
         AND u.company_description IS NOT NULL
       LIMIT $1
      `,
      [ROW_LIMIT]
    );

    for (const row of rows) {
      try {
        const sys = makeSystemInstruction(row.company_name, row.company_description);
        const res = await client.generateText(row.eng_translated, sys, {
          temperature: 0.0,
          maxOutputTokens: 8,
          timeoutMs: 12_000
        });
        if (!res.ok) throw new Error(res.message || 'Gemini error');

        const label = res.text.trim().toUpperCase();
        if (DEBUG_GEMINI) console.log('[Gemini label]', table, row.pk, '→', label);
        if (!ALLOWED.has(label)) throw new Error(`Unexpected label: ${label}`);

        const stars = mapLabelToStars(label);
        await pool.query(
          `UPDATE ${table}
              SET rating = $1,
                  gemini_checked = 1
            WHERE "${pk}" = $2`,
          [stars, row.pk]
        );
      } catch (err) {
        // leave gemini_checked = 0 for retry on next run
        if (DEBUG_GEMINI) console.error(`[Gemini ${table} ${row.pk}]`, err.message);
      }
    }
  }
}

/* Schedule */
cron.schedule(CRON_EXPR, () => {
  recheckSentimentWithGemini().catch(console.error);
});

module.exports = { recheckSentimentWithGemini };
