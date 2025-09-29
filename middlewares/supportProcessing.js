// middlewares/supportProcessing.js
const cron = require('node-cron');
const pool = require('../db/pool');
const { enqueueEmail } = require('../services/emailQueue');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPPORT_EMAIL_COMPLAINTS = process.env.SUPPORT_EMAIL_COMPLAINTS || 'support-complaints@example.com';
const SUPPORT_EMAIL_CONTACT = process.env.SUPPORT_EMAIL_CONTACT || 'support-contact@example.com';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

function safeUpper(s){ return String(s || '').trim().toUpperCase(); }

async function classifyPriority(text) {
  if (!genAI) return { priority: 'medium', confidence: 0 }; // fallback

  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: `
      You are a support triage model.
      Classify the complaint text into one of: LOW, MEDIUM, HIGH.
      Consider urgency, impact, and severity (e.g., payment failure, data loss => HIGH).
      Return STRICT JSON ONLY:

      {"priority":"LOW|MEDIUM|HIGH","confidence":0.0}
    `
  });

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { temperature: 0.0, maxOutputTokens: 128, responseMimeType: 'application/json' }
    });

    const raw = typeof result?.response?.text === 'function'
      ? result.response.text()
      : result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // poor-man fallback: extract first JSON block
      const start = raw.indexOf('{');
      if (start > -1) {
        let depth = 0, end = -1;
        for (let i = start; i < raw.length; i++) {
          const ch = raw[i];
          if (ch === '{') depth++;
          if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end > -1) parsed = JSON.parse(raw.slice(start, end + 1));
      }
    }

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

      // Classify priority
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
  console.log('[supportProcessing] cron started: every 2 minutes');
}

module.exports = { startSupportProcessingCron };
