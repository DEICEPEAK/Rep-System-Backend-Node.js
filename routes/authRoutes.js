// routes/authRoutes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../controllers/authController');

const router = express.Router();

const rlTight = rateLimit({ windowMs: 5 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false });
const rlVerify = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });
const rlResend = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
const rlReset  = rateLimit({ windowMs: 10 * 60 * 1000, max: 10 });


router.post('/verify-email', rlVerify, auth.verifyEmail);
router.post('/login', rlTight, auth.loginUser);
router.post('/request-password-reset', rlReset, auth.requestPasswordReset);
router.post('/setup-password', rlVerify, auth.setupPassword);


module.exports = router;
