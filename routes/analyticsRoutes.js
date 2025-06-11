const express = require('express');
const router  = express.Router();
const analytics = require('../controllers/analyticsController');
const { protect } = require('../middlewares/authMiddleware');

// all analytics endpoints require a valid JWT:
router.use(protect);


router.get('/positive-reviews',           analytics.positiveReviews);
router.get('/neutral-reviews',            analytics.neutralReviews);
router.get('/negative-reviews',           analytics.negativeReviews);
router.get('/highly-positive-reviews',    analytics.highlyPositiveReviews);
router.get('/moderately-positive-reviews',analytics.moderatelyPositiveReviews);
router.get('/slightly-negative-reviews',  analytics.slightlyNegativeReviews);
router.get('/highly-negative-reviews',    analytics.highlyNegativeReviews);
router.get('/reviews',                    analytics.reviews);

module.exports = router;
