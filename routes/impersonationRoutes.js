// controllers/impersonationController.js


const express = require('express');
const { exchangeCode, exitImpersonation } = require('../controllers/impersonationController');
const { protect } = require('../middlewares/authMiddleware');
const router = express.Router();

router.post('/impersonate/exchange', exchangeCode);
router.post('/impersonate/exit', protect, exitImpersonation);

module.exports = router;
