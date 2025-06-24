// controllers/businessDetailsController.js
const pool = require('../db/pool');

// Helper: list of all business-detail fields
const DETAIL_FIELDS = [
  'company_web_address',
  'twitter_username',
  'instagram_username',
  'feefo_business_info',
  'company_maps_place_id',
  'company_maps_url'
];

// POST /api/business_details/:id
// Create (or set) the six detail fields for user id
exports.createBusinessDetails = async (req, res, next) => {
  const userId = req.params.id;
  // Build SET clauses only for fields provided in body
  const sets = [];
  const vals = [];
  let idx = 1;

  DETAIL_FIELDS.forEach(field => {
    if (req.body[field] !== undefined) {
      sets.push(`${field} = $${idx}`);
      vals.push(req.body[field]);
      idx++;
    }
  });

  if (sets.length === 0) {
    return res.status(400).json({ error: 'No detail fields provided.' });
  }

  // Add userId as last param
  vals.push(userId);
  const query = `
    UPDATE users
       SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING id, ${DETAIL_FIELDS.join(', ')};
  `;
  try {
    const { rows } = await pool.query(query, vals);
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    res.status(201).json({ businessDetails: rows[0] });
  } catch (err) {
    next(err);
  }
};

// PUT /api/business_details/:id
// Edit (patch) the detail fields for user id
exports.editBusinessDetails = async (req, res, next) => {
  const userId = req.params.id;
  const sets = [];
  const vals = [];
  let idx = 1;

  DETAIL_FIELDS.forEach(field => {
    if (req.body[field] !== undefined) {
      sets.push(`${field} = $${idx}`);
      vals.push(req.body[field]);
      idx++;
    }
  });

  if (sets.length === 0) {
    return res.status(400).json({ error: 'No detail fields provided to update.' });
  }

  vals.push(userId);
  const query = `
    UPDATE users
       SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING id, ${DETAIL_FIELDS.join(', ')};
  `;
  try {
    const { rows } = await pool.query(query, vals);
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    res.json({ businessDetails: rows[0] });
  } catch (err) {
    next(err);
  }
};

// GET /api/business_details/:id/registration
// Compute the percentage of those six fields that are non-null
exports.getBusinessRegistrationPct = async (req, res, next) => {
  const userId = req.params.id;
  const query = `
    SELECT ${DETAIL_FIELDS.join(', ') }
      FROM users
     WHERE id = $1
     LIMIT 1;
  `;
  try {
    const { rows } = await pool.query(query, [userId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    const user = rows[0];

    // Count non-null / non-empty fields
    const filled = DETAIL_FIELDS.reduce((count, f) => {
      if (user[f] !== null && user[f] !== '') return count + 1;
      return count;
    }, 0);
    const pct = Math.round((filled / DETAIL_FIELDS.length) * 100);
    res.json({ registrationPercentage: pct });
  } catch (err) {
    next(err);
  }
};


exports.getMyCompany = async (req, res, next) => {
  const userId = req.user.id;      // set by your auth middleware

  try {
    const { rows } = await pool.query(
      `SELECT company_name
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ company_name: rows[0].company_name });
  } catch (err) {
    next(err);
  }
};