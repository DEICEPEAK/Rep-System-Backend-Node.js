// middlewares/aiSummaryWorker.js
require('dotenv').config();

const cron = require('node-cron');
const pool = require('../db/pool');
const { makeGeminiClient } = require('../services/geminiClientImpl');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BATCH_LIMIT    = Number(process.env.AI_SUMMARY_BATCH_LIMIT || 50);
const DEBUG_SUMMARY  = process.env.DEBUG_AI_SUMMARY === '1';

const gemini = makeGeminiClient({ apiKey: GEMINI_API_KEY }); // defaults to gemini-2.0-flash-001

// ---- Sources to include (post/review tables) ----
const SOURCES = [
  { table: 'tiktok_posts',       pk: 'post_id',  txt: 'eng_translated', star: 'rating', ts: 'created_at', label: 'tiktok' },
  { table: 'youtube_data',       pk: 'video_id', txt: 'eng_translated', star: 'rating', ts: 'published_at', label: 'youtube' },
  { table: 'instagram_mentions', pk: 'post_id',  txt: 'eng_translated', star: 'rating', ts: 'created_at', label: 'instagram' },
  { table: 'twitter_mentions',   pk: 'tweet_id', txt: 'eng_translated', star: 'rating', ts: 'created_at', label: 'twitter' },
  { table: 'reddit_posts',       pk: 'id',       txt: 'eng_translated', star: 'rating', ts: 'review_date', label: 'reddit' },
  { table: 'facebook_posts',     pk: 'post_id',  txt: 'eng_translated', star: 'rating', ts: 'created_at', label: 'facebook' },
  { table: 'linkedin_posts',     pk: 'id',       txt: 'eng_translated', star: 'rating', ts: 'posted_at_iso', label: 'linkedin' },

  { table: 'trustpilot_reviews',  pk: 'id', txt: 'eng_translated', star: 'rating', ts: 'review_date', label: 'trustpilot' },
  { table: 'feefo_reviews',       pk: 'id', txt: 'eng_translated', star: 'rating', ts: 'review_date', label: 'feefo' },
  { table: 'google_maps_reviews', pk: 'id', txt: 'eng_translated', star: 'rating', ts: 'review_date', label: 'google_maps' }
];

// ---------- Helpers ----------
const toUtcDate = (d) => new Date(new Date(d).toISOString().slice(0, 10)); // midnight UTC date object
const nextMidnightUtc = () => {
  const now = new Date();
  const utc = new Date(now.toISOString()); // UTC
  const next = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate() + 1, 0, 0, 0));
  return next;
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Robust JSON parse for LLM output
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

// ---------- Data fetch ----------
async function fetchDataset(companyName, startTs, endTs, sources = SOURCES) {
  const all = [];
  for (const s of sources) {
    const sql = `
      SELECT '${s.label}' AS source, ${s.pk} AS pk, ${s.txt} AS text, ${s.star} AS stars, ${s.ts} AS created_at
        FROM ${s.table}
       WHERE company_name = $1
         AND ${s.ts} >= $2
         AND ${s.ts} <  $3
         AND ${s.txt} IS NOT NULL
         AND ${s.star} IS NOT NULL
    `;
    const { rows } = await pool.query(sql, [companyName, startTs, endTs]);
    all.push(...rows.map(r => ({
      source: s.label,
      id: r.pk,
      text: r.text,
      stars: Number(r.stars),
      created_at: r.created_at
    })));
  }
  return all;
}

// ---------- Metrics ----------
function buildMetrics(dataset, prevDataset, startTs, endTs) {
  const total = dataset.length;
  const avg = total ? +(dataset.reduce((a, b) => a + b.stars, 0) / total).toFixed(2) : 0;

  const hist = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  dataset.forEach(d => { if (hist[d.stars] != null) hist[d.stars]++; });

  const bySourceMap = new Map();
  dataset.forEach(d => {
    const k = d.source;
    const o = bySourceMap.get(k) || { name: k, count: 0, sum: 0 };
    o.count++; o.sum += d.stars;
    bySourceMap.set(k, o);
  });
  const by_source = [...bySourceMap.values()].map(o => ({
    name: o.name, count: o.count, avg_stars: +(o.sum / o.count).toFixed(2)
  })).sort((a,b) => b.count - a.count);

  // by day (UTC) for last 7 days
  const dayMap = new Map();
  dataset.forEach(d => {
    const day = new Date(new Date(d.created_at).toISOString().slice(0,10)).toISOString().slice(0,10);
    const o = dayMap.get(day) || { day, count: 0, sum: 0 };
    o.count++; o.sum += d.stars;
    dayMap.set(day, o);
  });
  const by_day = [...dayMap.values()].sort((a,b) => a.day.localeCompare(b.day))
                    .map(o => ({ day: o.day, count: o.count, avg_stars: +(o.sum / o.count).toFixed(2) }));

  // previous period deltas
  const prevTotal = prevDataset.length;
  const prevAvg   = prevTotal ? +(prevDataset.reduce((a,b)=>a+b.stars,0)/prevTotal).toFixed(2) : 0;
  const trend_volume_pct = prevTotal ? +(((total - prevTotal) / prevTotal) * 100).toFixed(1) : null;
  const trend_stars_delta = +(avg - prevAvg).toFixed(2);

  // representative quotes (top 3 neg + top 3 pos by salience)
  const salience = (d) => Math.abs(d.stars - 3) * Math.log(1 + clamp((d.text || '').length, 0, 2000));
  const negatives = dataset.filter(d => d.stars <= 2)
                           .sort((a,b) => salience(b) - salience(a))
                           .slice(0,3);
  const positives = dataset.filter(d => d.stars >= 4)
                           .sort((a,b) => salience(b) - salience(a))
                           .slice(0,3);
  const trim = (s) => String(s || '').replace(/\s+/g,' ').trim().slice(0, 240);

  const quotes = [...negatives, ...positives].map(d => ({
    star: d.stars,
    text: trim(d.text),
    source: d.source,
    id: `${d.source}_${d.id}`
  }));

  return {
    period: {
      start: new Date(startTs).toISOString(),
      end:   new Date(endTs).toISOString()
    },
    total,
    avg_stars: avg,
    distribution: hist,
    sources: by_source,
    by_day,
    prev_period: {
      total: prevTotal,
      avg_stars: prevAvg
    },
    trend_vs_prev: {
      stars_delta: trend_stars_delta,        // e.g., +0.3
      volume_pct: trend_volume_pct           // e.g., +12.0
    },
    quotes
  };
}

// ---------- Prompt ----------
function makePrompt(companyName, metrics) {
  const sys = `
You are a strict reputation summarizer. Use ONLY the facts and quotes provided.
Do not invent metrics, dates, or sources. Return STRICT JSON only (no prose, no markdown).

Schema:
{
  "overview": {
    "period": "<YYYY-MM-DD → YYYY-MM-DD>",
    "total": <number>,
    "avg_stars": <number>,
    "trend_vs_prev": { "stars_delta": "<signed string like +0.3 or -0.2>", "volume_pct": "<signed pct like +12 or -8>" },
    "sources": [ { "name": "<source>", "count": <number>, "avg_stars": <number> } ],
    "distribution": { "1": <int>, "2": <int>, "3": <int>, "4": <int>, "5": <int> }
  },
  "themes": [ { "name": "<short label>", "sentiment": "NEGATIVE|SLIGHTLY_NEGATIVE|NEUTRAL|SLIGHTLY_POSITIVE|POSITIVE", "count": <int>, "change_vs_prev": "<signed int or '0'>" } ],
  "wins": [ "<bullet>", ... ],
  "pain_points": [ "<bullet>", ... ],
  "anomalies": [ { "date": "<YYYY-MM-DD>", "note": "<what happened>" } ],
  "quotes": [ { "star": <1-5>, "text": "<<=240 chars>", "source": "<source>", "id": "<source_pk>" } ],
  "actions": [
    { "action": "<concrete next step>", "why": "<reason tied to data>", "owner": "Ops|Support|Product|Comms", "metric_to_watch": "<KPI>" }
  ]
}

Rules:
- The "period" is exactly the last 7 days for ${companyName}.
- "themes" must be inferred from the provided quotes and distribution; keep them concise (max 5).
- "actions" must be concrete, directly tied to the observed issues/wins, and include an owner and metric_to_watch.
- If some fields are unknown from facts, use empty arrays rather than fabricating.
`.trim();

  const periodStr = `${metrics.period.start.slice(0,10)} → ${metrics.period.end.slice(0,10)}`;
  const facts = {
    overview: {
      period: periodStr,
      total: metrics.total,
      avg_stars: metrics.avg_stars,
      trend_vs_prev: metrics.trend_vs_prev,
      sources: metrics.sources,
      distribution: metrics.distribution
    },
    quotes: metrics.quotes
  };

  const user = [
    `COMPANY: ${companyName}`,
    `FACTS (strict):`,
    JSON.stringify(facts),
    `\nGenerate the JSON exactly per schema.`
  ].join('\n');

  return { systemInstruction: sys, userText: user };
}

// ---------- Markdown renderer (for convenience in UI) ----------
function renderMarkdown(summary) {
  if (!summary || typeof summary !== 'object') return 'No summary.';
  const lines = [];
  const ov = summary.overview || {};
  lines.push(`# Reputation Summary`);
  if (ov.period) lines.push(`**Period:** ${ov.period}`);
  if (typeof ov.total === 'number' && typeof ov.avg_stars === 'number') {
    const trend = ov.trend_vs_prev ? ` • Δ★ ${ov.trend_vs_prev.stars_delta || '0'} • ΔVol ${ov.trend_vs_prev.volume_pct || '0'}%` : '';
    lines.push(`**Volume/Avg:** ${ov.total} items • ${ov.avg_stars}★${trend}`);
  }
  if (ov.sources?.length) {
    lines.push(`**Top sources:** ` + ov.sources.map(s => `${s.name} (${s.count}, ${s.avg_stars}★)`).join(', '));
  }
  // Themes
  if (Array.isArray(summary.themes) && summary.themes.length) {
    lines.push(`\n## Themes`);
    summary.themes.forEach(t => lines.push(`- **${t.name}** — ${t.sentiment} (${t.count}${t.change_vs_prev ? `, Δ ${t.change_vs_prev}` : ''})`));
  }
  // Wins / Pain points
  if (summary.wins?.length) {
    lines.push(`\n## Wins`);
    summary.wins.forEach(w => lines.push(`- ${w}`));
  }
  if (summary.pain_points?.length) {
    lines.push(`\n## Pain points`);
    summary.pain_points.forEach(p => lines.push(`- ${p}`));
  }
  // Anomalies
  if (summary.anomalies?.length) {
    lines.push(`\n## Anomalies`);
    summary.anomalies.forEach(a => lines.push(`- ${a.date ? `**${a.date}:** ` : ''}${a.note}`));
  }
  // Actions
  if (summary.actions?.length) {
    lines.push(`\n## Recommended actions`);
    summary.actions.forEach(a => lines.push(`- **${a.action}** — *${a.owner || 'Owner?'}*. Why: ${a.why}. KPI: ${a.metric_to_watch}.`));
  }
  // Quotes
  if (summary.quotes?.length) {
    lines.push(`\n## Representative quotes`);
    summary.quotes.forEach(q => lines.push(`> ${q.text} — ${q.star}★ (${q.source}, ${q.id})`));
  }
  return lines.join('\n');
}

// ---------- Core: generate one user's summary ----------
async function generateSummaryForUser(userId) {
  // fetch user
  const userRes = await pool.query(`SELECT id, company_name FROM users WHERE id = $1`, [userId]);
  if (!userRes.rows.length) throw new Error('User not found');
  const { company_name } = userRes.rows[0];

  const rangeEnd   = new Date(); // now (server time, stored as timestamptz by PG)
  const rangeStart = new Date(rangeEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Fetch datasets
  const [curr, prev] = await Promise.all([
    fetchDataset(company_name, rangeStart, rangeEnd),
    fetchDataset(company_name, new Date(rangeStart.getTime() - 7*24*60*60*1000), rangeStart)
  ]);

  const metrics = buildMetrics(curr, prev, rangeStart, rangeEnd);

  // If empty dataset, still store a minimal summary (or you can skip)
  const { systemInstruction, userText } = makePrompt(company_name, metrics);

  let summaryJson = null, summaryText = null, model = null, tokensIn = null, tokensOut = null;

  try {
    const res = await gemini.generateText(userText, systemInstruction, {
      temperature: 0.2,
      maxOutputTokens: 900,
      timeoutMs: 15000
    });
    model = res.model; tokensIn = res.tokensIn; tokensOut = res.tokensOut;

    if (res.ok) {
      const parsed = safeJsonParse(res.text);
      if (parsed && parsed.overview) {
        summaryJson = parsed;
        summaryText = renderMarkdown(parsed);
      }
    }
  } catch (e) {
    if (DEBUG_SUMMARY) console.error('[aiSummary] LLM error:', e.message);
  }

  // Fallbacks if LLM failed
  if (!summaryJson) {
    summaryJson = {
      overview: {
        period: `${metrics.period.start.slice(0,10)} → ${metrics.period.end.slice(0,10)}`,
        total: metrics.total,
        avg_stars: metrics.avg_stars,
        trend_vs_prev: {
          stars_delta: (metrics.trend_vs_prev.stars_delta >= 0 ? '+' : '') + metrics.trend_vs_prev.stars_delta,
          volume_pct: metrics.trend_vs_prev.volume_pct == null ? '0' : (metrics.trend_vs_prev.volume_pct >= 0 ? '+' : '') + metrics.trend_vs_prev.volume_pct
        },
        sources: metrics.sources,
        distribution: metrics.distribution
      },
      themes: [],
      wins: [],
      pain_points: [],
      anomalies: [],
      quotes: metrics.quotes,
      actions: []
    };
    summaryText = renderMarkdown(summaryJson);
  }

  const expiresAt   = nextMidnightUtc();
  const summaryDay  = toUtcDate(rangeEnd).toISOString().slice(0,10); // YYYY-MM-DD (UTC)

  // Persist
  const insertSql = `
    INSERT INTO ai_summaries
      (user_id, company_name, range_start, range_end, generated_at, expires_at,
       metrics_json, summary_json, summary_text, model, tokens_in, tokens_out, summary_day)
    VALUES
      ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `;
  const params = [
    userId, company_name, rangeStart, rangeEnd, expiresAt,
    metrics, summaryJson, summaryText, model, tokensIn, tokensOut, summaryDay
  ];
  await pool.query(insertSql, params);

  // Mark user as fetched today
  await pool.query(`UPDATE users SET last_fetched_aisummary = now() WHERE id = $1`, [userId]);

  if (DEBUG_SUMMARY) console.log(`[aiSummary] stored for user ${userId} (${company_name})`);

  return { ok: true };
}

// ---------- Batch selector + cron ----------
async function runAiSummariesBatch() {
  const { rows } = await pool.query(
    `
    SELECT id, company_name
      FROM users
     WHERE last_fetched_aisummary IS NULL
        OR (last_fetched_aisummary AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE 'UTC')::date
     LIMIT $1
    `,
    [BATCH_LIMIT]
  );

  for (const u of rows) {
    try {
      await generateSummaryForUser(u.id);
    } catch (e) {
      console.error(`[aiSummary] failed user ${u.id}:`, e.message);
    }
  }
}

function startAiSummaryCron() {
  // Every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    runAiSummariesBatch().catch(console.error);
  });
  // console.log('[aiSummary] cron started: every 30 minutes');
}

module.exports = {
  startAiSummaryCron,
  runAiSummariesBatch,
  generateSummaryForUser
};
