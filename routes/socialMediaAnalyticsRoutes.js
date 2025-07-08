// routes/socialMediaAnalyticsRoutes.js

const express = require('express');
const router  = express.Router();
const analytics = require('../controllers/socialMediaAnalyticsController');
const { protect } = require('../middlewares/authMiddleware');

// all social‐media analytics endpoints require a valid JWT:
router.use(protect);

// 1) Total mentions & % change
router.get('/total-mentions', analytics.totalMentions);

// 2) Neutral count & %
router.get('/neutral', analytics.neutralMetrics);

// 3) Highly positive count & %
router.get('/highly-positive', analytics.highlyPositiveMetrics);

// 4) Moderately positive count & %
router.get('/moderately-positive', analytics.moderatelyPositiveMetrics);

// 5) Slightly negative count & %
router.get('/slightly-negative', analytics.slightlyNegativeMetrics);

// 6) Highly negative count & %
router.get('/highly-negative', analytics.highlyNegativeMetrics);

// 7) Mentions listing
router.get('/mentions', analytics.mentions);

module.exports = router;
