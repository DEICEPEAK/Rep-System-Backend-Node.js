/**
 * File: /admin/Routes/adminAuthRoutes.js
 */

const express = require('express');
const router = express.Router();

const {
  loginAdmin, requestAdminPasswordReset, resetAdminPassword,
  addNewAdmin
} = require('../controllers/adminAuthController');

const { protectAdmin, requireGlobalAdmin } = require('../middlewares/adminAuthMiddleware');

// Auth
router.post('/login', loginAdmin);

// Admin password reset
router.post('/password/forgot', requestAdminPasswordReset);
router.post('/password/reset', resetAdminPassword);

// Create a new admin (global_admin only)
router.post('/add-admin', protectAdmin, requireGlobalAdmin, addNewAdmin);

module.exports = router;
