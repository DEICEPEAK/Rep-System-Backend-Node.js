// middlewares/geminiSentimentRecheck.js
require('dotenv').config();

const cron = require('node-cron');
const pool = require('../db/pool');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/* ─────────── Config ─────────── */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');

const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const CRON_EXPR      = process.env.GEMINI_RECHECK_CRON || '*/5 * * * *';
const ROW_LIMIT      = Number(process.env.GEMINI_RECHECK_LIMIT || 200);
const MAX_IN_LEN     = Number(process.env.GEMINI_MAX_INPUT_CHARS || 1000);
const DEBUG_GEMINI   = process.env.DEBUG_GEMINI === '1';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/* ─────────── Helpers ─────────── */
function hardTrim(s, n = MAX_IN_LEN) {
  if (!s) return s;
  s = String(s).trim();
  return s.length > n ? s.slice(0, n) : s;
}

const ALLOWED = new Set([
  'NEGATIVE', 'SLIGHTLY_NEGATIVE', 'NEUTRAL', 'SLIGHTLY_POSITIVE', 'POSITIVE'
]);

function mapGeminiLabelToStars(label) {
  switch (String(label).toUpperCase()) {
    case 'NEGATIVE':           return 1;
    case 'SLIGHTLY_NEGATIVE':  return 2;
    case 'NEUTRAL':            return 3;
    case 'SLIGHTLY_POSITIVE':  return 4;
    case 'POSITIVE':           return 5;
    default:                   return null;
  }
}

function stripCodeFences(s) {
  if (!s) return s;
  return s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}
function extractFirstJson(s) {
  if (!s) return s;
  const start = s.indexOf('{');
  if (start < 0) return s;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s;
}
function safeJsonParse(raw) {
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(stripCodeFences(raw)); } catch {}
  try { return JSON.parse(extractFirstJson(stripCodeFences(raw))); } catch {}
  return null;
}

function validateNormalize(obj, originalText) {
  if (!obj || typeof obj !== 'object') return null;
  let { lang_src, text_en, sentiment, confidence } = obj;

  // Normalize types
  if (typeof lang_src !== 'string' || !lang_src.trim()) lang_src = 'und';
  if (typeof text_en !== 'string' || !text_en.trim())   text_en = hardTrim(originalText);
  if (typeof sentiment !== 'string') sentiment = 'NEUTRAL';
  sentiment = sentiment.toUpperCase().trim();
  if (!ALLOWED.has(sentiment)) sentiment = 'NEUTRAL';

  confidence = Number(confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  return { lang_src, text_en, sentiment, confidence };
}

/* ─────────── Gemini calls (3-layer strategy) ─────────── */

/** 1) Function-calling (preferred) */
async function geminiWithFunctionCall(text, companyName) {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    tools: [{
      functionDeclarations: [{
        name: 'setSentiment',
        description: 'Return final sentiment decision in a fixed schema.',
        parameters: {
          type: 'OBJECT',
          properties: {
            lang_src:   { type: 'STRING', description: "BCP-47 language code or 'en'." },
            text_en:    { type: 'STRING', description: 'English text (original if already English).' },
            sentiment:  { type: 'STRING', description: 'One of NEGATIVE, SLIGHTLY_NEGATIVE, NEUTRAL, SLIGHTLY_POSITIVE, POSITIVE.' },
            confidence: { type: 'NUMBER', description: 'Confidence 0.0–1.0.' }
          },
          required: ['lang_src', 'text_en', 'sentiment', 'confidence']
        }
      }]
    }]
  });

  const system = `
You are a strict multilingual sentiment classifier.
(1) If the text is not English, translate to plain English for sentiment analysis (keep emojis/punctuation).
(2) Classify sentiment SPECIFICALLY toward "${(companyName || 'the company').replace(/"/g, '\\"')}".
Return your answer by CALLING the function setSentiment exactly once with the fields:
- lang_src
- text_en
- sentiment (NEGATIVE | SLIGHTLY_NEGATIVE | NEUTRAL | SLIGHTLY_POSITIVE | POSITIVE)
- confidence (0..1)`.trim();

  const contents = [
    { role: 'user', parts: [{ text: system }] },
    { role: 'user', parts: [{ text: hardTrim(text) }] }
  ];

  const result = await model.generateContent({
    contents,
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    generationConfig: { temperature: 0.0, maxOutputTokens: 256 }
  });

  const parts = result?.response?.candidates?.[0]?.content?.parts || [];
  const fcPart = parts.find(p => p.functionCall);
  const fc = fcPart?.functionCall;
  if (!fc || fc.name !== 'setSentiment') return null;

  // args may be object or JSON string depending on SDK version
  const rawArgs = fc.args ?? fc.arguments;
  const argsObj = typeof rawArgs === 'string' ? safeJsonParse(rawArgs) : rawArgs;
  return validateNormalize(argsObj, text);
}

/** 2) JSON-mode fallback */
async function geminiJsonMode(text, companyName) {
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt = `
You are a strict multilingual sentiment classifier.
Task: (1) If the text is not English, translate it to plain English for sentiment analysis,
preserving emojis, emphasis, punctuation, and sentiment cues.
(2) Classify the sentiment specifically toward the company named "${(companyName || 'the company').replace(/"/g, '\\"')}" only.

Return ONLY a single JSON object with EXACTLY these keys:
{
  "lang_src": "<BCP-47 code or 'en'>",
  "text_en": "<English text (original if already English)>",
  "sentiment": "NEGATIVE | SLIGHTLY_NEGATIVE | NEUTRAL | SLIGHTLY_POSITIVE | POSITIVE",
  "confidence": 0.0
}

Rules:
- Output JSON ONLY. No prose, no markdown, no code fences.
- Escape internal quotes.
- Keep it to one line.
`.trim();

  const contents = [
    { role: 'user', parts: [{ text: prompt }] },
    { role: 'user', parts: [{ text: hardTrim(text) }] }
  ];

  const result = await model.generateContent({
    contents,
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 256,
      responseMimeType: 'application/json'
    }
  });

  const raw = typeof result?.response?.text === 'function'
    ? result.response.text()
    : result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  if (DEBUG_GEMINI) console.log('[Gemini JSON raw]', raw?.slice(0, 800));
  const parsed = safeJsonParse(raw);
  return validateNormalize(parsed, text);
}

/** 3) Label-only “one token” fallback */
async function geminiLabelOnly(text, companyName) {
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt = `
Return ONLY ONE of these tokens (in ALL CAPS), nothing else:
NEGATIVE | SLIGHTLY_NEGATIVE | NEUTRAL | SLIGHTLY_POSITIVE | POSITIVE

Text (classify sentiment TOWARD "${(companyName || 'the company').replace(/"/g, '\\"')}"):
${hardTrim(text)}

Answer with exactly one token.`.trim();

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }]}],
    generationConfig: { temperature: 0.0, maxOutputTokens: 2 }
  });

  const token = (typeof result?.response?.text === 'function'
    ? result.response.text()
    : result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || ''
  ).trim().toUpperCase();

  if (!ALLOWED.has(token)) return null;
  // Fill minimal structure; lang_src unknown, text_en original
  return { lang_src: 'und', text_en: hardTrim(text), sentiment: token, confidence: 0.5 };
}

/** Orchestrator with fallbacks */
async function translateAndClassify(text, companyName) {
  // 1) Function-calling
  try {
    const r = await geminiWithFunctionCall(text, companyName);
    if (r) return r;
  } catch (e) {
    if (DEBUG_GEMINI) console.warn('Function-call path failed:', e.message);
  }
  // 2) JSON mode
  try {
    const r = await geminiJsonMode(text, companyName);
    if (r) return r;
  } catch (e) {
    if (DEBUG_GEMINI) console.warn('JSON-mode path failed:', e.message);
  }
  // 3) Label-only last resort
  try {
    const r = await geminiLabelOnly(text, companyName);
    if (r) return r;
  } catch (e) {
    if (DEBUG_GEMINI) console.warn('Label-only path failed:', e.message);
  }
  return null;
}

/* ─────────── Tables to recheck ─────────── */
const SOURCES = [
  { table: 'instagram_mentions', pk: 'post_id',  texts: ['caption'] },
  { table: 'twitter_mentions',   pk: 'tweet_id', texts: ['text'] },
  { table: 'reddit_posts',       pk: 'id',       texts: ['title','full_review'] },
  { table: 'facebook_posts',     pk: 'post_id',  texts: ['message'] },
  { table: 'linkedin_posts',     pk: 'id',       texts: ['text'] },
  { table: 'tiktok_posts',       pk: 'post_id',  texts: ['caption'] },
  { table: 'youtube_data',       pk: 'video_id', texts: ['title','description'] },
];

/* ─────────── Worker ─────────── */
async function recheckSentimentWithGemini() {
  for (const src of SOURCES) {
    const { table, pk, texts } = src;
    const cols = [pk, ...texts, 'company_name', 'rating', 'gemini_checked'].map(c => `"${c}"`).join(', ');

    const { rows } = await pool.query(
      `SELECT ${cols}
         FROM ${table}
        WHERE gemini_checked = 0
          AND (rating = 0 OR rating IN (1,2))
        LIMIT $1`,
      [ROW_LIMIT]
    );

    let ok = 0, fail = 0;
    for (const row of rows) {
      try {
        const parts = texts.map(f => row[f]).filter(s => typeof s === 'string' && s.trim());
        if (!parts.length) {
          await pool.query(`UPDATE ${table} SET gemini_checked = 1 WHERE ${pk} = $1`, [row[pk]]);
          continue;
        }

        const text = parts.join(' ').trim();
        const company = row.company_name || 'the company';

        const out = await translateAndClassify(text, company);
        if (!out) {
          fail++;
          console.error('Gemini translate+classify failed: Model returned non-JSON or malformed JSON');
          continue; // leave gemini_checked=0 to retry later
        }

        let stars = mapGeminiLabelToStars(out.sentiment);
        if (!stars) stars = 3;

        await pool.query(
          `UPDATE ${table}
              SET rating = $1,
                  gemini_checked = 1
            WHERE ${pk} = $2`,
          [stars, row[pk]]
        );

        ok++;
        if (DEBUG_GEMINI) {
         // console.log(`[Gemini] ${table} ${row[pk]} → ${stars}★ (${out.sentiment}, src=${out.lang_src}, conf=${out.confidence})`);
        }
      } catch (err) {
        fail++;
        console.error(`Gemini recheck failed for ${table} ${row[pk]}: ${err.message}`);
      }
    }

   // console.log(`[Gemini ${table}] ok=${ok} fail=${fail}`);
  }
}

/* ─────────── Schedule ─────────── */
cron.schedule(CRON_EXPR, () => {
  //console.log('Running Gemini sentiment recheck...');
  recheckSentimentWithGemini().catch(console.error);
});

module.exports = { recheckSentimentWithGemini };
