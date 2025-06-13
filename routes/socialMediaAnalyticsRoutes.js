// routes/socialMediaAnalyticsRoutes.js

const express = require('express');
const router  = express.Router();
const analytics = require('../controllers/socialMediaAnalyticsController');
const { protect } = require('../middlewares/authMiddleware');

// all social‐media analytics endpoints require a valid JWT:
router.use(protect);

// 1–6. Combined metrics endpoint (total & sentiment buckets)
router.get('/mention-metrics', analytics.mentionMetrics);

// 8. Mentions listing
router.get('/mentions', analytics.mentions);

module.exports = router;
