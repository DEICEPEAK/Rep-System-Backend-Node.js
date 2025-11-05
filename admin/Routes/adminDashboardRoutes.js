/**
 * File: /admin/Routes/adminDashboardRoutes.js
 */

const express = require('express');
const router = express.Router();
const normalizeUserId = require('../middlewares/normalizeUserId');
const { addNewCompany, getUsersOverview, loginsToday, activeUsers15d, analyticsSummary, resendUserVerification, editUserBusinessDetails, viewBusinessDetails,} = require('../controllers/adminDashboardController');
const { protectAdmin, requireAdmin } = require('../middlewares/adminAuthMiddleware');


// Create a new company user (both admin roles)
router.post('/company', protectAdmin, requireAdmin, addNewCompany);
router.post('/resend-verification',   protectAdmin, requireAdmin, normalizeUserId, resendUserVerification);
router.put('/edit-business-details',  protectAdmin, requireAdmin, normalizeUserId, editUserBusinessDetails);
router.get('/view-business-details',  protectAdmin, requireAdmin, normalizeUserId, viewBusinessDetails);

// Users overview: total + list with selected fields (both admin roles)
router.get('/users', protectAdmin, requireAdmin, getUsersOverview);
router.get('/logins-today', protectAdmin, requireAdmin, loginsToday);
router.get('/active-users-15d', protectAdmin, requireAdmin, activeUsers15d);
router.get('/analytics-summary', protectAdmin, requireAdmin, analyticsSummary);



module.exports = router;
