const router = require('express').Router();
const { getSentimentTrend, getChannelBreakdown } = require('../controllers/metricsController');

// e.g. GET /api/metrics/trend?from=2025-05-01&to=2025-05-28
router.get('/trend', getSentimentTrend);

// e.g. GET /api/metrics/channel?from=2025-05-01&to=2025-05-28
router.get('/channel', getChannelBreakdown);

module.exports = router;
