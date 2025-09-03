const express = require('express');
const router = express.Router();
const {
  registerUser,
  loginUser,
  requestPasswordReset,
  resetPassword,
} = require('../controllers/authController');
const { protect, requireRole } = require('../middlewares/authMiddleware');

// POST /api/auth/register
//.post('/register', protect, requireRole('admin', 'global_admin'), registerUser);

// POST /api/auth/login
router.post('/login', loginUser);

// POST /api/auth/request-reset
router.post('/forget-password', requestPasswordReset);

// POST /api/auth/reset-password
router.post('/reset-password', resetPassword);

module.exports = router;
