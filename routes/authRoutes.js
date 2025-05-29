const express = require('express');
const router = express.Router();
const {
  registerUser,
  loginUser,
  requestPasswordReset,
  resetPassword,
} = require('../controllers/authController');

// POST /api/auth/register
router.post('/register', registerUser);

// POST /api/auth/login
router.post('/login', loginUser);

// POST /api/auth/request-reset
router.post('/request-reset', requestPasswordReset);

// POST /api/auth/reset-password
router.post('/reset-password', resetPassword);


module.exports = router;