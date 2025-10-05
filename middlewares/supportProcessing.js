// middlewares/supportProcessing.js
const cron = require('node-cron');
const pool = require('../db/pool');
const { enqueueEmail } = require('../services/emailQueue');
const { makeGeminiClient } = require('../services/geminiClientImpl');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPPORT_EMAIL_COMPLAINTS = process.env.SUPPORT_EMAIL_COMPLAINTS || 'support-complaints@example.com';
const SUPPORT_EMAIL_CONTACT    = process.env.SUPPORT_EMAIL_CONTACT  || 'support-contact@example.com';

const geminiClient = makeGeminiClient({ apiKey: GEMINI_API_KEY }); // uses 2.0-flash-001 via client default

function safeUpper(s){ return String(s || '').trim().toUpperCase(); }

// --- Robust JSON parsing helpers (kept from previous logic) ---
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

// Use geminiClient.generateText for priority classification
async function classifyPriority(text) {
  // Fallback if client is disabled or key missing (client returns ok:false)
  const systemInstruction = `
You are a support triage model.
Classify the complaint text into one of: LOW, MEDIUM, HIGH.
Consider urgency, impact, and severity (e.g., payment failure, data loss => HIGH).
Return STRICT JSON ONLY (no prose, no code fences):

{"priority":"LOW|MEDIUM|HIGH","confidence":0.0}
`.trim();

  try {
    const res = await geminiClient.generateText(text || '', systemInstruction, {
      temperature: 0.0,
      maxOutputTokens: 64,
      timeoutMs: 12_000
    });

    if (!res.ok) {
      // Could be CONFIG_ERROR or provider issue — graceful fallback
      return { priority: 'medium', confidence: 0 };
    }

    const parsed = safeJsonParse(res.text);
    const p = safeUpper(parsed?.priority);
    if (p === 'LOW' || p === 'MEDIUM' || p === 'HIGH') {
      return { priority: p.toLowerCase(), confidence: Number(parsed?.confidence) || 0 };
    }
    return { priority: 'medium', confidence: 0 };
  } catch (err) {
    console.error('[complaints] Priority classify failed:', err.message);
    return { priority: 'medium', confidence: 0 };
  }
}

async function mapEmailToUser(email) {
  const { rows } = await pool.query(
    `SELECT id, company_name, is_deleted, is_suspended
       FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1`,
    [email]
  );
  if (!rows.length) return null;
  return rows[0];
}

async function processComplaintsBatch(limit = 100) {
  // Only rows not yet prioritized (priority IS NULL)
  const { rows } = await pool.query(
    `SELECT id, complaint_id, contact_email, description, image_url,
            user_id, company_name, is_existing_user, status, created_at
       FROM complaints
      WHERE priority IS NULL
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit]
  );

  for (const c of rows) {
    try {
      // Map email to user (only if not mapped yet)
      let mappedUser = null;
      if (!c.is_existing_user || c.is_existing_user === 'NULL') {
        mappedUser = await mapEmailToUser(c.contact_email);
        if (mappedUser) {
          await pool.query(
            `UPDATE complaints
                SET is_existing_user='Yes',
                    user_id = $1,
                    company_name = $2
              WHERE id = $3`,
            [mappedUser.id, mappedUser.company_name, c.id]
          );
        } else {
          await pool.query(
            `UPDATE complaints
                SET is_existing_user='No'
              WHERE id = $1`,
            [c.id]
          );
        }
      } else if (c.is_existing_user === 'Yes') {
        const u = await mapEmailToUser(c.contact_email);
        mappedUser = u || null;
      }

      // Classify priority via Gemini client (2.0-flash-001)
      const { priority, confidence } = await classifyPriority(c.description);

      await pool.query(
        `UPDATE complaints
            SET priority = $1
          WHERE id = $2`,
        [priority, c.id]
      );

      // Notify support team
      const isDeleted = mappedUser?.is_deleted ?? null;
      const isSusp   = mappedUser?.is_suspended ?? null;

      enqueueEmail('complaint_notify', {
        to: SUPPORT_EMAIL_COMPLAINTS,
        complaintId: c.complaint_id,
        contactEmail: c.contact_email,
        description: c.description,
        imageUrl: c.image_url,
        priority,
        priorityConfidence: confidence,
        isExistingUser: c.is_existing_user || (mappedUser ? 'Yes' : 'No'),
        userId: mappedUser?.id || null,
        companyName: mappedUser?.company_name || null,
        user_is_deleted: isDeleted,
        user_is_suspended: isSusp,
        createdAt: c.created_at
      }).catch(() => {});

    } catch (err) {
      console.error('[complaints] process row failed:', err.message);
    }
  }
}

async function processContactsBatch(limit = 200) {
  // Only rows not yet mapped (is_existing_user IS NULL)
  const { rows } = await pool.query(
    `SELECT id, email, message, image_url, user_id, is_existing_user, created_at
       FROM contact_messages
      WHERE is_existing_user IS NULL
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit]
  );

  for (const m of rows) {
    try {
      const mappedUser = await mapEmailToUser(m.email);
      if (mappedUser) {
        await pool.query(
          `UPDATE contact_messages
              SET is_existing_user='Yes', user_id=$1
            WHERE id=$2`,
          [mappedUser.id, m.id]
        );
      } else {
        await pool.query(
          `UPDATE contact_messages
              SET is_existing_user='No'
            WHERE id=$1`,
          [m.id]
        );
      }

      // Notify the contact support team
      enqueueEmail('contact_notify', {
        to: SUPPORT_EMAIL_CONTACT,
        email: m.email,
        message: m.message,
        imageUrl: m.image_url,
        userId: mappedUser?.id || null,
        isExistingUser: mappedUser ? 'Yes' : 'No',
        createdAt: m.created_at
      }).catch(() => {});
    } catch (err) {
      console.error('[contact] process row failed:', err.message);
    }
  }
}

// ── Schedule: every 2 minutes ───────────────────────────────────────────
function startSupportProcessingCron() {
  cron.schedule('*/2 * * * *', () => {
    processComplaintsBatch().catch(console.error);
    processContactsBatch().catch(console.error);
  });
  // console.log('[supportProcessing] cron started: every 2 minutes');
}

module.exports = { startSupportProcessingCron };
