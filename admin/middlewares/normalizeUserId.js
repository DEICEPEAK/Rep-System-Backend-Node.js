// /admin/middlewares/normalizeUserId.js
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = function normalizeUserId(req, res, next) {
  const raw = (req.body && req.body.user_id) || (req.query && req.query.user_id);
  const isUuid = typeof raw === 'string' && UUID_RE.test(raw);
  const isNumericId = typeof raw === 'string' && /^[1-9]\d*$/.test(raw);

  if (!isUuid && !isNumericId) {
    return res.status(400).json({
      error: 'user_id is required (POST/PUT: body.user_id, GET: ?user_id=) and must be a UUID or positive integer.'
    });
  }

  // Surface as param for controllers
  req.params.userId = raw;
  next();
};
