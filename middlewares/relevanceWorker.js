// middlewares/relevanceWorker.js
require('dotenv').config();

const cron = require('node-cron');
const pool = require('../db/pool');
const { makeGeminiClient } = require('../services/geminiClientImpl');

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const CRON_EXPR       = process.env.RELEVANCE_CRON || '*/10 * * * *';
const ROW_LIMIT       = Number(process.env.RELEVANCE_LIMIT || 200);
const DEBUG_RELEVANCE = process.env.DEBUG_RELEVANCE === '1';

const client = makeGeminiClient({ apiKey: GEMINI_API_KEY });

async function columnExists(tableName, columnName) {
  const q = `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
    ) AS present
  `;
  const { rows } = await pool.query(q, [tableName, columnName]);
  return rows?.[0]?.present === true;
}

function makeSystemInstruction(companyName, description, keywords) {
  return [
    'You are a strict relevance classifier.',
    'Task: Decide if the given LinkedIn POST TEXT is ABOUT the target company.',
    `Company name: "${companyName || ''}"`,
    description ? `Company description: ${description}` : 'Company description: (none provided)',
    keywords ? `User keywords (aliases/hashtags/brands): ${keywords}` : 'User keywords: (none)',
    '',
    'RELEVANT means:',
    '- The post is clearly about the target company: products, services, brand, events, hiring, executives, offices, campaigns, partnerships, customer support, compliance, or official announcements.',
    '- Or it mentions the target company (or its aliases/hashtags) in a meaningful, topical way that ties the content to that company.',
    '',
    'IRRELEVANT means:',
    '- The post is about another company, person, or topic, even if similar strings or acronyms appear.',
    '- Mentions of generic/ambiguous tokens or hashtag lists without a clear link to the target company.',
    '- Directory-style lists, random tag dumps, or unrelated job/press posts for others.',
    '',
    'Language: The post may be in ANY language; interpret content in its original language (do NOT translate).',
    'Output: Return EXACTLY ONE TOKEN in ALL CAPS: RELEVANT or IRRELEVANT.',
  ].join('\n');
}

function normalizeLabel(s) {
  const up = (s || '').trim().toUpperCase();
  if (up === 'RELEVANT') return 'RELEVANT';
  if (up === 'IRRELEVANT') return 'IRRELEVANT';
  if (up.includes('RELEVANT') && !up.includes('IRRELEVANT')) return 'RELEVANT';
  if (up.includes('IRRELEVANT')) return 'IRRELEVANT';
  return null;
}

async function classifyBatch() {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY missing - relevance worker disabled');
    return 0;
  }

  const hasDesc     = await columnExists('users', 'description'); // <-- uses `description`
  const hasKeywords = await columnExists('users', 'keywords');

  const descSelect     = hasDesc     ? `COALESCE(u.description, '') AS description` : `''::text AS description`;
  const keywordsSelect = hasKeywords ? `COALESCE(u.keywords, '') AS user_keywords`  : `''::text AS user_keywords`;

  const { rows } = await pool.query(
    `
    SELECT
      p.id,
      p.company_name,
      COALESCE(NULLIF(p.text, ''), '') AS post_text,
      ${descSelect},
      ${keywordsSelect}
    FROM linkedin_posts p
    JOIN users u
      ON LOWER(u.company_name) = LOWER(p.company_name)
    WHERE p.relevant IS NULL
      AND p.text IS NOT NULL
      AND LENGTH(p.text) > 0
    ORDER BY p.posted_at_ts DESC NULLS LAST
    LIMIT $1
    `,
    [ROW_LIMIT]
  );

  if (!rows.length) {
    if (DEBUG_RELEVANCE) console.log('[Relevance] Nothing to classify.');
    return 0;
  }

  let updated = 0;

  for (const row of rows) {
    const { id, company_name } = row;
    const postText    = (row.post_text || '').trim();
    const description = row.description || '';
    const userKeywords = row.user_keywords || '';

    if (!postText) {
      await pool.query(`UPDATE linkedin_posts SET relevant = FALSE WHERE id = $1`, [id]);
      updated++;
      continue;
    }

    try {
      const sys = makeSystemInstruction(company_name, description, userKeywords);
      const res = await client.generateText(postText, sys, {
        temperature: 0.0,
        maxOutputTokens: 5,
        timeoutMs: 12_000
      });

      if (!res.ok) {
        if (DEBUG_RELEVANCE) console.error(`[Relevance ${id}] provider error:`, res.message || res.code);
        continue; // leave NULL for retry
      }

      const label = normalizeLabel(res.text);
      if (!label) {
        if (DEBUG_RELEVANCE) console.error(`[Relevance ${id}] unexpected label:`, res.text);
        continue; // leave NULL for retry
      }

      await pool.query(
        `UPDATE linkedin_posts SET relevant = $1 WHERE id = $2`,
        [label === 'RELEVANT', id]
      );
      updated++;

      if (DEBUG_RELEVANCE) {
        console.log(`[Relevance ${id}] → ${label} (company="${company_name}")`);
      }
    } catch (err) {
      if (DEBUG_RELEVANCE) console.error(`[Relevance ${row.id}]`, err.message || err);
      // keep as NULL for retry
    }
  }

  if (DEBUG_RELEVANCE) console.log(`[Relevance] Updated rows: ${updated}/${rows.length}`);
  return updated;
}

function startRelevanceCron() {
  cron.schedule(CRON_EXPR, () => {
    classifyBatch().catch(console.error);
  });
  if (DEBUG_RELEVANCE) console.log(`[Relevance] Cron scheduled: ${CRON_EXPR}, limit=${ROW_LIMIT}`);
}

module.exports = { startRelevanceCron, classifyBatch };
