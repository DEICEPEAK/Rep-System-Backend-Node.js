// routes/keywordRoutes.js


const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const ctrl = require('../controllers/translationController');

router.post('/', protect, ctrl.translate);

module.exports = router;