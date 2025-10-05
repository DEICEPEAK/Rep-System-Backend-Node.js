// routes/aiSummaryRoutes.js


const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const ctrl = require('../controllers/aiSummaryController');

router.get('/latest', protect, ctrl.getLatestSummary);
router.post('/generate-now', protect, ctrl.generateNow);
router.post('/history', protect, ctrl.emailLatestSummary);

module.exports = router;