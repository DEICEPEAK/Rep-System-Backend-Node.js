// Routes/videoContentRoutes.js

const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const ctrl = require('../controllers/videoContentController');

router.get('/video-contents', protect, ctrl.videoContents);
router.get('/video-stats', protect, ctrl.videoStats);

module.exports = router;