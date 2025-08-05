// routes/reviewRoutes.js

const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const ctrl = require('../controllers/reviewController');
const router = express.Router();


router.get('/positive',           protect, ctrl.positiveReviews);
router.get('/neutral',            protect, ctrl.neutralReviews);
router.get('/negative',           protect, ctrl.negativeReviews);
router.get('/highly-positive',    protect, ctrl.highlyPositiveReviews);
router.get('/moderately-positive',protect, ctrl.moderatelyPositiveReviews);
router.get('/slightly-negative',  protect, ctrl.slightlyNegativeReviews);
router.get('/highly-negative',    protect, ctrl.highlyNegativeReviews);
router.get('/review-thread',      protect, ctrl.reviews);
router.get('/stats',      protect, ctrl.reviewStatsToday);

module.exports = router;
