// controllers/aiSummaryController.js
const pool = require('../db/pool');
const { generateSummaryForUser } = require('../middlewares/aiSummaryWorker');
const { enqueueEmail } = require('../services/emailQueue');



// GET /api/ai-summaries/latest
// Returns the most recent summary for the current user (or by user_id param if you prefer admin use)
exports.getLatestSummary = async (req, res, next) => {
  try {
    const userId = req.user?.id || Number(req.query.user_id);
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    const { rows } = await pool.query(
      `SELECT id, user_id, company_name, range_start, range_end, generated_at, expires_at,
              metrics_json, summary_json, summary_text, model, tokens_in, tokens_out, summary_day
         FROM ai_summaries
        WHERE user_id = $1
        ORDER BY range_end DESC
        LIMIT 1`,
      [userId]
    );

    if (!rows.length) return res.status(404).json({ error: 'No summaries found' });
    return res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

// POST /api/ai-summaries/generate-now
// On-demand generation for the current user (or admin can pass user_id)
exports.generateNow = async (req, res, next) => {
  try {
    const userId = req.user?.id || Number(req.body.user_id);
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    await generateSummaryForUser(userId);
    return res.status(202).json({ message: 'Summary generation triggered' });
  } catch (err) {
    next(err);
  }
};


/** Utility: basic HTML-escape */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render a polished HTML email for an AI summary row */
function renderSummaryEmailHTML(row) {
  const s = row.summary_json || {};
  const ov = s.overview || {};
  const themes = Array.isArray(s.themes) ? s.themes : [];
  const wins = Array.isArray(s.wins) ? s.wins : [];
  const pains = Array.isArray(s.pain_points) ? s.pain_points : [];
  const anomalies = Array.isArray(s.anomalies) ? s.anomalies : [];
  const quotes = Array.isArray(s.quotes) ? s.quotes : [];
  const actions = Array.isArray(s.actions) ? s.actions : [];

  const sources = Array.isArray(ov.sources) ? ov.sources : [];
  const dist = ov.distribution || {};

  const css = `
    body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#121212; margin:0; padding:0; background:#f7f7f9; }
    .wrap { max-width: 880px; margin: 24px auto; background:#fff; border:1px solid #eee; border-radius:12px; overflow:hidden; }
    .hdr { background:#0b5cff; color:#fff; padding:20px 24px; }
    .hdr h1 { margin:0 0 6px; font-size:20px; }
    .hdr .meta { opacity:.95; font-size:13px; }
    .sec { padding:20px 24px; }
    h2 { font-size:16px; margin:0 0 12px; color:#202124; }
    p { margin:6px 0; }
    .kpis { display:flex; gap:16px; flex-wrap:wrap; }
    .kpi { background:#f2f6ff; border:1px solid #e5eeff; border-radius:10px; padding:12px 14px; min-width: 150px; }
    .kpi b { font-size:18px; display:block; }
    table { width:100%; border-collapse: collapse; font-size:13px; }
    th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #eee; }
    th { background:#fafbff; border-bottom:1px solid #eaefff; font-weight:600; }
    .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; border:1px solid #e6e6e6; background:#fafafa; }
    .quote { background:#fbfbfb; border:1px solid #eee; border-radius:10px; padding:10px 12px; margin:8px 0; }
    .muted { color:#5f6368; }
    .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:18px; }
    @media (max-width: 720px){ .grid2{ grid-template-columns:1fr; } }
    .footer { padding:14px 24px; font-size:12px; color:#666; background:#fafafa; border-top:1px solid #eee; }
  `;

  const sourcesRows = sources.map(r =>
    `<tr><td>${esc(r.name)}</td><td>${Number(r.count)||0}</td><td>${Number(r.avg_stars)||0}★</td></tr>`
  ).join('');

  const distRows = [1,2,3,4,5].map(k =>
    `<tr><td>${k}★</td><td>${Number(dist[k])||0}</td></tr>`
  ).join('');

  const themeRows = themes.map(t =>
    `<tr><td>${esc(t.name)}</td><td><span class="pill">${esc(t.sentiment)}</span></td><td>${Number(t.count)||0}</td><td>${esc(t.change_vs_prev ?? '0')}</td></tr>`
  ).join('');

  const winsList = wins.map(w => `<li>${esc(w)}</li>`).join('');
  const painsList = pains.map(p => `<li>${esc(p)}</li>`).join('');
  const anomalyRows = anomalies.map(a =>
    `<tr><td>${esc(a.date||'')}</td><td>${esc(a.note||'')}</td></tr>`
  ).join('');

  const actionRows = actions.map(a =>
    `<tr>
      <td>${esc(a.action||'')}</td>
      <td>${esc(a.why||'')}</td>
      <td>${esc(a.owner||'')}</td>
      <td>${esc(a.metric_to_watch||'')}</td>
    </tr>`
  ).join('');

  const quoteBlocks = quotes.map(q =>
    `<div class="quote">
       <div><b>${q.star||''}★</b> <span class="muted">• ${esc(q.source||'')}</span> <span class="muted">• ${esc(q.id||'')}</span></div>
       <div>${esc(q.text||'')}</div>
     </div>`
  ).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>AI Reputation Summary</title>
<style>${css}</style>
</head>
<body>
  <div class="wrap">
    <div class="hdr">
      <h1>AI Reputation Summary — ${esc(row.company_name)}</h1>
      <div class="meta">Period: ${esc(ov.period || '')} • Generated: ${new Date(row.generated_at).toLocaleString()}</div>
    </div>

    <div class="sec">
      <div class="kpis">
        <div class="kpi"><span class="muted">Total items</span><b>${Number(ov.total)||0}</b></div>
        <div class="kpi"><span class="muted">Avg stars</span><b>${Number(ov.avg_stars)||0}★</b></div>
        <div class="kpi"><span class="muted">Δ vs prev (★)</span><b>${esc(ov.trend_vs_prev?.stars_delta ?? '0')}</b></div>
        <div class="kpi"><span class="muted">Δ volume (%)</span><b>${esc(ov.trend_vs_prev?.volume_pct ?? '0')}%</b></div>
      </div>
    </div>

    <div class="sec grid2">
      <div>
        <h2>By source</h2>
        <table>
          <thead><tr><th>Source</th><th>Count</th><th>Avg ★</th></tr></thead>
          <tbody>${sourcesRows || '<tr><td colspan="3" class="muted">No data</td></tr>'}</tbody>
        </table>
      </div>
      <div>
        <h2>Distribution</h2>
        <table>
          <thead><tr><th>Stars</th><th>Count</th></tr></thead>
          <tbody>${distRows}</tbody>
        </table>
      </div>
    </div>

    <div class="sec">
      <h2>Themes</h2>
      <table>
        <thead><tr><th>Theme</th><th>Sentiment</th><th>Count</th><th>Δ vs prev</th></tr></thead>
        <tbody>${themeRows || '<tr><td colspan="4" class="muted">No themes available</td></tr>'}</tbody>
      </table>
    </div>

    <div class="sec grid2">
      <div>
        <h2>Wins</h2>
        <ul>${winsList || '<li class="muted">No wins identified</li>'}</ul>
      </div>
      <div>
        <h2>Pain points</h2>
        <ul>${painsList || '<li class="muted">No pain points identified</li>'}</ul>
      </div>
    </div>

    <div class="sec">
      <h2>Anomalies</h2>
      <table>
        <thead><tr><th>Date</th><th>Note</th></tr></thead>
        <tbody>${anomalyRows || '<tr><td colspan="2" class="muted">No anomalies detected</td></tr>'}</tbody>
      </table>
    </div>

    <div class="sec">
      <h2>Recommended actions</h2>
      <table>
        <thead><tr><th>Action</th><th>Why</th><th>Owner</th><th>Metric to watch</th></tr></thead>
        <tbody>${actionRows || '<tr><td colspan="4" class="muted">No actions available</td></tr>'}</tbody>
      </table>
    </div>

    <div class="sec">
      <h2>Representative quotes</h2>
      ${quoteBlocks || '<div class="muted">No quotes available</div>'}
    </div>

    <div class="footer">
      Valid through: ${new Date(row.expires_at).toUTCString()} • Summary day: ${esc(row.summary_day)}
    </div>
  </div>
</body>
</html>`;
}

/**
 * POST /api/ai-summaries/email-latest
 * Body (optional): { generateIfMissing: boolean }
 * Behavior:
 *  - Fetch latest summary for user; if none and generateIfMissing=true, generate then fetch
 *  - Render HTML and email it to the user's email (from users table)
 *  - Also attach the HTML file as .html for "download"
 */
exports.emailLatestSummary = async (req, res, next) => {
  try {
    const userId = req.user?.id || Number(req.body?.user_id);
    const generateIfMissing = !!req.body?.generateIfMissing;
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    // Fetch user (to get email + company)
    const ures = await pool.query(`SELECT id, email, company_name FROM users WHERE id=$1 LIMIT 1`, [userId]);
    if (!ures.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = ures.rows[0];
    if (!user.email) return res.status(400).json({ error: 'User email missing' });

    // Fetch latest summary
    let { rows } = await pool.query(
      `SELECT id, user_id, company_name, range_start, range_end, generated_at, expires_at,
              metrics_json, summary_json, summary_text, model, tokens_in, tokens_out, summary_day
         FROM ai_summaries
        WHERE user_id = $1
        ORDER BY range_end DESC
        LIMIT 1`,
      [userId]
    );

    if (!rows.length && generateIfMissing) {
      await generateSummaryForUser(userId);
      ({ rows } = await pool.query(
        `SELECT id, user_id, company_name, range_start, range_end, generated_at, expires_at,
                metrics_json, summary_json, summary_text, model, tokens_in, tokens_out, summary_day
           FROM ai_summaries
          WHERE user_id = $1
          ORDER BY range_end DESC
          LIMIT 1`,
        [userId]
      ));
    }

    if (!rows.length) {
      return res.status(404).json({ error: 'No summary available. Set generateIfMissing=true to create one.' });
    }

    const summaryRow = rows[0];
    const html = renderSummaryEmailHTML(summaryRow);
    const day = summaryRow.summary_day || new Date(summaryRow.range_end).toISOString().slice(0,10);
    const subject = `Your 7-day AI Reputation Summary — ${user.company_name} (${day})`;

    // Send via your email queue. Assumes your email service can handle:
    //  - a custom template 'ai_summary_report' that uses 'html_content' directly
    //  - optional attachments (if supported by your queue)
    await enqueueEmail('ai_summary_report', {
      to: user.email,
      subject,
      companyName: user.company_name,
      summaryDay: day,
      html_content: html,
      // If your queue supports attachments:
      attachments: [
        { filename: `ai-summary-${day}.html`, content: html }
      ]
    });

    return res.status(202).json({ message: 'Summary emailed', to: user.email, day });
  } catch (err) {
    next(err);
  }
};