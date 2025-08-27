// geminiSentimentRecheck.js
const cron = require('node-cron');
const pool = require('../db/pool');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// --- Helper to call Gemini for sentiment check (entity-aware) ---
async function recheckSentimentWithGemini(text, companyName) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: `
      You are a strict sentiment classifier.
      Analyze the sentiment **specifically toward the company named "${companyName}"** in the text.
      
      - Ignore unrelated context (e.g., story hooks, other people, sarcasm not directed at the company).
      - Focus only on how "${companyName}" is portrayed or implied.
      - Return ONE of these labels ONLY:
        NEGATIVE, SLIGHTLY_NEGATIVE, NEUTRAL, POSITIVE
    `
  });

  const payload = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: { temperature: 0.0 }
  };

  try {
    const result = await model.generateContent(payload);
    const response = result?.response;
    const out =
      (typeof response?.text === 'function' ? response.text() : '') ||
      response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      '';

    return out.trim().toUpperCase();
  } catch (err) {
    console.error('Gemini sentiment recheck failed:', err.message);
    return null;
  }
}

// --- Map Gemini label → star rating ---
function mapGeminiLabelToStars(label) {
  switch (label) {
    case 'NEGATIVE': return 1;
    case 'SLIGHTLY_NEGATIVE': return 2;
    case 'NEUTRAL': return 3;
    case 'POSITIVE': return 4; // or 5 if you want stronger
    default: return null;
  }
}

// --- Which sources to scan (reuse your SOURCES) ---
const SOURCES = [
  { table: 'instagram_mentions', pk: 'post_id', texts: ['caption'] },
  { table: 'twitter_mentions',   pk: 'tweet_id', texts: ['text'] },
  { table: 'reddit_posts',       pk: 'id', texts: ['title','full_review'] },
  { table: 'facebook_posts',     pk: 'post_id', texts: ['message'] },
  { table: 'linkedin_posts',     pk: 'id', texts: ['text'] },
  //{ table: 'trustpilot_reviews', pk: 'id', texts: ['review_title','review_body'] },
  { table: 'feefo_reviews',      pk: 'id', texts: ['service_review','product_review'] },
  //{ table: 'google_maps_reviews',pk: 'id', texts: ['review_text'] }
];

// --- Process Negative & Slightly Negative Posts ---
async function processRecheck() {
  for (const src of SOURCES) {
    const { table, pk, texts } = src;
    const cols = [pk, ...texts, 'company_name', 'rating'].map(c => `"${c}"`).join(', ');

    // Only fetch rows rated 1 or 2
    const rows = (await pool.query(
      `SELECT ${cols} FROM ${table} WHERE rating IN (1,2)`
    )).rows;

    for (const row of rows) {
      const parts = texts.map(f => row[f]).filter(s => typeof s === 'string' && s.trim());
      if (!parts.length || !row.company_name) continue;

      const text = parts.join(' ').trim();
      const company = row.company_name;

      const geminiLabel = await recheckSentimentWithGemini(text, company);
      if (!geminiLabel) continue;

      const correctedStars = mapGeminiLabelToStars(geminiLabel);

      if (correctedStars && correctedStars !== row.rating) {
        await pool.query(
          `UPDATE ${table} SET rating = $1 WHERE ${pk} = $2`,
          [correctedStars, row[pk]]
        );
        console.log(
          `Rechecked ${table} ${row[pk]} → corrected rating ${correctedStars} (was ${row.rating}, Gemini=${geminiLabel}, company=${company})`
        );
      }
    }
  }
}

// --- Schedule every 5 minutes ---
cron.schedule('*/120 * * * *', () => {
  console.log('Running Gemini sentiment recheck...');
  processRecheck().catch(console.error);
});

module.exports = processRecheck;
