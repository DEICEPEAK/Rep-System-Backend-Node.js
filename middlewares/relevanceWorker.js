// middlewares/relevanceWorker.js
require('dotenv').config();

const cron = require('node-cron');
const pool = require('../db/pool');
const { makeGeminiClient } = require('../services/geminiClientImpl');

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const CRON_EXPR       = process.env.RELEVANCE_CRON || '*/5 * * * *';
const ROW_LIMIT       = Number(process.env.RELEVANCE_LIMIT || 200);
const DEBUG_RELEVANCE = process.env.DEBUG_RELEVANCE === '1';

const client = makeGeminiClient({ apiKey: GEMINI_API_KEY });


// add console log to show error and successfully done jobs

/** Utility: check column exists (schema-safe on mixed DBs) */
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

/** Prompt (generic for social posts & videos; no translation) */
function makeSystemInstruction(companyName, description, keywords) {
  return [
    'You are a strict relevance classifier.',
    'Task: Decide if the given social-media content (post/video) text is ABOUT the target company.',
    `Company name: "${companyName || ''}"`,
    description ? `Company description: ${description}` : 'Company description: (none provided)',
    keywords ? `User keywords (aliases/hashtags/brands): ${keywords}` : 'User keywords: (none)',
    '',
    'RELEVANT means:',
    '- The content is clearly about the target company: products, services, brand, events, hiring, executives, offices, campaigns, partnerships, customer support, compliance, or official announcements.',
    '- Or it mentions the target company (or its aliases/hashtags) in a meaningful, topical way that ties the content to that company.',
    '',
    'IRRELEVANT means:',
    '- The content is about another company, person, or topic, even if similar strings or acronyms appear.',
    '- Mentions of generic/ambiguous tokens or hashtag lists without a clear link to the target company.',
    '- Directory-style lists, random tag dumps, or unrelated job/press posts for others.',
    '',
    'Language: The text may be in ANY language; interpret content in its original language (do NOT translate).',
    'Output: Return EXACTLY ONE TOKEN in ALL CAPS: RELEVANT or IRRELEVANT.'
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

/** Sources to check — note the per-table text expression */
const SOURCES = [
  {
    table: 'linkedin_posts',
    pk: 'id',
    textSql: `COALESCE(NULLIF(p.text, ''), '')`,
    // best effort ordering columns; optional
    orderBy: `p.posted_at_ts DESC NULLS LAST`
  },
  {
    table: 'tiktok_posts',
    pk: 'post_id',
    textSql: `COALESCE(NULLIF(p.caption, ''), '')`,
    orderBy: `p.created_at DESC NULLS LAST`
  },
  {
    table: 'youtube_data',
    pk: 'video_id',
    // combine title + description as the text signal
    textSql: `COALESCE(NULLIF(TRIM(CONCAT_WS(E'\\n\\n', NULLIF(p.title,''), NULLIF(p.description,''))), ''), '')`,
    orderBy: `p.published_at DESC NULLS LAST`
  }
];

/** Process a single table in batches */
async function classifyTable(src, hasDesc, hasKeywords) {
  // ensure the table actually has `relevant`
  const hasRelevant = await columnExists(src.table, 'relevant');
  if (!hasRelevant) {
    console.error(`[Relevance] Table ${src.table} missing 'relevant' column — skipping`);
    return 0;
  }

  if (DEBUG_RELEVANCE) {
    console.log(`[Relevance][${src.table}] Beginning classification (limit=${ROW_LIMIT})`);
  }

  const descSelect     = hasDesc     ? `COALESCE(u.description, '') AS description` : `''::text AS description`;
  const keywordsSelect = hasKeywords ? `COALESCE(u.keywords, '')   AS user_keywords` : `''::text AS user_keywords`;

  const orderClause = src.orderBy ? `ORDER BY ${src.orderBy}` : '';

  const { rows } = await pool.query(
    `
    SELECT
      p."${src.pk}" AS id,
      p.company_name,
      ${src.textSql} AS post_text,
      ${descSelect},
      ${keywordsSelect}
    FROM ${src.table} p
    JOIN users u
      ON LOWER(u.company_name) = LOWER(p.company_name)
    WHERE p.relevant IS NULL
      AND ${src.textSql} <> ''
    ${orderClause}
    LIMIT $1
    `,
    [ROW_LIMIT]
  );

  if (!rows.length) {
    if (DEBUG_RELEVANCE) console.log(`[Relevance][${src.table}] Nothing to classify.`);
    return 0;
  }

  if (DEBUG_RELEVANCE) console.log(`[Relevance][${src.table}] Fetched ${rows.length} rows to classify.`);

  let updated = 0;
  const tableStart = process.hrtime.bigint();

  for (const row of rows) {
    const rowStart = process.hrtime.bigint();
    const { id, company_name } = row;
    const postText     = (row.post_text || '').trim();
    const description  = row.description || '';
    const userKeywords = row.user_keywords || '';

    if (!postText) {
      await pool.query(`UPDATE ${src.table} SET relevant = FALSE WHERE "${src.pk}" = $1`, [id]);
      updated++;
      if (DEBUG_RELEVANCE) {
        const rowDurMs = Number(process.hrtime.bigint() - rowStart) / 1_000_000;
        console.log(`[Relevance][${src.table} ${id}] empty text → IRRELEVANT (t=${rowDurMs.toFixed(1)}ms)`);
      }
      continue;
    }

    try {
      const sys = makeSystemInstruction(company_name, description, userKeywords);
      const callStart = process.hrtime.bigint();
      const res = await client.generateText(postText, sys, {
        temperature: 0.0,
        maxOutputTokens: 5,
        timeoutMs: 12_000
      });
      const callDurMs = Number(process.hrtime.bigint() - callStart) / 1_000_000;

      if (!res.ok) {
        if (DEBUG_RELEVANCE) console.error(`[Relevance][${src.table} ${id}] provider error (t=${callDurMs.toFixed(1)}ms):`, res.message || res.code);
        continue; // leave NULL for retry
      }

      const label = normalizeLabel(res.text);
      if (!label) {
        if (DEBUG_RELEVANCE) console.error(`[Relevance][${src.table} ${id}] unexpected label (t=${callDurMs.toFixed(1)}ms):`, res.text);
        continue; // leave NULL for retry
      }

      await pool.query(
        `UPDATE ${src.table} SET relevant = $1 WHERE "${src.pk}" = $2`,
        [label === 'RELEVANT', id]
      );
      updated++;

      if (DEBUG_RELEVANCE) {
        const rowDurMs = Number(process.hrtime.bigint() - rowStart) / 1_000_000;
        const snippet = postText.length > 120 ? postText.slice(0, 120).replace(/\n/g, ' ') + '…' : postText.replace(/\n/g, ' ');
      //  console.log(`[Relevance][${src.table} ${id}] → ${label} (company="${company_name}") (call=${callDurMs.toFixed(1)}ms total=${rowDurMs.toFixed(1)}ms) snippet="${snippet}"`);
      }
    } catch (err) {
      if (DEBUG_RELEVANCE) console.error(`[Relevance][${src.table} ${id}] exception:`, err.message || err);
      // keep as NULL for retry
    }
  }

  const tableDurMs = Number(process.hrtime.bigint() - tableStart) / 1_000_000;
  if (DEBUG_RELEVANCE) console.log(`[Relevance][${src.table}] Updated rows: ${updated}/${rows.length} (t=${tableDurMs.toFixed(1)}ms)`);

  return updated;
}

/** Entry point for the cron batch */
async function classifyBatch() {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY missing - relevance worker disabled');
    return 0;
  }

  const hasDesc     = await columnExists('users', 'description');
  const hasKeywords = await columnExists('users', 'keywords');

  if (DEBUG_RELEVANCE) console.log('[Relevance] classifyBatch starting...');
  const batchStart = process.hrtime.bigint();

  let total = 0;
  for (const src of SOURCES) {
    const before = total;
    const changed = await classifyTable(src, hasDesc, hasKeywords);
    total += changed;
    if (DEBUG_RELEVANCE) console.log(`[Relevance] Source ${src.table} contributed ${changed} updates (cumulative=${total})`);
  }

  const batchDurMs = Number(process.hrtime.bigint() - batchStart) / 1_000_000;
  if (DEBUG_RELEVANCE) console.log(`[Relevance] classifyBatch completed: totalUpdated=${total} (t=${batchDurMs.toFixed(1)}ms)`);

  return total;
}

/** Clean up irrelevant rows from a table */
async function cleanIrrelevantRows(table, pkColumn) {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ${table} WHERE relevant = FALSE RETURNING "${pkColumn}"`
    );
    if (DEBUG_RELEVANCE) {
    //  console.log(`[Cleanup][${table}] Removed ${rowCount} irrelevant rows`);
    }
    return rowCount;
  } catch (err) {
    console.error(`[Cleanup][${table}] Failed to remove irrelevant rows:`, err.message);
    return 0;
  }
}

/** Cleanup batch job */
async function cleanupBatch() {
  const batchStart = process.hrtime.bigint();
  
  let totalRemoved = 0;
  for (const src of SOURCES) {
    const removed = await cleanIrrelevantRows(src.table, src.pk);
    totalRemoved += removed;
  }

  const batchDurMs = Number(process.hrtime.bigint() - batchStart) / 1_000_000;
  if (DEBUG_RELEVANCE) {
   // console.log(`[Cleanup] Batch completed: removed ${totalRemoved} rows (t=${batchDurMs.toFixed(1)}ms)`);
  }
  return totalRemoved;
}

/** Start both cron jobs */
function startRelevanceCron() {
  // Existing relevance classification cron
  cron.schedule(CRON_EXPR, () => {
    classifyBatch().catch(console.error);
  });

  // New cleanup cron - runs every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    cleanupBatch().catch(console.error);
  });

  if (DEBUG_RELEVANCE) {
   // console.log(`[Relevance] Classification cron scheduled: ${CRON_EXPR}, limit=${ROW_LIMIT}`);
    console.log('[Cleanup] Cleanup cron scheduled: */5 * * * *');
  }
}

// Update exports to include new functions
module.exports = { 
  startRelevanceCron, 
  classifyBatch,
  cleanupBatch  // Export cleanup function for testing
};
