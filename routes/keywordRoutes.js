// routes/keywordRoutes.js


const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const ctrl = require('../controllers/keywordController');



router.get('/social',  protect, ctrl.getSocialKeywords);
router.get('/review',  protect, ctrl.getReviewKeywords);
router.get('/general', protect, ctrl.getGeneralKeywords);

module.exports = router;