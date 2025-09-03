/**
 * File: /admin/Routes/adminDashboardRoutes.js
 */

const express = require('express');
const router = express.Router();

const { addNewCompany, getUsersOverview } = require('../controllers/adminDashboardController');
const { protectAdmin, requireAdmin } = require('../middlewares/adminAuthMiddleware');

// Create a new company user (both admin roles)
router.post('/company', protectAdmin, requireAdmin, addNewCompany);

// Users overview: total + list with selected fields (both admin roles)
router.get('/users', protectAdmin, requireAdmin, getUsersOverview);

module.exports = router;
