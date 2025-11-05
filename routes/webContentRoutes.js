// routes/webContentRoutes.js
const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const ctrl = require('../controllers/webContentController');

const router = express.Router();

router.get('/positive-count', protect, ctrl.positiveCount);
router.get('/neutral-count',  protect, ctrl.neutralCount);
router.get('/negative-count', protect, ctrl.negativeCount);
router.get('/all',            protect, ctrl.allWebContent);

module.exports = router;