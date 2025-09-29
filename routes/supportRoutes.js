// routes/supportRoutes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const { createComplaint, createContact } = require('../controllers/supportController');

const router = express.Router();

// Light abuse guard (no auth required)
const rlPublicTight = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false
});

router.post('/complaints', rlPublicTight, createComplaint);
router.post('/contact', rlPublicTight, createContact);

module.exports = router;
