// controllers/supportController.js
const crypto = require('crypto');
const pool = require('../db/pool');
const { enqueueEmail } = require('../services/emailQueue');

// Helpers
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || ''); }
function genComplaintId() {
  // Compact human-friendly id, e.g. CMP-20250928-7F3A9C
  const date = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `CMP-${date}-${rand}`;
}

/**
 * POST /api/support/complaints
 * Body: { name?, contact_email*, description*, image_url? }
 * No auth required.
 * Behavior:
 *   - create row (status defaults to 'Under Review')
 *   - immediately email the complainer an acknowledgement
 *   - the 2-min background job will:
 *       • map to user (user_id/company_name/is_existing_user)
 *       • classify priority with Gemini
 *       • notify support team with full payload
 */
exports.createComplaint = async (req, res, next) => {
  try {
    const { name, contact_email, description, image_url } = req.body || {};
    if (!isEmail(contact_email)) {
      return res.status(400).json({ error: 'A valid contact_email is required.' });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ error: 'Complaint/feedback description is required.' });
    }

    const complaintId = genComplaintId();
    const insertSql = `
      INSERT INTO complaints (
        complaint_id, contact_email, name, description, image_url, status
      ) VALUES ($1,$2,$3,$4,$5,'Under Review')
      RETURNING id, complaint_id, contact_email, created_at
    `;
    const { rows } = await pool.query(insertSql, [
      complaintId, contact_email.trim(), name || null, description.trim(), image_url || null
    ]);
    const row = rows[0];

    // Fire-and-forget: acknowledgement to complainer
    enqueueEmail('complaint_ack', {
      to: row.contact_email,
      complaintId: row.complaint_id,
      createdAt: row.created_at
    }).catch(() => { /* swallow; do not block HTTP */ });

    return res.status(201).json({
      message: 'Your complaint/feedback is under review. We will get back to you soon.',
      complaint_id: row.complaint_id
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/support/contact
 * Body: { email*, message*, image_url? }
 * No auth required.
 * Behavior:
 *   - create row
 *   - immediately email the sender an acknowledgement
 *   - the 2-min background job will:
 *       • map to user (user_id/is_existing_user)
 *       • email the contact team inbox with details
 */
exports.createContact = async (req, res, next) => {
  try {
    const { email, message, image_url } = req.body || {};
    if (!isEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const insertSql = `
      INSERT INTO contact_messages (email, message, image_url)
      VALUES ($1,$2,$3)
      RETURNING id, email, created_at
    `;
    const { rows } = await pool.query(insertSql, [
      email.trim(), message.trim(), image_url || null
    ]);
    const row = rows[0];

    // Ack to sender
    enqueueEmail('contact_ack', {
      to: row.email,
      createdAt: row.created_at
    }).catch(() => {});

    return res.status(201).json({
      message: 'Thanks for reaching out. We’ll respond as soon as possible.'
    });
  } catch (err) {
    next(err);
  }
};
